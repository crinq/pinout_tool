// ============================================================
// Dynamic MRV Solver
//
// Instead of a fixed variable order, dynamically picks the
// unassigned variable with the smallest remaining domain at
// each step. Combined with forward checking for effectiveness.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats, DmaData } from '../types';
import type { ProgramNode, RequireNode, PatternPart } from '../parser/constraint-ast';
import {
  prepareSolverContext,
  evaluateAllConstraints, buildSolution,
  canAssignPin, assignPin, unassignPin, evaluateExpr,
  propagateShared, undoPropagateShared, buildPinLookups,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  isOptionalRequireVacuous,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker,
} from './solver';

export function solveDynamicMRV(
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
  const n = ctx.variables.length;

  // Build mutable domains
  const domains: number[][] = ctx.variables.map(v => [...v.domain]);
  const assigned = new Array<boolean>(n).fill(false);

  // Build last-var-of-config check: we need to know when ALL variables of a (port, config) are assigned
  const configVarIndices = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${ctx.variables[i].portName}\0${ctx.variables[i].configName}`;
    if (!configVarIndices.has(key)) configVarIndices.set(key, []);
    configVarIndices.get(key)!.push(i);
  }

  const { pinToVarCandidates, instanceToVarCandidates } = buildPinLookups(ctx.variables);

  solveBacktrackDynamic(
    ctx.variables, assigned, domains, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats,
    ctx.configRequiresMap, configVarIndices, 0, n,
    pinToVarCandidates, instanceToVarCandidates, ctx.sharedPatterns,
    ctx.dmaData
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);

  return finalizeSolutions(
    solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime,
    ctx.gpioCountPerConfig, ctx.reservedPins, ctx.pinnedAssignments,
  );
}

export function solveBacktrackDynamic(
  variables: SolverVariable[],
  assigned: boolean[],
  domains: number[][],
  tracker: PinTracker,
  current: VariableAssignment[],
  configCombinations: Map<string, string>[],
  ports: Map<string, PortSpec>,
  pinnedAssignments: PinnedAssignment[],
  solutions: Solution[],
  maxSolutions: number,
  startTime: number,
  timeoutMs: number,
  stats: SolverStats,
  configRequiresMap: Map<string, RequireNode[]>,
  configVarIndices: Map<string, number[]>,
  depth: number,
  totalVars: number,
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[],
  dmaData?: DmaData
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;

  if (depth === totalVars) {
    // All variables assigned - check all config combinations
    stats.evaluatedCombinations++;
    const dmaOut1: Map<string, string>[] = [];
    if (evaluateAllConstraints(current, configCombinations, ports, dmaData, dmaOut1, undefined, sharedPatterns)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length, dmaOut1
      );
      solutions.push(solution);
      stats.validSolutions++;
      const elapsed = performance.now() - startTime;
      if (stats.firstSolutionMs === undefined) stats.firstSolutionMs = elapsed;
      stats.lastSolutionMs = elapsed;
    }
    return;
  }

  // Dynamic MRV: pick unassigned variable with smallest non-empty domain
  // Variables with empty domains are for inactive configs - skip them
  let bestVar = -1;
  let bestSize = Infinity;
  let unassignedCount = 0;
  for (let i = 0; i < totalVars; i++) {
    if (assigned[i]) continue;
    unassignedCount++;
    if (domains[i].length > 0 && domains[i].length < bestSize) {
      bestSize = domains[i].length;
      bestVar = i;
    }
  }

  if (bestVar === -1) {
    if (unassignedCount === 0) {
      // All assigned - this shouldn't happen (depth check above catches it)
      return;
    }
    // All unassigned variables have empty domains - check if it's a real wipeout
    // or if they're all for inactive configs. Either way, we can't proceed with
    // normal assignment. Try to complete the solution with remaining vars "skipped".
    // Mark all empty-domain vars as assigned and try to evaluate.
    const skipped: number[] = [];
    for (let i = 0; i < totalVars; i++) {
      if (!assigned[i]) { assigned[i] = true; skipped.push(i); }
    }
    stats.evaluatedCombinations++;
    const dmaOut2: Map<string, string>[] = [];
    if (evaluateAllConstraints(current, configCombinations, ports, dmaData, dmaOut2, undefined, sharedPatterns)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length, dmaOut2
      );
      solutions.push(solution);
      stats.validSolutions++;
      const elapsed2 = performance.now() - startTime;
      if (stats.firstSolutionMs === undefined) stats.firstSolutionMs = elapsed2;
      stats.lastSolutionMs = elapsed2;
    }
    for (const i of skipped) assigned[i] = false;
    return;
  }

  const vi = bestVar;
  const v = variables[vi];
  assigned[vi] = true;

  const domainCopy = [...domains[vi]];
  for (const candidateIdx of domainCopy) {
    if (solutions.length >= maxSolutions) return;
    if (performance.now() - startTime > timeoutMs) return;

    const candidate = v.candidates[candidateIdx];

    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName);
    current.push({ variable: v, candidate });

    // Eager constraint check: if all variables of this (port, config) are now assigned
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    const configVars = configVarIndices.get(configKey);
    if (configVars && configVars.every(idx => assigned[idx])) {
      const requires = configRequiresMap.get(configKey);
      if (requires) {
        const portChannels = new Map<string, VariableAssignment[]>();
        for (const va of current) {
          if (va.variable.portName === v.portName && va.variable.configName === v.configName) {
            if (!portChannels.has(va.variable.channelName)) {
              portChannels.set(va.variable.channelName, []);
            }
            portChannels.get(va.variable.channelName)!.push(va);
          }
        }
        const channelInfo = new Map<string, Map<string, VariableAssignment[]>>();
        channelInfo.set(v.portName, portChannels);

        for (const req of requires) {
          if (isOptionalRequireVacuous(req.expression, v.portName, channelInfo)) {
            continue;
          }
          if (!evaluateExpr(req.expression, v.portName, channelInfo, dmaData)) {
            if (req.optional) continue;
            pruned = true;
            break;
          }
        }
      }
    }

    if (!pruned) {
      // Forward checking propagation
      const removed = propagateShared(
        candidate, v.portName,
        variables, domains, i => assigned[i],
        pinToVarCandidates, instanceToVarCandidates, sharedPatterns
      );

      if (removed !== null) {
        solveBacktrackDynamic(
          variables, assigned, domains, tracker, current,
          configCombinations, ports, pinnedAssignments,
          solutions, maxSolutions, startTime, timeoutMs, stats,
          configRequiresMap, configVarIndices, depth + 1, totalVars,
          pinToVarCandidates, instanceToVarCandidates, sharedPatterns,
          dmaData
        );
        undoPropagateShared(removed, domains);
      }
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance, candidate.signalName);
  }

  assigned[vi] = false;
}
