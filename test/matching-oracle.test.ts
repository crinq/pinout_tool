import { describe, it, expect } from 'vitest';
import { checkGroupPinFeasibility } from '../src/solver/matching-oracle';
import type { SolverVariable } from '../src/solver/solver';
import type { SignalCandidate } from '../src/solver/pattern-matcher';

// Minimal candidate/variable builders — the oracle only reads
// pin.name, peripheralInstance and the domain indices.
function cand(pin: string, instance: string): SignalCandidate {
  return {
    pin: { name: pin, physical: { position: '' } } as never,
    signal: {} as never,
    signalName: `${instance}_X`,
    peripheralInstance: instance,
    peripheralType: instance.replace(/\d+$/, ''),
  };
}

function makeVar(
  port: string, channel: string, pins: Array<[string, string]>,
  config = 'C', optional = false
): SolverVariable {
  const candidates = pins.map(([p, i]) => cand(p, i));
  return {
    portName: port, channelName: channel, configName: config, exprIndex: 0,
    patternRaw: 'SPI*_X', candidates,
    domain: candidates.map((_, i) => i),
    optional,
  };
}

const COMBO = (ports: string[]) => [new Map(ports.map(p => [p, 'C']))];

describe('matching oracle', () => {
  it('accepts a feasible assignment', () => {
    const vars = [
      makeVar('A', 'x', [['PA0', 'SPI1'], ['PA1', 'SPI1']]),
      makeVar('B', 'y', [['PA1', 'SPI2'], ['PA2', 'SPI2']]),
    ];
    const res = checkGroupPinFeasibility(vars, COMBO(['A', 'B']), null);
    expect(res.feasible).toBe(true);
  });

  it('rejects pigeonhole-infeasible pools (3 vars, 2 pins)', () => {
    const vars = [
      makeVar('A', 'x', [['PA0', 'SPI1'], ['PA1', 'SPI1']]),
      makeVar('B', 'y', [['PA0', 'SPI2'], ['PA1', 'SPI2']]),
      makeVar('D', 'z', [['PA0', 'SPI3'], ['PA1', 'SPI3']]),
    ];
    const res = checkGroupPinFeasibility(vars, COMBO(['A', 'B', 'D']), null);
    expect(res.feasible).toBe(false);
    expect(res.violator).toBeDefined();
    expect(res.violator!.varIdxs.length).toBeGreaterThan(res.violator!.pinPool.length);
    expect(res.violator!.pinPool.sort()).toEqual(['PA0', 'PA1']);
  });

  it('respects instance-group filtering', () => {
    // Unrestricted: B can use PA9 via SPI9. Restricted to SPI2 it collides with A.
    const vars = [
      makeVar('A', 'x', [['PA0', 'SPI1']]),
      makeVar('B', 'y', [['PA0', 'SPI2'], ['PA9', 'SPI9']]),
    ];
    const combos = COMBO(['A', 'B']);
    expect(checkGroupPinFeasibility(vars, combos, null).feasible).toBe(true);

    const group = {
      assignments: new Map([
        ['A\0C\0x\x000', 'SPI1'],
        ['B\0C\0y\x000', 'SPI2'],
      ]),
    };
    const res = checkGroupPinFeasibility(vars, combos, group);
    expect(res.feasible).toBe(false);
  });

  it('reports a variable with zero candidates for its assigned instance', () => {
    const vars = [makeVar('A', 'x', [['PA0', 'SPI1']])];
    const group = { assignments: new Map([['A\0C\0x\x000', 'SPI5']]) };
    const res = checkGroupPinFeasibility(vars, COMBO(['A']), group);
    expect(res.feasible).toBe(false);
    expect(res.violator!.pinPool).toEqual([]);
  });

  it('ignores optional variables (sound relaxation)', () => {
    const vars = [
      makeVar('A', 'x', [['PA0', 'SPI1']]),
      makeVar('B', 'y', [['PA0', 'SPI2']], 'C', true),
    ];
    expect(checkGroupPinFeasibility(vars, COMBO(['A', 'B']), null).feasible).toBe(true);
  });

  it('only counts variables active in the combo', () => {
    // B's variable is for config "D", combo activates config "C" — not active.
    const vars = [
      makeVar('A', 'x', [['PA0', 'SPI1']]),
      makeVar('B', 'y', [['PA0', 'SPI2']], 'D'),
    ];
    const combos = [new Map([['A', 'C'], ['B', 'C']])];
    expect(checkGroupPinFeasibility(vars, combos, null).feasible).toBe(true);
  });
});
