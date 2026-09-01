import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { setActiveAnchorsFor } from '../src/solver/solver';
import { setActiveAnchors } from '../src/solver/cost-functions';
import type { Mcu, Solution } from '../src/types';

// two-phase does NOT call prepareSolverContext, so it only sees anchors when a
// solve entry sets them (the worker's handle() now does). This locks that the
// hard port/config anchor actually filters through that solver.

function loadG474(): Mcu {
  const dir = join(__dirname, 'g474');
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const TP = {
  maxGroups: 200, maxSolutionsPerGroup: 20, timeoutMs: 5000,
  costWeights: new Map<string, number>([['pin_count', 1], ['pin_proximity', 1], ['pin_anchor', 1]]),
  skipGpioMapping: true,
};

const usesPin = (sol: Solution, pin: string): boolean =>
  sol.configAssignments.some(ca => ca.assignments.some(a => a.pinName === pin));

describe('hard port anchor filters through solveTwoPhase', () => {
  const mcu = loadG474();

  it('keeps only solutions that place a channel on the port-anchored pin', () => {
    const base = `port ENC:
  channel SCK
  channel MISO

  config "SPI":
    SCK = SPI*_SCK $s
    MISO = SPI*_MISO $s`;

    // Unanchored baseline (make sure no stale anchors leak in).
    setActiveAnchors(null);
    const baseRes = solveTwoPhase(parseConstraints(base).ast!, mcu, TP);
    expect(baseRes.solutions.length).toBeGreaterThan(1);

    // Pick a pin used by some baseline solution, but NOT by all of them, so the
    // filter has something real to remove.
    const candidatePins = new Set<string>();
    for (const sol of baseRes.solutions) for (const ca of sol.configAssignments)
      for (const a of ca.assignments) if (a.portName === 'ENC') candidatePins.add(a.pinName);
    const pin = [...candidatePins].find(p => baseRes.solutions.some(s => !usesPin(s, p)));
    expect(pin, 'expected a pin not used by every baseline solution').toBeDefined();

    // Anchored: `port ENC: @ <pin>` — every surviving solution must use it.
    const anchored = `port ENC: @ ${pin}\n` + base.split('\n').slice(1).join('\n');
    const ast = parseConstraints(anchored).ast!;
    expect(parseConstraints(anchored).errors.filter(e => e.type === 'error')).toEqual([]);
    setActiveAnchorsFor(ast, mcu); // what the worker entry now does
    const res = solveTwoPhase(ast, mcu, TP);

    expect(res.solutions.length).toBeGreaterThan(0);
    expect(res.solutions.length).toBeLessThan(baseRes.solutions.length);
    for (const sol of res.solutions) expect(usesPin(sol, pin!)).toBe(true);
  });
});
