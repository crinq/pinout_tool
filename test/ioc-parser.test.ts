import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isIocFile, parseIocFile } from '../src/parser/ioc-parser';

describe('ioc-parser', () => {
  const f4Text = readFileSync(join(__dirname, '../example/cube/f4.ioc'), 'utf-8');
  const h7Text = readFileSync(join(__dirname, '../example/cube/h7.ioc'), 'utf-8');

  describe('isIocFile', () => {
    it('detects .ioc files', () => {
      expect(isIocFile(f4Text)).toBe(true);
      expect(isIocFile(h7Text)).toBe(true);
    });

    it('rejects non-.ioc content', () => {
      expect(isIocFile('<Mcu RefName="STM32F405">')).toBe(false);
      expect(isIocFile('')).toBe(false);
    });
  });

  describe('parseIocFile - F4', () => {
    const result = parseIocFile(f4Text);

    it('extracts MCU name', () => {
      expect(result.mcuName).toBe('STM32F405VGTx');
    });

    it('extracts MCU package', () => {
      expect(result.mcuPackage).toBe('LQFP100');
    });

    it('extracts SPI pin assignments', () => {
      const spi = result.assignments.filter(a => a.signalName.startsWith('SPI'));
      expect(spi).toEqual([
        { pinName: 'PB3', signalName: 'SPI1_SCK' },
        { pinName: 'PB4', signalName: 'SPI1_MISO' },
        { pinName: 'PB5', signalName: 'SPI1_MOSI' },
      ]);
    });

    it('resolves shared ADC signals via SH map', () => {
      const adc = result.assignments.filter(a => a.signalName.startsWith('ADC'));
      expect(adc).toEqual([
        { pinName: 'PA4', signalName: 'ADC1_IN4' },
        { pinName: 'PA5', signalName: 'ADC2_IN5' },
      ]);
    });

    it('extracts USB assignments', () => {
      const usb = result.assignments.filter(a => a.signalName.includes('USB'));
      expect(usb).toEqual([
        { pinName: 'PA11', signalName: 'USB_OTG_FS_DM' },
        { pinName: 'PA12', signalName: 'USB_OTG_FS_DP' },
      ]);
    });

    it('splits hyphenated SYS/debug signals and uses first part', () => {
      const sys = result.assignments.filter(a => a.signalName.startsWith('SYS'));
      expect(sys).toEqual([
        { pinName: 'PA13', signalName: 'SYS_JTMS' },
        { pinName: 'PA14', signalName: 'SYS_JTCK' },
      ]);
    });
  });

  describe('parseIocFile - H7 dual-core', () => {
    const result = parseIocFile(h7Text);

    it('extracts MCU name', () => {
      expect(result.mcuName).toBe('STM32H755IITx');
    });

    it('extracts MCU package', () => {
      expect(result.mcuPackage).toBe('LQFP176');
    });

    it('extracts SPI assignments', () => {
      const spi = result.assignments.filter(a => a.signalName.startsWith('SPI'));
      expect(spi).toEqual([
        { pinName: 'PA5', signalName: 'SPI1_SCK' },
        { pinName: 'PA6', signalName: 'SPI1_MISO' },
        { pinName: 'PA7', signalName: 'SPI1_MOSI' },
      ]);
    });

    it('extracts UART assignments', () => {
      const uart = result.assignments.filter(a => a.signalName.startsWith('UART'));
      expect(uart).toEqual([
        { pinName: 'PA0', signalName: 'UART4_TX' },
        { pinName: 'PA1', signalName: 'UART4_RX' },
      ]);
    });

    it('strips S_ prefix from timer signals', () => {
      const tim = result.assignments.filter(a => a.signalName.startsWith('TIM'));
      expect(tim).toContainEqual({ pinName: 'PE9', signalName: 'TIM1_CH1' });
      expect(tim).toContainEqual({ pinName: 'PE11', signalName: 'TIM1_CH2' });
      expect(tim).toContainEqual({ pinName: 'PE13', signalName: 'TIM1_CH3' });
      expect(tim).toContainEqual({ pinName: 'PC6', signalName: 'TIM3_CH1' });
      expect(tim).toContainEqual({ pinName: 'PC7', signalName: 'TIM3_CH2' });
    });

    it('has correct total assignment count', () => {
      // SPI(3) + UART(2) + TIM(5) = 10
      expect(result.assignments.length).toBe(10);
    });
  });
});
