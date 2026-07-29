import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, runPreSolveChecks } from '../src/solver/solver';
import type { Mcu } from '../src/types';

// P2: the numeric `require` functions and comparison/boolean operators are
// parsed but had no test proving they are actually ENFORCED during solving.
// Strategy: a contradictory require (`f(A) < f(B)` AND `f(A) > f(B)`) is
// unsatisfiable for any real values, so it must prune every solution — but
// only if the function+operator is evaluated. If it were ignored, the baseline
// solutions would survive. The pattern is geometry-independent.

function loadG474(): Mcu {
  const dir = join(__dirname, 'g474');
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const mcu = loadG474();
const CFG = { maxSolutions: 50, timeoutMs: 5000, costWeights: new Map<string, number>() };

// A two-channel USART port (A=TX, B=RX on the same instance) — solvable on g474.
const BASE = `port P:
  channel A
  channel B

  config "u":
    A = USART*_TX $u
    B = USART*_RX $u`;

/** Solution count for BASE plus the given extra require line(s). */
function count(extra = ''): number {
  const src = extra ? `${BASE}\n    ${extra.replace(/\n/g, '\n    ')}` : BASE;
  const { ast, errors } = parseConstraints(src);
  expect(errors, errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return solveConstraints(ast!, mcu, CFG).solutions.length;
}

describe('require function/operator evaluation (enforced, not just parsed)', () => {
  const baseline = count();

  it('the baseline port is solvable', () => {
    expect(baseline).toBeGreaterThan(0);
  });

  it('a contradiction with a numeric function prunes everything', () => {
    // Each function must be evaluated; a contradictory pair yields 0.
    for (const f of ['pin_number', 'channel_number', 'instance_number', 'pin_row', 'pin_col']) {
      const n = count(`require ${f}(A) < ${f}(B)\nrequire ${f}(A) > ${f}(B)`);
      expect(n, `${f} contradiction should yield 0 solutions`).toBe(0);
    }
  });

  it('pin_number distinguishes the two (distinct) pins — == fails, != holds', () => {
    // A and B land on different pins (pin exclusivity), so == is never true...
    expect(count('require pin_number(A) == pin_number(B)')).toBe(0);
    // ...and != always holds, leaving the baseline intact.
    expect(count('require pin_number(A) != pin_number(B)')).toBe(baseline);
  });

  it('pin_distance is enforced (< 0 is impossible)', () => {
    expect(count('require pin_distance(A, B) < 0')).toBe(0);
    expect(count('require pin_distance(A, B) >= 0')).toBe(baseline);
  });

  it('boolean OR (|) is evaluated', () => {
    // Both operands false (no pin number exceeds 9999) → OR false → 0.
    expect(count('require pin_number(A) > 9999 | pin_number(B) > 9999')).toBe(0);
  });

  it('boolean XOR (^) is evaluated', () => {
    // false ^ false = false → 0.
    expect(count('require pin_number(A) > 9999 ^ pin_number(B) > 9999')).toBe(0);
  });
});

// P4: duplicate channel names are caught by pre-solve validation, not the parser.
describe('pre-solve validation — duplicate channel', () => {
  it('flags a port with two channels of the same name', () => {
    const src = `port P:
  channel TX
  channel TX

  config "c":
    TX = USART*_TX`;
    const { ast } = parseConstraints(src);
    const errs = runPreSolveChecks(ast!, mcu).filter(e => e.type === 'error');
    expect(errs.length).toBeGreaterThan(0);
  });
});
