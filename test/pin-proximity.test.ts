import { describe, it, expect } from 'vitest';
import { parseBgaPosition, getCostFunction } from '../src/solver/cost-functions';
import type { Mcu, Solution } from '../src/types';

// ============================================================
// Fix 1: BGA row labels honor JEDEC skips (I, O, Q, S, X, Z)
// ============================================================

describe('parseBgaPosition (JEDEC row skips)', () => {
  const rowIdx = (label: string) => parseBgaPosition(`${label}1`)!.row;

  it('assigns contiguous indices across skipped letters', () => {
    // UFBGA176 rows: A B C D E F G H J K L M N P R (I, O, Q skipped)
    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R'];
    rows.forEach((r, i) => expect(rowIdx(r)).toBe(i));
  });

  it('reports distance 1 for physically adjacent rows across a skip boundary', () => {
    expect(rowIdx('J') - rowIdx('H')).toBe(1); // was 2 (skips I)
    expect(rowIdx('P') - rowIdx('N')).toBe(1); // was 2 (skips O)
    expect(rowIdx('R') - rowIdx('P')).toBe(1); // was 2 (skips Q)
    expect(rowIdx('R') - rowIdx('A')).toBe(14); // was 17 (skips I,O,Q)
  });

  it('leaves column and non-BGA parsing untouched', () => {
    expect(parseBgaPosition('N15')).toEqual({ row: 12, col: 15 });
    expect(parseBgaPosition('42')).toBeNull();
  });
});

// ============================================================
// Proximity spans ALL of a port's configs (every config is routed
// on the PCB; only one is active at runtime). This is intentional —
// the test locks it in so it is not "simplified" to per-config.
// ============================================================

function mcuWith(positions: Record<string, string>, pkg: string): Mcu {
  const logicalPinByName = new Map(
    Object.entries(positions).map(([name, pos]) => [name, { physical: { position: pos } }]),
  );
  return { package: pkg, logicalPinByName } as unknown as Mcu;
}

function solutionWith(assignments: Array<{ port: string; config: string; pin: string }>): Solution {
  return {
    configAssignments: [{
      activeConfigs: new Map(),
      assignments: assignments.map(a => ({
        pinName: a.pin, signalName: '', portName: a.port,
        channelName: '', configurationName: a.config,
      })),
    }],
  } as unknown as Solution;
}

describe('pin_proximity (whole-port footprint across configs)', () => {
  const prox = getCostFunction('pin_proximity')!;

  it('sums distances over the union of all configs of a port', () => {
    // ENC routes SPI (pins 1,2) and TIM (pins 4,5); both are on the PCB.
    // Full footprint = 4 pins → all 6 pairwise LQFP distances:
    // |1-2|+|1-4|+|1-5|+|2-4|+|2-5|+|4-5| = 1+3+4+2+3+1 = 14.
    const mcu = mcuWith({ s1: '1', s2: '2', t1: '4', t2: '5' }, 'LQFP100');
    const sol = solutionWith([
      { port: 'ENC', config: 'SPI', pin: 's1' },
      { port: 'ENC', config: 'SPI', pin: 's2' },
      { port: 'ENC', config: 'TIM', pin: 't1' },
      { port: 'ENC', config: 'TIM', pin: 't2' },
    ]);
    expect(prox.compute(sol, mcu)).toBe(14);
  });

  it('an outlier pin in one config raises proximity against the whole footprint', () => {
    const mcu = mcuWith({ s1: '1', s2: '2', t1: '4', t2: '5', far: '60' }, 'LQFP100');
    const tight = solutionWith([
      { port: 'ENC', config: 'SPI', pin: 's1' },
      { port: 'ENC', config: 'SPI', pin: 's2' },
      { port: 'ENC', config: 'TIM', pin: 't1' },
      { port: 'ENC', config: 'TIM', pin: 't2' },
    ]);
    const outlier = solutionWith([
      { port: 'ENC', config: 'SPI', pin: 's1' },
      { port: 'ENC', config: 'SPI', pin: 'far' }, // 2 -> 60
      { port: 'ENC', config: 'TIM', pin: 't1' },
      { port: 'ENC', config: 'TIM', pin: 't2' },
    ]);
    // Moving one signal to a far pin worsens its distance to every other pin of
    // the port — the all-pairs sum grows by a lot. This is the intended metric.
    expect(prox.compute(outlier, mcu)).toBeGreaterThan(prox.compute(tight, mcu) + 100);
  });
});
