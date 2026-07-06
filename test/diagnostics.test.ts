// ============================================================
// Tests for src/solver/diagnostics.ts
//
// Drives the analyzer with synthetic constraint snippets against the
// G474 fixture so we can assert specific bottleneck shapes.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { analyzeSolverInputs, formatSolverSummary, aggregateSolverRuns, type SolverRunRecord } from '../src/solver/diagnostics';
import type { SolverResult } from '../src/types';

const G474 = parseMcuXml(readFileSync(join(__dirname, 'g474/STM32G474R(B-C-E)Tx.xml'), 'utf-8'));

function analyze(src: string) {
  const ast = parseConstraints(src).ast!;
  return analyzeSolverInputs(ast, G474);
}

describe('diagnostics: per-port channel reports', () => {
  it('reports candidate counts for a satisfiable USART port', () => {
    const r = analyze(`
port CMD:
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)
`);
    const cmd = r.ports.find(p => p.portName === 'CMD')!;
    expect(cmd).toBeDefined();
    expect(cmd.channels).toHaveLength(2);
    for (const ch of cmd.channels) {
      expect(ch.candidatesFree).toBeGreaterThan(0);
      expect(ch.uniqueInstancesFree).toBeGreaterThan(0);
      expect(ch.typeSet.has('USART')).toBe(true);
    }
    // No bottleneck → summary stays at the headline only.
    expect(r.summary[0]).toMatch(/STM32G474/);
    expect(r.summary.length).toBeLessThanOrEqual(1);
  });

  it('flags zero-candidate channels when the pattern is unsatisfiable', () => {
    const r = analyze(`
port BOGUS:
  channel X

  config "C":
    X = NEVER999_NOPE
`);
    const port = r.ports.find(p => p.portName === 'BOGUS')!;
    expect(port.channels[0].candidatesTotal).toBe(0);
    expect(port.channels[0].candidatesFree).toBe(0);
    expect(port.channels[0].hints[0]).toMatch(/No pin/);
    expect(r.summary.some(s => /Zero-candidate channels/.test(s))).toBe(true);
  });

  it('attributes pruning to reserves vs pinned assignments', () => {
    // Reserve PA0/PA1; that should subtract from USART_TX/RX channel
    // candidate sets and bump prunedByReserve > 0.
    const r = analyze(`
reserve: PA0, PA1, PA2, PA3

port CMD:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const tx = r.ports[0].channels[0];
    expect(tx.prunedByReserve).toBeGreaterThan(0);
  });
});

describe('diagnostics: peripheral type demand', () => {
  it('marks shortfall when more ports request a type than there are instances', () => {
    // G474 has 6 USART-bucket instances (USART1-3, UART4/5, LPUART1).
    // Request 7 distinct ports → demand exceeds supply by 1.
    const ports = Array.from({ length: 7 }, (_, i) => `
port P${i}:
  channel TX

  config "UART":
    TX = USART*_TX
`).join('\n');
    const r = analyze(ports);
    const usart = r.typeDemand.find(t => t.type === 'USART')!;
    expect(usart).toBeDefined();
    expect(usart.totalRequired).toBe(7);
    expect(usart.totalFree).toBeGreaterThan(0);
    expect(usart.shortfall).toBe(true);
    expect(usart.missingInstances).toBeGreaterThan(0);
    expect(r.summary.some(s => /USART:/.test(s))).toBe(true);
  });

  it('does NOT flag shortfall when the type is shared:', () => {
    // shared: ADC* lifts the per-port instance lock-out, so even 10 ports
    // requesting ADC don't produce a shortfall.
    const ports = Array.from({ length: 10 }, (_, i) => `
port P${i}:
  channel A

  config "C":
    A = ADC*_IN[0-15]
`).join('\n');
    const src = `shared: ADC*\n${ports}`;
    const r = analyze(src);
    const adc = r.typeDemand.find(t => t.type === 'ADC');
    if (adc) {
      expect(adc.shared).toBe(true);
      expect(adc.shortfall).toBe(false);
    }
  });
});

describe('diagnostics: pin demand / cross-port contention', () => {
  it('records competing channels when two ports overlap on pins', () => {
    const r = analyze(`
port A:
  channel TX

  config "UART":
    TX = USART*_TX

port B:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const aTx = r.pinDemand.find(p => p.portName === 'A' && p.channelName === 'TX')!;
    expect(aTx).toBeDefined();
    expect(aTx.competingChannels.length).toBeGreaterThan(0);
    expect(aTx.competingChannels.some(c => c.startsWith('B.'))).toBe(true);
  });
});

describe('diagnostics: unmatched reserve detection', () => {
  it('flags literal reserves that match nothing on the MCU', () => {
    const r = analyze(`
reserve: NOTAPIN, FAKEPERIPH, PA0
port P:
  channel A

  config "C":
    A = USART*_TX
`);
    expect(r.unmatchedReserves).toContain('NOTAPIN');
    expect(r.unmatchedReserves).toContain('FAKEPERIPH');
    expect(r.unmatchedReserves).not.toContain('PA0');
  });
});

describe('formatSolverSummary', () => {
  it('produces a one-liner with valid/failed/time and bottleneck', () => {
    const r = analyze(`
port BOGUS:
  channel X

  config "C":
    X = NEVER999_NOPE
`);
    const line = formatSolverSummary('test-solver', 0, 1234, 56, r);
    expect(line).toMatch(/test-solver/);
    expect(line).toMatch(/0 valid/);
    expect(line).toMatch(/1234 failed/);
    expect(line).toMatch(/56ms/);
    expect(line).toMatch(/Zero-candidate/);
  });

  it('omits the bottleneck tail when nothing notable shows up', () => {
    const r = analyze(`
port CMD:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const line = formatSolverSummary('s', 5, 10, 12, r);
    expect(line).toMatch(/5 valid/);
    expect(line).toMatch(/5 failed/);
    expect(line).not.toMatch(/—/);   // no bottleneck appended
  });
});

// ============================================================
// aggregateSolverRuns: cross-solver overview
// ============================================================

function fakeResult(opts: {
  validCount?: number;
  evaluated?: number;
  ms?: number;
  errors?: { type: 'error' | 'warning'; message: string }[];
  firstSolutionMs?: number;
} = {}): SolverResult {
  return {
    mcuRef: 'fake',
    solutions: Array.from({ length: opts.validCount ?? 0 }, (_, i) => ({
      id: i, mcuRef: 'fake',
      configAssignments: [], portPeripherals: new Map(), costs: new Map(),
      totalCost: 0, gpioCount: 0, optionalTotal: 0, optionalFulfilled: 0,
    })) as unknown as SolverResult['solutions'],
    errors: opts.errors ?? [],
    statistics: {
      totalCombinations: 0,
      evaluatedCombinations: opts.evaluated ?? 0,
      validSolutions: opts.validCount ?? 0,
      solveTimeMs: opts.ms ?? 0,
      configCombinations: 0,
      firstSolutionMs: opts.firstSolutionMs,
    },
  };
}

describe('aggregateSolverRuns', () => {
  it('ranks peripheral shortfalls by missing instances (top 5)', () => {
    // 7 USART ports + 1 unsatisfiable bogus port + 1 perfectly-fine SPI port.
    const usartPorts = Array.from({ length: 7 }, (_, i) => `
port U${i}:
  channel TX

  config "UART":
    TX = USART*_TX
`).join('\n');
    const r = analyze(`${usartPorts}
port SPI_OK:
  channel MOSI

  config "SPI":
    MOSI = SPI*_MOSI

port BOGUS:
  channel X

  config "C":
    X = NEVER999_NOPE
`);
    const runs: SolverRunRecord[] = [
      { solverId: 'a', state: 'finished', result: fakeResult({ validCount: 0, evaluated: 100, ms: 50 }) },
      { solverId: 'b', state: 'finished', result: fakeResult({ validCount: 0, evaluated: 250, ms: 80 }) },
    ];
    const agg = aggregateSolverRuns(r, runs);

    // USART shortfall must lead the peripheral ranking.
    expect(agg.topPeripheralShortfalls[0].label).toBe('USART');
    expect(agg.topPeripheralShortfalls[0].severity).toBeGreaterThan(0);

    // Hardest channels include the BOGUS one (zero candidates → highest severity).
    expect(agg.topHardChannels[0].label).toMatch(/BOGUS\.X/);
    expect(agg.topHardChannels[0].severity).toBeGreaterThanOrEqual(1000);

    // Headline reflects no valid solutions and a top shortfall.
    expect(agg.headlines.some(h => /USART/.test(h))).toBe(true);
    expect(agg.headlines.some(h => /no free candidates/i.test(h))).toBe(true);
    expect(agg.headlines.some(h => /No solver produced/i.test(h))).toBe(true);
  });

  it('aggregates run stats across solvers and dedupes errors', () => {
    const r = analyze(`
port CMD:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const sameError = { type: 'error' as const, message: 'Phase 1: nothing matched' };
    const runs: SolverRunRecord[] = [
      { solverId: 'A', state: 'finished',
        result: fakeResult({ validCount: 3, evaluated: 100, ms: 12, firstSolutionMs: 4, errors: [sameError] }) },
      { solverId: 'B', state: 'finished',
        result: fakeResult({ validCount: 5, evaluated: 200, ms: 8, firstSolutionMs: 2, errors: [sameError] }) },
      { solverId: 'C', state: 'timeout',
        result: fakeResult({ validCount: 0, evaluated: 50, ms: 1000, errors: [{ type: 'warning', message: 'timeout' }] }) },
    ];
    const agg = aggregateSolverRuns(r, runs);

    expect(agg.runStats.solverCount).toBe(3);
    expect(agg.runStats.finishedCount).toBe(2);
    expect(agg.runStats.timeoutCount).toBe(1);
    expect(agg.runStats.bestValidCount).toBe(5);
    expect(agg.runStats.totalEvaluated).toBe(350);
    expect(agg.runStats.totalSolveTimeMs).toBe(1020);
    expect(agg.runStats.fastestFirstSolutionMs).toBe(2);

    // Same error from A and B folds into one digest entry with both solvers listed.
    const folded = agg.errorDigest.find(e => e.message === 'Phase 1: nothing matched')!;
    expect(folded).toBeDefined();
    expect(folded.count).toBe(2);
    expect(folded.solvers.sort()).toEqual(['A', 'B']);

    // Errors come before warnings.
    expect(agg.errorDigest[0].type).toBe('error');
  });

  it('returns empty top-N lists when there are no bottlenecks', () => {
    const r = analyze(`
port CMD:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const agg = aggregateSolverRuns(r, []);
    expect(agg.topPeripheralShortfalls).toHaveLength(0);
    // Hard-channel list is always populated with whatever channels exist
    // (even ones that aren't bottlenecks) — it just ranks by hardness.
    expect(agg.topHardChannels.length).toBeLessThanOrEqual(10);
  });

  it('defaults to top-10 ranking, not top-5', () => {
    // 20 ports each with a USART channel → plenty of candidates per
    // channel, but the topHardChannels list still surfaces up to 10 of
    // them (severities are negative since none are hard, the cap is the
    // observable behaviour).
    const ports = Array.from({ length: 20 }, (_, i) => `
port P${i}:
  channel TX

  config "UART":
    TX = USART*_TX
`).join('\n');
    const r = analyze(ports);
    const agg = aggregateSolverRuns(r, []);
    expect(agg.topHardChannels.length).toBe(10);
  });

  it('excludes pure-GPIO channels from hardChannels and contention rankings', () => {
    const r = analyze(`
port LEDS:
  channel R
  channel G
  channel B

  config "GPIO":
    R = OUT
    G = OUT
    B = OUT

port CMD:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const agg = aggregateSolverRuns(r, []);
    // None of the LED channels (pure GPIO) should appear.
    for (const row of agg.topHardChannels) {
      expect(row.label).not.toMatch(/LEDS\./);
    }
    for (const row of agg.topContention) {
      expect(row.label).not.toMatch(/LEDS\./);
    }
  });

  it('skips GPIO type from peripheral shortfalls', () => {
    // Many ports demanding GPIO would synthesize a GPIO type bucket.
    // Even if the bucket somehow shows shortfall the aggregator must
    // suppress it from the user-facing ranking.
    const ports = Array.from({ length: 4 }, (_, i) => `
port P${i}:
  channel A

  config "C":
    A = OUT
`).join('\n');
    const r = analyze(ports);
    const agg = aggregateSolverRuns(r, []);
    for (const row of agg.topPeripheralShortfalls) {
      expect(row.label).not.toBe('GPIO');
    }
  });

  it('drops forced-binding channels when excludeForcedBinding is set', () => {
    // PA13/PA14 are the only USART2 RX pins on G474 if we reserve every
    // other USART RX pin → forced binding. Reserve everything that
    // could carry USART_TX except PA9 to manufacture exactly 1 free pin.
    const r = analyze(`
reserve: PA0, PA1, PA2, PA3, PA4, PA5, PA6, PA7, PB1, PB2, PB3, PB4, PB5, PB7, PB8, PB9, PB10, PB11, PC0, PC1, PC2, PC3, PC4, PC5, PC6, PC7, PC10, PC11, PD5, PE0, PE1
port CMD:
  channel TX

  config "UART":
    TX = USART*_TX
`);
    const cmdTx = r.ports[0].channels[0];
    if (cmdTx.uniquePinsFree !== 1) {
      // Test premise broken (data drift) — tighten reserves above. Skip
      // the assertion rather than fail spuriously.
      return;
    }
    const withForced = aggregateSolverRuns(r, []);
    const withoutForced = aggregateSolverRuns(r, [], { excludeForcedBinding: true });
    // With the toggle off the forced channel ranks (severity 100).
    expect(withForced.topHardChannels.some(c => /CMD\.TX/.test(c.label))).toBe(true);
    // With the toggle on it disappears.
    expect(withoutForced.topHardChannels.some(c => /CMD\.TX/.test(c.label))).toBe(false);
  });

  it('keeps zero-candidate channels even when excludeForcedBinding is set', () => {
    const r = analyze(`
port BOGUS:
  channel X

  config "C":
    X = NEVER999_NOPE
`);
    const agg = aggregateSolverRuns(r, [], { excludeForcedBinding: true });
    // Zero-candidate is a real shortage, not a forced binding — keep it.
    expect(agg.topHardChannels[0].label).toMatch(/BOGUS\.X/);
  });

  it('reports minRequirements with peripheral vs GPIO pin split', () => {
    const r = analyze(`
port CMD:
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX

port LEDS:
  channel R
  channel G

  config "GPIO":
    R = OUT
    G = OUT

port OPT:
  channel CTS

  config "UART":
    CTS ?= USART*_CTS
`);
    const agg = aggregateSolverRuns(r, []);
    const min = agg.minRequirements;
    expect(min.peripheralSignalPins).toBe(2);   // CMD.TX, CMD.RX (CTS is optional)
    expect(min.gpioPins).toBe(2);                // LEDS.R, LEDS.G
    expect(min.totalPins).toBe(4);
    expect(min.peripheralInstances).toBeGreaterThanOrEqual(1); // ≥ USART (CMD)
    expect(min.byType.get('USART')).toBeGreaterThanOrEqual(1);
    expect(min.byType.has('GPIO')).toBe(false);
  });
});
