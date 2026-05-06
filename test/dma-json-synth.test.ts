// ============================================================
// Tests for the DMA synthesizer in mcu-json-parser
// (vendor JSON → DmaData)
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseMcuJson, synthesizeDmaDataFromJson, type McuJsonDocument } from '../src/parser/mcu-json-parser';
import { findDmaStreamsForSignal } from '../src/parser/dma-xml-parser';

const DATA_BASE = join(__dirname, '../../mcu_data/data/stm32/mcu');
const HAS_DATA = existsSync(DATA_BASE);
const maybeDescribe = HAS_DATA ? describe : describe.skip;

function loadDoc(die: string): McuJsonDocument {
  return JSON.parse(readFileSync(join(DATA_BASE, `${die}.json`), 'utf-8')) as McuJsonDocument;
}

maybeDescribe('DMA synthesis from vendor JSON', () => {
  // ============================================================
  // STM32C011D6 — DMAMUX (single DMA1 controller)
  // ============================================================
  describe('STM32C011D6 (DMAMUX1 → DMA1)', () => {
    const mcus = parseMcuJson(JSON.stringify(loadDoc('stm32c011d6')));
    const dma = mcus[0].dma!;

    it('attaches DmaData to every variant', () => {
      expect(mcus[0].dma).toBeDefined();
      expect(dma.streams.length).toBeGreaterThan(0);
    });

    it('every stream name comes from dma_controllers[].channels[]', () => {
      // No DMAMUX_CH<n> placeholder leaks through — the resolver maps the
      // mux input slot back to the underlying physical channel name.
      for (const s of dma.streams) {
        expect(s.name).toMatch(/^(DMA|BDMA|GPDMA|LPDMA|MDMA|HPDMA|XSPI)\d*_CH\d+$/);
      }
    });

    it('USART1_TX routes through every DMA1 channel attached to DMAMUX1', () => {
      const streams = findDmaStreamsForSignal(dma, 'USART1_TX', 'USART1');
      // STM32C0 has DMA1 with 3 channels, all on DMAMUX1.
      expect(streams.length).toBe(3);
      for (const s of streams) expect(s.controller).toBe('DMA1');
    });

    it('USART1_RX is registered separately from USART1_TX', () => {
      const tx = findDmaStreamsForSignal(dma, 'USART1_TX', 'USART1');
      const rx = findDmaStreamsForSignal(dma, 'USART1_RX', 'USART1');
      expect(rx.length).toBe(tx.length);
      // Different DMAMUX request numbers, but here we only assert the
      // streams resolve — the request id lives inside the JSON token and
      // is dropped from DmaStreamInfo by design.
      expect(rx.length).toBeGreaterThan(0);
    });

    it('ADC1 instance-level DMA falls back via instanceToDmaStreams', () => {
      // The vendor JSON encodes ADC's whole-instance DMA route as
      // signal === "ADC1" (the peripheral name itself). The synthesizer
      // emits this under the bare instance key so the solver can find
      // it via the instance fallback path.
      const streams = findDmaStreamsForSignal(dma, 'ADC1', 'ADC1');
      expect(streams.length).toBeGreaterThan(0);
      // Same lookup with an unrelated signalName triggers the instance
      // fallback and should still return ADC1 streams.
      const instanceFallback = findDmaStreamsForSignal(dma, 'something_unrelated', 'ADC1');
      expect(instanceFallback.length).toBe(streams.length);
    });
  });

  // ============================================================
  // STM32F405VG — fixed mapping (DMA1 + DMA2)
  // ============================================================
  describe('STM32F405VG (fixed-mapping, DMA1 + DMA2)', () => {
    const mcus = parseMcuJson(JSON.stringify(loadDoc('stm32f405vg')));
    const dma = mcus[0].dma!;

    it('synthesizes both controllers', () => {
      const ctrls = new Set(dma.streams.map(s => s.controller));
      expect(ctrls.has('DMA1')).toBe(true);
      expect(ctrls.has('DMA2')).toBe(true);
    });

    it('USART1_TX routes only through DMA2_CH7 (single fixed binding)', () => {
      const streams = findDmaStreamsForSignal(dma, 'USART1_TX', 'USART1');
      expect(streams.map(s => s.name)).toEqual(['DMA2_CH7']);
    });

    it('USART1_RX appears on both DMA2_CH2 and DMA2_CH5', () => {
      const streams = findDmaStreamsForSignal(dma, 'USART1_RX', 'USART1');
      expect(streams.map(s => s.name).sort()).toEqual(['DMA2_CH2', 'DMA2_CH5']);
    });
  });

  // ============================================================
  // STM32H750IB — multi-controller (DMA1+DMA2 via DMAMUX1, BDMA via DMAMUX2, MDMA standalone)
  // ============================================================
  describe('STM32H750IB (DMA1/DMA2 via DMAMUX1, BDMA via DMAMUX2)', () => {
    const file = join(DATA_BASE, 'stm32h750ib.json');
    if (!existsSync(file)) {
      it.skip('skipped — vendor JSON missing', () => {});
      return;
    }
    const mcus = parseMcuJson(readFileSync(file, 'utf-8'));
    const dma = mcus[0].dma!;

    it('exposes DMA1, DMA2, BDMA, MDMA streams', () => {
      const ctrls = new Set(dma.streams.map(s => s.controller));
      expect(ctrls.has('DMA1')).toBe(true);
      expect(ctrls.has('DMA2')).toBe(true);
      expect(ctrls.has('BDMA')).toBe(true);
      expect(ctrls.has('MDMA')).toBe(true);
    });

    it('USART1_TX fans out across all 16 DMAMUX1 slots (DMA1+DMA2)', () => {
      const streams = findDmaStreamsForSignal(dma, 'USART1_TX', 'USART1');
      // DMA1 has 8 channels, DMA2 has 8 channels — total 16 mux slots.
      expect(streams.length).toBe(16);
      const ctrls = new Set(streams.map(s => s.controller));
      expect(ctrls).toEqual(new Set(['DMA1', 'DMA2']));
    });
  });

  // ============================================================
  // synthesizeDmaDataFromJson direct unit tests
  // ============================================================
  describe('synthesizeDmaDataFromJson unit tests', () => {
    it('returns undefined when the document has no dma_controllers', () => {
      const doc: McuJsonDocument = {
        name: 'stub', family: 'test', packages: [], peripherals: [],
      };
      expect(synthesizeDmaDataFromJson(doc)).toBeUndefined();
    });

    it('skips unparseable tokens gracefully', () => {
      const doc: McuJsonDocument = {
        name: 'stub', family: 'test',
        dma_controllers: [{
          name: 'DMA1',
          channels: [{ name: 'DMA1_CH0', channel: 0 }],
        }],
        peripherals: [{
          name: 'TEST1', kind: 'test',
          dma_channels: [{ signal: 'TX', dma: ['NOT_A_VALID_TOKEN', 'DMA1_CH0'] }],
        }],
      };
      const dma = synthesizeDmaDataFromJson(doc)!;
      expect(dma.streams).toHaveLength(1);
      // The valid one still resolves; the bogus one is ignored.
      expect(findDmaStreamsForSignal(dma, 'TEST1_TX', 'TEST1').map(s => s.name))
        .toEqual(['DMA1_CH0']);
    });

    it('accepts enable_condition tokens (routing listed even with condition)', () => {
      const doc: McuJsonDocument = {
        name: 'stub', family: 'test',
        dma_controllers: [{
          name: 'DMA1',
          channels: [
            { name: 'DMA1_CH1', channel: 1 },
            { name: 'DMA1_CH2', channel: 2 },
          ],
        }],
        peripherals: [{
          name: 'ADC1', kind: 'adc',
          dma_channels: [{
            signal: 'RX',
            dma: [
              { dma: 'DMA1_CH1', enable_condition: { set_register: { register: 'ADC1.CFGR1', field: 'DMA_RMP', value: 0 } } },
              { dma: 'DMA1_CH2', enable_condition: { set_register: { register: 'ADC1.CFGR1', field: 'DMA_RMP', value: 1 } } },
            ],
          }],
        }],
      };
      const dma = synthesizeDmaDataFromJson(doc)!;
      const streams = findDmaStreamsForSignal(dma, 'ADC1_RX', 'ADC1');
      expect(streams.map(s => s.name).sort()).toEqual(['DMA1_CH1', 'DMA1_CH2']);
    });

    it('sets DmaData.version to doc.die when present', () => {
      const doc: McuJsonDocument = {
        name: 'stm32x', family: 'test', die: 'DIEX',
        dma_controllers: [{ name: 'DMA1', channels: [{ name: 'DMA1_CH0', channel: 0 }] }],
        peripherals: [],
      };
      const dma = synthesizeDmaDataFromJson(doc)!;
      expect(dma.version).toBe('DIEX');
    });
  });
});
