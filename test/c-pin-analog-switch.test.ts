import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseMcuJson } from '../src/parser/mcu-json-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import {
  solveConstraints, coupledBasePin, pinnedOccupiedPins,
  createPinTracker, canAssignPin, assignPin, unassignPin,
} from '../src/solver/solver';
import type { Mcu } from '../src/types';

// Dual-pad analog pins (PC2 / PC2_C) are two package pads joined by a
// configurable analog switch:
//   * the `_C` pad has its own dedicated ADC channels — switch open, so it is
//     independent of the base pin;
//   * the digital functions the vendor data also lists on the `_C` pad belong to
//     the base pin and are only reachable with the switch CLOSED, which shorts
//     the pads — the base pin is then part of the same net and unusable.

const xml: Mcu = parseMcuXml(readFileSync(join(__dirname, 'h755i/STM32H755IIKx.xml'), 'utf-8'));
const jsonVariants = parseMcuJson(readFileSync(join(__dirname, 'fixtures/stm32h723ve.json'), 'utf-8'));
const json: Mcu = jsonVariants.find(m => m.package === 'LQFP100') ?? jsonVariants[0];

const sigNames = (mcu: Mcu, pin: string) =>
  mcu.logicalPins.find(p => p.name === pin)?.signals.map(s => s.name) ?? [];
const types = (mcu: Mcu, pin: string) =>
  new Set(mcu.logicalPins.find(p => p.name === pin)?.signals.map(s => s.peripheralType) ?? []);

describe('_C pads carry only their own analog channels', () => {
  for (const [label, mcu] of [['XML', xml], ['JSON', json]] as const) {
    it(`${label}: no digital functions on the _C pad`, () => {
      const cPins = mcu.logicalPins.filter(p => /^P[A-Z]\d+_C$/.test(p.name));
      expect(cPins.length, `${label} fixture has _C pins`).toBeGreaterThan(0);
      for (const p of cPins) {
        expect(p.signals.length, `${p.name} has signals`).toBeGreaterThan(0);
        for (const s of p.signals) {
          expect(['ADC', 'DAC', 'OPAMP', 'COMP'], `${p.name}/${s.name}`).toContain(s.peripheralType);
        }
      }
    });

    it(`${label}: the base pin keeps its digital functions`, () => {
      const base = mcu.logicalPins.find(p => /^P[A-Z]\d+_C$/.test(p.name))!.name.slice(0, -2);
      if (!mcu.logicalPins.some(p => p.name === base)) return;  // pad not bonded out
      const t = types(mcu, base);
      expect(t.size).toBeGreaterThan(1);                        // more than just ADC
    });
  }

  it('JSON matches XML: PC2_C is analog-only', () => {
    // Regression: the JSON parser used to pass the base pin's alternate
    // functions through, so an AF could be mapped to PC2_C while the base pin
    // carried something else.
    expect(sigNames(json, 'PC2_C').length).toBeGreaterThan(0);
    expect(sigNames(json, 'PC2_C').every(n => n.startsWith('ADC'))).toBe(true);
    expect(sigNames(json, 'PC2_C')).not.toContain('SPI2_MISO');
    // Same pin in the XML source — the two parsers must agree.
    expect(sigNames(xml, 'PC2_C').every(n => n.startsWith('ADC'))).toBe(true);
    expect(types(xml, 'PC2').size).toBeGreaterThan(1);   // base pin keeps digital fns
  });

  it('a package may bond out the _C pad without its base pin', () => {
    // stm32h723ve/LQFP100 exposes PC2_C but not PC2; coupling to a pin that is
    // not bonded out is harmless because nothing can be assigned to it.
    expect(sigNames(json, 'PC2_C').length).toBeGreaterThan(0);
    expect(json.logicalPins.some(p => p.name === 'PC2')).toBe(false);
    expect(coupledBasePin('PC2_C', 'SPI2_MISO')).toBe('PC2');
  });
});

describe('coupledBasePin', () => {
  it('an own ADC channel leaves the base pin free (switch open)', () => {
    expect(coupledBasePin('PC2_C', 'ADC3_INP0')).toBeUndefined();
    expect(coupledBasePin('PA0_C', 'ADC1_INN1')).toBeUndefined();
  });

  it('a switch-through signal consumes the base pin', () => {
    expect(coupledBasePin('PC2_C', 'SPI2_MISO')).toBe('PC2');
    expect(coupledBasePin('PA1_C', 'ETH_REF_CLK')).toBe('PA1');
  });

  it('ordinary pins are never coupled', () => {
    expect(coupledBasePin('PC2', 'SPI2_MISO')).toBeUndefined();
    expect(coupledBasePin('PB14', 'ADC1_INP1')).toBeUndefined();
  });
});

describe('pin tracker honours the analog switch', () => {
  const track = () => createPinTracker([], []);

  it('a switch-through signal on _C blocks the base pin', () => {
    const t = track();
    expect(canAssignPin(t, 'PC2_C', 'P', 'c', 'AF', 'SPI2', 'SPI2_MISO', 'N1')).toBe(true);
    assignPin(t, 'PC2_C', 'P', 'c', 'AF', 'SPI2', 'SPI2_MISO', 'N1');
    // PC2 is now part of the same net — not available to another channel.
    expect(canAssignPin(t, 'PC2', 'P', 'c', 'AN', 'ADC1', 'ADC1_INP12', 'M1')).toBe(false);
    // …nor to another port.
    expect(canAssignPin(t, 'PC2', 'Q', 'c', 'AN', 'ADC1', 'ADC1_INP12', 'M1')).toBe(false);
  });

  it('releases the base pin again on backtrack', () => {
    const t = track();
    assignPin(t, 'PC2_C', 'P', 'c', 'AF', 'SPI2', 'SPI2_MISO', 'N1');
    unassignPin(t, 'PC2_C', 'P', 'c', 'SPI2', 'SPI2_MISO', 'N1');
    expect(canAssignPin(t, 'PC2', 'P', 'c', 'AN', 'ADC1', 'ADC1_INP12', 'M1')).toBe(true);
  });

  it('the _C pad\'s own ADC channel leaves the base pin usable', () => {
    const t = track();
    assignPin(t, 'PC2_C', 'P', 'c', 'AN2', 'ADC3', 'ADC3_INP0', 'N1');
    expect(canAssignPin(t, 'PC2', 'P', 'c', 'AN', 'ADC1', 'ADC1_INP12', 'M1')).toBe(true);
  });

  it('blocks in the other order too: base pin first', () => {
    const t = track();
    assignPin(t, 'PC2', 'P', 'c', 'AN', 'ADC1', 'ADC1_INP12', 'M1');
    expect(canAssignPin(t, 'PC2_C', 'P', 'c', 'AF', 'SPI2', 'SPI2_MISO', 'N1')).toBe(false);
    // but its own ADC channel is still fine
    expect(canAssignPin(t, 'PC2_C', 'P', 'c', 'AF', 'ADC3', 'ADC3_INP0', 'N1')).toBe(true);
  });
});

describe('pin declarations on a _C pad', () => {
  it('a switch-through pin decl also occupies the base pin', () => {
    expect(pinnedOccupiedPins({ pinName: 'PC2_C', signalName: 'SPI2_MISO' })).toEqual(['PC2_C', 'PC2']);
    expect(pinnedOccupiedPins({ pinName: 'PC2_C', signalName: 'ADC3_INP0' })).toEqual(['PC2_C']);
    expect(pinnedOccupiedPins({ pinName: 'PA9', signalName: 'USART1_TX' })).toEqual(['PA9']);
  });

  it('end to end: PC2 is not handed out while PC2_C is pinned to an AF', () => {
    const src = `pin PC2_C = SPI2_MISO

port P:
  channel AN = ADC1_INP12`;   // ADC1_INP12 only exists on PC2
    const r = solveConstraints(parseConstraints(src).ast!, xml,
      { maxSolutions: 20, timeoutMs: 5000, costWeights: new Map() });
    const used = r.solutions.flatMap(s => s.configAssignments.flatMap(c => c.assignments));
    expect(used.some(a => a.pinName === 'PC2')).toBe(false);
  });

  it('an own-ADC pin decl still leaves PC2 available', () => {
    const src = `pin PC2_C = ADC3_INP0

port P:
  channel AN = ADC1_INP12`;
    const r = solveConstraints(parseConstraints(src).ast!, xml,
      { maxSolutions: 20, timeoutMs: 5000, costWeights: new Map() });
    expect(r.solutions.length).toBeGreaterThan(0);
    const used = r.solutions.flatMap(s => s.configAssignments.flatMap(c => c.assignments));
    expect(used.some(a => a.pinName === 'PC2' && a.signalName === 'ADC1_INP12')).toBe(true);
  });
});

describe('naming _C pads in the constraint language', () => {
  it('parses everywhere a pin name is accepted', () => {
    for (const src of [
      'port P:\n  channel A @ PC2_C = ADC3_INP0',
      'port P:\n  channel A @ !PC2_C = ADC1_INP12',
      'pin PC2_C = ADC3_INP0',
      'reserve: PC2_C',
      'reserve: PA0_C, PC2_C, PH0',
    ]) {
      const r = parseConstraints(src);
      expect(r.errors.map(e => `L${e.line}: ${e.message}`), src).toEqual([]);
    }
  });

  it('keeps the _C suffix in the parsed name', () => {
    const ast = parseConstraints('port P:\n  channel A @ PC2_C = ADC3_INP0').ast!;
    const port = ast.statements.find(s => s.type === 'port_decl') as { channels: { allowedPins?: string[] }[] };
    expect(port.channels[0].allowedPins).toEqual(['PC2_C']);
    const pinAst = parseConstraints('pin PC2_C = ADC3_INP0').ast!;
    expect((pinAst.statements[0] as { pinName: string }).pinName).toBe('PC2_C');
  });

  it('an underscore that is not a _C suffix is still a syntax error', () => {
    expect(parseConstraints('pin PC2_X = ADC3_INP0').errors.length).toBeGreaterThan(0);
  });
});
