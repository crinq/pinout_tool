import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDmaXml, findDmaStreamsForSignal, isDmaXml, getDmaXmlVersion } from '../src/parser/dma-xml-parser';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import type { DmaData } from '../src/types';

const DMA_XML_PATH = join(__dirname, '../example/mcu_data/STM32F4/DMA-STM32F417_dma_v2_0_Modes.xml');
const MCU_XML_PATH = join(__dirname, '../example/mcu_data/STM32F4/STM32F405VGTx.xml');

describe('DMA XML Parser', () => {
  const dmaXml = readFileSync(DMA_XML_PATH, 'utf-8');
  let dmaData: DmaData;

  it('should detect DMA XML files', () => {
    expect(isDmaXml(dmaXml)).toBe(true);
    const mcuXml = readFileSync(MCU_XML_PATH, 'utf-8');
    expect(isDmaXml(mcuXml)).toBe(false);
  });

  it('should extract DMA version', () => {
    expect(getDmaXmlVersion(dmaXml)).toBe('STM32F417_dma_v2_0');
  });

  it('should parse DMA XML without errors', () => {
    dmaData = parseDmaXml(dmaXml);
    expect(dmaData.version).toBe('STM32F417_dma_v2_0');
  });

  it('should find 16 DMA streams (DMA1: 8, DMA2: 8)', () => {
    dmaData = parseDmaXml(dmaXml);
    expect(dmaData.streams.length).toBe(16);

    const dma1 = dmaData.streams.filter(s => s.controller === 'DMA1');
    const dma2 = dmaData.streams.filter(s => s.controller === 'DMA2');
    expect(dma1.length).toBe(8);
    expect(dma2.length).toBe(8);
  });

  it('should parse stream names correctly', () => {
    dmaData = parseDmaXml(dmaXml);
    const streamNames = dmaData.streams.map(s => s.name).sort();
    expect(streamNames).toContain('DMA1_Stream0');
    expect(streamNames).toContain('DMA1_Stream7');
    expect(streamNames).toContain('DMA2_Stream0');
    expect(streamNames).toContain('DMA2_Stream7');
  });

  it('should map USART1_TX to DMA streams', () => {
    dmaData = parseDmaXml(dmaXml);
    const streams = findDmaStreamsForSignal(dmaData, 'USART1_TX');
    expect(streams.length).toBeGreaterThan(0);
    // USART1_TX should be on DMA2_Stream7
    expect(streams.some(s => s.name === 'DMA2_Stream7')).toBe(true);
  });

  it('should map USART1_RX to DMA streams', () => {
    dmaData = parseDmaXml(dmaXml);
    const streams = findDmaStreamsForSignal(dmaData, 'USART1_RX');
    expect(streams.length).toBeGreaterThan(0);
    // USART1_RX should be on DMA2_Stream2 and DMA2_Stream5
    const names = streams.map(s => s.name);
    expect(names).toContain('DMA2_Stream2');
    expect(names).toContain('DMA2_Stream5');
  });

  it('should map SPI1_TX to DMA streams', () => {
    dmaData = parseDmaXml(dmaXml);
    const streams = findDmaStreamsForSignal(dmaData, 'SPI1_TX');
    expect(streams.length).toBeGreaterThan(0);
  });

  it('should not find SPI1_MOSI directly (MCU signal name differs from DMA trigger)', () => {
    dmaData = parseDmaXml(dmaXml);
    // SPI1_MOSI is the MCU signal name, DMA uses SPI1_TX
    const streams = findDmaStreamsForSignal(dmaData, 'SPI1_MOSI');
    expect(streams.length).toBe(0);
    // But SPI1_TX should be found
    const txStreams = findDmaStreamsForSignal(dmaData, 'SPI1_TX');
    expect(txStreams.length).toBeGreaterThan(0);
  });

  it('should handle peripheral-level DMA requests (ADC1)', () => {
    dmaData = parseDmaXml(dmaXml);
    // ADC1 is a peripheral-level request, not signal-level
    const streamsByInstance = findDmaStreamsForSignal(dmaData, 'ADC1_IN0', 'ADC1');
    expect(streamsByInstance.length).toBeGreaterThan(0);
  });

  it('should skip MEMTOMEM entries', () => {
    dmaData = parseDmaXml(dmaXml);
    // No signal called MEMTOMEM should exist
    const streams = findDmaStreamsForSignal(dmaData, 'MEMTOMEM');
    expect(streams.length).toBe(0);
  });

  it('should handle slash-separated signals (TIM5_CH3/UP)', () => {
    dmaData = parseDmaXml(dmaXml);
    // DMA1_Stream0 should have TIM5_CH3 and TIM5_UP from "TIM5_CH3/UP"
    const ch3 = findDmaStreamsForSignal(dmaData, 'TIM5_CH3');
    const up = findDmaStreamsForSignal(dmaData, 'TIM5_UP');
    expect(ch3.length).toBeGreaterThan(0);
    expect(up.length).toBeGreaterThan(0);
    // Both should share at least one stream (DMA1_Stream0)
    const ch3Names = ch3.map(s => s.name);
    const upNames = up.map(s => s.name);
    const shared = ch3Names.filter(n => upNames.includes(n));
    expect(shared.length).toBeGreaterThan(0);
  });

  it('should build signalToDmaStreams lookup', () => {
    dmaData = parseDmaXml(dmaXml);
    expect(dmaData.signalToDmaStreams.size).toBeGreaterThan(0);
    expect(dmaData.signalToDmaStreams.has('USART1_TX')).toBe(true);
    expect(dmaData.signalToDmaStreams.has('SPI3_RX')).toBe(true);
  });

  it('should build instanceToDmaStreams lookup for peripheral-level requests', () => {
    dmaData = parseDmaXml(dmaXml);
    expect(dmaData.instanceToDmaStreams.has('ADC1')).toBe(true);
    expect(dmaData.instanceToDmaStreams.has('ADC2')).toBe(true);
    expect(dmaData.instanceToDmaStreams.has('ADC3')).toBe(true);
  });
});

// ============================================================
// STM32H7 DMA (range-based streams, all peripherals on all streams)
// ============================================================

const H7_DMA_XML_PATH = join(__dirname, '../example/mcu_data/STM32H7/DMA-STM32H753_dma2_v1_3_Modes.xml');

describe('H7 DMA XML Parser (range-based streams)', () => {
  const h7DmaXml = readFileSync(H7_DMA_XML_PATH, 'utf-8');
  let h7DmaData: DmaData;

  it('should detect H7 DMA XML', () => {
    expect(isDmaXml(h7DmaXml)).toBe(true);
  });

  it('should parse H7 DMA XML without errors', () => {
    h7DmaData = parseDmaXml(h7DmaXml);
    expect(h7DmaData.version).toBe('STM32H753_dma2_v1_3');
  });

  it('should expand stream ranges to 16 streams (DMA1: 8, DMA2: 8)', () => {
    h7DmaData = parseDmaXml(h7DmaXml);
    expect(h7DmaData.streams.length).toBe(16);
    const dma1 = h7DmaData.streams.filter(s => s.controller === 'DMA1');
    const dma2 = h7DmaData.streams.filter(s => s.controller === 'DMA2');
    expect(dma1.length).toBe(8);
    expect(dma2.length).toBe(8);
  });

  it('should make every peripheral available on all 16 streams', () => {
    h7DmaData = parseDmaXml(h7DmaXml);
    const usart1tx = findDmaStreamsForSignal(h7DmaData, 'USART1_TX');
    expect(usart1tx.length).toBe(16);
    const spi1rx = findDmaStreamsForSignal(h7DmaData, 'SPI1_RX');
    expect(spi1rx.length).toBe(16);
  });

  it('should have signal lookup entries for H7 peripherals', () => {
    h7DmaData = parseDmaXml(h7DmaXml);
    expect(h7DmaData.signalToDmaStreams.has('USART1_TX')).toBe(true);
    expect(h7DmaData.signalToDmaStreams.has('SPI3_RX')).toBe(true);
    expect(h7DmaData.signalToDmaStreams.has('TIM1_CH1')).toBe(true);
    expect(h7DmaData.signalToDmaStreams.has('I2C1_RX')).toBe(true);
  });
});

describe('MCU-DMA version mapping', () => {
  it('should find DMA IP version in MCU XML', () => {
    const mcuXml = readFileSync(MCU_XML_PATH, 'utf-8');
    const mcu = parseMcuXml(mcuXml);
    const dmaPeripheral = mcu.peripherals.find(p => p.originalType === 'DMA');
    expect(dmaPeripheral).toBeDefined();
    expect(dmaPeripheral!.version).toBe('STM32F417_dma_v2_0');
  });
});

