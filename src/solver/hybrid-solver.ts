// ============================================================
// Hybrid Solver
//
// Combines single-phase and two-phase solving:
// 1. Runs priority-backtracking to quickly find solutions
// 2. Extracts instance groups from those solutions
// 3. Generates permuted groups via instance swapping
// 4. Runs Phase 2 (pin-level) on all groups with diversity
//
// This is effective when Phase 1 fails to find the right
// instance combinations but single-phase solvers succeed.
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, SolverStats } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
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
  buildInstanceVariables, solvePhase2ForGroup,
  groupFingerprint, varKey, sortInstanceDomainsByCost,
  type InstanceGroup, type InstanceVariable,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority } from './port-priority';
import { solvePriorityBacktracking } from './priority-backtracking-solver';
import { generatePermutedGroups } from './group-permutation';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';
import { mulberry32 } from './solver-utils';

// ============================================================
// Instance Group Extraction from Solutions
// ============================================================

/**
 * Extract instance groups from single-phase solutions by reverse-mapping
 * pin assignments back to peripheral instance assignments.
 */
function extractInstanceGroupsFromSolutions(
  solutions: Solution[],
  allInstanceVars: InstanceVariable[],
): InstanceGroup[] {
  // Build lookup: portName\0configName\0channelName → InstanceVariable[]
  const varsByChannel = new Map<string, InstanceVariable[]>();
  for (const iv of allInstanceVars) {
    const key = `${iv.portName}\0${iv.configName}\0${iv.channelName}`;
    if (!varsByChannel.has(key)) varsByChannel.set(key, []);
    varsByChannel.get(key)!.push(iv);
  }

  const fingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];

  for (const sol of solutions) {
    // For each config combination assignment in the solution
    for (const cca of sol.configAssignments) {
      const assignments = new Map<string, string>();

      for (const a of cca.assignments) {
        // Extract peripheral instance from signal name (e.g. "SPI1_MOSI" → "SPI1")
        const match = a.signalName.match(/^([A-Z]+\d*)/);
        if (!match) continue;
        const instance = match[1];

        // Find matching instance variables
        const configName = a.configurationName;
        const channelKey = `${a.portName}\0${configName}\0${a.channelName}`;
        const matchingVars = varsByChannel.get(channelKey);
        if (!matchingVars) continue;

        for (const iv of matchingVars) {
          // Verify this instance is in the variable's domain
          if (iv.instanceCandidates.includes(instance)) {
            assignments.set(varKey(iv), instance);
          }
        }
      }

      if (assignments.size === 0) continue;

      const fp = groupFingerprint(assignments);
      if (!fingerprints.has(fp)) {
        fingerprints.add(fp);
        groups.push({ assignments });
      }
    }
  }

  return groups;
}

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

const MAX_PERMUTED_GROUPS = 200;
const MAX_PERMS_PER_GROUP = 50;

export function solveHybrid(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];

  // ========== Setup (same as other two-phase solvers) ==========
  const { ast: expandedAst, errors: macroErrors } = expandAllMacros(ast, getStdlibMacros());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) reservedPinSet.add(pa.pinName);
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

  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

  // ========== Phase A: Run priority-backtracking (30% time budget) ==========
  const phase1TimeoutMs = Math.floor(config.timeoutMs * 0.3);
  const pbResult = solvePriorityBacktracking(ast, mcu, {
    maxSolutions: 500,
    timeoutMs: phase1TimeoutMs,
    costWeights: config.costWeights,
    skipGpioMapping: config.skipGpioMapping,
  });

  // ========== Phase B: Extract instance groups from solutions ==========
  const sourceGroups = extractInstanceGroupsFromSolutions(pbResult.solutions, allInstanceVars);

  if (sourceGroups.length === 0) {
    // Fallback: return priority-backtracking results directly
    errors.push({ type: 'warning', message: 'Hybrid: No instance groups extracted from single-phase solutions' });
    const stats: SolverStats = {
      totalCombinations: configCombinations.length,
      evaluatedCombinations: 0,
      validSolutions: pbResult.solutions.length,
      solveTimeMs: performance.now() - startTime,
      configCombinations: configCombinations.length,
    };
    return { mcuRef: mcu.refName, solutions: pbResult.solutions, errors, statistics: stats };
  }

  // ========== Phase C: Generate permuted groups ==========
  const fingerprints = new Set<string>();
  for (const g of sourceGroups) {
    fingerprints.add(groupFingerprint(g.assignments));
  }

  const permRng = mulberry32(42);
  const permutedGroups: InstanceGroup[] = [];
  for (const sg of sourceGroups) {
    if (permutedGroups.length >= MAX_PERMUTED_GROUPS) break;
    const newGroups = generatePermutedGroups(
      sg, allInstanceVars, fingerprints,
      MAX_PERMS_PER_GROUP, permRng
    );
    for (const g of newGroups) {
      if (permutedGroups.length >= MAX_PERMUTED_GROUPS) break;
      permutedGroups.push(g);
    }
  }

  const allGroups = [...sourceGroups, ...permutedGroups];
  const orderedGroups = orderByDiversity(allGroups);

  // ========== Phase D: Run Phase 2 with diversity ==========
  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

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

  const solutions = runPhase2Diverse(orderedGroups, solveGroup, {
    maxSolutionsPerGroup: config.maxSolutionsPerGroup,
    solutionsPerRound,
    timeoutMs: config.timeoutMs,
    startTime,
  });

  if (solutions.length === 0) {
    errors.push({
      type: 'warning',
      message: `Hybrid: Extracted ${sourceGroups.length} groups (+${permutedGroups.length} permuted) from ${pbResult.solutions.length} single-phase solutions but Phase 2 found no valid pin assignments`,
    });
  }

  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);

  stats.validSolutions = solutions.length;
  return finalizeSolutions(
    solutions, mcu, config.costWeights, errors, stats,
    startTime, gpioCountPerConfig, reserved.pins, pinnedAssignments,
  );
}
