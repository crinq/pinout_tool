import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isIocFile, parseIocFile } from '../src/parser/ioc-parser';

// Self-contained fixture mirroring the shapes we care about (from the
// stm32_pinout_tool_claude.ioc example): GPIO in/out + labels, S_ prefix,
// plain peripheral signals, and a label on a peripheral pin.
const SAMPLE_IOC = `#MicroXplorer Configuration settings - do not modify
Mcu.Name=STM32H755IIKx
Mcu.Package=UFBGA176
PA1_C.Signal=ADCx_INP1
PA9.GPIO_Label=test
PA9.Signal=GPIO_Output
PB6.Signal=UART5_TX
PB8.Signal=S_TIM4_CH3
PD1.Signal=UART4_TX
PD2.GPIO_Label=rx
PD2.Signal=UART5_RX
PG13.Signal=GPIO_Output
PG4.Signal=TIM1_BKIN2
PG9.Signal=GPIO_Input
SH.ADCx_INP1.0=ADC1_INP1,IN1-Single-Ended
SH.ADCx_INP1.ConfNb=1
`;

describe('ioc-parser', () => {
  const f4Text = readFileSync(join(__dirname, '../example/cube/f4.ioc'), 'utf-8');

  describe('isIocFile', () => {
    it('detects .ioc files', () => {
      expect(isIocFile(f4Text)).toBe(true);
      expect(isIocFile(SAMPLE_IOC)).toBe(true);
    });
    it('rejects non-.ioc content', () => {
      expect(isIocFile('<Mcu RefName="STM32F405">')).toBe(false);
      expect(isIocFile('')).toBe(false);
    });
  });

  describe('parseIocFile - F4 (real file)', () => {
    const result = parseIocFile(f4Text);
    it('extracts MCU name + package', () => {
      expect(result.mcuName).toBe('STM32F405VGTx');
      expect(result.mcuPackage).toBe('LQFP100');
    });
    it('extracts SPI pin assignments', () => {
      const spi = result.assignments.filter(a => a.signalName.startsWith('SPI'));
      expect(spi).toEqual([
        { pinName: 'PB3', signalName: 'SPI1_SCK', label: undefined },
        { pinName: 'PB4', signalName: 'SPI1_MISO', label: undefined },
        { pinName: 'PB5', signalName: 'SPI1_MOSI', label: undefined },
      ]);
    });
    it('resolves shared ADC signals via SH map', () => {
      const adc = result.assignments.filter(a => a.signalName.startsWith('ADC'));
      expect(adc).toEqual([
        { pinName: 'PA4', signalName: 'ADC1_IN4', label: undefined },
        { pinName: 'PA5', signalName: 'ADC2_IN5', label: undefined },
      ]);
    });
    it('splits hyphenated SYS/debug signals and uses first part', () => {
      const sys = result.assignments.filter(a => a.signalName.startsWith('SYS'));
      expect(sys).toEqual([
        { pinName: 'PA13', signalName: 'SYS_JTMS', label: undefined },
        { pinName: 'PA14', signalName: 'SYS_JTCK', label: undefined },
      ]);
    });
  });

  describe('parseIocFile - GPIO, labels, S_ prefix', () => {
    const result = parseIocFile(SAMPLE_IOC);
    const byPin = (p: string) => result.assignments.find(a => a.pinName === p);

    it('extracts MCU name + package', () => {
      expect(result.mcuName).toBe('STM32H755IIKx');
      expect(result.mcuPackage).toBe('UFBGA176');
    });

    it('maps GPIO_Output → OUT and carries the label', () => {
      expect(byPin('PA9')).toEqual({ pinName: 'PA9', signalName: 'OUT', label: 'test' });
      expect(byPin('PG13')).toEqual({ pinName: 'PG13', signalName: 'OUT', label: undefined });
    });

    it('maps GPIO_Input → IN', () => {
      expect(byPin('PG9')).toEqual({ pinName: 'PG9', signalName: 'IN', label: undefined });
    });

    it('strips the S_ shared marker from peripheral signals', () => {
      expect(byPin('PB8')).toEqual({ pinName: 'PB8', signalName: 'TIM4_CH3', label: undefined });
    });

    it('maps _C dual-pad analog pins to the plain name and resolves ADCx_* shared signals', () => {
      expect(byPin('PA1_C')).toBeUndefined(); // stored as PA1, not PA1_C
      expect(byPin('PA1')).toEqual({ pinName: 'PA1', signalName: 'ADC1_INP1', label: undefined });
    });

    it('keeps plain peripheral signals and labels on peripheral pins', () => {
      expect(byPin('PD1')).toEqual({ pinName: 'PD1', signalName: 'UART4_TX', label: undefined });
      expect(byPin('PG4')).toEqual({ pinName: 'PG4', signalName: 'TIM1_BKIN2', label: undefined });
      expect(byPin('PD2')).toEqual({ pinName: 'PD2', signalName: 'UART5_RX', label: 'rx' });
    });

    it('includes GPIO pins (no longer skipped) and the _C pin — 9 total', () => {
      expect(result.assignments.length).toBe(9);
    });
  });
});
