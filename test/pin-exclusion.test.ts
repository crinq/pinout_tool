import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import type { Mcu, Solution } from '../src/types';

// `@ !PIN` must remove the pin from the solver's domain, at channel, port and
// config level. Each case picks a pin the unconstrained solve actually uses,
// then re-solves with it excluded and asserts it never appears again.

function loadG474(): Mcu {
  const dir = join(__dirname, 'g474');
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const mcu = loadG474();
const CFG = { maxSolutions: 100, timeoutMs: 5000, costWeights: new Map<string, number>() };

function solve(src: string): Solution[] {
  const { ast, errors } = parseConstraints(src);
  expect(errors, errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return solveConstraints(ast!, mcu, CFG).solutions;
}

/** Pins used by a channel across all solutions. */
function pinsOf(sols: Solution[], channel?: string): Set<string> {
  const out = new Set<string>();
  for (const s of sols) for (const ca of s.configAssignments) for (const a of ca.assignments) {
    if (a.portName === '<pinned>') continue;
    if (!channel || a.channelName === channel) out.add(a.pinName);
  }
  return out;
}

/** Placement clauses go after the `:` on port/config headers, after the name on channels. */
const PORT = (portAt = '', txAt = '', cfgAt = '') => `port P:${portAt}
  channel TX${txAt}
  channel RX

  config "c":${cfgAt}
    TX = USART*_TX $u
    RX = USART*_RX $u`;

describe('@ !pin exclusion', () => {
  const baseline = solve(PORT());

  it('the baseline solves and uses pins', () => {
    expect(baseline.length).toBeGreaterThan(0);
    expect(pinsOf(baseline).size).toBeGreaterThan(1);
  });

  it('channel-level `@ !PIN` bars that pin from that channel only', () => {
    const txPin = [...pinsOf(baseline, 'TX')][0];
    const sols = solve(PORT('', ` @ !${txPin}`));
    expect(sols.length).toBeGreaterThan(0);            // still solvable
    expect(pinsOf(sols, 'TX').has(txPin)).toBe(false); // TX avoids it
  });

  it('port-level `@ !PIN` bars the pin from every channel of the port', () => {
    const pin = [...pinsOf(baseline)][0];
    const sols = solve(PORT(` @ !${pin}`));
    expect(sols.length).toBeGreaterThan(0);
    expect(pinsOf(sols).has(pin)).toBe(false);
  });

  it('config-level `@ !PIN` bars the pin from channels mapped in that config', () => {
    const pin = [...pinsOf(baseline)][0];
    const sols = solve(PORT('', '', ` @ !${pin}`));
    expect(sols.length).toBeGreaterThan(0);
    expect(pinsOf(sols).has(pin)).toBe(false);
  });

  it('a mixed `@ PIN, !PIN` list applies both parts', () => {
    const txPin = [...pinsOf(baseline, 'TX')][0];
    const src = `port P:
  channel TX @ ${txPin}, !${txPin}
  channel RX

  config "c":
    TX = USART*_TX $u
    RX = USART*_RX $u`;
    // Required and excluded cancel out → TX has an empty domain → no solutions.
    expect(solve(src).length).toBe(0);
  });
});
