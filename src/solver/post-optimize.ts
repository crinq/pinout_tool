// ============================================================
// Post-Optimization (greedy pin-level local search)
//
// Runs AFTER the solvers, optional (settings-gated). For each pin
// that carries a single signal, it tries every free alternative pin
// that offers the SAME signal (same peripheral instance + function,
// so instance-level constraints are preserved) and keeps the move if
// it lowers total cost. Repeats until no single move improves — i.e.
// each solution is driven to a local optimum under single-pin moves.
//
// Only the pin changes; the peripheral instance and signal function
// stay fixed, so structural (group) diversity from the solvers is
// preserved — only pin placement is polished. Require constraints
// (pin_distance/…) and DMA are re-validated on every trial.
// ============================================================

import type { Mcu, Solution, SolverError } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import type { SignalCandidate } from './pattern-matcher';
import {
  prepareSolverContext, resolveReservePatterns,
  createPinTracker, canAssignPin, assignPin, unassignPin,
  evaluateAllConstraints, buildSolution, deduplicateSolutions,
  type SolverContext, type SolverVariable, type VariableAssignment,
} from './solver';
import { computeTotalCost } from './cost-functions';

const EPS = 1e-9;
const MAX_PASSES = 12;

export interface PostOptimizeConfig {
  costWeights: Map<string, number>;
  skipGpioMapping?: boolean;
  /** Wall-clock budget in ms; solutions are polished best-first until it runs out. */
  timeoutMs: number;
}

export interface PostOptimizeResult {
  solutions: Solution[];
  /** How many solutions were improved (cost strictly decreased). */
  improved: number;
  /** How many were processed before the budget ran out. */
  processed: number;
}

/**
 * Polish a set of solutions with greedy single-pin local search.
 * Returns a fresh, de-duplicated, cost-sorted list. Solutions left
 * unprocessed when the budget expires are carried through unchanged.
 */
export function postOptimizeSolutions(
  solutions: Solution[],
  ast: ProgramNode,
  mcu: Mcu,
  config: PostOptimizeConfig,
): PostOptimizeResult {
  if (solutions.length === 0) return { solutions, improved: 0, processed: 0 };

  const errors: SolverError[] = [];
  const ctx = prepareSolverContext(ast, mcu, errors, config.skipGpioMapping);
  if (!ctx) return { solutions, improved: 0, processed: 0 };

  const reservedPositions = resolveReservePatterns(ctx.expandedAst, mcu).positions;

  // (port, config, channel) -> variables, for reconstructing assignments
  const varsByChannel = new Map<string, SolverVariable[]>();
  for (const v of ctx.variables) {
    const key = `${v.portName}\0${v.configName}\0${v.channelName}`;
    if (!varsByChannel.has(key)) varsByChannel.set(key, []);
    varsByChannel.get(key)!.push(v);
  }

  const startTime = performance.now();
  const out: Solution[] = [];
  let improved = 0;
  let processed = 0;

  // Best-first: users inspect low-cost solutions first, so polish those first.
  const ordered = [...solutions].sort((a, b) => a.totalCost - b.totalCost);

  for (const sol of ordered) {
    if (performance.now() - startTime > config.timeoutMs) {
      out.push(sol); // budget spent — carry through untouched
      continue;
    }
    processed++;
    const optimized = optimizeOne(sol, ctx, mcu, config.costWeights, reservedPositions, varsByChannel);
    if (optimized && optimized.totalCost < sol.totalCost - EPS) {
      improved++;
      optimized.solverOrigin = sol.solverOrigin;
      optimized.name = sol.name;
      out.push(optimized);
    } else {
      out.push(sol);
    }
  }

  const deduped = deduplicateSolutions(out.sort((a, b) => a.totalCost - b.totalCost));
  return { solutions: deduped, improved, processed };
}

/** Reconstruct variable assignments for a solution from its config-combo assignments. */
function reconstructAssignments(
  sol: Solution,
  varsByChannel: Map<string, SolverVariable[]>,
): Map<SolverVariable, SignalCandidate> {
  const assigned = new Map<SolverVariable, SignalCandidate>();
  for (const ca of sol.configAssignments) {
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      const vs = varsByChannel.get(`${a.portName}\0${a.configurationName}\0${a.channelName}`);
      if (!vs) continue;
      for (const v of vs) {
        if (assigned.has(v)) continue;
        const c = v.candidates.find(cc => cc.pin.name === a.pinName && cc.signalName === a.signalName);
        if (c) { assigned.set(v, c); break; }
      }
    }
  }
  return assigned;
}

function optimizeOne(
  sol: Solution,
  ctx: SolverContext,
  mcu: Mcu,
  weights: Map<string, number>,
  reservedPositions: string[],
  varsByChannel: Map<string, SolverVariable[]>,
): Solution | null {
  const assignedMap = reconstructAssignments(sol, varsByChannel);
  if (assignedMap.size === 0) return null;

  const current: VariableAssignment[] = [...assignedMap].map(([variable, candidate]) => ({ variable, candidate }));

  // Fresh tracker reflecting this solution's occupancy.
  const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns, reservedPositions);
  for (const va of current) {
    const c = va.candidate, v = va.variable;
    assignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position);
  }

  const evalCost = (): number => {
    const s = buildSolution(current, ctx.configCombinations, ctx.ports, ctx.pinnedAssignments, 0);
    return computeTotalCost(s, mcu, weights);
  };
  const valid = (): boolean =>
    evaluateAllConstraints(current, ctx.configCombinations, ctx.ports, ctx.dmaData, undefined, ctx.mcuInfo, ctx.sharedPatterns);

  let currentCost = evalCost();
  let changed = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improvedThisPass = false;

    // Positions used exactly once = pins carrying a single signal (movable freely).
    const posCount = new Map<string, number>();
    for (const va of current) {
      const p = va.candidate.pin.physical.position;
      posCount.set(p, (posCount.get(p) ?? 0) + 1);
    }

    for (let i = 0; i < current.length; i++) {
      const va = current[i];
      const cur = va.candidate;
      if ((posCount.get(cur.pin.physical.position) ?? 0) !== 1) continue; // not a single-signal pin
      const v = va.variable;

      // Free the current pin so alternatives can be tested against a clean tracker.
      unassignPin(tracker, cur.pin.name, v.portName, v.configName, cur.peripheralInstance, cur.signalName, cur.pin.physical.position);

      let bestCost = currentCost;
      let bestCand: SignalCandidate | null = null;

      for (const ci of v.domain) {
        const alt = v.candidates[ci];
        if (alt.signalName !== cur.signalName) continue;                 // same signal only
        if (alt.pin.physical.position === cur.pin.physical.position) continue;
        if (!canAssignPin(tracker, alt.pin.name, v.portName, v.configName, v.channelName, alt.peripheralInstance, alt.signalName, alt.pin.physical.position)) continue;

        assignPin(tracker, alt.pin.name, v.portName, v.configName, v.channelName, alt.peripheralInstance, alt.signalName, alt.pin.physical.position);
        current[i] = { variable: v, candidate: alt };
        if (valid()) {
          const nc = evalCost();
          if (nc < bestCost - EPS) { bestCost = nc; bestCand = alt; }
        }
        unassignPin(tracker, alt.pin.name, v.portName, v.configName, alt.peripheralInstance, alt.signalName, alt.pin.physical.position);
        current[i] = va;
      }

      if (bestCand) {
        assignPin(tracker, bestCand.pin.name, v.portName, v.configName, v.channelName, bestCand.peripheralInstance, bestCand.signalName, bestCand.pin.physical.position);
        current[i] = { variable: v, candidate: bestCand };
        posCount.clear();
        for (const x of current) posCount.set(x.candidate.pin.physical.position, (posCount.get(x.candidate.pin.physical.position) ?? 0) + 1);
        currentCost = bestCost;
        improvedThisPass = true;
        changed = true;
      } else {
        // Restore the original pin (no improving move found).
        assignPin(tracker, cur.pin.name, v.portName, v.configName, v.channelName, cur.peripheralInstance, cur.signalName, cur.pin.physical.position);
      }
    }

    if (!improvedThisPass) break;
  }

  if (!changed) return null;

  // Final rebuild with DMA stream assignment attached.
  const dmaOut: Map<string, string>[] = [];
  if (!evaluateAllConstraints(current, ctx.configCombinations, ctx.ports, ctx.dmaData, dmaOut, ctx.mcuInfo, ctx.sharedPatterns)) {
    return null; // should not happen — we only accepted valid states
  }
  const result = buildSolution(current, ctx.configCombinations, ctx.ports, ctx.pinnedAssignments, sol.id, dmaOut);
  result.mcuRef = mcu.refName;
  computeTotalCost(result, mcu, weights);
  return result;
}
