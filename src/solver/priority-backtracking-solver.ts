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
  prepareSolverContext, solveBacktrack,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  type SolverConfig, type VariableAssignment,
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
    ctx.dmaData
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);

  if (solutions.length === 0 && ctx.deepest.depth >= 0) {
    const failingVar = ctx.deepest.depth + 1 < ctx.variables.length ? ctx.variables[ctx.deepest.depth + 1] : null;
    const partialAssignments = ctx.deepest.assignments.map((va: VariableAssignment) => ({
      pinName: va.candidate.pin.name,
      signalName: va.candidate.signalName,
      portName: va.variable.portName,
      channelName: va.variable.channelName,
      configurationName: va.variable.configName,
    }));

    if (failingVar) {
      errors.push({
        type: 'error',
        message: `Could not assign ${failingVar.portName}.${failingVar.channelName} (config "${failingVar.configName}") - ${failingVar.candidates.length} candidates all conflict`,
        source: `${failingVar.portName}.${failingVar.channelName}`,
        partialSolution: partialAssignments,
      });
    } else {
      errors.push({
        type: 'error',
        message: 'All pin assignments found but require constraints failed for all config combinations',
        partialSolution: partialAssignments,
      });
    }
  }

  return finalizeSolutions(solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime, ctx.gpioCountPerConfig, ctx.reservedPins, ctx.pinnedAssignments);
}
