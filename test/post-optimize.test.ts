import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { postOptimizeSolutions } from '../src/solver/post-optimize';
import type { Mcu, Solution, SolverResult } from '../src/types';

const COST_WEIGHTS = new Map<string, number>([
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

/** Structural validity — every active combo must keep pin exclusivity. */
function assertValid(result: { solutions: Solution[] }): void {
  for (const sol of result.solutions.slice(0, 30)) {
    for (const ca of sol.configAssignments) {
      const pinOwner = new Map<string, string>();
      const pcPins = new Set<string>();
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const owner = pinOwner.get(a.pinName);
        expect(owner === undefined || owner === a.portName).toBe(true);
        pinOwner.set(a.pinName, a.portName);
        const k = `${a.portName}\0${a.configurationName}\0${a.pinName}`;
        expect(pcPins.has(k)).toBe(false);
        pcPins.add(k);
      }
    }
  }
}

describe('post-optimize', () => {
  it('never increases cost and keeps solutions valid (g474/multi_config)', () => {
    const { mcu, ast } = loadCase('g474', 'multi_config');
    const base = solveTwoPhase(ast, mcu, {
      maxGroups: 30, maxSolutionsPerGroup: 5, timeoutMs: 4000, costWeights: COST_WEIGHTS,
    });
    expect(base.solutions.length).toBeGreaterThan(0);

    const before = base.solutions.map(s => s.totalCost).sort((a, b) => a - b);
    const { solutions, improved, processed } = postOptimizeSolutions(base.solutions, ast, mcu, {
      costWeights: COST_WEIGHTS, timeoutMs: 5000,
    });
    const after = solutions.map(s => s.totalCost).sort((a, b) => a - b);

    // Best cost must not get worse; typically it improves.
    expect(after[0]).toBeLessThanOrEqual(before[0] + 1e-9);
    expect(processed).toBeGreaterThan(0);
    expect(improved).toBeGreaterThanOrEqual(0);
    assertValid({ solutions });
  });

  it('reaches a local optimum: a second pass yields no further gain', () => {
    const { mcu, ast } = loadCase('g474', 'simple_uart_spi');
    const base = solveTwoPhase(ast, mcu, {
      maxGroups: 20, maxSolutionsPerGroup: 5, timeoutMs: 4000, costWeights: COST_WEIGHTS,
    });
    const first = postOptimizeSolutions(base.solutions, ast, mcu, { costWeights: COST_WEIGHTS, timeoutMs: 5000 });
    const second = postOptimizeSolutions(first.solutions, ast, mcu, { costWeights: COST_WEIGHTS, timeoutMs: 5000 });
    // Already at a local optimum — nothing left to improve.
    expect(second.improved).toBe(0);
    assertValid(second);
  });

  it('preserves peripheral instances (only pins move, not structure)', () => {
    const { mcu, ast } = loadCase('g474', 'multi_config');
    const base = solveTwoPhase(ast, mcu, {
      maxGroups: 20, maxSolutionsPerGroup: 3, timeoutMs: 4000, costWeights: COST_WEIGHTS,
    });
    const groupsBefore = new Set(base.solutions.map(s =>
      [...s.portPeripherals].map(([p, set]) => `${p}:${[...set].sort().join(',')}`).sort().join('|')));
    const { solutions } = postOptimizeSolutions(base.solutions, ast, mcu, { costWeights: COST_WEIGHTS, timeoutMs: 5000 });
    const groupsAfter = new Set(solutions.map(s =>
      [...s.portPeripherals].map(([p, set]) => `${p}:${[...set].sort().join(',')}`).sort().join('|')));
    // Every post-optimized structural fingerprint existed before (no new instances introduced).
    for (const g of groupsAfter) expect(groupsBefore.has(g)).toBe(true);
  });
});
