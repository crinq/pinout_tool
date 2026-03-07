// ============================================================
// Priority Diverse Solver
//
// Hybrid strategy combining fast priority-based initial solving
// with diverse randomized restarts:
// - Round 0: port-priority ordering for fast initial solutions
// - Remaining rounds: MRV ordering with shuffled domains for
//   group diversity (explores different peripheral instances)
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import { computeTotalCost } from './cost-functions';
import {
  prepareSolverContext, solveBacktrack, deduplicateSolutions,
  validateGpioAvailability,
  createPinTracker,
  type SolverVariable, type VariableAssignment,
} from './solver';
import { computePortPriority, sortByPortPriority } from './port-priority';

export interface PriorityDiverseConfig {
  numRestarts: number;
  maxSolutions: number;
  timeoutMs: number;
  costWeights: Map<string, number>;
  skipGpioMapping?: boolean;
}

import { mulberry32, shuffleArray } from './solver-utils';

export function solvePriorityDiverse(
  ast: ProgramNode,
  mcu: Mcu,
  config: PriorityDiverseConfig
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, config.skipGpioMapping);
  if (!ctx) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: errors.length > 0 ? errors : [{ type: 'warning', message: 'No variables to solve' }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
    };
  }

  const portPriority = computePortPriority(ctx.variables);

  const allSolutions: Solution[] = [];

  // Give round 0 (priority) half the budget, remaining rounds share the rest
  const round0Budget = Math.ceil(config.maxSolutions / 2);
  const diverseRounds = Math.max(1, config.numRestarts - 1);
  const perDiverseRound = Math.max(1, Math.ceil((config.maxSolutions - round0Budget) / diverseRounds));

  const stats: SolverStats = {
    totalCombinations: ctx.configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: ctx.configCombinations.length,
  };

  // ========== Round 0: Priority ordering (fast initial solve) ==========
  {
    const vars: SolverVariable[] = ctx.variables.map(v => ({ ...v, domain: [...v.domain] }));
    sortByPortPriority(vars, portPriority);

    const lastVarOfConfig = new Map<string, number>();
    for (let i = 0; i < vars.length; i++) {
      const key = `${vars[i].portName}\0${vars[i].configName}`;
      lastVarOfConfig.set(key, i);
    }

    const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns);
    const restartSolutions: Solution[] = [];
    const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

    solveBacktrack(
      vars, 0, tracker, [],
      ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
      restartSolutions, round0Budget, startTime, config.timeoutMs, stats, deepest,
      lastVarOfConfig, ctx.configRequiresMap,
      ctx.dmaData
    );

    allSolutions.push(...restartSolutions);
  }

  // ========== Rounds 1-N: MRV ordering with shuffled domains (diversity) ==========
  for (let r = 1; r <= diverseRounds; r++) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (allSolutions.length >= config.maxSolutions) break;

    const rng = mulberry32(r * 12345 + 67890);

    // Shuffle each variable's candidate domain
    const vars: SolverVariable[] = ctx.variables.map(v => ({
      ...v,
      domain: shuffleArray([...v.domain], rng),
    }));

    // MRV sort (standard) - shuffled domains break ties differently each round
    vars.sort((a, b) => a.domain.length - b.domain.length);

    const lastVarOfConfig = new Map<string, number>();
    for (let i = 0; i < vars.length; i++) {
      const key = `${vars[i].portName}\0${vars[i].configName}`;
      lastVarOfConfig.set(key, i);
    }

    const remaining = config.maxSolutions - allSolutions.length;
    const limit = Math.min(perDiverseRound, remaining);

    const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns);
    const restartSolutions: Solution[] = [];
    const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

    solveBacktrack(
      vars, 0, tracker, [],
      ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
      restartSolutions, limit, startTime, config.timeoutMs, stats, deepest,
      lastVarOfConfig, ctx.configRequiresMap,
      ctx.dmaData
    );

    allSolutions.push(...restartSolutions);
  }

  if (allSolutions.length >= config.maxSolutions) {
    errors.push({ type: 'warning', message: `Maximum solutions (${config.maxSolutions}) reached.` });
  }
  if (performance.now() - startTime > config.timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${allSolutions.length} solutions.` });
  }

  if (allSolutions.length === 0 && ctx.deepest.depth >= 0) {
    const failingVar = ctx.deepest.depth + 1 < ctx.variables.length ? ctx.variables[ctx.deepest.depth + 1] : null;
    if (failingVar) {
      errors.push({
        type: 'error',
        message: `Could not assign ${failingVar.portName}.${failingVar.channelName} (config "${failingVar.configName}") - ${failingVar.candidates.length} candidates all conflict`,
        source: `${failingVar.portName}.${failingVar.channelName}`,
      });
    }
  }

  for (const sol of allSolutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, config.costWeights);
  }

  allSolutions.sort((a, b) => a.totalCost - b.totalCost);
  allSolutions.forEach((s, i) => s.id = i);
  stats.solveTimeMs = performance.now() - startTime;
  stats.validSolutions = allSolutions.length;

  const deduped = deduplicateSolutions(allSolutions);
  const filtered = validateGpioAvailability(deduped, ctx.gpioCountPerConfig, mcu, ctx.reservedPins, ctx.pinnedAssignments);
  return { mcuRef: mcu.refName, solutions: filtered, errors, statistics: stats };
}
