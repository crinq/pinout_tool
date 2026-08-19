import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuJson } from '../src/parser/mcu-json-parser';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, runPreSolveChecks } from '../src/solver/solver';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import type { Mcu, Solution } from '../src/types';

// `require flag(ch, "name", value)`: every pin the channel occupies must carry
// that per-pin flag with that value; a missing flag fails.
//
// Fixture is real catalogue data (stm32f103vb.json): all 80 GPIOs carry
// `5V_tolerant`, 60 true / 20 false. Handily, PA2/PA3 (USART2_TX/RX) are the
// only USART pins that are NOT 5V tolerant — every other USART pin is.
const variants = parseMcuJson(readFileSync(join(__dirname, 'fixtures/stm32f103vb.json'), 'utf-8'));
const mcu: Mcu = variants.find(m => m.package === 'LQFP100') ?? variants[0];

const CFG = { maxSolutions: 400, timeoutMs: 8000, costWeights: new Map<string, number>() };
const solve = (src: string): Solution[] => {
  const { ast, errors } = parseConstraints(src);
  expect(errors, errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return solveConstraints(ast!, mcu, CFG).solutions;
};
const pinsOf = (sols: Solution[], channel: string) => new Set(
  sols.flatMap(s => s.configAssignments.flatMap(ca => ca.assignments))
      .filter(a => a.channelName === channel).map(a => a.pinName),
);
const flagOf = (pin: string) =>
  mcu.logicalPins.find(p => p.name === pin)?.flags?.['5V_tolerant'];

describe('per-pin flags from the catalogue', () => {
  it('parses the flags dict for every GPIO', () => {
    const flagged = mcu.logicalPins.filter(p => p.flags?.['5V_tolerant'] !== undefined);
    expect(flagged.length).toBeGreaterThan(50);
    expect(flagOf('PA9')).toBe(true);    // USART1_TX — tolerant
    expect(flagOf('PA2')).toBe(false);   // USART2_TX — not tolerant
  });

  it('CubeMX XML carries no flags', () => {
    const dir = join(__dirname, 'f405v');
    const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
    const x = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
    expect(x.logicalPins.every(p => p.flags === undefined)).toBe(true);
  });
});

describe('require flag(...)', () => {
  const base = (extra = '') => `port P:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)${extra ? '\n  ' + extra : ''}`;

  it('without the constraint, both tolerant and non-tolerant pins appear', () => {
    const pins = pinsOf(solve(base()), 'TX');
    expect([...pins].some(p => flagOf(p) === true)).toBe(true);
    expect(pins.has('PA2')).toBe(true);           // the non-tolerant one
  });

  it('true keeps only pins flagged true', () => {
    const sols = solve(base('require flag(TX, "5V_tolerant", true)'));
    expect(sols.length).toBeGreaterThan(0);
    const pins = pinsOf(sols, 'TX');
    expect(pins.size).toBeGreaterThan(0);
    for (const p of pins) expect(flagOf(p), p).toBe(true);
    expect(pins.has('PA2')).toBe(false);
  });

  it('false keeps only pins flagged false', () => {
    const pins = pinsOf(solve(base('require flag(TX, "5V_tolerant", false)')), 'TX');
    expect(pins.size).toBeGreaterThan(0);
    for (const p of pins) expect(flagOf(p), p).toBe(false);
    expect([...pins]).toEqual(['PA2']);           // the only non-tolerant USART TX
  });

  it('constrains both channels independently', () => {
    const sols = solve(base('require flag(TX, "5V_tolerant", true)\n  require flag(RX, "5V_tolerant", true)'));
    expect(sols.length).toBeGreaterThan(0);
    for (const p of pinsOf(sols, 'TX')) expect(flagOf(p), p).toBe(true);
    for (const p of pinsOf(sols, 'RX')) expect(flagOf(p), p).toBe(true);
  });

  it('a missing flag fails the condition', () => {
    expect(solve(base('require flag(TX, "no_such_flag", true)'))).toHaveLength(0);
  });

  it('applies to every pin of a multi-pin channel', () => {
    const src = `port P:
  channel BOTH = USART*_TX + USART*_RX
  require flag(BOTH, "5V_tolerant", false)`;
    // PA2/PA3 are the only non-tolerant TX/RX, and they are the same instance.
    const pins = pinsOf(solve(src), 'BOTH');
    expect([...pins].sort()).toEqual(['PA2', 'PA3']);
  });

  it('is accepted by pre-solve validation (known function)', () => {
    const { ast } = parseConstraints(base('require flag(TX, "5V_tolerant", true)'));
    const errs = runPreSolveChecks(ast!, mcu).filter(e => /unknown function/i.test(e.message));
    expect(errs).toEqual([]);
  });

  it('holds through the two-phase solver as well', () => {
    const { ast } = parseConstraints(base('require flag(TX, "5V_tolerant", true)'));
    const r = solveTwoPhase(ast!, mcu, { maxGroups: 50, maxSolutionsPerGroup: 5, timeoutMs: 8000, costWeights: new Map() });
    expect(r.solutions.length).toBeGreaterThan(0);
    for (const p of pinsOf(r.solutions, 'TX')) expect(flagOf(p), p).toBe(true);
  });

  it('works with require? (soft) without breaking the solve', () => {
    const sols = solve(base('require? flag(TX, "no_such_flag", true)'));
    expect(sols.length).toBeGreaterThan(0);   // soft failure is ignored
  });
});
