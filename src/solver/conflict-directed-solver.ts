// ============================================================
// Conflict-Directed Solver (CDS)
//
// Modern-CSP search for problems with many mutually-blocking
// peripheral constraints:
//
// - dom/wdeg-lite variable ordering: variables collect weight when
//   they participate in conflicts; selection minimizes
//   domainSize / (1 + weight). The search *learns* which ports are
//   hard and decides them first (what port-priority approximates
//   statically).
// - Conflict-directed backjumping (CBJ): a dead-ended variable jumps
//   straight to the deepest decision that pruned it, skipping the
//   unrelated assignments in between. Conflict sets are maintained as
//   SUPERSETS of the true reasons (always safe, sometimes chronological).
// - Luby restarts with weight + phase carry-over: each restart is
//   better informed; candidate order keeps the last successful value
//   first (phase saving) until a solution exists, then anti-phase
//   ordering diversifies subsequent solutions.
// - F2 same_instance propagation + pin/instance forward checking.
//
// ponytail: no nogood store — certified nogood learning lives in the
// CEGAR solver where the matching oracle can prove them.
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, DmaData } from '../types';
import type { ProgramNode, RequireNode, ConstraintExprNode } from '../parser/constraint-ast';
import {
  prepareSolverContext, evaluateAllConstraints, buildSolution,
  canAssignPin, assignPin, unassignPin, evaluateExpr,
  propagateShared, undoPropagateShared, buildPinLookups,
  buildSameInstancePropagator, propagateSameInstance,
  createPinTracker, isOptionalRequireVacuous,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  type SolverConfig, type VariableAssignment,
  type SameInstancePropagator,
  type EvalMcuInfo, type SolverContext,
} from './solver';
import { mulberry32 } from './solver-utils';

const LUBY_UNIT = 2000; // backtracks per Luby unit

/** Luby restart sequence (1-based): 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,... */
export function luby(i: number): number {
  for (;;) {
    let k = 1;
    while ((1 << k) - 1 < i) k++;
    if ((1 << k) - 1 === i) return 1 << (k - 1);
    // i lies strictly inside the previous block: recurse on its offset
    i -= (1 << (k - 1)) - 1;
  }
}

interface Frame {
  vi: number;
  order: number[];      // candidate visit order (phase-saved / shuffled)
  pos: number;          // next index into order
  candIdx: number;      // -1 = none, -2 = skipped optional, else assigned candidate
  conflictSet: Set<number>; // accumulated conflict levels for rejected values
  // undo info
  pinKey?: string; physKey?: string; instKey?: string;
}

interface SearchShared {
  weight: Float64Array;               // dom/wdeg-lite variable weights
  lastValue: Map<number, number>;     // phase saving: vi -> candIdx
  antiPhase: boolean;                 // after first solution: diversify
}

export function solveConflictDirected(
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
  const shared: SearchShared = {
    weight: new Float64Array(ctx.variables.length),
    lastValue: new Map(),
    antiPhase: false,
  };

  let restart = 0;
  for (;;) {
    const budget = { backtracks: LUBY_UNIT * luby(restart + 1) };
    const status = searchOnce(ctx, cfg, solutions, shared, startTime, restart, budget);
    if (status !== 'restart') break;
    restart++;
  }

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);
  if (solutions.length === 0 && ctx.deepest.depth >= 0) {
    errors.push({
      type: 'error',
      message: `No valid assignment found (searched ${restart + 1} restart(s), deepest ${ctx.deepest.depth + 1}/${ctx.variables.length} variables)`,
      partialSolution: ctx.deepest.assignments.map(va => ({
        pinName: va.candidate.pin.name,
        signalName: va.candidate.signalName,
        portName: va.variable.portName,
        channelName: va.variable.channelName,
        configurationName: va.variable.configName,
      })),
    });
  }

  return finalizeSolutions(
    solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime,
    ctx.gpioCountPerConfig, ctx.reservedPins, ctx.pinnedAssignments,
  );
}

/** Collect ports referenced via dot_access in an expression (cross-port requires). */
function collectReferencedPorts(expr: ConstraintExprNode, out: Set<string>): void {
  switch (expr.type) {
    case 'dot_access': out.add(expr.object); break;
    case 'function_call': for (const a of expr.args) collectReferencedPorts(a, out); break;
    case 'binary_expr':
      collectReferencedPorts(expr.left, out);
      collectReferencedPorts(expr.right, out);
      break;
    case 'unary_expr': collectReferencedPorts(expr.operand, out); break;
  }
}

type SearchStatus = 'exhausted' | 'timeout' | 'full' | 'restart';

function searchOnce(
  ctx: SolverContext,
  cfg: SolverConfig,
  solutions: Solution[],
  shared: SearchShared,
  startTime: number,
  restartIdx: number,
  budget: { backtracks: number }
): SearchStatus {
  const variables = ctx.variables;
  const n = variables.length;
  const rng = mulberry32(0x9E3779B9 ^ (restartIdx * 2654435761));

  // Fresh per-restart state
  const domains: number[][] = variables.map(v => [...v.domain]);
  const assigned = new Array<boolean>(n).fill(false);
  const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns);
  const { pinToVarCandidates, instanceToVarCandidates } = buildPinLookups(variables);
  const sameInstance: SameInstancePropagator | undefined =
    buildSameInstancePropagator(variables, ctx.configRequiresMap);
  const current: VariableAssignment[] = [];

  // Conflict bookkeeping
  const pruneLevels: Array<Set<number>> = variables.map(() => new Set());
  const removedBatches: Array<Array<{ varIdx: number; candIdx: number }>> = [];
  const pinLevel = new Map<string, number>();
  const physLevel = new Map<string, number>();
  const instLevel = new Map<string, number>();
  const portLevels = new Map<string, number[]>();

  // (port, config) -> variable indices, and referenced-ports per configKey
  const configVarIndices = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${variables[i].portName}\0${variables[i].configName}`;
    if (!configVarIndices.has(key)) configVarIndices.set(key, []);
    configVarIndices.get(key)!.push(i);
  }
  const configRefPorts = new Map<string, string[]>();
  for (const [key, requires] of ctx.configRequiresMap) {
    const refs = new Set<string>();
    for (const req of requires) collectReferencedPorts(req.expression, refs);
    refs.delete(key.split('\0')[0]);
    if (refs.size > 0) configRefPorts.set(key, [...refs]);
  }

  const frames: Frame[] = [];
  let backtracks = 0;

  const selectVar = (): number => {
    let best = -1;
    let bestScore = Infinity;
    let sawOptional = false;
    for (let i = 0; i < n; i++) {
      if (assigned[i]) continue;
      if (variables[i].optional) { sawOptional = true; continue; }
      const score = domains[i].length / (1 + shared.weight[i]);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best === -1 && sawOptional) {
      for (let i = 0; i < n; i++) {
        if (!assigned[i] && variables[i].optional) return i;
      }
    }
    return best;
  };

  const buildOrder = (vi: number): number[] => {
    const dom = domains[vi];
    const order = [...dom];
    // Fisher-Yates
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const last = shared.lastValue.get(vi);
    if (last !== undefined) {
      const li = order.indexOf(last);
      if (li !== -1) {
        order.splice(li, 1);
        // phase saving: try last value first; anti-phase: try it last
        if (shared.antiPhase) order.push(last);
        else order.unshift(last);
      }
    }
    return order;
  };

  const undoAssignment = (f: Frame, level: number): void => {
    if (f.candIdx >= 0) {
      const v = variables[f.vi];
      const c = v.candidates[f.candIdx];
      current.pop();
      const batch = removedBatches.pop();
      if (batch) {
        for (const e of batch) pruneLevels[e.varIdx].delete(level);
        undoPropagateShared(batch, domains);
      }
      unassignPin(tracker, c.pin.name, v.portName, v.configName, c.peripheralInstance, c.signalName, c.pin.physical.position);
      if (f.pinKey) pinLevel.delete(f.pinKey);
      if (f.physKey) physLevel.delete(f.physKey);
      if (f.instKey) instLevel.delete(f.instKey);
      const pl = portLevels.get(v.portName);
      if (pl && pl[pl.length - 1] === level) pl.pop();
      f.pinKey = f.physKey = f.instKey = undefined;
    }
    assigned[f.vi] = false;
    f.candIdx = -1;
  };

  /** Pop frames above target level (exclusive), undoing their assignments. */
  const unwindTo = (target: number): void => {
    while (frames.length - 1 > target) {
      const f = frames.pop()!;
      undoAssignment(f, frames.length);
    }
  };

  const addAllLevels = (set: Set<number>): void => {
    for (let l = 0; l < frames.length; l++) set.add(l);
  };

  // Main loop. Frames grow as variables are assigned; a conflict merges its
  // reason set into the target frame and search resumes there (CBJ).
  for (;;) {
    if (performance.now() - startTime > cfg.timeoutMs) { unwindTo(-1); return 'timeout'; }
    if (solutions.length >= cfg.maxSolutions) { unwindTo(-1); return 'full'; }
    if (backtracks > budget.backtracks) { unwindTo(-1); return 'restart'; }

    // Need a new frame?
    if (frames.length === 0 || frames[frames.length - 1].candIdx !== -1) {
      const vi = selectVar();
      if (vi === -1) {
        // All variables assigned — leaf
        ctx.stats.evaluatedCombinations++;
        const dmaOut: Map<string, string>[] = [];
        if (evaluateAllConstraints(current, ctx.configCombinations, ctx.ports, ctx.dmaData, dmaOut, ctx.mcuInfo, ctx.sharedPatterns)) {
          solutions.push(buildSolution(
            current, ctx.configCombinations, ctx.ports, ctx.pinnedAssignments, solutions.length, dmaOut
          ));
          ctx.stats.validSolutions++;
          const elapsed = performance.now() - startTime;
          if (ctx.stats.firstSolutionMs === undefined) ctx.stats.firstSolutionMs = elapsed;
          ctx.stats.lastSolutionMs = elapsed;
          shared.antiPhase = true;
        }
        // Continue enumeration chronologically from the deepest frame.
        // Reasons unknown at leaf level → conservative full conflict set.
        if (frames.length === 0) return 'exhausted';
        const top = frames[frames.length - 1];
        addAllLevels(top.conflictSet);
        undoAssignment(top, frames.length - 1);
        backtracks++;
        continue;
      }

      const v = variables[vi];
      if (v.optional && domains[vi].length === 0) {
        // Skipped optional variable — no tracker state
        assigned[vi] = true;
        frames.push({ vi, order: [], pos: 0, candIdx: -2, conflictSet: new Set() });
        continue;
      }
      if (!v.optional && domains[vi].length === 0) {
        // Dead end before any frame: the pruners of this variable are at fault
        shared.weight[vi] += 1;
        const conflict = new Set(pruneLevels[vi]);
        if (!failTo(conflict)) return 'exhausted';
        continue;
      }
      frames.push({ vi, order: buildOrder(vi), pos: 0, candIdx: -1, conflictSet: new Set() });
      if (frames.length - 1 > ctx.deepest.depth) {
        ctx.deepest.depth = frames.length - 1;
        ctx.deepest.assignments = [...current];
      }
      continue;
    }

    // Try next candidate of the top frame
    const level = frames.length - 1;
    const f = frames[level];
    const v = variables[f.vi];
    let advanced = false;

    while (f.pos < f.order.length) {
      const candIdx = f.order[f.pos++];
      if (!domains[f.vi].includes(candIdx)) continue; // pruned since order snapshot
      const c = v.candidates[candIdx];

      if (!canAssignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position)) {
        // Attribute the rejection: cross-port owners + same-port assignments
        const pl = pinLevel.get(c.pin.name);
        if (pl !== undefined) f.conflictSet.add(pl);
        const phl = physLevel.get(c.pin.physical.position);
        if (phl !== undefined) f.conflictSet.add(phl);
        if (c.peripheralInstance) {
          const il = instLevel.get(c.peripheralInstance);
          if (il !== undefined) f.conflictSet.add(il);
        }
        const spl = portLevels.get(v.portName);
        if (spl) for (const l of spl) f.conflictSet.add(l);
        continue;
      }

      assignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position);
      current.push({ variable: v, candidate: c });

      // Eager require check when this (port, config) is fully assigned
      let pruned = false;
      const configKey = `${v.portName}\0${v.configName}`;
      const cvi = configVarIndices.get(configKey)!;
      assigned[f.vi] = true;
      const allAssigned = cvi.every(idx => assigned[idx]);
      if (allAssigned) {
        const requires = ctx.configRequiresMap.get(configKey);
        if (requires && !checkRequires(requires, v.portName, v.configName, current, ctx.dmaData, ctx.mcuInfo)) {
          pruned = true;
          // Conflict scope: this config's variables + referenced ports
          for (const idx of cvi) {
            shared.weight[idx] += 1;
            const lv = levelOfVar(frames, idx);
            if (lv !== -1 && lv !== level) f.conflictSet.add(lv);
          }
          const refPorts = configRefPorts.get(configKey);
          if (refPorts) {
            for (const rp of refPorts) {
              const rpl = portLevels.get(rp);
              if (rpl) for (const l of rpl) f.conflictSet.add(l);
            }
          }
        }
      }

      // Forward checking (F2 same_instance + pin/instance exclusivity)
      if (!pruned) {
        const siRemoved = sameInstance
          ? propagateSameInstance(f.vi, c, sameInstance, variables, domains, i => assigned[i])
          : null;
        const removed = propagateShared(
          c, v.portName, variables, domains, i => assigned[i],
          pinToVarCandidates, instanceToVarCandidates, ctx.sharedPatterns
        );
        if (removed === null) {
          if (siRemoved) undoPropagateShared(siRemoved, domains);
          // Port wipeout: precise blame unavailable (chronological fallback)
          addAllLevels(f.conflictSet);
          pruned = true;
        } else {
          const batch = siRemoved && siRemoved.length > 0 ? [...siRemoved, ...removed] : removed;
          removedBatches.push(batch);
          for (const e of batch) pruneLevels[e.varIdx].add(level);
        }
      }

      if (pruned) {
        current.pop();
        assigned[f.vi] = false;
        unassignPin(tracker, c.pin.name, v.portName, v.configName, c.peripheralInstance, c.signalName, c.pin.physical.position);
        continue;
      }

      // Commit
      f.candIdx = candIdx;
      shared.lastValue.set(f.vi, candIdx);
      if (!pinLevel.has(c.pin.name)) { pinLevel.set(c.pin.name, level); f.pinKey = c.pin.name; }
      if (!physLevel.has(c.pin.physical.position)) { physLevel.set(c.pin.physical.position, level); f.physKey = c.pin.physical.position; }
      if (c.peripheralInstance && !instLevel.has(c.peripheralInstance)) { instLevel.set(c.peripheralInstance, level); f.instKey = c.peripheralInstance; }
      if (!portLevels.has(v.portName)) portLevels.set(v.portName, []);
      portLevels.get(v.portName)!.push(level);
      advanced = true;
      break;
    }

    if (advanced) continue;

    if (v.optional && f.candIdx !== -2) {
      // Optional variable with no workable candidate: skip it
      assigned[f.vi] = true;
      f.candIdx = -2;
      continue;
    }

    // Frame exhausted — backjump using its accumulated conflict set
    shared.weight[f.vi] += 1;
    const conflict = new Set(f.conflictSet);
    for (const l of pruneLevels[f.vi]) conflict.add(l);
    frames.pop();
    assigned[f.vi] = false;
    if (!failTo(conflict)) return 'exhausted';
  }

  /** Backjump to the deepest level in `conflict`. Returns false when the search space is exhausted. */
  function failTo(conflict: Set<number>): boolean {
    backtracks++;
    conflict.delete(frames.length); // self-references from stale bookkeeping
    // Deepest conflict level whose frame actually carries an assignment —
    // skipped-optional frames (candIdx === -2) cannot resolve any conflict.
    let target = -1;
    for (const l of conflict) {
      if (l > target && l < frames.length && frames[l].candIdx !== -2) target = l;
    }
    if (target === -1) {
      unwindTo(-1);
      return false;
    }
    unwindTo(target);
    const tf = frames[frames.length - 1];
    for (const l of conflict) if (l < frames.length - 1) tf.conflictSet.add(l);
    undoAssignment(tf, frames.length - 1);
    return true;
  }
}

/** Level (frame index) at which a variable is assigned, or -1. */
function levelOfVar(frames: Frame[], vi: number): number {
  for (let l = frames.length - 1; l >= 0; l--) {
    if (frames[l].vi === vi) return l;
  }
  return -1;
}

function checkRequires(
  requires: RequireNode[],
  portName: string,
  configName: string,
  current: VariableAssignment[],
  dmaData: DmaData | undefined,
  mcuInfo: EvalMcuInfo | undefined
): boolean {
  const portChannels = new Map<string, VariableAssignment[]>();
  for (const va of current) {
    if (va.variable.portName === portName && va.variable.configName === configName) {
      if (!portChannels.has(va.variable.channelName)) portChannels.set(va.variable.channelName, []);
      portChannels.get(va.variable.channelName)!.push(va);
    }
  }
  const channelInfo = new Map<string, Map<string, VariableAssignment[]>>();
  channelInfo.set(portName, portChannels);

  for (const req of requires) {
    if (isOptionalRequireVacuous(req.expression, portName, channelInfo)) continue;
    if (!evaluateExpr(req.expression, portName, channelInfo, dmaData, mcuInfo)) {
      if (req.optional) continue;
      return false;
    }
  }
  return true;
}
