// ============================================================
// Priority Group Solver
//
// Three-phase approach combining diverse instance discovery,
// instance permutation for group diversity, and priority-ordered
// pin assignment:
// - Phase 1: Multi-round instance group discovery (priority round 0,
//   shuffled MRV rounds 1+)
// - Phase 1.5: Generate additional groups by permuting peripheral
//   instances of the same type across ports
// - Phase 2: Priority-ordered backtracking for pin assignment
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, SolverStats } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import {
  extractPorts, resolveReservePatterns, extractPinnedAssignments,
  extractSharedPatterns, resolveAllVariables,
  generateConfigCombinations, validateConstraints,
  emptyResult, pushSolverWarnings, finalizeSolutions,
  partitionGpioVariables, isGpioVariable,
  configsHaveDma,
} from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  buildInstanceVariables, solvePhase1, solvePhase2ForGroup,
  groupFingerprint, varKey,
  type InstanceGroup, type InstanceTracker,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority } from './port-priority';
import { mulberry32, diversifyDomain } from './solver-utils';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';
import { generatePermutedGroups } from './group-permutation';

// ============================================================
// Config
// ============================================================

const MAX_DIVERSITY_ROUNDS = 20;
const STALE_ROUNDS_LIMIT = 3;
const MAX_PERMUTED_GROUPS = 200;
const MAX_PERMS_PER_GROUP = 50;

// ============================================================
// Diversity-Aware Group Ordering (farthest-point sampling)
// ============================================================

function orderByDiversity(groups: InstanceGroup[]): InstanceGroup[] {
  if (groups.length <= 2) return [...groups];

  const n = groups.length;
  const selected: InstanceGroup[] = [groups[0]];
  const used = new Uint8Array(n);
  used[0] = 1;
  const minDist = new Float64Array(n).fill(Infinity);

  for (let iter = 1; iter < n; iter++) {
    const last = selected[selected.length - 1];
    let bestIdx = -1;
    let bestDist = -1;

    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      let d = 0;
      for (const [k, v] of last.assignments) {
        if (groups[i].assignments.get(k) !== v) d++;
      }
      minDist[i] = Math.min(minDist[i], d);
      if (minDist[i] > bestDist) {
        bestDist = minDist[i];
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.push(groups[bestIdx]);
    used[bestIdx] = 1;
  }

  return selected;
}

// ============================================================
// Main solver
// ============================================================

export function solvePriorityGroup(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];

  const { ast: expandedAst, errors: macroErrors } = expandAllMacros(ast, getStdlibMacros());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) {
    reservedPinSet.add(pa.pinName);
  }
  const reservedPeripheralSet = new Set(reserved.peripherals);

  validateConstraints(ports, errors);

  const configCombinations = generateConfigCombinations(ports);
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);

  if (allVariables.length === 0) {
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }

  const emptyVar = allVariables.find(v => v.domain.length === 0);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }

  const { solveVars, gpioVars, gpioCountPerConfig } = partitionGpioVariables(allVariables, !!config.skipGpioMapping);

  if (solveVars.length === 0 && gpioVars.length === 0) {
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }

  if (gpioVars.length > 0) {
    errors.push({ type: 'warning', message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only` });
  }

  const portPriority = computePortPriority(solveVars);
  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);

  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
      }
    }
  }

  // ========== Phase 1: Diverse Instance Group Discovery ==========
  const groupFingerprints = new Set<string>();
  const discoveredGroups: InstanceGroup[] = [];
  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));

  // D4: Instance coverage tracking
  const instanceCoverage = new Map<string, Set<string>>();
  // D2: Track groups discovered per combo index
  const groupsPerCombo = new Map<number, number>();

  let staleRounds = 0;
  for (let round = 0; round < MAX_DIVERSITY_ROUNDS; round++) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (discoveredGroups.length >= config.maxGroups) break;

    const groupsBefore = discoveredGroups.length;

    // D2: In later rounds, prioritize combos with fewer discovered groups
    const comboIndices = [...configCombinations.keys()];
    if (round > 0) {
      comboIndices.sort((a, b) =>
        (groupsPerCombo.get(a) ?? 0) - (groupsPerCombo.get(b) ?? 0));
    }

    for (const comboIdx of comboIndices) {
      if (performance.now() - startTime > config.timeoutMs) break;
      if (discoveredGroups.length >= config.maxGroups) break;

      const combo = configCombinations[comboIdx];
      let activeVars = allInstanceVars.filter(iv =>
        combo.get(iv.portName) === iv.configName
      );

      if (activeVars.length === 0) continue;

      if (round === 0) {
        // Priority ordering: most constrained peripherals first
        sortByPortPriority(activeVars, portPriority);
      } else {
        // Deterministic domain diversification + MRV sort
        activeVars = activeVars.map(iv => {
          const diversified = diversifyDomain(iv.domain, round, round * 54321 + comboIdx * 11);
          // D4: Coverage bias only after deterministic rounds exhausted
          const coverage = instanceCoverage.get(varKey(iv));
          if (coverage && coverage.size > 0 && round > iv.domain.length + 1) {
            diversified.sort((a, b) => {
              const covA = coverage.has(iv.instanceCandidates[a]) ? 1 : 0;
              const covB = coverage.has(iv.instanceCandidates[b]) ? 1 : 0;
              return covA - covB;
            });
          }
          return { ...iv, domain: diversified };
        });
        activeVars.sort((a, b) => a.domain.length - b.domain.length);
      }

      const lastVarOfConfig = new Map<string, number>();
      for (let i = 0; i < activeVars.length; i++) {
        const key = `${activeVars[i].portName}\0${activeVars[i].configName}`;
        lastVarOfConfig.set(key, i);
      }

      const tracker: InstanceTracker = {
        instanceOwner: new Map(),
        instanceRefCount: new Map(),
        sharedPatterns,
      };

      const remaining = config.maxGroups - discoveredGroups.length;
      const limit = Math.min(maxGroupsPerCombo, remaining);

      const comboGroups: InstanceGroup[] = [];
      solvePhase1(
        activeVars, 0, tracker, [],
        ports, comboGroups, limit,
        startTime, config.timeoutMs,
        lastVarOfConfig, configRequiresMap,
        dmaData
      );

      let comboNewCount = 0;
      for (const g of comboGroups) {
        if (discoveredGroups.length >= config.maxGroups) break;
        const fp = groupFingerprint(g.assignments);
        if (!groupFingerprints.has(fp)) {
          groupFingerprints.add(fp);
          discoveredGroups.push(g);
          comboNewCount++;
        }
      }
      groupsPerCombo.set(comboIdx, (groupsPerCombo.get(comboIdx) ?? 0) + comboNewCount);
    }

    // D4: Update instance coverage from newly discovered groups
    const newGroupCount = discoveredGroups.length - groupsBefore;
    for (let gi = groupsBefore; gi < discoveredGroups.length; gi++) {
      for (const [vk, inst] of discoveredGroups[gi].assignments) {
        if (!instanceCoverage.has(vk)) instanceCoverage.set(vk, new Set());
        instanceCoverage.get(vk)!.add(inst);
      }
    }

    // Adaptive termination: stop after consecutive stale rounds
    if (newGroupCount === 0) {
      staleRounds++;
      if (staleRounds >= STALE_ROUNDS_LIMIT) break;
    } else {
      staleRounds = 0;
    }
    if (round === 0 && discoveredGroups.length >= config.maxGroups) break;
  }

  if (discoveredGroups.length === 0) {
    errors.push({ type: 'error', message: 'Phase 1: No valid peripheral instance assignments found' });
    return {
      mcuRef: mcu.refName, solutions: [], errors,
      statistics: { totalCombinations: configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: configCombinations.length },
    };
  }

  // ========== Phase 2a: Pin Assignment on Discovered Groups ==========
  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  const solutions: Solution[] = [];

  const phase2Sort = (vars: typeof allVariables) => {
    const p2Priority = computePortPriority(vars);
    sortByPortPriority(vars, p2Priority);
  };

  const domainCache = new Map<string, number[]>();
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2ForGroup(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData, domainCache, mcu, config.costWeights, seed, pinUsage
    );

  const orderedDiscovered = orderByDiversity(discoveredGroups);
  // Track per-group feasibility for D10 feedback
  const discoveredSolutionCount = new Map<InstanceGroup, number>();
  {
    const discoveredSolutions = runPhase2Diverse(orderedDiscovered, (group, maxSol, seed, pinUsage) => {
      const sols = solveGroup(group, maxSol, seed, pinUsage);
      discoveredSolutionCount.set(group, (discoveredSolutionCount.get(group) ?? 0) + sols.length);
      return sols;
    }, {
      maxSolutionsPerGroup: config.maxSolutionsPerGroup,
      solutionsPerRound,
      timeoutMs: config.timeoutMs,
      startTime,
    });
    solutions.push(...discoveredSolutions);
  }

  // ========== Phase 1.5: Instance Permutation (D10: skip failed groups) ==========
  const permutedGroups: InstanceGroup[] = [];
  if (performance.now() - startTime < config.timeoutMs) {
    const permRng = mulberry32(42);

    for (const group of discoveredGroups) {
      if (performance.now() - startTime > config.timeoutMs) break;
      if (permutedGroups.length >= MAX_PERMUTED_GROUPS) break;

      // D10: Skip permutations of groups that produced 0 Phase 2 solutions
      if ((discoveredSolutionCount.get(group) ?? 0) === 0) continue;

      const newGroups = generatePermutedGroups(
        group, allInstanceVars, groupFingerprints,
        MAX_PERMS_PER_GROUP, permRng
      );

      for (const g of newGroups) {
        if (permutedGroups.length >= MAX_PERMUTED_GROUPS) break;
        permutedGroups.push(g);
      }
    }

    // ========== Phase 2b: Pin Assignment on Permuted Groups ==========
    if (permutedGroups.length > 0) {
      const orderedPermuted = orderByDiversity(permutedGroups);
      solutions.push(...runPhase2Diverse(orderedPermuted, solveGroup, {
        maxSolutionsPerGroup: config.maxSolutionsPerGroup,
        solutionsPerRound,
        timeoutMs: config.timeoutMs,
        startTime,
      }));
    }
  }

  if (solutions.length === 0 && discoveredGroups.length > 0) {
    errors.push({
      type: 'warning',
      message: `Phase 1 found ${discoveredGroups.length} groups (+${permutedGroups.length} permuted) but Phase 2 found no valid pin assignments`,
    });
  }

  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);

  return finalizeSolutions(
    solutions, mcu, config.costWeights, errors, stats,
    startTime, gpioCountPerConfig, reserved.pins, pinnedAssignments,
  );
}
