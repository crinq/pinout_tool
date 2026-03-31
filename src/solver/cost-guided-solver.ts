// ============================================================
// Cost-Guided Ordering Solver
//
// Before trying candidates for each variable, sorts them by
// estimated incremental cost. This finds better solutions earlier
// by preferring candidates that minimize port spread, debug pin
// usage, and pin proximity.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats, DmaData } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { parseBgaPosition, parsePackagePinCount, isDebugPin } from './cost-functions';
import type { SignalCandidate } from './pattern-matcher';
import {
  prepareSolverContext,
  evaluateAllConstraints, buildSolution,
  canAssignPin, assignPin, unassignPin, evaluateExpr,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  isOptionalRequireVacuous,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker,
} from './solver';

export function solveCostGuided(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = mergeSolverConfig(config);

  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, cfg.skipGpioMapping);
  if (!ctx) { return emptyResult(mcu.refName, errors); }

  const solutions: Solution[] = [];
  const isBGA = /BGA|WLCSP/i.test(mcu.package);
  const totalPins = parsePackagePinCount(mcu.package);

  // Precompute cost weights
  const wSpread = cfg.costWeights.get('port_spread') ?? 0;
  const wDebug = cfg.costWeights.get('debug_pin_penalty') ?? 0;
  const wProximity = cfg.costWeights.get('pin_proximity') ?? 0;

  solveBacktrackCostGuided(
    ctx.variables, 0, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats, ctx.deepest,
    ctx.lastVarOfConfig, ctx.configRequiresMap,
    mcu, isBGA, totalPins, wSpread, wDebug, wProximity,
    ctx.dmaData
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);
  return finalizeSolutions(solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime, ctx.gpioCountPerConfig, ctx.reservedPins, ctx.pinnedAssignments);
}

function estimateCost(
  candidate: SignalCandidate,
  current: VariableAssignment[],
  portName: string,
  _mcu: Mcu,
  isBGA: boolean,
  totalPins: number,
  wSpread: number,
  wDebug: number,
  wProximity: number
): number {
  let cost = 0;
  const pinName = candidate.pin.name;

  // Port spread: +1 if this introduces a new GPIO port letter for this port
  if (wSpread > 0) {
    const match = pinName.match(/^P([A-Z])/);
    if (match) {
      const portLetter = match[1];
      let alreadyUsed = false;
      for (const va of current) {
        if (va.variable.portName === portName) {
          const m = va.candidate.pin.name.match(/^P([A-Z])/);
          if (m && m[1] === portLetter) { alreadyUsed = true; break; }
        }
      }
      if (!alreadyUsed) cost += wSpread;
    }
  }

  // Debug pin penalty
  if (wDebug > 0 && isDebugPin(candidate.pin)) {
    cost += wDebug * 10;
  }

  // Pin proximity: average distance to already-assigned pins in the same port
  if (wProximity > 0) {
    const portPins: string[] = [];
    for (const va of current) {
      if (va.variable.portName === portName) {
        portPins.push(va.candidate.pin.position);
      }
    }
    if (portPins.length > 0) {
      let totalDist = 0;
      const pos = candidate.pin.position;
      if (isBGA) {
        const p = parseBgaPosition(pos);
        if (p) {
          for (const otherPos of portPins) {
            const o = parseBgaPosition(otherPos);
            if (o) {
              const dr = p.row - o.row;
              const dc = p.col - o.col;
              totalDist += Math.sqrt(dr * dr + dc * dc);
            }
          }
        }
      } else if (totalPins > 0) {
        const num = parseInt(pos, 10);
        if (!isNaN(num)) {
          for (const otherPos of portPins) {
            const otherNum = parseInt(otherPos, 10);
            if (!isNaN(otherNum)) {
              const diff = Math.abs(num - otherNum);
              totalDist += Math.min(diff, totalPins - diff);
            }
          }
        }
      }
      cost += wProximity * totalDist / portPins.length;
    }
  }

  return cost;
}

function solveBacktrackCostGuided(
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
  mcu: Mcu,
  isBGA: boolean,
  totalPins: number,
  wSpread: number,
  wDebug: number,
  wProximity: number,
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
    if (evaluateAllConstraints(current, configCombinations, ports, dmaData, dmaOut, undefined, tracker.sharedPatterns)) {
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

  // Sort domain by estimated incremental cost
  const scored = v.domain.map(idx => ({
    idx,
    cost: estimateCost(v.candidates[idx], current, v.portName, mcu, isBGA, totalPins, wSpread, wDebug, wProximity),
  }));
  scored.sort((a, b) => a.cost - b.cost);

  for (const { idx: candidateIdx } of scored) {
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
      solveBacktrackCostGuided(
        variables, varIndex + 1, tracker, current,
        configCombinations, ports, pinnedAssignments,
        solutions, maxSolutions, startTime, timeoutMs, stats, deepest,
        lastVarOfConfig, configRequiresMap,
        mcu, isBGA, totalPins, wSpread, wDebug, wProximity,
        dmaData
      );
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance, candidate.signalName);
  }
}
