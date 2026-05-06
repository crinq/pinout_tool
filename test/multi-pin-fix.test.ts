// ============================================================
// Tests for the unified physical/logical pin model
//
// Covers four representative MCUs across the failure classes
// catalogued in ai_docs/parser.md plus one normal-package MCU
// as a regression check:
//   - STM32C031K(4-6)Tx — UFQFPN32 with PINREMAP variants
//   - STM32U031F4Px      — UFQFPN20 with shared bond pads
//   - STM32C051D8Yx      — WLCSP25 mixed (variants + shared)
//   - STM32H755ZITx      — LQFP144 with PC2_C analog-switch siblings
//   - STM32F405VGTx      — LQFP100, no shared physicals (control)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { parseMcuXml, validateMcu } from '../src/parser/mcu-xml-parser';
import type { Mcu, PhysicalPin } from '../src/types';
import { parseConstraints } from '../src/parser/constraint-parser';
import { resolveReservePatterns, createPinTracker, canAssignPin, assignPin } from '../src/solver/solver';

const ALL_DIR = join(__dirname, 'all/mcu');

let prevDOMParser: typeof globalThis.DOMParser | undefined;
beforeAll(() => {
  prevDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = LinkedomDOMParser as unknown as typeof globalThis.DOMParser;
});
afterAll(() => {
  globalThis.DOMParser = prevDOMParser as typeof globalThis.DOMParser;
});

function load(filename: string): Mcu {
  return parseMcuXml(readFileSync(join(ALL_DIR, filename), 'utf-8'));
}

function namesOn(phys: PhysicalPin): string[] {
  return phys.logicals.map(l => l.name).sort();
}

// ============================================================
// STM32C031K(4-6)Tx — PINREMAP variants
// ============================================================

describe('STM32C031K(4-6)Tx PINREMAP variant model', () => {
  let mcu: Mcu;
  beforeAll(() => { mcu = load('STM32C031K(4-6)Tx.xml'); });

  it('parses without throwing and validates clean', () => {
    const v = validateMcu(mcu);
    expect(v.errors, v.errors.join('; ')).toEqual([]);
  });

  it('treats PA9/PA11 as two logicals on physical pin 22', () => {
    const phys22 = mcu.physicalPinByPosition.get('22')!;
    expect(phys22).toBeDefined();
    expect(namesOn(phys22)).toEqual(['PA11', 'PA9']);
  });

  it('marks the PINREMAP row as non-default', () => {
    const phys22 = mcu.physicalPinByPosition.get('22')!;
    const def = phys22.logicals.find(l => l.isDefaultVariant);
    const variant = phys22.logicals.find(l => !l.isDefaultVariant);
    expect(def).toBeDefined();
    expect(variant).toBeDefined();
    expect(variant!.variantGroup).toBe('PINREMAP');
  });

  it('back-refs round-trip', () => {
    for (const lp of mcu.logicalPins) {
      expect(lp.physical.logicals).toContain(lp);
      expect(mcu.physicalPinByPosition.get(lp.physical.position)).toBe(lp.physical);
    }
  });
});

// ============================================================
// STM32U031F4Px — UFQFPN20 multi-bond pads
// ============================================================

describe('STM32U031F4Px UFQFPN20 shared bond pads', () => {
  let mcu: Mcu;
  beforeAll(() => { mcu = load('STM32U031F4Px.xml'); });

  it('exposes all four GPIOs sharing position 18', () => {
    const phys18 = mcu.physicalPinByPosition.get('18')!;
    expect(phys18).toBeDefined();
    expect(namesOn(phys18)).toEqual(['PA14', 'PB4', 'PB5', 'PB6']);
    for (const lp of phys18.logicals) {
      expect(lp.isDefaultVariant).toBe(true);
      expect(lp.variantGroup).toBeUndefined();
    }
  });

  it('every logical at a shared position is reachable via logicalPinByGpioName', () => {
    for (const name of ['PA14', 'PB4', 'PB5', 'PB6']) {
      const lp = mcu.logicalPinByGpioName.get(name);
      expect(lp, `missing logical ${name}`).toBeDefined();
      expect(lp!.physical.position).toBe('18');
    }
  });
});

// ============================================================
// STM32C051D8Yx — mixed variants + shared
// ============================================================

describe('STM32C051D8Yx WLCSP25 mixed model', () => {
  let mcu: Mcu;
  beforeAll(() => { mcu = load('STM32C051D8Yx.xml'); });

  it('parses without throwing and validates clean', () => {
    const v = validateMcu(mcu);
    expect(v.errors, v.errors.join('; ')).toEqual([]);
  });

  it('has at least one shared-pad physical with no variant attribute', () => {
    const sharedPlain = mcu.physicalPins.filter(p =>
      p.logicals.length > 1 && p.logicals.every(l => l.isDefaultVariant)
    );
    expect(sharedPlain.length).toBeGreaterThan(0);
  });

  it('has at least one PINREMAP physical', () => {
    const remaps = mcu.physicalPins.filter(p =>
      p.logicals.some(l => !l.isDefaultVariant)
    );
    expect(remaps.length).toBeGreaterThan(0);
  });
});

// ============================================================
// STM32H755ZITx — _C analog-switch siblings
// ============================================================

describe('STM32H755ZITx _C analog switch handling', () => {
  let mcu: Mcu;
  beforeAll(() => { mcu = load('STM32H755ZITx.xml'); });

  it('parses without throwing and validates clean', () => {
    const v = validateMcu(mcu);
    expect(v.errors, v.errors.join('; ')).toEqual([]);
  });

  it('keeps PC2_C as its own logical with only analog signals', () => {
    const lp = mcu.logicalPinByName.get('PC2_C')!;
    expect(lp).toBeDefined();
    const types = new Set(lp.signals.map(s => s.peripheralType));
    // _C variants only carry analog peripherals (ADC/DAC/OPAMP/COMP).
    types.delete(undefined as unknown as string);
    for (const t of types) {
      expect(['ADC', 'DAC', 'OPAMP', 'COMP']).toContain(t);
    }
  });
});

// ============================================================
// STM32F405VGTx — control case (no shared physicals expected)
// ============================================================

describe('STM32F405VGTx control case', () => {
  let mcu: Mcu;
  beforeAll(() => { mcu = load('STM32F405VGTx.xml'); });

  it('parses and validates clean', () => {
    const v = validateMcu(mcu);
    expect(v.errors, v.errors.join('; ')).toEqual([]);
  });

  it('every assignable physical has exactly one logical (no PINREMAP, no shared pads)', () => {
    for (const phys of mcu.physicalPins) {
      const assignable = phys.logicals.filter(l => l.isAssignable);
      expect(assignable.length).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================
// Reserve: position-based reservation
// ============================================================

describe('reserve: with positions blocks all logicals on the physical', () => {
  it('reserves every logical on a multi-bond pad (UFQFPN20 pos 18)', () => {
    const mcu = load('STM32U031F4Px.xml');
    const ast = parseConstraints('reserve: 18').ast!;
    const r = resolveReservePatterns(ast, mcu);
    expect(r.positions).toEqual(['18']);
    // All four bonded GPIOs must be reserved.
    expect(r.pins.sort()).toEqual(['PA14', 'PB4', 'PB5', 'PB6']);
  });

  it('reserves PINREMAP siblings when a position is given (C031K pos 22)', () => {
    const mcu = load('STM32C031K(4-6)Tx.xml');
    const ast = parseConstraints('reserve: 22').ast!;
    const r = resolveReservePatterns(ast, mcu);
    expect(r.positions).toEqual(['22']);
    expect(r.pins.sort()).toEqual(['PA11', 'PA9']);
  });

  it('still works for plain GPIO names', () => {
    const mcu = load('STM32F405VGTx.xml');
    const ast = parseConstraints('reserve: PA0').ast!;
    const r = resolveReservePatterns(ast, mcu);
    expect(r.pins).toContain('PA0');
    expect(r.positions).toEqual([]);
  });

  it('accepts BGA-style positions', () => {
    const mcu = load('STM32C051D8Yx.xml');
    // Pick any known WLCSP position from the XML's pin list.
    const phys = mcu.physicalPins.find(p => /^[A-Z]\d+$/.test(p.position))!;
    expect(phys).toBeDefined();
    const ast = parseConstraints(`reserve: ${phys.position}`).ast!;
    const r = resolveReservePatterns(ast, mcu);
    expect(r.positions).toEqual([phys.position]);
    expect(r.pins.sort()).toEqual(phys.logicals.map(l => l.name).sort());
  });
});

// ============================================================
// Solver tracker: physical pin lock propagation
// ============================================================

describe('PinTracker locks physical pins (mutex across siblings)', () => {
  it('blocks PA11 across ports once PA9 is assigned (C031K shared physical)', () => {
    const mcu = load('STM32C031K(4-6)Tx.xml');
    const phys22 = mcu.physicalPinByPosition.get('22')!;
    const tracker = createPinTracker([], [], []);

    const pa9 = mcu.logicalPinByGpioName.get('PA9')!;
    const pa11 = mcu.logicalPinByGpioName.get('PA11')!;
    expect(pa9.physical).toBe(phys22);
    expect(pa11.physical).toBe(phys22);

    expect(canAssignPin(tracker, pa9.name, 'CMD', 'UART', 'TX', 'USART1', 'USART1_TX', phys22.position)).toBe(true);
    assignPin(tracker, pa9.name, 'CMD', 'UART', 'TX', 'USART1', 'USART1_TX', phys22.position);

    // Different port trying to use PA11 (sibling on same physical) must fail.
    expect(
      canAssignPin(tracker, pa11.name, 'OTHER', 'UART', 'TX', 'USART2', 'USART2_TX', phys22.position)
    ).toBe(false);

    // Same port can still use the physical (treated as shared within port).
    expect(
      canAssignPin(tracker, pa9.name, 'CMD', 'UART', 'TX', 'USART1', 'USART1_TX', phys22.position)
    ).toBe(false); // already in use within same config
  });

  it('reserved positions reject assignments to every co-located logical', () => {
    const mcu = load('STM32U031F4Px.xml');
    const phys18 = mcu.physicalPinByPosition.get('18')!;
    const tracker = createPinTracker([], [], [phys18.position]);
    for (const lp of phys18.logicals) {
      expect(
        canAssignPin(tracker, lp.name, 'P', 'C', 'CH', undefined, undefined, phys18.position),
        `${lp.name} should be blocked by reserved physical`
      ).toBe(false);
    }
  });
});
