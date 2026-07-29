import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { runPreSolveChecks } from '../src/solver/solver';
import type { Mcu } from '../src/types';

// A constraint that needs QUADSPI. h755 has that peripheral; f405 does not.
// A multi-MCU solve must keep h755 and skip f405 rather than aborting the run.
const QSPI_CONSTRAINT = `port QSPI:
  channel CLK

  config "q":
    CLK = QUADSPI*_CLK`;

function loadMcu(folder: string): Mcu {
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const hasFatal = (mcu: Mcu, ast: Parameters<typeof runPreSolveChecks>[0]) =>
  runPreSolveChecks(ast, mcu).some(e => e.type === 'error');

describe('multi-MCU pre-solve gating (skip incapable CPUs, do not abort)', () => {
  const h755 = loadMcu('h755i'); // has QUADSPI
  const f405 = loadMcu('f405v'); // no QUADSPI
  const ast = parseConstraints(QSPI_CONSTRAINT).ast!;

  it('flags the peripheral-missing MCU as fatal, the capable one as clean', () => {
    expect(hasFatal(f405, ast)).toBe(true);  // no QUADSPI → would fail on its own
    expect(hasFatal(h755, ast)).toBe(false); // has QUADSPI → solvable
  });

  it('partitions a mixed candidate list into solvable + skipped (run proceeds)', () => {
    const candidates = [f405, h755]; // incapable one first — used to abort the whole run
    const solvable = candidates.filter(m => !hasFatal(m, ast));
    const skipped = candidates.filter(m => hasFatal(m, ast));

    expect(solvable.map(m => m.refName)).toEqual([h755.refName]);
    expect(skipped.map(m => m.refName)).toEqual([f405.refName]);
    expect(solvable.length).toBeGreaterThan(0); // → app solves survivors instead of aborting
  });
});
