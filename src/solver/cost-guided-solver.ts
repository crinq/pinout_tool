// ============================================================
// Cost-Guided Ordering Solver
//
// Before trying candidates for each variable, sorts them by
// estimated incremental cost. This finds better solutions earlier
// by preferring candidates that minimize port spread, debug pin
// usage, and pin proximity.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { computeTotalCost, parseBgaPosition, parsePackagePinCount } from './cost-functions';
import type { SignalCandidate } from './pattern-matcher';
import {
  prepareSolverContext,
  evaluateAllConstraints, buildSolution, deduplicateSolutions,
  canAssignPin, assignPin, unassignPin, evaluateExpr,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker,
} from './solver';

const DEFAULT_CONFIG: SolverConfig = {
  maxSolutions: 100,
  timeoutMs: 5000,
  costWeights: new Map(),
};

const DEBUG_PINS = new Set(['PA13', 'PA14', 'PA15', 'PB3', 'PB4']);

export function solveCostGuided(
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

  const ctx = prepareSolverContext(ast, mcu, errors);
  if (!ctx) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: errors.length > 0 ? errors : [{ type: 'warning', message: 'No variables to solve' }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
    };
  }

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
    mcu, isBGA, totalPins, wSpread, wDebug, wProximity
  );

  if (solutions.length >= cfg.maxSolutions) {
    errors.push({ type: 'warning', message: `Maximum solutions (${cfg.maxSolutions}) reached.` });
  }
  if (performance.now() - startTime > cfg.timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${solutions.length} solutions.` });
  }

  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, cfg.costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  ctx.stats.solveTimeMs = performance.now() - startTime;

  const deduped = deduplicateSolutions(solutions);
  return { mcuRef: mcu.refName, solutions: deduped, errors, statistics: ctx.stats };
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
  if (wDebug > 0 && DEBUG_PINS.has(pinName)) {
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
  wProximity: number
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;

  if (varIndex > deepest.depth) {
    deepest.depth = varIndex;
    deepest.assignments = [...current];
  }

  if (varIndex === variables.length) {
    stats.evaluatedCombinations++;
    if (evaluateAllConstraints(current, configCombinations, ports)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length
      );
      solutions.push(solution);
      stats.validSolutions++;
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

    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance);
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
          if (!evaluateExpr(req.expression, v.portName, channelInfo)) {
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
        mcu, isBGA, totalPins, wSpread, wDebug, wProximity
      );
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance);
  }
}
