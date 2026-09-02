// ============================================================
// Priority Two-Phase Solver
//
// Two-phase solver with port-priority variable ordering:
// peripherals with fewer available pins are assigned first
// in both Phase 1 (instance assignment) and Phase 2 (pin assignment).
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import {
  prepareSolverContext, emptyResult, pushSolverWarnings, finalizeSolutions,
  isGpioVariable, type SolverVariable,
} from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  priorityPhase2Sort,
  PHASE2_GROUP_STEP_BUDGET,
  buildInstanceVariables, solvePhase1, solvePhase2ForGroup,
  groupFingerprint, sortInstanceDomainsByCost,
  type InstanceGroup, type InstanceTracker,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority } from './port-priority';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';

export function solvePriorityTwoPhase(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, config.skipGpioMapping);
  if (!ctx) return emptyResult(mcu.refName, errors, 0, startTime);
  const { ports, pinnedAssignments, sharedPatterns, configCombinations, dmaData, gpioVarsPerConfig, configRequiresMap } = ctx;
  const reservedPins = ctx.reservedPins;
  const solveVars = ctx.variables;

  // Compute port priority from solver variables (pin counts per port)
  const portPriority = computePortPriority(solveVars);

  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);

  // C3: Sort instance domains by ascending average pin cost
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

  // ========== Phase 1: Instance Assignment per Config Combination ==========
  const groupFingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];
  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));

  for (const combo of configCombinations) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (groups.length >= config.maxGroups) break;

    const activeVars = allInstanceVars.filter(iv =>
      combo.get(iv.portName) === iv.configName
    );

    if (activeVars.length === 0) continue;

    // Sort by port priority (most constrained first), then MRV tiebreaker
    sortByPortPriority(activeVars, portPriority);

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

    const comboGroups: InstanceGroup[] = [];
    solvePhase1(
      activeVars, 0, tracker, [],
      ports, comboGroups, maxGroupsPerCombo,
      startTime, config.timeoutMs,
      lastVarOfConfig, configRequiresMap,
      dmaData
    );

    for (const g of comboGroups) {
      if (groups.length >= config.maxGroups) break;
      const fp = groupFingerprint(g.assignments);
      if (!groupFingerprints.has(fp)) {
        groupFingerprints.add(fp);
        groups.push(g);
      }
    }
  }

  if (groups.length === 0) {
    errors.push({ type: 'error', message: 'Phase 1: No valid peripheral instance assignments found' });
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }

  // ========== Phase 2: Pin assignment per group ==========
  const stats = ctx.stats;

  const solutions: Solution[] = [];

  // Phase-2 sort: port priority with MRV + cost tiebreaker (C1)
  const phase2Sort = (vars: SolverVariable[]): void => priorityPhase2Sort(vars, config.costWeights);

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
  solutions.push(...runPhase2Diverse(groups, solveGroup, {
    maxSolutionsPerGroup: config.maxSolutionsPerGroup,
    solutionsPerRound,
    timeoutMs: config.timeoutMs,
    startTime,
  }));

  if (solutions.length === 0 && groups.length > 0) {
    errors.push({
      type: 'warning',
      message: `Phase 1 found ${groups.length} instance groups but Phase 2 found no valid pin assignments`,
    });
  }

  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);

  return finalizeSolutions(solutions, mcu, config.costWeights, errors, stats, startTime, gpioVarsPerConfig, reservedPins, pinnedAssignments);
}
