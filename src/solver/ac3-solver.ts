// ============================================================
// AC-3 Forward Checking Solver
//
// After each variable assignment, propagates constraints to shrink
// remaining variables' domains. Detects failures earlier and prunes
// more branches than the basic backtracking solver.
//
// Propagation rules:
// 1. Pin exclusivity: assigned pin removed from other ports' domains
// 2. Instance exclusivity: non-shared instance removed from other ports
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats, DmaData } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import {
  prepareSolverContext,
  evaluateAllConstraints, buildSolution,
  canAssignPin, assignPin, unassignPin, evaluateExpr,
  propagateShared, undoPropagateShared, buildPinLookups,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker,
} from './solver';
import type { PatternPart } from '../parser/constraint-ast';

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

  // Build mutable domains
  const domains: number[][] = ctx.variables.map(v => [...v.domain]);

  const { pinToVarCandidates, instanceToVarCandidates } = buildPinLookups(ctx.variables);

  solveBacktrackAC3(
    ctx.variables, 0, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats, ctx.deepest,
    ctx.lastVarOfConfig, ctx.configRequiresMap,
    domains, pinToVarCandidates, instanceToVarCandidates, ctx.sharedPatterns,
    ctx.dmaData
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);
  return finalizeSolutions(solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime, ctx.gpioCountPerConfig, ctx.reservedPins, ctx.pinnedAssignments);
}

function solveBacktrackAC3(
  variables: SolverVariable[],
  varIndex: number,
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
  deepest: { depth: number; assignments: VariableAssignment[] },
  lastVarOfConfig: Map<string, number>,
  configRequiresMap: Map<string, RequireNode[]>,
  domains: number[][],
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[],
  dmaData?: DmaData
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;

  if (varIndex > deepest.depth) {
    deepest.depth = varIndex;
    deepest.assignments = [...current];
  }

  if (varIndex === variables.length) {
    stats.evaluatedCombinations++;
    const dmaOut: Map<string, string>[] = [];
    if (evaluateAllConstraints(current, configCombinations, ports, dmaData, dmaOut)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length, dmaOut
      );
      solutions.push(solution);
      stats.validSolutions++;
      const elapsed = performance.now() - startTime;
      if (stats.firstSolutionMs === undefined) stats.firstSolutionMs = elapsed;
      stats.lastSolutionMs = elapsed;
    }
    return;
  }

  const v = variables[varIndex];
  const assigned = new Set<number>();
  for (let i = 0; i < varIndex; i++) assigned.add(i);

  // Iterate over current domain (may have been pruned by propagation)
  const domainCopy = [...domains[varIndex]];
  for (const candidateIdx of domainCopy) {
    if (solutions.length >= maxSolutions) return;
    if (performance.now() - startTime > timeoutMs) return;

    const candidate = v.candidates[candidateIdx];

    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName);
    current.push({ variable: v, candidate });

    // Eager constraint check
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    if (lastVarOfConfig.get(configKey) === varIndex) {
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
          if (!evaluateExpr(req.expression, v.portName, channelInfo, dmaData)) {
            pruned = true;
            break;
          }
        }
      }
    }

    if (!pruned) {
      // Forward-check propagation
      assigned.add(varIndex);
      const removed = propagateShared(
        candidate, v.portName,
        variables, domains, i => assigned.has(i),
        pinToVarCandidates, instanceToVarCandidates,
        sharedPatterns
      );

      if (removed !== null) {
        // No domain wipeout - recurse
        solveBacktrackAC3(
          variables, varIndex + 1, tracker, current,
          configCombinations, ports, pinnedAssignments,
          solutions, maxSolutions, startTime, timeoutMs, stats, deepest,
          lastVarOfConfig, configRequiresMap,
          domains, pinToVarCandidates, instanceToVarCandidates, sharedPatterns,
          dmaData
        );
        undoPropagateShared(removed, domains);
      }
      assigned.delete(varIndex);
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance, candidate.signalName);
  }
}
