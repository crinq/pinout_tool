import { describe, it, expect } from 'vitest';
import { regionTargetXY, buildGeom, filterByHardAnchors } from '../src/solver/pin-anchors';
import { getCostFunction, setActiveAnchors } from '../src/solver/cost-functions';
import type { Mcu, Solution } from '../src/types';
import type { SolutionAnchors } from '../src/solver/cost-functions';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);

describe('regionTargetXY — extreme corner/edge compass model', () => {
  it('single directions hit the edge center', () => {
    const N = regionTargetXY('N')!; near(N.x, 0.5); near(N.y, 0);
    const S = regionTargetXY('S')!; near(S.x, 0.5); near(S.y, 1);
    const E = regionTargetXY('E')!; near(E.x, 1); near(E.y, 0.5);
    const W = regionTargetXY('W')!; near(W.x, 0); near(W.y, 0.5);
  });

  it('two orthogonal directions hit the corner', () => {
    const NW = regionTargetXY('NW')!; near(NW.x, 0); near(NW.y, 0);
    const SE = regionTargetXY('SE')!; near(SE.x, 1); near(SE.y, 1);
  });

  it('doubling a direction biases along the edge (NNW → top edge, left of center)', () => {
    const NNW = regionTargetXY('NNW')!; near(NNW.x, 0.25); near(NNW.y, 0);
  });

  it('C blends the target back toward the center by its share of the letters', () => {
    const NC = regionTargetXY('NC')!; near(NC.x, 0.5); near(NC.y, 0.25);
    const C = regionTargetXY('C')!; near(C.x, 0.5); near(C.y, 0.5);
  });

  it('rejects non-compass strings (center is C, not M)', () => {
    expect(regionTargetXY('PA1')).toBeNull();
    expect(regionTargetXY('XY')).toBeNull();
    expect(regionTargetXY('M')).toBeNull();
  });
});

describe('buildGeom — normalized package coordinates', () => {
  it('LQFP maps pin numbers around the perimeter (corners)', () => {
    const geom = buildGeom({ package: 'LQFP100', physicalPins: [] } as unknown as Mcu);
    const p1 = geom.norm('1')!;  near(p1.x, 0); near(p1.y, 0);   // top-left
    const p26 = geom.norm('26')!; near(p26.x, 0); near(p26.y, 1); // bottom-left
    const p51 = geom.norm('51')!; near(p51.x, 1); near(p51.y, 1); // bottom-right
    const p76 = geom.norm('76')!; near(p76.x, 1); near(p76.y, 0); // top-right
    expect(geom.scale).toBe(25);
  });

  it('BGA maps row/col to a normalized grid (A1 top-left)', () => {
    const pins = ['A1', 'A2', 'A3', 'B1', 'C3'].map(position => ({ position, logicals: [] }));
    const geom = buildGeom({ package: 'UFBGA100', physicalPins: pins } as unknown as Mcu);
    const a1 = geom.norm('A1')!; near(a1.x, 0); near(a1.y, 0);   // top-left (row A, col 1)
    const c3 = geom.norm('C3')!; near(c3.x, 1); near(c3.y, 1);   // bottom-right (row C, col 3)
  });
});

describe('filterByHardAnchors', () => {
  const sol = (pins: [string, string, string][]): Solution => ({
    configAssignments: [{
      combination: new Map(),
      assignments: pins.map(([portName, configurationName, pinName]) => ({
        portName, channelName: 'X', pinName, signalName: 'SIG', configurationName,
      })),
    }],
  } as unknown as Solution);

  const anchors = (over: Partial<SolutionAnchors>): SolutionAnchors => ({
    byChannel: new Map(), geom: { norm: () => null, scale: 1 },
    hardPortPins: [], hardConfigPins: [], hardGroupPins: [], groupOfChannel: new Map(), ...over,
  });

  it('keeps solutions that cover the required port pin, drops the rest', () => {
    const good = sol([['CMD', 'c', 'PA1']]);
    const bad = sol([['CMD', 'c', 'PB9']]);
    const out = filterByHardAnchors([good, bad], anchors({ hardPortPins: [{ portName: 'CMD', pins: ['PA1'] }] }));
    expect(out).toEqual([good]);
  });

  it('scopes config-fixed pins to the named config', () => {
    const good = sol([['CMD', 'uart', 'PA1']]);
    const wrongConfig = sol([['CMD', 'spi', 'PA1']]);
    const out = filterByHardAnchors([good, wrongConfig],
      anchors({ hardConfigPins: [{ portName: 'CMD', configName: 'uart', pins: ['PA1'] }] }));
    expect(out).toEqual([good]);
  });

  it('passes everything through when there are no hard anchors', () => {
    const a = sol([['CMD', 'c', 'PA1']]);
    expect(filterByHardAnchors([a], anchors({}))).toEqual([a]);
  });
});

// P3: a soft `~` anchor must bias ranking — the pin_anchor cost is lower for a
// pin near the anchor target than for one far from it.
describe('pin_anchor soft cost biases ranking', () => {
  const mcu = {
    package: 'LQFP100',
    logicalPinByName: new Map([
      ['PIN_NEAR', { physical: { position: '1' } }],   // top-left corner
      ['PIN_FAR', { physical: { position: '50' } }],   // opposite side
    ]),
  } as unknown as Mcu;

  const solOn = (pinName: string): Solution => ({
    configAssignments: [{
      combination: new Map(),
      assignments: [{ portName: 'P', channelName: 'A', pinName, signalName: 'SIG', configurationName: 'c' }],
    }],
  } as unknown as Solution);

  it('near pin costs less than far pin for the same channel anchor', () => {
    const geom = buildGeom(mcu);
    const target = geom.norm('1')!; // anchor a channel toward package position 1
    const anchors: SolutionAnchors = {
      byChannel: new Map([['P\0A', [target]]]),
      geom, hardPortPins: [], hardConfigPins: [], hardGroupPins: [], groupOfChannel: new Map(),
    };
    setActiveAnchors(anchors);
    try {
      const pinAnchor = getCostFunction('pin_anchor')!;
      const near = pinAnchor.compute(solOn('PIN_NEAR'), mcu);
      const far = pinAnchor.compute(solOn('PIN_FAR'), mcu);
      expect(near).toBeCloseTo(0, 5);       // sits on the target
      expect(far).toBeGreaterThan(near);    // penalized for distance
    } finally {
      setActiveAnchors(null);
    }
  });

  it('is zero when no anchors are active', () => {
    setActiveAnchors(null);
    expect(getCostFunction('pin_anchor')!.compute(solOn('PIN_FAR'), mcu)).toBe(0);
  });
});
