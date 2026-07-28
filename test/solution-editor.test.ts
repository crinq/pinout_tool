import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { solveConflictDirected } from '../src/solver/conflict-directed-solver';
import { isGpioVariable } from '../src/solver/solver';
import { SolutionEditor } from '../src/solver/solution-editor';
import type { Mcu, Solution } from '../src/types';

const WEIGHTS = new Map<string, number>([
  ['pin_count', 1], ['port_spread', 0.2], ['peripheral_count', 0.5],
  ['debug_pin_penalty', 0], ['pin_clustering', 0], ['pin_proximity', 3],
]);

function loadCase(folder: string, name: string) {
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).filter(f => f.endsWith('.xml') && !f.startsWith('DMA-'))[0];
  const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
  const dma = readdirSync(dir).filter(f => f.startsWith('DMA-') && f.endsWith('.xml'))[0];
  if (dma) { const t = readFileSync(join(dir, dma), 'utf-8'); if (isDmaXml(t)) mcu.dma = parseDmaXml(t); }
  const { ast } = parseConstraints(readFileSync(join(dir, 'pass', `${name}.txt`), 'utf-8'));
  return { mcu, ast: ast! };
}

function firstSolution(folder: string, name: string, skipGpio = true): { mcu: Mcu; ast: any; sol: Solution } {
  const { mcu, ast } = loadCase(folder, name);
  const res = solveTwoPhase(ast, mcu, { maxGroups: 40, maxSolutionsPerGroup: 5, timeoutMs: 4000, costWeights: WEIGHTS, skipGpioMapping: skipGpio });
  expect(res.solutions.length).toBeGreaterThan(0);
  return { mcu, ast, sol: res.solutions[0] };
}

/** Every active config-combo must keep cross-port pin exclusivity + single pin per (port,config). */
function assertValid(sol: Solution): void {
  for (const ca of sol.configAssignments) {
    const pinOwner = new Map<string, string>();
    const pcPins = new Set<string>();
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      const owner = pinOwner.get(a.pinName);
      expect(owner === undefined || owner === a.portName, `pin ${a.pinName} shared by ${owner} & ${a.portName}`).toBe(true);
      pinOwner.set(a.pinName, a.portName);
      const k = `${a.portName}\0${a.configurationName}\0${a.pinName}`;
      expect(pcPins.has(k), `pin ${a.pinName} reused in ${a.portName}/${a.configurationName}`).toBe(false);
      pcPins.add(k);
    }
  }
}

describe('SolutionEditor', () => {
  it('reconstructs baseline cost matching the solver', () => {
    const { mcu, ast, sol } = firstSolution('g474', 'multi_config');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    expect(ed).toBeTruthy();
    expect(ed.baselineCost).toBeCloseTo(sol.totalCost, 4);
    expect(ed.toSolution().totalCost).toBeCloseTo(sol.totalCost, 4);
    assertValid(ed.toSolution());
  });

  it('modifier 1: a pin move applies its reported cost delta and stays valid', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    // Find any variable with at least one pin move.
    let applied = false;
    for (const v of (ed as any).ctx.variables) {
      const moves = ed.listPinMoves(v);
      if (moves.length === 0) continue;
      const m = moves[0];
      const before = ed.currentCost;
      const predicted = before + m.costDelta;
      m.apply();
      expect(ed.currentCost).toBeCloseTo(predicted, 6);
      assertValid(ed.toSolution());
      applied = true;
      break;
    }
    expect(applied).toBe(true);
  });

  it('modifier 3: swaps structurally-identical ports, cost-neutral and valid', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    const swaps = ed.listPortSwaps('ENC0');
    // ENC0/ENC1/ENC2 are structurally identical → at least one swap target.
    expect(swaps.length).toBeGreaterThan(0);
    const before = ed.currentCost;
    // Whole-port swap of identical ports is cost-neutral (same pin set, relabeled).
    expect(Math.abs(swaps[0].costDelta)).toBeLessThan(1e-6);
    swaps[0].apply();
    expect(ed.currentCost).toBeCloseTo(before, 6);
    assertValid(ed.toSolution());
  });

  it('modifier 2: unassign then reassign a pin round-trips', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    // Pick an occupied pin from the solution.
    const occupied = sol.configAssignments[0].assignments.find(a => a.portName !== '<pinned>')!;
    const moves = ed.movesForPin(occupied.pinName);
    const un = moves.find(m => m.label.startsWith('Unassign'));
    expect(un).toBeTruthy();
    un!.apply();
    assertValid(ed.toSolution());
    // Pin now free → an assign option must offer to place the same channel back.
    const back = ed.movesForPin(occupied.pinName).find(m => m.label.startsWith(`${occupied.portName}.${occupied.channelName}:`));
    expect(back).toBeTruthy();
    back!.apply();
    assertValid(ed.toSolution());
  });

  it('modifier 5: replaces a peripheral with an unused instance when one exists', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    // Find a port+instance that has an unused-instance replacement.
    let found = false;
    for (const [port, periphs] of sol.portPeripherals) {
      for (const inst of periphs) {
        const reps = ed.listUnusedReplacements(port, inst);
        if (reps.length === 0) continue;
        const before = ed.currentCost;
        reps[0].apply();
        expect(ed.currentCost).toBeCloseTo(before + reps[0].costDelta, 6);
        assertValid(ed.toSolution());
        found = true;
        break;
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });

  it('modifier 4: swaps one peripheral between two ports when compatible', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    let found = false;
    for (const [port, periphs] of sol.portPeripherals) {
      for (const inst of periphs) {
        const swaps = ed.listPeripheralSwaps(port, inst);
        if (swaps.length === 0) continue;
        const before = ed.currentCost;
        swaps[0].apply();
        expect(ed.currentCost).toBeCloseTo(before + swaps[0].costDelta, 6);
        assertValid(ed.toSolution());
        found = true;
        break;
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });

  it('highlightPins covers both the vacated pin and the newly-occupied pin', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    let checked = false;
    for (const v of (ed as any).ctx.variables) {
      const moves = ed.listPinMoves(v);
      if (moves.length === 0) continue;
      const m = moves[0];
      const newPin = m.label.split('→')[1].trim(); // "SIG → NEWPIN"
      // Both the current pin and the target pin must be highlighted (was: target only).
      expect(m.highlightPins).toContain(newPin);
      expect(m.highlightPins.length).toBeGreaterThanOrEqual(2);
      checked = true;
      break;
    }
    expect(checked).toBe(true);
  });

  it('unused-instance replacement highlights new pins, not only current ones', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    const instOf = (sig: string) => sig.match(/^([A-Z]+\d+)/)?.[1] ?? '';
    let checked = false;
    for (const [port, periphs] of sol.portPeripherals) {
      for (const inst of periphs) {
        const reps = ed.listUnusedReplacements(port, inst);
        if (reps.length === 0) continue;
        const curPins = new Set(
          sol.configAssignments.flatMap(ca => ca.assignments)
            .filter(a => a.portName === port && instOf(a.signalName) === inst)
            .map(a => a.pinName));
        const hp = reps[0].highlightPins;
        // Must include at least one pin the peripheral does NOT currently occupy.
        expect(hp.some(p => !curPins.has(p))).toBe(true);
        checked = true;
        break;
      }
      if (checked) break;
    }
    expect(checked).toBe(true);
  });

  it('clicking a free pin offers relocating an assigned signal there (both directions)', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, false)!;
    for (const v of (ed as any).ctx.variables) {
      const moves = ed.listPinMoves(v);
      if (moves.length === 0) continue;
      const sig = moves[0].label.split('→')[0].trim(); // "ENC0.CS:SPI2:NSS"
      const newPin = moves[0].label.split('→')[1].trim();
      // The reverse direction: clicking the (free) target pin must offer moving it back here.
      const back = ed.movesForPin(newPin).find(m => m.label.startsWith(`${sig} from `));
      expect(back).toBeTruthy();
      return;
    }
    throw new Error('expected at least one pin move');
  });

  it('clicking a free pin offers unmapped IN/OUT signals (skipGpio=false)', () => {
    // ecat_more_complex has real IN/OUT channels (en0, led_*); solve it with the
    // conflict-directed solver (two-phase can't) using skipGpio so they're unmapped.
    const { mcu, ast } = loadCase('h755i', 'ecat_more_complex');
    const res = solveConflictDirected(ast, mcu, {
      maxSolutions: 5, timeoutMs: 10000, costWeights: WEIGHTS, skipGpioMapping: true,
    });
    expect(res.solutions.length).toBeGreaterThan(0);
    const sol = res.solutions[0];
    // Editor with skipGpio=false → the IN/OUT channels become placeable variables.
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, false)!;
    const assignedPins = new Set(
      sol.configAssignments.flatMap(ca => ca.assignments)
        .filter(a => a.portName !== '<pinned>').map(a => a.pinName));
    const gpioVar = (ed as any).ctx.variables.find((v: any) => !(ed as any).assigned.has(v) && isGpioVariable(v));
    expect(gpioVar, 'no unmapped IN/OUT variable in the editor context').toBeTruthy();
    const freePin = gpioVar.candidates.map((c: any) => c.pin.name).find((p: string) => !assignedPins.has(p));
    expect(freePin, 'no free candidate pin for the GPIO channel').toBeTruthy();

    const opts = ed.movesForPin(freePin);
    const prefix = `${gpioVar.portName}.${gpioVar.channelName}:`;
    const matching = opts.filter(m => m.label.startsWith(prefix));
    // A channel present in several configs must appear ONCE, not once per config.
    expect(matching.length).toBe(1);

    // Applying it takes the pin in every config of that channel that can use it.
    matching[0].apply();
    const chanVars = (ed as any).ctx.variables.filter(
      (v: any) => v.portName === gpioVar.portName && v.channelName === gpioVar.channelName);
    const withCand = chanVars.filter((v: any) => v.candidates.some((c: any) => c.pin.name === freePin));
    expect(withCand.length).toBeGreaterThan(0);
    for (const v of withCand) {
      expect((ed as any).assigned.get(v)?.pin.name).toBe(freePin);
    }
  }, 15000);

  it('undo/redo restores cost and assignment exactly', () => {
    const { mcu, ast, sol } = firstSolution('h755i', 'ecat_complex');
    const ed = SolutionEditor.fromSolution(sol, ast, mcu, WEIGHTS, true)!;
    const base = ed.currentCost;
    const swaps = ed.listPortSwaps('ENC0');
    const move = swaps[0] ?? null;
    // Use a pin move if no swap (ensures a change happens).
    let changed = false;
    if (move) { move.apply(); changed = true; }
    else {
      for (const v of (ed as any).ctx.variables) {
        const m = ed.listPinMoves(v);
        if (m.length) { m[0].apply(); changed = true; break; }
      }
    }
    expect(changed).toBe(true);
    const afterApply = ed.currentCost;

    expect(ed.canUndo()).toBe(true);
    ed.undo();
    expect(ed.currentCost).toBeCloseTo(base, 6);
    expect(ed.canRedo()).toBe(true);
    ed.redo();
    expect(ed.currentCost).toBeCloseTo(afterApply, 6);
    assertValid(ed.toSolution());
  });
});
