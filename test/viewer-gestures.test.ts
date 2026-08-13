import { describe, it, expect } from 'vitest';
import { snapQuarterTurns, anchoredPan } from '../src/ui/package-viewer';

describe('snapQuarterTurns — rotation snaps every 90°', () => {
  it('ignores small twists', () => {
    for (const deg of [0, 10, 30, 44.9, -44.9]) expect(snapQuarterTurns(deg)).toBe(0);
  });

  it('trips the first step at ~45° and then every 90°', () => {
    expect(snapQuarterTurns(45)).toBe(1);
    expect(snapQuarterTurns(90)).toBe(1);
    expect(snapQuarterTurns(134)).toBe(1);
    expect(snapQuarterTurns(136)).toBe(2);
    expect(snapQuarterTurns(180)).toBe(2);
    expect(snapQuarterTurns(270)).toBe(3);
  });

  it('is symmetric for counter-clockwise twists', () => {
    expect(snapQuarterTurns(-45)).toBe(-1);
    expect(snapQuarterTurns(-90)).toBe(-1);
    expect(snapQuarterTurns(-180)).toBe(-2);
  });

  it('only the delta since the last step is applied', () => {
    // The viewer rotates by (steps - alreadyApplied), so a continuous twist
    // never double-counts.
    let applied = 0;
    const twistTo = (deg: number) => {
      const steps = snapQuarterTurns(deg);
      const delta = steps - applied;
      applied = steps;
      return delta;
    };
    expect(twistTo(50)).toBe(1);   // first quarter turn
    expect(twistTo(80)).toBe(0);   // still within the same step
    expect(twistTo(140)).toBe(1);  // next one
    expect(twistTo(10)).toBe(-2);  // twisting back undoes both
    expect(applied).toBe(0);
  });
});

describe('anchoredPan — the point under the cursor stays put', () => {
  it('is a no-op when the scale does not change', () => {
    expect(anchoredPan(30, 120, 1)).toBe(30);
  });

  it('keeps the cursor point fixed while zooming in and out', () => {
    // Screen position of a model point: s = offset*scale + pan (relative to the
    // view origin). Zooming must leave s unchanged for the anchored point.
    const check = (pan: number, offset: number, factor: number) => {
      const before = offset + pan;                       // scale 1 → cursor sits here
      const pan2 = anchoredPan(pan, offset, factor);
      const after = offset * factor + pan2;
      expect(after).toBeCloseTo(before, 10);
    };
    check(0, 100, 2);
    check(-40, 250, 0.5);
    check(17.5, -80, 1.25);
  });

  it('round-trips: zoom in then back out restores the pan', () => {
    const pan0 = 12;
    const offset = 60;
    const pan1 = anchoredPan(pan0, offset, 2);
    // after zooming, the same point sits at a new offset from the origin
    const pan2 = anchoredPan(pan1, offset * 2, 0.5);
    expect(pan2).toBeCloseTo(pan0, 10);
  });
});
