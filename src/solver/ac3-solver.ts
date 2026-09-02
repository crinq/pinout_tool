// ============================================================
// AC3 Solver
//
// Backtracking with forward-checking propagation (arc-consistency
// lite). solveBacktrack already supports the full propagation context
// (pin/instance exclusivity + F2 same_instance, shared wipeout check),
// so this solver is just that engine with propagation enabled — the
// standalone re-implementation it used to carry was a line-for-line
// copy that kept drifting behind on fixes.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import {
  prepareSolverContext, solveBacktrack, buildPropagationContext,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  type SolverConfig,
} from './solver';

export function solveAC3(
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

  const solutions: Solution[] = [];
  const propagationCtx = buildPropagationContext(ctx.variables, ctx.sharedPatterns, ctx.configRequiresMap);

  solveBacktrack(
    ctx.variables, 0, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats, ctx.deepest,
    ctx.lastVarOfConfig, ctx.configRequiresMap,
    ctx.dmaData, propagationCtx, undefined, ctx.mcuInfo,
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);
  return finalizeSolutions(solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime, ctx.gpioVarsPerConfig, ctx.reservedPins, ctx.pinnedAssignments);
}
