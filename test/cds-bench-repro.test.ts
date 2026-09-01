import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConflictDirected, luby } from '../src/solver/conflict-directed-solver';

// Regression: a broken Luby implementation spun forever at luby(4) — the
// solver hung as soon as a run survived to its third restart (benchmark
// params: high maxSolutions so the solution cap doesn't end the run first).
describe('cds restart regression', () => {
  it('luby sequence is correct and total', () => {
    const expected = [1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, 1];
    expect(expected.map((_, i) => luby(i + 1))).toEqual(expected);
    // Positions that previously diverged (i not of the form 2^k-1)
    for (let i = 1; i <= 200; i++) expect(luby(i)).toBeGreaterThan(0);
  });

  it('terminates under enumeration pressure (benchmark params)', () => {
    const folderPath = join(__dirname, 'h755i');
    const xmlFiles = readdirSync(folderPath).filter(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'));
    const mcu = parseMcuXml(readFileSync(join(folderPath, xmlFiles[0]), 'utf-8'));
    const dmaFiles = readdirSync(folderPath).filter(f => f.startsWith('DMA-') && f.endsWith('.xml'));
    if (dmaFiles.length > 0) {
      const t = readFileSync(join(folderPath, dmaFiles[0]), 'utf-8');
      if (isDmaXml(t)) mcu.dma = parseDmaXml(t);
    }
    const { ast } = parseConstraints(readFileSync(join(folderPath, 'pass', 'ecat_complex.txt'), 'utf-8'));

    const t0 = performance.now();
    const result = solveConflictDirected(ast!, mcu, {
      maxSolutions: 5000,
      timeoutMs: 3000,
      costWeights: new Map<string, number>([
        ['pin_count', 1], ['port_spread', 0.2], ['peripheral_count', 0.5],
        ['debug_pin_penalty', 0], ['pin_clustering', 0], ['pin_proximity', 1],
      ]),
      skipGpioMapping: true,
    });
    const dt = performance.now() - t0;
    expect(result.solutions.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(15000); // hang manifests as >> timeout
  }, 20000);
});
