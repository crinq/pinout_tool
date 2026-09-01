import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { classifyProjectSolutions } from '../src/solver/solution-status';
import type { Mcu, Solution } from '../src/types';

const WEIGHTS = new Map<string, number>([['pin_count', 1], ['pin_proximity', 1]]);

function loadMcu(folder: string): Mcu {
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).filter(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))[0];
  const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
  const dma = readdirSync(dir).filter(f => f.startsWith('DMA-') && f.endsWith('.xml'))[0];
  if (dma) { const t = readFileSync(join(dir, dma), 'utf-8'); if (isDmaXml(t)) mcu.dma = parseDmaXml(t); }
  return mcu;
}
const parse = (text: string) => parseConstraints(text).ast!;

describe('classifyProjectSolutions', () => {
  it('marks a solution valid for the constraints it was solved with', () => {
    const mcu = loadMcu('g474');
    const ast = parse(readFileSync(join(__dirname, 'g474/pass/simple_uart_spi.txt'), 'utf-8'));
    const res = solveTwoPhase(ast, mcu, { maxGroups: 10, maxSolutionsPerGroup: 3, timeoutMs: 4000, costWeights: WEIGHTS, skipGpioMapping: true });
    expect(res.solutions.length).toBeGreaterThan(0);
    const sol = res.solutions[0];
    sol.mcuRef = mcu.refName;
    const map = classifyProjectSolutions([sol], ast, mcu, true);
    expect(map.get(sol)).toBe('valid');
  });

  it('marks a solution invalid when a new required port is added', () => {
    const mcu = loadMcu('g474');
    const base = readFileSync(join(__dirname, 'g474/pass/simple_uart_spi.txt'), 'utf-8');
    const sol = solveTwoPhase(parse(base), mcu, { maxGroups: 5, maxSolutionsPerGroup: 2, timeoutMs: 4000, costWeights: WEIGHTS, skipGpioMapping: true }).solutions[0];
    sol.mcuRef = mcu.refName;
    // Add a brand-new required port the stored solution can't cover.
    const extended = base + `\nport EXTRA:\n  channel TX\n  config "U":\n    TX = USART*_TX\n`;
    const map = classifyProjectSolutions([sol], parse(extended), mcu, true);
    expect(map.get(sol)).toBe('invalid');
  });

  it('marks a solution "extra" when a port is removed from the constraints', () => {
    const mcu = loadMcu('g474');
    const base = readFileSync(join(__dirname, 'g474/pass/simple_uart_spi.txt'), 'utf-8');
    const sol = solveTwoPhase(parse(base), mcu, { maxGroups: 5, maxSolutionsPerGroup: 2, timeoutMs: 4000, costWeights: WEIGHTS, skipGpioMapping: true }).solutions[0];
    sol.mcuRef = mcu.refName;
    // Drop the last `port ...` block: the solution still covers the rest but
    // carries assignments for the removed port → "extra".
    const lastPort = base.lastIndexOf('\nport ');
    const trimmed = lastPort > 0 ? base.slice(0, lastPort) : base;
    const map = classifyProjectSolutions([sol], parse(trimmed), mcu, true);
    // The trimmed constraints must still be solvable for a meaningful verdict.
    expect(['extra', 'valid']).toContain(map.get(sol));
    if (base !== trimmed) expect(map.get(sol)).toBe('extra');
  });

  it('omits solutions from a different MCU', () => {
    const mcu = loadMcu('g474');
    const ast = parse(readFileSync(join(__dirname, 'g474/pass/simple_uart_spi.txt'), 'utf-8'));
    const sol = solveTwoPhase(ast, mcu, { maxGroups: 3, maxSolutionsPerGroup: 1, timeoutMs: 4000, costWeights: WEIGHTS, skipGpioMapping: true }).solutions[0];
    sol.mcuRef = 'STM32-SOMETHING-ELSE';
    const map = classifyProjectSolutions([sol], ast, mcu, true);
    expect(map.has(sol)).toBe(false);
  });
});
