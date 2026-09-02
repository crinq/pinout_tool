// ============================================================
// Priority Backtracking Solver
//
// Standard backtracking CSP solver but with port-priority
// variable ordering: peripherals with fewer available pins
// are assigned first, ensuring constrained peripherals get
// the best pin choices.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import {
  prepareSolverContext, solveBacktrack, pushDeepestConflictError,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  type SolverConfig,
} from './solver';
import { computePortPriority, sortByPortPriority } from './port-priority';

export function solvePriorityBacktracking(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = mergeSolverConfig(config);

  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, cfg.skipGpioMapping);
  if (!ctx) {
    return emptyResult(mcu.refName, errors);
  }

  // Re-sort by port priority instead of pure MRV
  const priority = computePortPriority(ctx.variables);
  sortByPortPriority(ctx.variables, priority);

  // Recompute lastVarOfConfig since indices changed after re-sort
  ctx.lastVarOfConfig.clear();
  for (let i = 0; i < ctx.variables.length; i++) {
    const key = `${ctx.variables[i].portName}\0${ctx.variables[i].configName}`;
    ctx.lastVarOfConfig.set(key, i);
  }

  const solutions: Solution[] = [];

  solveBacktrack(
    ctx.variables, 0, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats, ctx.deepest,
    ctx.lastVarOfConfig, ctx.configRequiresMap,
    ctx.dmaData, undefined, undefined, ctx.mcuInfo
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);

  if (solutions.length === 0) pushDeepestConflictError(errors, ctx.deepest, ctx.variables);

  return finalizeSolutions(solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime, ctx.gpioVarsPerConfig, ctx.reservedPins, ctx.pinnedAssignments);
}
