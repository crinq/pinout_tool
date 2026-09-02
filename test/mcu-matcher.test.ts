import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import { extractMcuFilters, matchesMcuFilters, matchesPatterns, globToRegex, type McuMetadata } from '../src/mcu-matcher';

const filtersFor = (src: string) => extractMcuFilters(parseConstraints(src).ast!)!;

// A middle-of-the-road part: 256 KB RAM, 512 KB flash, 100 MHz, -40..85 °C, 1.8..3.6 V.
const mcu = (over: Partial<McuMetadata>): McuMetadata => ({
  refName: 'STM32TEST', package: 'LQFP48', ram: 256, flash: 512, frequency: 100,
  tempMin: -40, tempMax: 85, voltageMin: 1.8, voltageMax: 3.6,
  cores: ['Arm Cortex-M4'], tags: [], ...over,
});

/** Does an MCU with the given overrides pass the filter parsed from `src`? */
const passes = (src: string, over: Partial<McuMetadata>) => matchesMcuFilters(mcu(over), filtersFor(src));

// ============================================================
// Memory / frequency: min/max on the MCU's own capacity, inclusive bounds.
// ============================================================

describe('ram filter', () => {
  it('lower bound: >= value (limit inclusive)', () => {
    expect(passes('ram: 256K', { ram: 256 })).toBe(true);  // at the limit
    expect(passes('ram: 256K', { ram: 512 })).toBe(true);  // above
    expect(passes('ram: 256K', { ram: 128 })).toBe(false); // below
  });
  it('upper bound: <= value (limit inclusive)', () => {
    expect(passes('ram: < 1M', { ram: 1024 })).toBe(true);  // at the limit (1M = 1024K)
    expect(passes('ram: < 1M', { ram: 512 })).toBe(true);   // below
    expect(passes('ram: < 1M', { ram: 2048 })).toBe(false); // above
  });
  it('range: within [min, max] (both limits inclusive)', () => {
    expect(passes('ram: 128K < 512K', { ram: 256 })).toBe(true);  // inside
    expect(passes('ram: 128K < 512K', { ram: 128 })).toBe(true);  // lower limit
    expect(passes('ram: 128K < 512K', { ram: 512 })).toBe(true);  // upper limit
    expect(passes('ram: 128K < 512K', { ram: 64 })).toBe(false);  // under range
    expect(passes('ram: 128K < 512K', { ram: 1024 })).toBe(false); // over range
  });
});

describe('rom filter', () => {
  it('lower bound: >= value (limit inclusive)', () => {
    expect(passes('rom: 512K', { flash: 512 })).toBe(true);
    expect(passes('rom: 512K', { flash: 1024 })).toBe(true);
    expect(passes('rom: 512K', { flash: 256 })).toBe(false);
  });
  it('upper bound: <= value (limit inclusive)', () => {
    expect(passes('rom: < 2M', { flash: 2048 })).toBe(true);
    expect(passes('rom: < 2M', { flash: 1024 })).toBe(true);
    expect(passes('rom: < 2M', { flash: 4096 })).toBe(false);
  });
  it('range: within [min, max] (both limits inclusive)', () => {
    expect(passes('rom: 256K < 2M', { flash: 512 })).toBe(true);
    expect(passes('rom: 256K < 2M', { flash: 256 })).toBe(true);
    expect(passes('rom: 256K < 2M', { flash: 2048 })).toBe(true);
    expect(passes('rom: 256K < 2M', { flash: 128 })).toBe(false);
    expect(passes('rom: 256K < 2M', { flash: 4096 })).toBe(false);
  });
});

describe('freq filter', () => {
  it('lower bound: >= value (limit inclusive)', () => {
    expect(passes('freq: 100', { frequency: 100 })).toBe(true);
    expect(passes('freq: 100', { frequency: 200 })).toBe(true);
    expect(passes('freq: 100', { frequency: 80 })).toBe(false);
  });
  it('upper bound: <= value (limit inclusive)', () => {
    expect(passes('freq: < 200', { frequency: 200 })).toBe(true);
    expect(passes('freq: < 200', { frequency: 150 })).toBe(true);
    expect(passes('freq: < 200', { frequency: 300 })).toBe(false);
  });
  it('range: within [min, max] (both limits inclusive)', () => {
    expect(passes('freq: 100 < 480', { frequency: 240 })).toBe(true);
    expect(passes('freq: 100 < 480', { frequency: 100 })).toBe(true);
    expect(passes('freq: 100 < 480', { frequency: 480 })).toBe(true);
    expect(passes('freq: 100 < 480', { frequency: 80 })).toBe(false);
    expect(passes('freq: 100 < 480', { frequency: 600 })).toBe(false);
  });
});

// ============================================================
// Temperature: the requested working point(s) must lie inside the MCU range.
// Bare `temp: X` and `temp: < X` both mean "X must fit" (min ≤ X ≤ max);
// a range means the whole interval must fit.
// ============================================================

describe('temp filter', () => {
  it('single point (bare): min <= value <= max (limits inclusive)', () => {
    expect(passes('temp: 85', { tempMin: -40, tempMax: 85 })).toBe(true);   // at the hot limit
    expect(passes('temp: -40', { tempMin: -40, tempMax: 85 })).toBe(true);  // at the cold limit
    expect(passes('temp: 130', { tempMin: -40, tempMax: 150 })).toBe(true); // inside
    expect(passes('temp: 130', { tempMin: -40, tempMax: 125 })).toBe(false); // above range (125 part)
    expect(passes('temp: -40', { tempMin: -20, tempMax: 85 })).toBe(false); // below range (not cold enough)
  });
  it('single point (< value): same as bare — the point must fit both ends', () => {
    expect(passes('temp: < 125', { tempMin: -40, tempMax: 125 })).toBe(true);  // at the hot limit
    expect(passes('temp: < 125', { tempMin: -40, tempMax: 150 })).toBe(true);  // inside
    expect(passes('temp: < 125', { tempMin: -40, tempMax: 85 })).toBe(false);  // above range
    expect(passes('temp: < -50', { tempMin: -40, tempMax: 85 })).toBe(false);  // below range (-50 < mcu min)
  });
  it('range: the whole interval must fit (min <= lo, hi <= max)', () => {
    expect(passes('temp: -40 < 125', { tempMin: -40, tempMax: 125 })).toBe(true);  // exact fit
    expect(passes('temp: -40 < 125', { tempMin: -55, tempMax: 150 })).toBe(true);  // wider MCU
    expect(passes('temp: -40 < 125', { tempMin: -20, tempMax: 125 })).toBe(false); // lo below MCU min
    expect(passes('temp: -40 < 125', { tempMin: -40, tempMax: 85 })).toBe(false);  // hi above MCU max
  });
});

// ============================================================
// Voltage: identical working-point semantics to temperature.
// ============================================================

describe('voltage filter', () => {
  it('single point (bare): min <= value <= max (limits inclusive)', () => {
    expect(passes('voltage: 3.3', { voltageMin: 1.8, voltageMax: 3.6 })).toBe(true);  // inside
    expect(passes('voltage: 3.6', { voltageMin: 1.8, voltageMax: 3.6 })).toBe(true);  // at upper limit
    expect(passes('voltage: 1.8', { voltageMin: 1.8, voltageMax: 3.6 })).toBe(true);  // at lower limit
    expect(passes('voltage: 3.3', { voltageMin: 1.8, voltageMax: 3.0 })).toBe(false); // above range
    expect(passes('voltage: 1.6', { voltageMin: 1.8, voltageMax: 3.6 })).toBe(false); // below range
  });
  it('single point (< value): same as bare — the point must fit both ends', () => {
    expect(passes('voltage: < 2.5', { voltageMin: 1.8, voltageMax: 3.6 })).toBe(true);  // inside
    expect(passes('voltage: < 2.5', { voltageMin: 2.7, voltageMax: 3.6 })).toBe(false); // below MCU min
    expect(passes('voltage: < 3.6', { voltageMin: 1.8, voltageMax: 3.3 })).toBe(false); // above MCU max
  });
  it('range: the whole interval must fit (min <= lo, hi <= max)', () => {
    expect(passes('voltage: 1.8 < 3.6', { voltageMin: 1.8, voltageMax: 3.6 })).toBe(true);  // exact fit
    expect(passes('voltage: 1.8 < 3.6', { voltageMin: 1.62, voltageMax: 5.0 })).toBe(true); // wider MCU
    expect(passes('voltage: 1.8 < 3.6', { voltageMin: 2.0, voltageMax: 3.6 })).toBe(false); // lo below MCU min
    expect(passes('voltage: 1.8 < 3.6', { voltageMin: 1.8, voltageMax: 3.3 })).toBe(false); // hi above MCU max
  });
});

// ============================================================
// P1: glob engine (globToRegex / matchesPatterns) — mcu/package pattern core.
// ============================================================

describe('glob engine', () => {
  it('* wildcard, pass and fail', () => {
    expect(matchesPatterns('STM32F405VGTx', ['STM32F4*'])).toBe(true);
    expect(matchesPatterns('STM32G474', ['STM32F4*'])).toBe(false);
  });
  it('implicit trailing * and case-insensitive', () => {
    expect(matchesPatterns('STM32F405VGTx', ['stm32f4'])).toBe(true);   // no explicit *, lowercase
    expect(matchesPatterns('STM32G4', ['stm32f4'])).toBe(false);
  });
  it('leading *', () => {
    expect(matchesPatterns('LQFP176', ['*176'])).toBe(true);
    expect(matchesPatterns('LQFP100', ['*176'])).toBe(false);
  });
  it('[a,b] alternatives (comma-separated)', () => {
    expect(matchesPatterns('STM32F407VGTx', ['STM32F[405,407]'])).toBe(true);
    expect(matchesPatterns('STM32F405VGTx', ['STM32F[405,407]'])).toBe(true);
    expect(matchesPatterns('STM32F401CC', ['STM32F[405,407]'])).toBe(false);
  });
  it('matches if ANY pattern in the list matches', () => {
    expect(matchesPatterns('STM32G474', ['STM32F4*', 'STM32G4*'])).toBe(true);
    expect(matchesPatterns('STM32L0', ['STM32F4*', 'STM32G4*'])).toBe(false);
  });
  it('? matches a single char at the engine level', () => {
    expect(globToRegex('STM32F40?').test('STM32F401')).toBe(true);
    expect(globToRegex('STM32F40?').test('STM32F4')).toBe(false); // nothing for the ?
  });
  it('[n-m] is a numeric range, like signal patterns', () => {
    expect(matchesPatterns('STM32F406', ['STM32F[405-407]'])).toBe(true);
    expect(matchesPatterns('STM32F404', ['STM32F[405-407]'])).toBe(false);
    expect(matchesPatterns('STM32F405RG', ['STM32F[4-7]*'])).toBe(true);
    // Reversed / non-numeric ranges stay literal.
    expect(matchesPatterns('STM32F405-403X', ['STM32F[405-403]*'])).toBe(true);
  });
});

// ============================================================
// P1: mcu / package filters through the full matcher.
// ============================================================

describe('mcu filter', () => {
  it('wildcard name pattern, pass and fail', () => {
    expect(passes('mcu: STM32F4*', { refName: 'STM32F405VGTx' })).toBe(true);
    expect(passes('mcu: STM32F4*', { refName: 'STM32G474RETx' })).toBe(false);
  });
  it('multiple patterns via |', () => {
    expect(passes('mcu: STM32F4* | STM32G4*', { refName: 'STM32G474RETx' })).toBe(true);
    expect(passes('mcu: STM32F4* | STM32G4*', { refName: 'STM32L071' })).toBe(false);
  });
  it('bracket alternatives', () => {
    expect(passes('mcu: STM32F[405,407]', { refName: 'STM32F407VGTx' })).toBe(true);
    expect(passes('mcu: STM32F[405,407]', { refName: 'STM32F401CCUx' })).toBe(false);
  });
});

describe('package filter', () => {
  it('wildcard, pass and fail', () => {
    expect(passes('package: LQFP*', { package: 'LQFP48' })).toBe(true);
    expect(passes('package: LQFP*', { package: 'UFBGA100' })).toBe(false);
  });
  it('leading *', () => {
    expect(passes('package: *176', { package: 'LQFP176' })).toBe(true);
    expect(passes('package: *176', { package: 'LQFP100' })).toBe(false);
  });
  it('bracket alternatives', () => {
    expect(passes('package: LQFP[48,100]', { package: 'LQFP100' })).toBe(true);
    expect(passes('package: LQFP[48,100]', { package: 'LQFP144' })).toBe(false);
  });
});

// ============================================================
// Core: `+` separates AND groups (each must match a core), `|` separates
// alternatives within a group. `core: M4 + M7` means dual-core M4 AND M7.
// ============================================================

const SINGLE_M4 = ['Arm Cortex-M4'];
const SINGLE_M7 = ['Arm Cortex-M7'];
const SINGLE_M0 = ['Arm Cortex-M0+'];
const DUAL_M7_M4 = ['Arm Cortex-M7', 'Arm Cortex-M4'];

describe('core filter', () => {
  it('single core: pass when present (in a single- or multi-core part), fail when absent', () => {
    expect(passes('core: M4', { cores: SINGLE_M4 })).toBe(true);
    expect(passes('core: M4', { cores: DUAL_M7_M4 })).toBe(true);
    expect(passes('core: M4', { cores: SINGLE_M0 })).toBe(false);
  });

  it('alternatives (|): pass when any listed core is present', () => {
    expect(passes('core: M4 | M7', { cores: SINGLE_M4 })).toBe(true);
    expect(passes('core: M4 | M7', { cores: SINGLE_M7 })).toBe(true);
    expect(passes('core: M4 | M7', { cores: SINGLE_M0 })).toBe(false);
  });

  it('AND groups (+): require every core — must reject single-core parts', () => {
    expect(passes('core: M4 + M7', { cores: DUAL_M7_M4 })).toBe(true);
    expect(passes('core: M4 + M7', { cores: SINGLE_M4 })).toBe(false); // regression: single M4 must NOT pass
    expect(passes('core: M4 + M7', { cores: SINGLE_M7 })).toBe(false); // single M7 must NOT pass
    expect(passes('core: m4 + m7', { cores: SINGLE_M4 })).toBe(false); // case-insensitive too
  });
});

// ============================================================
// Extraction sanity — the parsed bounds themselves.
// ============================================================

describe('extractMcuFilters — parsed bounds', () => {
  it('temp/voltage bare and `< X` are points (both ends); a range keeps its ends', () => {
    expect(filtersFor('temp: 130')).toMatchObject({ reqTempMin: 130, reqTempMax: 130 });
    expect(filtersFor('temp: < 85')).toMatchObject({ reqTempMin: 85, reqTempMax: 85 });
    expect(filtersFor('temp: -40 < 125')).toMatchObject({ reqTempMin: -40, reqTempMax: 125 });
    expect(filtersFor('voltage: < 2.5')).toMatchObject({ reqVoltageMin: 2.5, reqVoltageMax: 2.5 });
    expect(filtersFor('voltage: 1.8 < 3.6')).toMatchObject({ reqVoltageMin: 1.8, reqVoltageMax: 3.6 });
  });
  it('memory suffixes scale to bytes', () => {
    expect(filtersFor('ram: 256K')).toMatchObject({ minRamBytes: 256 * 1024 });
    expect(filtersFor('rom: < 2M')).toMatchObject({ maxRomBytes: 2 * 1024 * 1024 });
  });
  it('core `+` yields separate AND groups; `|` yields alternatives within one', () => {
    expect(filtersFor('core: M4 + M7').coreRequired).toEqual([['M4'], ['M7']]);
    expect(filtersFor('core: M4 | M7').coreRequired).toEqual([['M4', 'M7']]);
  });
});
