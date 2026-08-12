import { describe, it, expect, afterEach } from 'vitest';
import {
  getCostFunction, setActiveAnchors, setSquaredCosts, getSquaredCosts,
  type SolutionAnchors,
} from '../src/solver/cost-functions';
import { buildGeom } from '../src/solver/pin-anchors';
import type { Mcu, Solution } from '../src/types';

// The squared option sums d² per distance term, so a single far-away pin costs
// far more than several slightly-spread ones (same total linear distance).

const LQFP = { package: 'LQFP100' };

/** LQFP MCU whose pins sit at the given package positions. */
function mcuWith(positions: string[]): Mcu {
  const logicalPinByName = new Map(
    positions.map(p => [`PIN${p}`, { physical: { position: p } }]),
  );
  return { ...LQFP, logicalPinByName, physicalPins: [] } as unknown as Mcu;
}

/** One port, one config, one assignment per pin. */
function solOf(pins: string[], channel = 'A'): Solution {
  return {
    configAssignments: [{
      combination: new Map(),
      assignments: pins.map((p, i) => ({
        portName: 'P', channelName: pins.length > 1 ? `${channel}${i}` : channel,
        pinName: `PIN${p}`, signalName: 'SIG', configurationName: 'c',
      })),
    }],
  } as unknown as Solution;
}

const compute = (id: string, sol: Solution, mcu: Mcu) => getCostFunction(id)!.compute(sol, mcu);

afterEach(() => { setSquaredCosts(false); setActiveAnchors(null); });

describe('squared distance costs', () => {
  it('defaults to off', () => {
    expect(getSquaredCosts()).toBe(false);
  });

  it('pin_proximity: squares each pairwise distance', () => {
    // Positions 1, 2, 3 → pairwise distances 1, 1, 2.
    const mcu = mcuWith(['1', '2', '3']);
    const sol = solOf(['1', '2', '3']);

    setSquaredCosts(false);
    expect(compute('pin_proximity', sol, mcu)).toBe(1 + 1 + 2);

    setSquaredCosts(true);
    expect(compute('pin_proximity', sol, mcu)).toBe(1 + 1 + 4);
  });

  it('pin_proximity: punishes one outlier harder than an even spread', () => {
    // Both have the same linear total (2+2+4 = 1+7+8... ) — compare directly:
    const even = { mcu: mcuWith(['1', '3', '5']), sol: solOf(['1', '3', '5']) };   // d = 2,2,4
    const outlier = { mcu: mcuWith(['1', '2', '9']), sol: solOf(['1', '2', '9']) }; // d = 1,7,8

    setSquaredCosts(false);
    const evenLin = compute('pin_proximity', even.sol, even.mcu);      // 8
    const outLin = compute('pin_proximity', outlier.sol, outlier.mcu); // 16

    setSquaredCosts(true);
    const evenSq = compute('pin_proximity', even.sol, even.mcu);       // 4+4+16 = 24
    const outSq = compute('pin_proximity', outlier.sol, outlier.mcu);  // 1+49+64 = 114

    // Squaring widens the gap between a spread-out port and a tight one.
    expect(outLin / evenLin).toBeLessThan(outSq / evenSq);
    expect(evenSq).toBe(24);
    expect(outSq).toBe(114);
  });

  it('pin_clustering: squares the per-port diameter', () => {
    const mcu = mcuWith(['1', '2', '5']);
    const sol = solOf(['1', '2', '5']); // diameter = 4

    setSquaredCosts(false);
    expect(compute('pin_clustering', sol, mcu)).toBe(4);

    setSquaredCosts(true);
    expect(compute('pin_clustering', sol, mcu)).toBe(16);
  });

  it('pin_anchor: squares each anchor miss distance', () => {
    const mcu = mcuWith(['1', '26']);
    const geom = buildGeom(mcu);
    const target = geom.norm('1')!;
    setActiveAnchors({
      byChannel: new Map([['P\0A0', [target]], ['P\0A1', [target]]]),
      geom, hardPortPins: [], hardConfigPins: [],
    } as SolutionAnchors);
    const sol = solOf(['1', '26']); // one pin on target, one far away

    setSquaredCosts(false);
    const lin = compute('pin_anchor', sol, mcu);
    setSquaredCosts(true);
    const sq = compute('pin_anchor', sol, mcu);

    expect(lin).toBeGreaterThan(0);
    expect(sq).toBeCloseTo(lin * lin, 5); // single non-zero term → d² == (Σd)²
  });

  it('leaves non-distance cost functions untouched', () => {
    const mcu = mcuWith(['1', '2', '3']);
    const sol = solOf(['1', '2', '3']);
    setSquaredCosts(false);
    const before = compute('pin_count', sol, mcu);
    setSquaredCosts(true);
    expect(compute('pin_count', sol, mcu)).toBe(before);
  });
});
