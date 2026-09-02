// ============================================================
// Solution Editor — interactive single/bulk edits on a solved
// (or partial) Solution, with live validity + cost.
//
// Reuses the post-optimize engine: reconstruct a Solution into the
// solver variable model, hold the assignment as
// Map<SolverVariable, SignalCandidate>, and evaluate any proposed
// change by rebuilding a PinTracker + evaluateAllConstraints +
// computeTotalCost (all in src/solver/*). Every modifier is a move
// generator returning pre-validated EditCandidates with a cost delta;
// applying one pushes an undo snapshot.
//
// Modifiers implemented:
//   1 remap signal → free pin
//   2 assign unmapped signal → pin (+ unassign)
//   3 swap all peripherals between two structurally-equal ports
//   4 swap one peripheral (instance+pins) between two ports
//   5 replace a peripheral with a compatible unused instance
// ============================================================

import type { Mcu, Solution, SolverError } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import type { SignalCandidate } from './pattern-matcher';
import {
  prepareSolverContext, resolveReservePatterns,
  createPinTracker, canAssignPin, assignPin, unassignPin,
  evaluateAllConstraints, buildSolution,
  type SolverContext, type SolverVariable, type VariableAssignment, type PinTracker,
} from './solver';
import { computeTotalCost } from './cost-functions';
import { buildVarsByChannel, reconstructAssignments } from './post-optimize';

const EPS = 1e-9;

/** A validated edit the UI can preview (cost delta, glow pins) and apply. */
export interface EditCandidate {
  label: string;
  /** newTotalCost − currentTotalCost. Negative = improvement; 0 = cost-neutral (still useful). */
  costDelta: number;
  /** Logical pin names to highlight while previewing this candidate. */
  highlightPins: string[];
  apply: () => void;
}

type Assignment = Map<SolverVariable, SignalCandidate>;

/**
 * Cross-port variable identity (config+channel+exprIndex), for matching swaps.
 * Inline-mapping ports get an implicit config named after the PORT, which
 * would make two structurally-identical inline ports (ECAT vs GD) never
 * match — normalize that case to an empty config name.
 */
function chanKey(v: SolverVariable): string {
  const cfg = v.configName === v.portName ? '' : v.configName;
  return `${cfg}\0${v.channelName}\0${v.exprIndex}`;
}

export class SolutionEditor {
  private assigned: Assignment;
  private undoStack: Assignment[] = [];
  private redoStack: Assignment[] = [];
  currentCost = 0;
  readonly baselineCost: number;

  private constructor(
    private ctx: SolverContext,
    private mcu: Mcu,
    private weights: Map<string, number>,
    private reservedPositions: string[],
    assigned: Assignment,
  ) {
    this.assigned = assigned;
    this.currentCost = this.costOf(assigned) ?? Infinity;
    this.baselineCost = this.currentCost;
  }

  /** Build an editor from a solved (or partial) solution. Returns null if the constraints can't be prepared. */
  static fromSolution(sol: Solution, ast: ProgramNode, mcu: Mcu, weights: Map<string, number>, skipGpioMapping?: boolean): SolutionEditor | null {
    const errors: SolverError[] = [];
    const ctx = prepareSolverContext(ast, mcu, errors, skipGpioMapping);
    if (!ctx) return null;
    const reservedPositions = resolveReservePatterns(ctx.expandedAst, mcu).positions;
    const varsByChannel = buildVarsByChannel(ctx.variables);
    const assigned = reconstructAssignments(sol, varsByChannel);
    return new SolutionEditor(ctx, mcu, weights, reservedPositions, assigned);
  }

  // ---------- core evaluation ----------

  private buildTracker(a: Assignment): PinTracker | null {
    const tracker = createPinTracker(this.ctx.reservedPins, this.ctx.sharedPatterns, this.reservedPositions);
    for (const [v, c] of a) {
      if (!canAssignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position)) {
        return null; // pin/instance/channel collision
      }
      assignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position);
    }
    return tracker;
  }

  private toVA(a: Assignment): VariableAssignment[] {
    return [...a].map(([variable, candidate]) => ({ variable, candidate }));
  }

  /** Total cost of an assignment ignoring require validity (for the live/partial preview). */
  private costOf(a: Assignment): number | null {
    const sol = buildSolution(this.toVA(a), this.ctx.configCombinations, this.ctx.ports, this.ctx.pinnedAssignments, 0);
    return computeTotalCost(sol, this.mcu, this.weights);
  }

  /** Cost of a fully-valid trial (pin-consistent + requires + DMA), or null if invalid. */
  private evaluate(trial: Assignment): number | null {
    if (!this.buildTracker(trial)) return null;
    const va = this.toVA(trial);
    if (!evaluateAllConstraints(va, this.ctx.configCombinations, this.ctx.ports, this.ctx.dmaData, undefined, this.ctx.mcuInfo, this.ctx.sharedPatterns)) {
      return null;
    }
    return this.costOf(trial);
  }

  private candidate(trial: Assignment, cost: number, label: string): EditCandidate {
    return { label, costDelta: cost - this.currentCost, highlightPins: this.changedPins(trial), apply: () => this.commit(trial, cost) };
  }

  /** "ENC0.CS:SPI2:NSS" — port.channel:instance:function for a candidate on a channel. */
  private sigLabel(v: SolverVariable, c: SignalCandidate): string {
    const inst = c.peripheralInstance;
    const func = inst && c.signalName.startsWith(inst + '_') ? c.signalName.slice(inst.length + 1) : c.signalName;
    return inst ? `${v.portName}.${v.channelName}:${inst}:${func}` : `${v.portName}.${v.channelName}:${c.signalName}`;
  }

  /** Pins a move touches: both the pin(s) it vacates and the pin(s) it newly occupies. */
  private changedPins(trial: Assignment): string[] {
    const pins = new Set<string>();
    const vars = new Set<SolverVariable>([...this.assigned.keys(), ...trial.keys()]);
    for (const v of vars) {
      const oldPin = this.assigned.get(v)?.pin.name;
      const newPin = trial.get(v)?.pin.name;
      if (oldPin === newPin) continue;
      if (oldPin) pins.add(oldPin);
      if (newPin) pins.add(newPin);
    }
    return [...pins];
  }

  private commit(trial: Assignment, cost: number): void {
    this.undoStack.push(this.assigned);
    this.redoStack.length = 0;
    this.assigned = trial;
    this.currentCost = cost;
  }

  // ---------- undo / redo ----------

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.assigned);
    this.assigned = prev;
    this.currentCost = this.costOf(prev) ?? Infinity;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.assigned);
    this.assigned = next;
    this.currentCost = this.costOf(next) ?? Infinity;
    return true;
  }

  // ---------- lookups the UI needs ----------

  /** The variable (if any) currently mapped to this logical pin. */
  private varAtPin(pinName: string): SolverVariable | null {
    for (const [v, c] of this.assigned) if (c.pin.name === pinName) return v;
    return null;
  }

  private allVarsOfPort(port: string): SolverVariable[] {
    return this.ctx.variables.filter(v => v.portName === port);
  }

  private portSignature(port: string): string {
    return this.allVarsOfPort(port).map(chanKey).sort().join('|');
  }

  // ---------- Modifier 1: remap a signal to a free pin ----------

  listPinMoves(v: SolverVariable): EditCandidate[] {
    const cur = this.assigned.get(v);
    if (!cur) return [];
    const out: EditCandidate[] = [];
    const seen = new Set<string>();
    for (const ci of v.domain) {
      const c = v.candidates[ci];
      if (c.signalName !== cur.signalName) continue;                        // same signal, different pin
      if (c.pin.physical.position === cur.pin.physical.position) continue;
      if (seen.has(c.pin.name)) continue;
      seen.add(c.pin.name);
      const trial = new Map(this.assigned); trial.set(v, c);
      const cost = this.evaluate(trial);
      if (cost === null) continue;
      out.push(this.candidate(trial, cost, `${this.sigLabel(v, cur)} → ${c.pin.name}`));
    }
    return out.sort((a, b) => a.costDelta - b.costDelta);
  }

  // ---------- Modifier 2: assign / unassign ----------

  unassign(v: SolverVariable): EditCandidate | null {
    if (!this.assigned.has(v)) return null;
    const trial = new Map(this.assigned); trial.delete(v);
    const cost = this.evaluate(trial);
    if (cost === null) return null;
    return this.candidate(trial, cost, `Unassign ${v.portName}.${v.channelName}`);
  }

  /**
   * All edits available for clicking a pin: if occupied → its pin moves +
   * unassign; if free → assign options from every unassigned variable that can
   * map here.
   */
  movesForPin(pinName: string): EditCandidate[] {
    const occupant = this.varAtPin(pinName);
    if (occupant) {
      const moves = this.listPinMoves(occupant);
      const un = this.unassign(occupant);
      return un ? [...moves, un] : moves;
    }
    // Free pin. Offer, per (port, channel) — grouped so a channel that spans
    // several configs (a GPIO net exists in each) shows ONCE and, when applied,
    // takes this pin in every config that can use it:
    //  (a) relocate an already-assigned signal here (mirror of listPinMoves);
    //  (b) assign an unmapped channel (peripheral or IN/OUT) here.
    const reloc = new Map<string, { label: string; changes: Array<[SolverVariable, SignalCandidate]> }>();
    const assign = new Map<string, { label: string; changes: Array<[SolverVariable, SignalCandidate]> }>();

    for (const v of this.ctx.variables) {
      const cur = this.assigned.get(v);
      if (cur) {
        let target: SignalCandidate | undefined;
        for (const ci of v.domain) {
          const c = v.candidates[ci];
          if (c.signalName === cur.signalName && c.pin.name === pinName && c.pin.physical.position !== cur.pin.physical.position) { target = c; break; }
        }
        if (!target) continue;
        const key = `${v.portName}\0${v.channelName}\0${cur.signalName}`;
        if (!reloc.has(key)) reloc.set(key, { label: `${this.sigLabel(v, cur)} from ${cur.pin.name}`, changes: [] });
        reloc.get(key)!.changes.push([v, target]);
      } else {
        let cand: SignalCandidate | undefined;
        for (const ci of v.domain) {
          const c = v.candidates[ci];
          if (c.pin.name === pinName) { cand = c; break; }
        }
        if (!cand) continue;
        const key = `${v.portName}\0${v.channelName}`;
        if (!assign.has(key)) assign.set(key, { label: this.sigLabel(v, cand), changes: [] });
        assign.get(key)!.changes.push([v, cand]);
      }
    }

    const out: EditCandidate[] = [];
    for (const g of [...reloc.values(), ...assign.values()]) {
      const trial = new Map(this.assigned);
      for (const [v, c] of g.changes) trial.set(v, c);
      const cost = this.evaluate(trial);
      if (cost === null) continue;
      out.push(this.candidate(trial, cost, g.label));
    }
    return out.sort((a, b) => a.costDelta - b.costDelta);
  }

  // ---------- Modifier 3: swap all peripherals between two ports ----------

  listPortSwaps(port: string): EditCandidate[] {
    const sig = this.portSignature(port);
    const out: EditCandidate[] = [];
    const ports = new Set(this.ctx.variables.map(v => v.portName));
    for (const other of ports) {
      if (other === port) continue;
      if (this.portSignature(other) !== sig) continue; // structurally interchangeable only
      const trial = this.swapVars(port, other, () => true);
      if (!trial) continue;
      const cost = this.evaluate(trial);
      if (cost === null) continue;
      out.push(this.candidate(trial, cost, `Swap all: ${port} ↔ ${other}`));
    }
    return out.sort((a, b) => a.costDelta - b.costDelta);
  }

  // ---------- Modifier 4: swap one peripheral between two ports ----------

  /** `instance` is a peripheral currently used by `port` (e.g. "USART1"). */
  listPeripheralSwaps(port: string, instance: string): EditCandidate[] {
    const mine = this.varsOfInstance(port, instance);
    if (mine.length === 0) return [];
    const type = mine[0].c.peripheralType;
    const myKeys = new Set(mine.map(m => chanKey(m.v)));
    const out: EditCandidate[] = [];

    const ports = new Set(this.ctx.variables.map(v => v.portName));
    for (const other of ports) {
      if (other === port) continue;
      // Other port's peripheral of the same type must cover the same channels.
      const theirs = this.varsOfType(other, type);
      if (theirs.length === 0) continue;
      const theirKeys = new Set(theirs.map(t => chanKey(t.v)));
      if (theirKeys.size !== myKeys.size || [...myKeys].some(k => !theirKeys.has(k))) continue;

      const trial = this.swapVars(port, other, v => myKeys.has(chanKey(v)));
      if (!trial) continue;
      const cost = this.evaluate(trial);
      if (cost === null) continue;
      const otherInst = theirs[0].c.peripheralInstance;
      out.push(this.candidate(trial, cost, `Swap ${type}: ${port}(${instance}) ↔ ${other}(${otherInst})`));
    }
    return out.sort((a, b) => a.costDelta - b.costDelta);
  }

  // ---------- Modifier 5: replace a peripheral with an unused instance ----------

  listUnusedReplacements(port: string, instance: string): EditCandidate[] {
    const mine = this.varsOfInstance(port, instance);
    if (mine.length === 0) return [];
    const type = mine[0].c.peripheralType;
    const used = new Set<string>();
    for (const c of this.assigned.values()) if (c.peripheralInstance) used.add(c.peripheralInstance);
    const all = this.mcu.typeToInstances.get(type) ?? [];
    const out: EditCandidate[] = [];

    const base = new Map(this.assigned);
    for (const m of mine) base.delete(m.v);           // free the current instance's pins

    for (const inst of all) {
      if (used.has(inst)) continue;                    // unused only
      const trial = this.rerouteToInstance(mine.map(m => m.v), inst, base);
      if (!trial) continue;
      const cost = this.evaluate(trial);
      if (cost === null) continue;
      out.push(this.candidate(trial, cost, `Replace ${instance} → ${inst}`));
    }
    return out.sort((a, b) => a.costDelta - b.costDelta);
  }

  // ---------- swap / reroute helpers ----------

  /** Swap the candidates of matching (chanKey) variables between two ports, for vars where filter(portVar) is true. */
  private swapVars(portA: string, portB: string, filter: (v: SolverVariable) => boolean): Assignment | null {
    const byKeyA = new Map<string, SolverVariable>();
    const byKeyB = new Map<string, SolverVariable>();
    for (const v of this.allVarsOfPort(portA)) byKeyA.set(chanKey(v), v);
    for (const v of this.allVarsOfPort(portB)) byKeyB.set(chanKey(v), v);

    const trial = new Map(this.assigned);
    for (const [key, vA] of byKeyA) {
      if (!filter(vA)) continue;
      const vB = byKeyB.get(key);
      if (!vB) return null; // no counterpart — not swappable
      const cA = this.assigned.get(vA);
      const cB = this.assigned.get(vB);
      // Candidates carry raw (pin, signal); assigning B's candidate to A is valid
      // because structurally-equal ports resolve the same patterns.
      if (cB) trial.set(vA, cB); else trial.delete(vA);
      if (cA) trial.set(vB, cA); else trial.delete(vB);
    }
    return trial;
  }

  /** Backtrack the given variables onto free pins of `instance`, on top of `base`. */
  private rerouteToInstance(vars: SolverVariable[], instance: string, base: Assignment): Assignment | null {
    const tracker = this.buildTracker(base);
    if (!tracker) return null;
    const result = new Map(base);
    const assignPinFor = (v: SolverVariable, c: SignalCandidate) =>
      assignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position);
    const unassignPinFor = (v: SolverVariable, c: SignalCandidate) =>
      unassignPin(tracker, c.pin.name, v.portName, v.configName, c.peripheralInstance, c.signalName, c.pin.physical.position);

    const backtrack = (i: number): boolean => {
      if (i === vars.length) return true;
      const v = vars[i];
      for (const ci of v.domain) {
        const c = v.candidates[ci];
        if (c.peripheralInstance !== instance) continue;
        if (!canAssignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position)) continue;
        assignPinFor(v, c); result.set(v, c);
        if (backtrack(i + 1)) return true;
        unassignPinFor(v, c); result.delete(v);
      }
      return false;
    };
    return backtrack(0) ? result : null;
  }

  // ---------- variable/pin queries ----------

  private varsOfInstance(port: string, instance: string): Array<{ v: SolverVariable; c: SignalCandidate }> {
    const out: Array<{ v: SolverVariable; c: SignalCandidate }> = [];
    for (const [v, c] of this.assigned) {
      if (v.portName === port && c.peripheralInstance === instance) out.push({ v, c });
    }
    return out;
  }

  private varsOfType(port: string, type: string): Array<{ v: SolverVariable; c: SignalCandidate }> {
    const out: Array<{ v: SolverVariable; c: SignalCandidate }> = [];
    for (const [v, c] of this.assigned) {
      if (v.portName === port && c.peripheralType === type) out.push({ v, c });
    }
    return out;
  }

  // ---------- output ----------

  /** Rebuild a Solution from the current (possibly partial) assignment, with costs + DMA. */
  toSolution(id = 0): Solution {
    const va = this.toVA(this.assigned);
    const dmaOut: Map<string, string>[] = [];
    // Populate DMA streams when the assignment is complete + valid; ignore otherwise (preview may be partial).
    evaluateAllConstraints(va, this.ctx.configCombinations, this.ctx.ports, this.ctx.dmaData, dmaOut, this.ctx.mcuInfo, this.ctx.sharedPatterns);
    const sol = buildSolution(va, this.ctx.configCombinations, this.ctx.ports, this.ctx.pinnedAssignments, id, dmaOut);
    sol.mcuRef = this.mcu.refName;
    sol.solverOrigin = 'manual';
    computeTotalCost(sol, this.mcu, this.weights);
    return sol;
  }

  /** True when the current assignment satisfies every require + DMA constraint. */
  isComplete(): boolean {
    return this.evaluate(this.assigned) !== null;
  }

  isDirty(): boolean {
    return this.undoStack.length > 0 || Math.abs(this.currentCost - this.baselineCost) > EPS;
  }
}
