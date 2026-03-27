// ============================================================
// MRV Group Solver
//
// Combines the priority-group solver's diverse instance
// discovery (Phase 1 + Phase 1.5) with the dynamic MRV
// solver's forward-checking backtracker for pin assignment.
//
// - Phase 1: Multi-round instance group discovery
// - Phase 1.5: Instance permutation for group diversity
// - Phase 2: Dynamic MRV backtracking with forward checking
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, SolverStats, DmaData } from '../types';
import type { ProgramNode, RequireNode, PatternPart } from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import {
  extractPorts, resolveReservePatterns, extractPinnedAssignments,
  extractSharedPatterns, resolveAllVariables,
  generateConfigCombinations, validateConstraints,
  emptyResult, pushSolverWarnings, finalizeSolutions,
  createPinTracker,
  partitionGpioVariables, isGpioVariable,
  configsHaveDma, buildPinLookups,
  type SolverVariable, type PinnedAssignment, type PortSpec,
} from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  buildInstanceVariables, solvePhase1,
  groupFingerprint, varKey,
  type InstanceGroup, type InstanceTracker,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority, type PriorityFn } from './port-priority';
import { solveBacktrackDynamic } from './dynamic-mrv-solver';
import { mulberry32, shuffleArray, diversifyDomain } from './solver-utils';
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
  // minDist[i] = minimum distance from group i to any already-selected group
  const minDist = new Float64Array(n).fill(Infinity);

  for (let iter = 1; iter < n; iter++) {
    const last = selected[selected.length - 1];
    let bestIdx = -1;
    let bestDist = -1;

    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      // Hamming distance: count differing instance assignments
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
// Phase 2: Dynamic MRV per Group
// ============================================================

function solvePhase2MRV(
  group: InstanceGroup,
  allVariables: SolverVariable[],
  ports: Map<string, PortSpec>,
  reservedPins: string[],
  pinnedAssignments: PinnedAssignment[],
  sharedPatterns: PatternPart[],
  configCombinations: Map<string, string>[],
  maxSolutions: number,
  startTime: number,
  timeoutMs: number,
  stats: SolverStats,
  dmaData?: DmaData,
  shuffleSeed?: number,
  pinUsageCount?: Map<string, number>,
): Solution[] {
  // Filter each variable's domain to only candidates matching the group's instance
  const filteredVars: SolverVariable[] = allVariables.map(sv => {
    const key = `${sv.portName}\0${sv.configName}\0${sv.channelName}\0${sv.exprIndex}`;
    const requiredInstance = group.assignments.get(key);

    if (!requiredInstance) {
      return { ...sv, domain: [...sv.domain] };
    }

    const filteredDomain = sv.domain.filter(idx => {
      return sv.candidates[idx].peripheralInstance === requiredInstance;
    });

    return { ...sv, domain: filteredDomain };
  });

  // Skip groups where filtering eliminated all candidates for some variable
  // that belongs to at least one active config
  const emptyVar = filteredVars.find(v => v.domain.length === 0);
  if (emptyVar) return [];

  // D6: Randomized candidate ordering within each variable's domain
  if (shuffleSeed && shuffleSeed > 0) {
    const rng = mulberry32(shuffleSeed);
    for (const v of filteredVars) {
      v.domain = shuffleArray(v.domain, rng);
    }
  }

  // D9: Anti-correlated pin sampling — prefer less-used pins
  if (pinUsageCount && pinUsageCount.size > 0) {
    for (const v of filteredVars) {
      v.domain.sort((a, b) =>
        (pinUsageCount.get(v.candidates[a].pin.name) ?? 0) -
        (pinUsageCount.get(v.candidates[b].pin.name) ?? 0));
    }
  }

  const n = filteredVars.length;

  // Build mutable domains
  const domains: number[][] = filteredVars.map(v => [...v.domain]);
  const assigned = new Array<boolean>(n).fill(false);

  // Build config var indices for eager constraint checking
  const configVarIndices = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${filteredVars[i].portName}\0${filteredVars[i].configName}`;
    if (!configVarIndices.has(key)) configVarIndices.set(key, []);
    configVarIndices.get(key)!.push(i);
  }

  // Build config requires map
  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const config of port.configs) {
      if (config.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${config.name}`, config.requires);
      }
    }
  }

  const { pinToVarCandidates, instanceToVarCandidates } = buildPinLookups(filteredVars);

  const tracker = createPinTracker(reservedPins, sharedPatterns);
  const solutions: Solution[] = [];

  solveBacktrackDynamic(
    filteredVars, assigned, domains, tracker, [],
    configCombinations, ports, pinnedAssignments,
    solutions, maxSolutions, startTime, timeoutMs, stats,
    configRequiresMap, configVarIndices, 0, n,
    pinToVarCandidates, instanceToVarCandidates, sharedPatterns,
    dmaData
  );

  return solutions;
}

// ============================================================
// Main solver
// ============================================================

export function solveMrvGroup(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig,
  computePriority: PriorityFn = computePortPriority
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

  const portPriority = computePriority(solveVars);
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

  // D4: Instance coverage tracking - which instances have been seen per variable
  const instanceCoverage = new Map<string, Set<string>>();
  // D2: Track groups discovered per combo index for fair scheduling
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
        sortByPortPriority(activeVars, portPriority);
      } else {
        // Deterministic domain diversification
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
      // D2: Track per-combo discovery count
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

  // ========== Phase 2a: MRV Pin Assignment on Discovered Groups ==========
  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  const solutions: Solution[] = [];
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2MRV(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      dmaData, seed, pinUsage
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

    // ========== Phase 2b: MRV Pin Assignment on Permuted Groups ==========
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
