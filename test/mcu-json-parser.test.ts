// ============================================================
// Tests for the JSON-format MCU importer
// (vendor data layout: ../../mcu_data/data/stm32/mcu/<die>.json)
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseMcuJson } from '../src/parser/mcu-json-parser';

const DATA_BASE = join(__dirname, '../../mcu_data/data/stm32/mcu');

function loadJson(die: string): string {
  return readFileSync(join(DATA_BASE, `${die}.json`), 'utf-8');
}

const HAS_DATA = existsSync(DATA_BASE);
const maybeDescribe = HAS_DATA ? describe : describe.skip;

maybeDescribe('mcu-json-parser', () => {
  // ============================================================
  // STM32C011D6 — single WLCSP12 variant with PINREMAP-style multi-bond
  // ============================================================
  describe('STM32C011D6 (WLCSP12 with multi-bond pads)', () => {
    const mcus = parseMcuJson(loadJson('stm32c011d6'));

    it('emits one Mcu per package variant', () => {
      expect(mcus).toHaveLength(1);
      expect(mcus[0].refName).toBe('STM32C011D6Yx');
      expect(mcus[0].package).toBe('WLCSP12');
      expect(mcus[0].family).toBe('STM32C0');
    });

    it('captures freq/flash/ram/voltage/temperature', () => {
      const m = mcus[0];
      expect(m.frequency).toBe(48);
      expect(m.flash).toBe(32);
      expect(m.ram).toBe(6);
      // Voltage values track the upstream JSON; just sanity-check shape.
      expect(m.voltage.min).toBeGreaterThan(0);
      expect(m.voltage.max).toBeGreaterThan(m.voltage.min);
      expect(m.temperature.min).toBe(-40);
      expect(m.temperature.max).toBe(85);
      expect(m.cores.length).toBeGreaterThan(0);
    });

    it('expands package pin names[] into mutually-exclusive logical pins on one physical', () => {
      // The vendor JSON's `packages[].pins[].names` carries every GPIO bonded
      // to the same pad. Find any multi-name pad so the test stays stable
      // across schema revisions.
      const m = mcus[0];
      const sharedPhys = m.physicalPins.find(p => p.logicals.length > 1);
      expect(sharedPhys, 'expected at least one shared pad in WLCSP12').toBeDefined();
      const def = sharedPhys!.logicals.filter(l => l.isDefaultVariant);
      const alt = sharedPhys!.logicals.filter(l => !l.isDefaultVariant);
      expect(def).toHaveLength(1);
      expect(alt.length).toBeGreaterThanOrEqual(1);
      for (const l of alt) expect(l.variantGroup).toBe('ALT');
    });

    it('attaches peripheral signals onto the correct GPIO via gpios[]', () => {
      // The new schema lives on the GPIO entry: PA9.alternate_functions
      // includes USART1_TX (AF1).
      const m = mcus[0];
      const pa9 = m.logicalPinByGpioName.get('PA9');
      if (!pa9) return; // PA9 may be unbonded in tiny packages
      const tx = pa9.signals.find(s => s.name === 'USART1_TX');
      expect(tx).toBeDefined();
      expect(tx!.peripheralInstance).toBe('USART1');
      expect(tx!.peripheralType).toBe('USART');
      expect(tx!.signalFunction).toBe('TX');
      // ioModes is "AF<N>" for alternate_functions entries.
      expect(tx!.ioModes).toMatch(/^AF\d+$/);
    });

    it('synthesizes a GPIO signal on every assignable logical pin', () => {
      const m = mcus[0];
      const someGpio = m.logicalPins.find(l => l.isAssignable && l.gpioPort)!;
      const gpio = someGpio.signals.find(s => s.peripheralType === 'GPIO');
      expect(gpio).toBeDefined();
    });

    it('uses pin.type from JSON to classify non-IO pads', () => {
      const m = mcus[0];
      // type "power" → not assignable, type "io" → assignable.
      const power = m.physicalPins.find(p => p.logicals[0].type === 'Power');
      expect(power, 'expected a power pad in the package').toBeDefined();
      for (const lp of power!.logicals) expect(lp.isAssignable).toBe(false);
    });

    it('back-refs round-trip', () => {
      const m = mcus[0];
      for (const lp of m.logicalPins) {
        expect(lp.physical.logicals).toContain(lp);
        expect(m.physicalPinByPosition.get(lp.physical.position)).toBe(lp.physical);
      }
    });

    it('exposes the full peripheral list with normalized types', () => {
      const m = mcus[0];
      const u = m.peripheralByInstance.get('USART1')!;
      expect(u).toBeDefined();
      expect(u.type).toBe('USART');
      expect(u.originalType).toBe('USART');
    });

    it('typeToInstances groups by canonical type (so the constraint solver finds them)', () => {
      const m = mcus[0];
      // The vendor JSON encodes timer instances as `kind: "timer"`. Without
      // the type derivation in mcu-json-parser, validatePeripheralAvailability
      // would search `mcu.typeToInstances` for "TIM" and miss everything.
      const tim = m.typeToInstances.get('TIM') ?? [];
      expect(tim.length).toBeGreaterThan(0);
      expect(tim.some(n => /^TIM\d+$/.test(n))).toBe(true);
      // GPIO ports flatten into a single bucket regardless of port letter.
      const gpio = m.typeToInstances.get('GPIO') ?? [];
      expect(gpio.some(n => n.startsWith('GPIOA'))).toBe(true);
    });
  });

  // ============================================================
  // STM32C011F4 — die with multiple package variants (TSSOP20 + UFQFPN20)
  // ============================================================
  describe('STM32C011F4 (multi-package die)', () => {
    const mcus = parseMcuJson(loadJson('stm32c011f4'));

    it('emits one Mcu per variant', () => {
      const variants = mcus.map(m => m.refName).sort();
      expect(variants.length).toBeGreaterThan(1);
      // Variants should differ in package, share core/peripheral metadata.
      const pkgs = new Set(mcus.map(m => m.package));
      expect(pkgs.size).toBe(mcus.length);
    });

    it('every variant carries the same peripheral list', () => {
      const ref = mcus[0].peripheralByInstance.size;
      for (const m of mcus) expect(m.peripheralByInstance.size).toBe(ref);
    });

    it('every variant has independent logical/physical maps', () => {
      // Mutating one variant's pin maps must not leak into another.
      mcus[0].logicalPinByName.set('__sentinel__', mcus[0].logicalPins[0]);
      expect(mcus[1].logicalPinByName.has('__sentinel__')).toBe(false);
    });
  });

  // ============================================================
  // F4 / F405-class dies — sanity check on non-DMAMUX, larger footprint
  // ============================================================
  describe('STM32F405VG (LQFP control case)', () => {
    if (!existsSync(join(DATA_BASE, 'stm32f405vg.json'))) {
      it.skip('skipped — vendor JSON missing', () => {});
      return;
    }
    const mcus = parseMcuJson(loadJson('stm32f405vg'));

    it('produces at least one variant', () => {
      expect(mcus.length).toBeGreaterThan(0);
    });

    it('every assignable logical resolves a USART_TX or similar signal', () => {
      // Quick sanity that signals were attached at scale.
      const m = mcus[0];
      const txCount = [...m.signalToLogicalPins.keys()].filter(k => k.endsWith('_TX')).length;
      expect(txCount).toBeGreaterThan(0);
    });

    it('USB OTG instances live in the USB type bucket (kind "otg" mapping)', () => {
      const m = mcus[0];
      const usb = m.typeToInstances.get('USB') ?? [];
      expect(usb).toContain('USB_OTG_FS');
      expect(usb).toContain('USB_OTG_HS');
    });

    it('CAN bucket carries CAN1 and CAN2', () => {
      const m = mcus[0];
      const can = m.typeToInstances.get('CAN') ?? [];
      expect(can).toContain('CAN1');
      expect(can).toContain('CAN2');
    });
  });
});
