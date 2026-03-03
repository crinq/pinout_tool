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
import { computeTotalCost } from './cost-functions';
import {
  prepareSolverContext, solveBacktrack, deduplicateSolutions,
  validateGpioAvailability,
  type SolverConfig, type VariableAssignment,
} from './solver';
import { computePortPriority, sortByPortPriority } from './port-priority';

const DEFAULT_CONFIG: SolverConfig = {
  maxSolutions: 100,
  timeoutMs: 5000,
  costWeights: new Map(),
};

export function solvePriorityBacktracking(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (config.costWeights) {
    cfg.costWeights = new Map([...DEFAULT_CONFIG.costWeights, ...config.costWeights]);
  }

  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, cfg.skipGpioMapping);
  if (!ctx) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: errors.length > 0 ? errors : [{ type: 'warning', message: 'No variables to solve' }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
    };
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

  if (solutions.length >= cfg.maxSolutions) {
    errors.push({ type: 'warning', message: `Maximum solutions (${cfg.maxSolutions}) reached.` });
  }
  if (performance.now() - startTime > cfg.timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${solutions.length} solutions.` });
  }

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
        message: `Could not assign ${failingVar.portName}.${failingVar.channelName} (config "${failingVar.configName}") — ${failingVar.candidates.length} candidates all conflict`,
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

  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, cfg.costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  ctx.stats.solveTimeMs = performance.now() - startTime;

  const deduped = deduplicateSolutions(solutions);
  const filtered = validateGpioAvailability(deduped, ctx.gpioCountPerConfig, mcu, ctx.reservedPins, ctx.pinnedAssignments);
  return { mcuRef: mcu.refName, solutions: filtered, errors, statistics: ctx.stats };
}
