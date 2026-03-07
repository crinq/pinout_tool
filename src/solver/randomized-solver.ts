// ============================================================
// Randomized Restarts Solver
//
// Runs the backtracking solver N times with differently shuffled
// candidate orderings. Each restart explores a different part of
// the design space, improving solution diversity.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import { computeTotalCost } from './cost-functions';
import {
  prepareSolverContext, solveBacktrack, deduplicateSolutions,
  validateGpioAvailability,
  createPinTracker,
  type SolverVariable,
} from './solver';

export interface RandomizedConfig {
  numRestarts: number;
  maxSolutions: number;
  timeoutMs: number;
  costWeights: Map<string, number>;
  skipGpioMapping?: boolean;
}

import { mulberry32, shuffleArray } from './solver-utils';

export function solveRandomizedRestarts(
  ast: ProgramNode,
  mcu: Mcu,
  config: RandomizedConfig
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

  const allSolutions: Solution[] = [];
  const perRestart = Math.max(1, Math.ceil(config.maxSolutions / config.numRestarts));

  const stats: SolverStats = {
    totalCombinations: ctx.configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: ctx.configCombinations.length,
  };

  for (let r = 0; r < config.numRestarts; r++) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (allSolutions.length >= config.maxSolutions) break;

    const rng = mulberry32(r * 12345 + 67890);

    // Shuffle each variable's domain
    const shuffled: SolverVariable[] = ctx.variables.map(v => ({
      ...v,
      domain: shuffleArray([...v.domain], rng),
    }));

    // Re-sort by MRV (preserves MRV heuristic, shuffled order breaks ties)
    shuffled.sort((a, b) => a.domain.length - b.domain.length);

    // Rebuild lastVarOfConfig for the new variable order
    const lastVarOfConfig = new Map<string, number>();
    for (let i = 0; i < shuffled.length; i++) {
      const key = `${shuffled[i].portName}\0${shuffled[i].configName}`;
      lastVarOfConfig.set(key, i);
    }

    const remaining = config.maxSolutions - allSolutions.length;
    const limit = Math.min(perRestart, remaining);

    const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns);
    const restartSolutions: Solution[] = [];
    const deepest = { depth: -1, assignments: [] as import('./solver').VariableAssignment[] };

    solveBacktrack(
      shuffled, 0, tracker, [],
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
