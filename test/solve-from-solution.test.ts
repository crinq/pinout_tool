import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, setFixedAssignments } from '../src/solver/solver';
import { runSingleSolver } from '../src/solver/solver-worker-impl';
import { SolutionEditor } from '../src/solver/solution-editor';
import type { Assignment, Solution } from '../src/types';

const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));
const ast = parseConstraints(`
port COM:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)

port BUS:
  channel MOSI = SPI*_MOSI
  channel SCK = SPI*_SCK
  require same_instance(MOSI, SCK)

port IO:
  channel LED = OUT
`).ast!;

const flat = (s: Solution): Assignment[] => s.configAssignments.flatMap(ca => ca.assignments);
const pinOf = (s: Solution, port: string, ch: string) =>
  flat(s).find(a => a.portName === port && a.channelName === ch)?.pinName;

afterEach(() => setFixedAssignments(null));

// A base solution that does not use the cheapest COM pins, so keeping it is observable.
const base = solveConstraints(ast, mcu, { maxSolutions: 50, timeoutMs: 5000, costWeights: new Map(), skipGpioMapping: false })
  .solutions.at(-1)!;
const kept = flat(base).filter(a => a.portName !== 'BUS');          // the user unassigned BUS

describe('solve from solution', () => {
  it.each([
    'backtracking', 'cost-guided', 'ac3', 'dynamic-mrv', 'priority-backtracking', 'randomized-restarts',
    'two-phase', 'diverse-instances', 'priority-two-phase', 'priority-diverse',
    'priority-group', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'conflict-directed', 'cegar', 'lns-repair', 'adaptive',
  ])('%s keeps the kept assignments and solves the rest', (id) => {
    setFixedAssignments(kept);
    const r = runSingleSolver(id, ast, mcu,
      { maxSolutions: 5, timeoutMs: 2000, costWeights: new Map(), skipGpioMapping: true },
      { maxGroups: 20, maxSolutionsPerGroup: 3 }, { numRestarts: 3 }, 'easy');
    expect(r.solutions.length, r.errors.map(e => e.message).join('; ')).toBeGreaterThan(0);
    for (const s of r.solutions) {
      expect(pinOf(s, 'COM', 'TX')).toBe(pinOf(base, 'COM', 'TX'));
      expect(pinOf(s, 'COM', 'RX')).toBe(pinOf(base, 'COM', 'RX'));
      // the kept OUT stays placed even with skip_gpio_mapping, so its pin stays taken
      expect(pinOf(s, 'IO', 'LED')).toBe(pinOf(base, 'IO', 'LED'));
      expect(pinOf(s, 'BUS', 'MOSI')).toBeDefined();
      expect(pinOf(s, 'BUS', 'SCK')).toBeDefined();
      const pins = flat(s).map(a => a.pinName);
      expect(new Set(pins).size).toBe(pins.length);
    }
  });

  it('solves kept assignments the constraints no longer allow fresh, with a warning', () => {
    setFixedAssignments([
      ...kept.filter(a => a.channelName !== 'TX'),
      { ...kept.find(a => a.channelName === 'TX')!, signalName: 'USART9_TX' },   // no such signal
    ]);
    const r = solveConstraints(ast, mcu, { maxSolutions: 3, timeoutMs: 2000, costWeights: new Map() });
    expect(r.solutions.length).toBeGreaterThan(0);
    expect(r.errors.map(e => e.message)).toContainEqual(
      expect.stringMatching(/^Solve from solution: 1 kept assignment\(s\) no longer fit .*COM\.TX/));
  });

  it('a normal solve is unaffected once cleared', () => {
    setFixedAssignments(kept);
    setFixedAssignments(null);
    const r = solveConstraints(ast, mcu, { maxSolutions: 50, timeoutMs: 2000, costWeights: new Map() });
    expect(new Set(r.solutions.map(s => pinOf(s, 'COM', 'TX'))).size).toBeGreaterThan(1);
  });
});

describe('unassign in the solution editor', () => {
  const ast2 = parseConstraints(`
port COM:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)

port DBG:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)

port BUS:
  channel MOSI = SPI*_MOSI
  channel SCK = SPI*_SCK
`).ast!;
  const sol = solveConstraints(ast2, mcu, { maxSolutions: 1, timeoutMs: 2000, costWeights: new Map(), skipGpioMapping: false }).solutions[0];
  const inst = (s: Solution, port: string) => flat(s).find(a => a.portName === port)!.signalName.split('_')[0];

  it('unassignInstance clears only that port\'s channels on the instance', () => {
    const ed = SolutionEditor.fromSolution(sol, ast2, mcu, new Map(), false)!;
    const comInst = inst(sol, 'COM');
    ed.unassignInstance('COM', comInst)!.apply();
    const after = ed.toSolution();
    expect(flat(after).some(a => a.portName === 'COM')).toBe(false);
    expect(pinOf(after, 'DBG', 'TX')).toBe(pinOf(sol, 'DBG', 'TX'));
    expect(pinOf(after, 'BUS', 'SCK')).toBe(pinOf(sol, 'BUS', 'SCK'));
    expect(ed.unassignInstance('COM', comInst)).toBeNull();     // nothing left to clear
    ed.undo();
    expect(pinOf(ed.toSolution(), 'COM', 'TX')).toBe(pinOf(sol, 'COM', 'TX'));
  });

  it('unassignPort + solve from the result keeps every other port and re-solves that one', () => {
    const ed = SolutionEditor.fromSolution(sol, ast2, mcu, new Map(), false)!;
    ed.unassignPort('BUS')!.apply();
    const partial = ed.toSolution();
    expect(flat(partial).some(a => a.portName === 'BUS')).toBe(false);
    setFixedAssignments(flat(partial));
    const r = solveConstraints(ast2, mcu, { maxSolutions: 5, timeoutMs: 2000, costWeights: new Map() });
    expect(r.solutions.length).toBeGreaterThan(0);
    for (const s of r.solutions) {
      for (const port of ['COM', 'DBG']) for (const ch of ['TX', 'RX']) expect(pinOf(s, port, ch)).toBe(pinOf(sol, port, ch));
      expect(pinOf(s, 'BUS', 'MOSI')).toBeDefined();
    }
  });
});
