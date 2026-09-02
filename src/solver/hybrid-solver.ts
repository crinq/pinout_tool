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
import {
  type SolverVariable,
  prepareSolverContext,
  emptyResult, pushSolverWarnings, finalizeSolutions,
   isGpioVariable,
   } from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  PHASE2_GROUP_STEP_BUDGET,
  buildInstanceVariables, solvePhase2ForGroup,
  groupFingerprint, varKey, sortInstanceDomainsByCost,
  type InstanceGroup, type InstanceVariable,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority } from './port-priority';
import { solvePriorityBacktracking } from './priority-backtracking-solver';
import { generatePermutedGroups } from './group-permutation';
import { runPhase2Diverse, type GroupSolverFn, orderByDiversity } from './phase2-diversity';
import { mulberry32 } from './solver-utils';

// ============================================================
// Instance Group Extraction from Solutions
// ============================================================

/**
 * Extract instance groups from single-phase solutions by reverse-mapping
 * pin assignments back to peripheral instance assignments.
 */
export function extractInstanceGroupsFromSolutions(
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
        // Extract peripheral instance from signal name (e.g. "SPI1_MOSI" →
        // "SPI1"). Split at the first underscore — a prefix regex truncates
        // I2C1 to "I2" and the instance never matches instanceCandidates.
        const us = a.signalName.indexOf('_');
        const instance = us === -1 ? a.signalName : a.signalName.substring(0, us);
        if (!instance) continue;

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
  const ctx = prepareSolverContext(ast, mcu, errors, config.skipGpioMapping);
  if (!ctx) return emptyResult(mcu.refName, errors, 0, startTime);
  const { ports, pinnedAssignments, sharedPatterns, configCombinations, dmaData, gpioVarsPerConfig } = ctx;
  const reservedPins = ctx.reservedPins;
  const solveVars = ctx.variables;

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
  const stats = ctx.stats;

  const phase2Sort = (vars: SolverVariable[]) => {
    const p2Priority = computePortPriority(vars);
    sortByPortPriority(vars, p2Priority);
  };

  const domainCache = new Map<string, number[]>();
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));

  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2ForGroup(
      group, solveVars, ports, reservedPins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData, domainCache, mcu, config.costWeights, seed, pinUsage,
      { steps: PHASE2_GROUP_STEP_BUDGET }
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
    startTime, gpioVarsPerConfig, reservedPins, pinnedAssignments,
  );
}
