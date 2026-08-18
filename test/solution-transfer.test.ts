import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, solutionDedupKey } from '../src/solver/solver';
import { toWire, fromWire } from '../src/solver/solution-transfer';
import type { Assignment, Solution, SolverResult } from '../src/types';

// The worker→main payload is the one place a big solve can exhaust the
// renderer's memory (every worker's solutions are live at once), so the format
// shares everything shareable. These tests pin both the shape and that nothing
// is lost by reconstructing it.

function loadF405(): ReturnType<typeof parseMcuXml> {
  const dir = join(__dirname, 'f405v');
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
  const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
  const per = mcu.peripherals.find(p => p.originalType === 'DMA');
  const dma = readdirSync(dir).find(f => f.startsWith('DMA-') && (!per || f.includes(per.version)));
  if (dma) { const t = readFileSync(join(dir, dma), 'utf-8'); if (isDmaXml(t)) mcu.dma = parseDmaXml(t); }
  return mcu;
}

const mcu = loadF405();
const src = readFileSync(join(__dirname, 'f405v/pass/dma_multi_config.txt'), 'utf-8');
const result: SolverResult = solveConstraints(
  parseConstraints(src).ast!, mcu,
  { maxSolutions: 40, timeoutMs: 8000, costWeights: new Map() },
);

const key = (a: Assignment) =>
  `${a.portName}|${a.channelName}|${a.pinName}|${a.signalName}|${a.configurationName}`;
const setOf = (as: Assignment[]) => new Set(as.map(key));

describe('worker wire format', () => {
  it('the fixture actually exercises configs, DMA and several solutions', () => {
    expect(result.solutions.length).toBeGreaterThan(1);
    const s = result.solutions[0];
    expect(s.configAssignments.length).toBeGreaterThan(1);          // multiple combos
    expect(mcu.dma).toBeDefined();
    expect(s.configAssignments.some(ca => (ca.dmaStreamAssignment?.size ?? 0) > 0)).toBe(true);
  });

  it('round-trips every solution losslessly', () => {
    const back = fromWire(toWire(result));
    expect(back.solutions).toHaveLength(result.solutions.length);
    expect(back.mcuRef).toBe(result.mcuRef);
    expect(back.statistics).toEqual(result.statistics);

    for (let i = 0; i < result.solutions.length; i++) {
      const a: Solution = result.solutions[i], b: Solution = back.solutions[i];
      expect(b.id, `id #${i}`).toBe(a.id);
      expect(b.totalCost, `cost #${i}`).toBe(a.totalCost);
      expect(b.gpioCount).toBe(a.gpioCount);
      expect([...b.costs]).toEqual([...a.costs]);
      expect([...b.portPeripherals].map(([k, v]) => [k, [...v].sort()]))
        .toEqual([...a.portPeripherals].map(([k, v]) => [k, [...v].sort()]));
      expect(b.configAssignments, `combos #${i}`).toHaveLength(a.configAssignments.length);

      for (let c = 0; c < a.configAssignments.length; c++) {
        const ca = a.configAssignments[c], cb = b.configAssignments[c];
        expect([...cb.activeConfigs].sort()).toEqual([...ca.activeConfigs].sort());
        // Assignments are re-selected from the shared pool, so compare as sets.
        expect(setOf(cb.assignments), `assignments #${i}/${c}`).toEqual(setOf(ca.assignments));
        expect([...(cb.dmaStreamAssignment ?? [])].sort())
          .toEqual([...(ca.dmaStreamAssignment ?? [])].sort());
      }
    }
  });

  it('shares the assignment pool and combo table across the whole result', () => {
    const w = toWire(result);
    const entries = result.solutions
      .flatMap(s => s.configAssignments)
      .reduce((n, ca) => n + ca.assignments.length, 0);
    const distinct = new Set(
      result.solutions.flatMap(s => s.configAssignments).flatMap(ca => ca.assignments.map(key)),
    ).size;
    expect(w.assignmentPool).toHaveLength(distinct);   // pooled once per result…
    expect(entries).toBeGreaterThan(distinct);          // …not once per combo
    // Every solution enumerates the same combinations, so the table is tiny.
    expect(w.comboTable.length).toBeLessThanOrEqual(result.solutions[0].configAssignments.length);
  });

  it('does not ship the dedup-key memo, and it still matches after transfer', () => {
    const w = toWire(result);
    expect(JSON.stringify(w)).not.toContain('_dedupKey');
    const back = fromWire(w);
    for (let i = 0; i < result.solutions.length; i++) {
      // recomputed on demand — must agree with the sender's key
      expect(solutionDedupKey(back.solutions[i])).toBe(solutionDedupKey(result.solutions[i]));
    }
  });

  it('interns DMA names instead of repeating them per solution', () => {
    const w = toWire(result);
    const dmaEntryCount = w.solutions.reduce((n, s) => n + s.combos.reduce((m, c) => m + (c.dma?.length ?? 0), 0), 0);
    if (dmaEntryCount === 0) return;
    expect(w.dmaStrings.length).toBeGreaterThan(0);
    expect(w.dmaStrings.length).toBeLessThan(dmaEntryCount * 2); // fewer names than slots
    for (const s of w.solutions) {
      for (const c of s.combos) {
        for (const [t, st] of c.dma ?? []) {
          expect(typeof t).toBe('number');
          expect(w.dmaStrings[t]).toBeTypeOf('string');
          expect(w.dmaStrings[st]).toBeTypeOf('string');
        }
      }
    }
  });
});
