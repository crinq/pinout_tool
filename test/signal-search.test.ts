import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseSearchPattern } from '../src/parser/constraint-parser';
import { expandPatternToCandidates } from '../src/solver/pattern-matcher';
import type { Mcu, Pin, Signal } from '../src/types';

const mcuXml = readFileSync(join(__dirname, 'g474/STM32G474R(B-C-E)Tx.xml'), 'utf-8');
const mcu = parseMcuXml(mcuXml);

/**
 * Reproduce the exact search logic from package-viewer.ts executeSearch().
 * Returns { matchedPins, matchedSignals, tier } to identify which tier matched.
 */
function executeSearch(query: string, mcuData: Mcu): { pins: Set<string>; signals: Set<string>; tier: number } {
  const pins = new Set<string>();
  const signals = new Set<string>();

  if (!query.trim()) return { pins, signals, tier: 0 };

  const trimmed = query.trim().toUpperCase();

  // Tier 1: Exact pin name match
  for (const pin of mcuData.pins) {
    const gpioName = (pin.gpioPort && pin.gpioNumber !== undefined)
      ? `P${pin.gpioPort}${pin.gpioNumber}`
      : pin.name;
    if (gpioName.toUpperCase() === trimmed || pin.name.toUpperCase() === trimmed) {
      pins.add(pin.name);
    }
  }

  if (pins.size > 0) return { pins, signals, tier: 1 };

  // Tier 2: Signal pattern match
  const patternNode = parseSearchPattern(trimmed);
  if (patternNode) {
    const candidates = expandPatternToCandidates(patternNode, mcuData);
    for (const c of candidates) {
      pins.add(c.pin.name);
      signals.add(c.signalName);
    }
  }

  if (pins.size > 0) return { pins, signals, tier: 2 };

  // Tier 3: Substring fallback
  for (const pin of mcuData.pins) {
    for (const sig of pin.signals) {
      if (sig.name.toUpperCase().includes(trimmed)) {
        pins.add(pin.name);
        signals.add(sig.name);
      }
    }
  }

  return { pins, signals, tier: 3 };
}

// ============================================================
// Tests
// ============================================================

describe('Signal search: pattern parsing', () => {
  it('parses TIM*_CH1', () => {
    const p = parseSearchPattern('TIM*_CH1');
    expect(p).not.toBeNull();
    expect(p!.instancePart.type).toBe('wildcard');
  });

  it('parses tim*_ch1 (lowercase)', () => {
    const p = parseSearchPattern('TIM*_CH1'); // uppercased in executeSearch
    expect(p).not.toBeNull();
  });

  it('parses TIM[1,2]_CH1', () => {
    const p = parseSearchPattern('TIM[1,2]_CH1');
    expect(p).not.toBeNull();
    expect(p!.instancePart.type).toBe('range');
  });

  it('parses ADC*_IN[1-4]', () => {
    const p = parseSearchPattern('ADC*_IN[1-4]');
    expect(p).not.toBeNull();
    expect(p!.instancePart.type).toBe('wildcard');
    expect(p!.functionPart.type).toBe('range');
  });

  it('parses USART*_TX', () => {
    const p = parseSearchPattern('USART*_TX');
    expect(p).not.toBeNull();
    expect(p!.instancePart.type).toBe('wildcard');
  });

  it('parses *_TX', () => {
    const p = parseSearchPattern('*_TX');
    expect(p).not.toBeNull();
    expect(p!.instancePart.type).toBe('any');
  });

  it('parses SPI[1-3]_*', () => {
    const p = parseSearchPattern('SPI[1-3]_*');
    expect(p).not.toBeNull();
    expect(p!.instancePart.type).toBe('range');
    expect(p!.functionPart.type).toBe('any');
  });
});

describe('Signal search: pattern expansion', () => {
  it('TIM*_CH1 matches multiple timer CH1 pins', () => {
    const p = parseSearchPattern('TIM*_CH1')!;
    const candidates = expandPatternToCandidates(p, mcu);
    expect(candidates.length).toBeGreaterThan(5);
    const signalNames = new Set(candidates.map(c => c.signalName));
    expect(signalNames.has('TIM1_CH1')).toBe(true);
    expect(signalNames.has('TIM2_CH1')).toBe(true);
  });

  it('TIM[1,2]_CH1 matches only TIM1 and TIM2', () => {
    const p = parseSearchPattern('TIM[1,2]_CH1')!;
    const candidates = expandPatternToCandidates(p, mcu);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.signalName).toMatch(/^TIM[12]_CH1$/);
    }
  });

  it('ADC*_IN[0-3] matches ADC inputs 0-3', () => {
    const p = parseSearchPattern('ADC*_IN[0-3]')!;
    const candidates = expandPatternToCandidates(p, mcu);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.signalName).toMatch(/^ADC\d+_IN[0-3]$/);
    }
  });

  it('USART*_TX matches USART/UART/LPUART TX signals', () => {
    const p = parseSearchPattern('USART*_TX')!;
    const candidates = expandPatternToCandidates(p, mcu);
    expect(candidates.length).toBeGreaterThan(0);
    const instances = new Set(candidates.map(c => c.peripheralInstance));
    // Should match USART1, USART2, etc. and possibly UART4, LPUART1 via aliases
    expect(instances.size).toBeGreaterThan(1);
  });
});

describe('Signal search: full executeSearch flow', () => {
  it('exact pin name match (tier 1)', () => {
    const result = executeSearch('PA0', mcu);
    expect(result.tier).toBe(1);
    expect(result.pins.size).toBe(1);
  });

  it('exact pin name match is case-insensitive (tier 1)', () => {
    const result = executeSearch('pa0', mcu);
    expect(result.tier).toBe(1);
    expect(result.pins.size).toBe(1);
  });

  it('wildcard pattern TIM*_CH1 uses tier 2', () => {
    const result = executeSearch('TIM*_CH1', mcu);
    expect(result.tier).toBe(2);
    expect(result.pins.size).toBeGreaterThan(5);
    expect(result.signals.has('TIM1_CH1')).toBe(true);
  });

  it('wildcard pattern tim*_ch1 (lowercase) uses tier 2', () => {
    const result = executeSearch('tim*_ch1', mcu);
    expect(result.tier).toBe(2);
    expect(result.pins.size).toBeGreaterThan(5);
  });

  it('range pattern TIM[1,2]_CH1 uses tier 2', () => {
    const result = executeSearch('TIM[1,2]_CH1', mcu);
    expect(result.tier).toBe(2);
    expect(result.pins.size).toBeGreaterThan(0);
    for (const sig of result.signals) {
      expect(sig).toMatch(/^TIM[12]_CH1$/);
    }
  });

  it('range pattern TIM[1-3]_CH1 uses tier 2', () => {
    const result = executeSearch('TIM[1-3]_CH1', mcu);
    expect(result.tier).toBe(2);
    expect(result.pins.size).toBeGreaterThan(0);
  });

  it('substring SPI falls through to tier 3', () => {
    const result = executeSearch('SPI', mcu);
    expect(result.tier).toBe(3);
    expect(result.pins.size).toBeGreaterThan(0);
  });

  it('exact signal TIM1_CH1 uses tier 2 (literal pattern)', () => {
    const result = executeSearch('TIM1_CH1', mcu);
    expect(result.tier).toBe(2);
    expect(result.pins.size).toBeGreaterThan(0);
    expect(result.signals.has('TIM1_CH1')).toBe(true);
  });

  it('ADC*_IN[1-4] uses tier 2', () => {
    const result = executeSearch('ADC*_IN[1-4]', mcu);
    expect(result.tier).toBe(2);
    expect(result.pins.size).toBeGreaterThan(0);
  });
});
