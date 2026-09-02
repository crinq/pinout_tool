// ============================================================
// Diverse Instances Solver
//
// Enhances the two-phase solver's Phase 1 to find more diverse
// peripheral instance groups by running multiple rounds with
// shuffled instance candidate orderings.
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import {
  prepareSolverContext,
  emptyResult, pushSolverWarnings, finalizeSolutions,
   isGpioVariable,
   } from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  costGuidedPhase2Sort,
  PHASE2_GROUP_STEP_BUDGET,
  buildInstanceVariables, solvePhase1, solvePhase2ForGroup,
  groupFingerprint, sortInstanceDomainsByCost, orderByConfigBlock,
  type InstanceGroup, type InstanceTracker,
} from './two-phase-solver';
import { checkGroupPinFeasibility } from './matching-oracle';
import { diversifyDomain } from './solver-utils';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';

const MAX_DIVERSITY_ROUNDS = 25;

export function solveDiverseInstances(
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

  // Build instance variables from non-GPIO solver variables only.
  // GPIO variables don't have meaningful peripheral instances for Phase 1.
  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);

  // C3: Sort instance domains by ascending average pin cost
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

  // ========== Phase 1: Multi-round diverse instance assignment ==========
  // Only accept instance groups that can actually be pin-routed (sound: the
  // oracle never rejects a routable group) so Phase 2 is not fed dead ends.
  const phase1Deadline = startTime + config.timeoutMs;
  const acceptGroup = (assignments: Map<string, string>): boolean =>
    checkGroupPinFeasibility(solveVars, configCombinations, { assignments }, { deadline: phase1Deadline }).feasible;

  const groupFingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];

  /** Collect groups up to `groupCap`; re-runnable with a wider cap. */
  const collectGroups = (groupCap: number): void => {
  const maxGroupsPerCombo = Math.max(1, Math.ceil(groupCap / configCombinations.length));

  for (let round = 0; round < MAX_DIVERSITY_ROUNDS; round++) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (groups.length >= groupCap) break;

    for (const combo of configCombinations) {
      if (performance.now() - startTime > config.timeoutMs) break;
      if (groups.length >= groupCap) break;

      // Filter to active variables
      let activeVars = allInstanceVars.filter(iv =>
        combo.get(iv.portName) === iv.configName
      );

      if (activeVars.length === 0) continue;

      // For round > 0, diversify each variable's instance domain
      if (round > 0) {
        const comboIdx = configCombinations.indexOf(combo);
        activeVars = activeVars.map(iv => ({
          ...iv,
          domain: diversifyDomain(iv.domain, round, round * 54321 + comboIdx * 11),
        }));
      }

      // Keep each (port, config) contiguous so its requires prune early
      // (see orderByConfigBlock).
      orderByConfigBlock(activeVars);

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

      const remaining = groupCap - groups.length;
      const limit = Math.min(maxGroupsPerCombo, remaining);

      const comboGroups: InstanceGroup[] = [];
      solvePhase1(
        activeVars, 0, tracker, [],
        ports, comboGroups, limit,
        startTime, config.timeoutMs,
        lastVarOfConfig, configRequiresMap, dmaData, undefined,
        acceptGroup
      );

      for (const g of comboGroups) {
        if (groups.length >= groupCap) break;
        const fp = groupFingerprint(g.assignments);
        if (!groupFingerprints.has(fp)) {
          groupFingerprints.add(fp);
          groups.push(g);
        }
      }
    }

    // If round 0 already found enough groups, stop
    if (round === 0 && groups.length >= groupCap) break;
  }
  };
  collectGroups(config.maxGroups);

  if (groups.length === 0) {
    errors.push({ type: 'error', message: 'Phase 1: No valid peripheral instance assignments found' });
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }

  // ========== Phase 2: Pin assignment per group ==========
  const stats = ctx.stats;

  const solutions: Solution[] = [];

  // C1: Cost-guided variable ordering for Phase 2
  const costWeights = config.costWeights;
  const phase2Sort = (vars: typeof solveVars): void => costGuidedPhase2Sort(vars, costWeights);

  const domainCache = new Map<string, number[]>();
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2ForGroup(
      group, solveVars, ports, reservedPins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData, domainCache, mcu, costWeights, seed, pinUsage,
      { steps: PHASE2_GROUP_STEP_BUDGET }
    );
  const runPhase2 = (gs: InstanceGroup[]): Solution[] => runPhase2Diverse(gs, solveGroup, {
    maxSolutionsPerGroup: config.maxSolutionsPerGroup,
    solutionsPerRound,
    timeoutMs: config.timeoutMs,
    startTime,
  });
  solutions.push(...runPhase2(groups));

  // Phase 2 can exhaust a small group set in milliseconds; widen Phase 1 and
  // retry rather than give up with most of the timeout unspent.
  const MAX_GROUP_CAP = 20000;
  let cap = config.maxGroups;
  while (
    solutions.length === 0 &&
    groups.length >= cap &&
    cap < MAX_GROUP_CAP &&
    performance.now() - startTime < config.timeoutMs * 0.9
  ) {
    cap = Math.min(cap * 4, MAX_GROUP_CAP);
    const before = groups.length;
    collectGroups(cap);
    if (groups.length === before) break; // Phase 1 has nothing more to give
    solutions.push(...runPhase2(groups));
  }

  if (solutions.length === 0 && groups.length > 0) {
    errors.push({
      type: 'warning',
      message: `Phase 1 found ${groups.length} instance groups but Phase 2 found no valid pin assignments`,
    });
  }

  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);

  return finalizeSolutions(solutions, mcu, config.costWeights, errors, stats, startTime, gpioVarsPerConfig, reservedPins, pinnedAssignments);
}
