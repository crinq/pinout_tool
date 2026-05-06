import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { parseMcuXml, validateMcu } from '../src/parser/mcu-xml-parser';
import { parseDmaXml } from '../src/parser/dma-xml-parser';

// jsdom retains every parsed Document via the shared window — sweeping all
// 1961 MCU XMLs accumulates >8GB before GC. linkedom is a pure-JS DOM that
// supports the selectors the parsers need (:scope > X) and releases per-doc
// memory cleanly. Override the global DOMParser only inside this suite.
const MCU_DIR = join(__dirname, 'all/mcu');
const DMA_DIR = join(__dirname, 'all/dma');

interface McuFailure {
  file: string;
  refName?: string;
  stage: 'mcu-parse' | 'mcu-validate' | 'dma-missing' | 'dma-parse';
  detail: string;
}

const mcuFiles = readdirSync(MCU_DIR).filter(f => f.endsWith('.xml'));
const dmaFiles = new Set(readdirSync(DMA_DIR).filter(f => f.endsWith('.xml')));

describe('All STM32 MCU + DMA parser sweep', () => {
  const failures: McuFailure[] = [];
  const dmaCache = new Map<string, { ok: true } | { ok: false; error: string }>();
  let mcusWithDma = 0;
  let mcusWithoutDma = 0;
  let validateWarningsTotal = 0;
  const warningCounts = new Map<string, number>();
  let prevDOMParser: typeof globalThis.DOMParser | undefined;

  function tryParseDma(version: string): { ok: true } | { ok: false; error: string } {
    const cached = dmaCache.get(version);
    if (cached) return cached;
    const fname = `DMA-${version}_Modes.xml`;
    if (!dmaFiles.has(fname)) {
      const result = { ok: false as const, error: `DMA file ${fname} not found` };
      dmaCache.set(version, result);
      return result;
    }
    try {
      const xml = readFileSync(join(DMA_DIR, fname), 'utf-8');
      parseDmaXml(xml);
      const result = { ok: true as const };
      dmaCache.set(version, result);
      return result;
    } catch (e) {
      const result = { ok: false as const, error: (e as Error).message };
      dmaCache.set(version, result);
      return result;
    }
  }

  beforeAll(async () => {
    prevDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = LinkedomDOMParser as unknown as typeof globalThis.DOMParser;

    for (const file of mcuFiles) {
      const path = join(MCU_DIR, file);
      let mcu;
      try {
        const xml = readFileSync(path, 'utf-8');
        mcu = parseMcuXml(xml);
      } catch (e) {
        failures.push({ file, stage: 'mcu-parse', detail: (e as Error).message });
        continue;
      }

      const validation = validateMcu(mcu);
      validateWarningsTotal += validation.warnings.length;
      for (const w of validation.warnings) {
        // Bucket by peripheral instance (last token)
        const m = w.match(/unknown peripheral (\S+)/);
        const key = m ? `unknown peripheral ${m[1]}` : w;
        warningCounts.set(key, (warningCounts.get(key) ?? 0) + 1);
      }
      if (!validation.valid) {
        failures.push({
          file,
          refName: mcu.refName,
          stage: 'mcu-validate',
          detail: validation.errors.join('; '),
        });
      }

      const dmaPeripheral = mcu.peripherals.find(p => p.originalType === 'DMA');
      if (!dmaPeripheral || !dmaPeripheral.version) {
        mcusWithoutDma++;
        continue;
      }
      mcusWithDma++;

      const dmaResult = tryParseDma(dmaPeripheral.version);
      if (!dmaResult.ok) {
        failures.push({
          file,
          refName: mcu.refName,
          stage: dmaResult.error.includes('not found') ? 'dma-missing' : 'dma-parse',
          detail: `version=${dmaPeripheral.version}: ${dmaResult.error}`,
        });
      }
    }
  }, 60_000);

  afterAll(() => {
    globalThis.DOMParser = prevDOMParser as typeof globalThis.DOMParser;
  });

  it('summary counts', () => {
    console.log(`MCU files: ${mcuFiles.length}`);
    console.log(`MCUs with DMA: ${mcusWithDma}`);
    console.log(`MCUs without DMA: ${mcusWithoutDma}`);
    console.log(`Distinct DMA versions referenced: ${dmaCache.size}`);
    console.log(`Validation warnings total: ${validateWarningsTotal}`);
    console.log(`Failures: ${failures.length}`);
    const top = [...warningCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length) {
      console.log('Top warnings:');
      for (const [k, n] of top) console.log(`  ${n}\t${k}`);
    }
    expect(mcuFiles.length).toBeGreaterThan(0);
    expect(dmaFiles.size).toBeGreaterThan(0);
  });

  it('all MCU XMLs parse without throwing', () => {
    const parseFailures = failures.filter(f => f.stage === 'mcu-parse');
    if (parseFailures.length > 0) {
      console.log('mcu-parse failures:');
      for (const f of parseFailures) console.log(`  ${f.file}: ${f.detail}`);
    }
    expect(parseFailures).toEqual([]);
  });

  it('all MCU XMLs pass validateMcu', () => {
    const validateFailures = failures.filter(f => f.stage === 'mcu-validate');
    if (validateFailures.length > 0) {
      console.log('mcu-validate failures:');
      for (const f of validateFailures) {
        console.log(`  ${f.file} (${f.refName}): ${f.detail}`);
      }
    }
    expect(validateFailures).toEqual([]);
  });

  it('every MCU DMA peripheral has a matching DMA XML file', () => {
    const missing = failures.filter(f => f.stage === 'dma-missing');
    if (missing.length > 0) {
      const byVersion = new Map<string, string[]>();
      for (const f of missing) {
        const m = f.detail.match(/version=([^:]+):/);
        const v = m ? m[1] : 'unknown';
        const arr = byVersion.get(v) ?? [];
        arr.push(f.refName ?? f.file);
        byVersion.set(v, arr);
      }
      console.log('dma-missing failures:');
      for (const [v, mcus] of byVersion) {
        console.log(`  ${v}: ${mcus.length} MCU(s), e.g. ${mcus.slice(0, 3).join(', ')}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('logical/physical model invariants', () => {
    // Spot-checks that exercise the new shape; the per-MCU loop already
    // ran validateMcu (which now includes structural checks), so this is
    // a sanity test on a known fixture.
    const xml = readFileSync(join(MCU_DIR, 'STM32U031F4Px.xml'), 'utf-8');
    const mcu = parseMcuXml(xml);
    const phys18 = mcu.physicalPinByPosition.get('18')!;
    expect(phys18).toBeDefined();
    // UFQFPN20: PA14 (SWCLK), PB4, PB5, PB6 share position 18.
    expect(phys18.logicals.map(l => l.name).sort()).toEqual(
      ['PA14', 'PB4', 'PB5', 'PB6'].sort()
    );
    for (const lp of phys18.logicals) {
      expect(lp.physical).toBe(phys18);
      expect(lp.isDefaultVariant).toBe(true);
      expect(lp.variantGroup).toBeUndefined();
    }
  });

  it('every referenced DMA XML parses without throwing', () => {
    const parseErrors = failures.filter(f => f.stage === 'dma-parse');
    if (parseErrors.length > 0) {
      console.log('dma-parse failures:');
      for (const f of parseErrors) {
        console.log(`  ${f.file} (${f.refName}): ${f.detail}`);
      }
    }
    expect(parseErrors).toEqual([]);
  });

  it('full failure dump (diagnostic)', () => {
    if (failures.length > 0) {
      const byStage = new Map<string, McuFailure[]>();
      for (const f of failures) {
        const arr = byStage.get(f.stage) ?? [];
        arr.push(f);
        byStage.set(f.stage, arr);
      }
      for (const [stage, arr] of byStage) {
        console.log(`=== ${stage} (${arr.length}) ===`);
        for (const f of arr) {
          console.log(`${f.file}\t${f.refName ?? ''}\t${f.detail}`);
        }
      }
    }
    expect(failures.length).toBeGreaterThanOrEqual(0);
  });
});
