import { describe, it, expect } from 'vitest';
import { matchSignalPattern, expandPatternToCandidates } from '../src/solver/pattern-matcher';
import type { SignalPatternNode, PatternPart } from '../src/parser/constraint-ast';
import type { Signal, Pin, Mcu } from '../src/types';

// Helper to build a SignalPatternNode
function pat(instancePart: PatternPart, functionPart: PatternPart): SignalPatternNode {
  return {
    type: 'signal_pattern',
    instancePart,
    functionPart,
    raw: '',
    loc: { line: 1, column: 1 },
  };
}

// Helper to build a Signal
function sig(name: string, opts: Partial<Signal> = {}): Signal {
  return {
    name,
    peripheralInstance: opts.peripheralInstance,
    peripheralType: opts.peripheralType,
    instanceNumber: opts.instanceNumber,
    signalFunction: opts.signalFunction,
  };
}

describe('Pattern matcher', () => {
  // ========== Literal patterns ==========

  describe('literal patterns', () => {
    it('should match exact instance and function', () => {
      const pattern = pat(
        { type: 'literal', value: 'USART1' },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART1_TX', {
        peripheralInstance: 'USART1', peripheralType: 'USART',
        instanceNumber: 1, signalFunction: 'TX',
      }))).toBe(true);
    });

    it('should not match different instance', () => {
      const pattern = pat(
        { type: 'literal', value: 'USART1' },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART2_TX', {
        peripheralInstance: 'USART2', peripheralType: 'USART',
        instanceNumber: 2, signalFunction: 'TX',
      }))).toBe(false);
    });

    it('should not match different function', () => {
      const pattern = pat(
        { type: 'literal', value: 'USART1' },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART1_RX', {
        peripheralInstance: 'USART1', peripheralType: 'USART',
        instanceNumber: 1, signalFunction: 'RX',
      }))).toBe(false);
    });
  });

  // ========== Wildcard patterns ==========

  describe('wildcard patterns', () => {
    it('should match any instance with prefix', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'USART' },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART1_TX', {
        peripheralInstance: 'USART1', peripheralType: 'USART',
        instanceNumber: 1, signalFunction: 'TX',
      }))).toBe(true);
      expect(matchSignalPattern(pattern, sig('USART3_TX', {
        peripheralInstance: 'USART3', peripheralType: 'USART',
        instanceNumber: 3, signalFunction: 'TX',
      }))).toBe(true);
    });

    it('should match wildcard function part', () => {
      const pattern = pat(
        { type: 'literal', value: 'TIM1' },
        { type: 'wildcard', prefix: 'CH' },
      );
      expect(matchSignalPattern(pattern, sig('TIM1_CH1', {
        peripheralInstance: 'TIM1', peripheralType: 'TIM',
        instanceNumber: 1, signalFunction: 'CH1',
      }))).toBe(true);
      expect(matchSignalPattern(pattern, sig('TIM1_CH4', {
        peripheralInstance: 'TIM1', peripheralType: 'TIM',
        instanceNumber: 1, signalFunction: 'CH4',
      }))).toBe(true);
    });

    it('should not match wrong prefix', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'SPI' },
        { type: 'literal', value: 'MOSI' },
      );
      expect(matchSignalPattern(pattern, sig('USART1_MOSI', {
        peripheralInstance: 'USART1', peripheralType: 'USART',
        instanceNumber: 1, signalFunction: 'MOSI',
      }))).toBe(false);
    });
  });

  // ========== Any patterns ==========

  describe('any patterns', () => {
    it('should match any instance', () => {
      const pattern = pat(
        { type: 'any' },
        { type: 'literal', value: 'SWDIO' },
      );
      expect(matchSignalPattern(pattern, sig('SYS_SWDIO', {
        peripheralInstance: 'SYS', peripheralType: 'SYS',
        instanceNumber: undefined, signalFunction: 'SWDIO',
      }))).toBe(true);
    });

    it('should match any function', () => {
      const pattern = pat(
        { type: 'literal', value: 'ADC1' },
        { type: 'any' },
      );
      expect(matchSignalPattern(pattern, sig('ADC1_IN0', {
        peripheralInstance: 'ADC1', peripheralType: 'ADC',
        instanceNumber: 1, signalFunction: 'IN0',
      }))).toBe(true);
      expect(matchSignalPattern(pattern, sig('ADC1_IN15', {
        peripheralInstance: 'ADC1', peripheralType: 'ADC',
        instanceNumber: 1, signalFunction: 'IN15',
      }))).toBe(true);
    });
  });

  // ========== Range patterns ==========

  describe('range patterns', () => {
    it('should match instance in range', () => {
      const pattern = pat(
        { type: 'range', prefix: 'USART', values: [1, 2, 3] },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART1_TX', {
        peripheralInstance: 'USART1', peripheralType: 'USART',
        instanceNumber: 1, signalFunction: 'TX',
      }))).toBe(true);
      expect(matchSignalPattern(pattern, sig('USART3_TX', {
        peripheralInstance: 'USART3', peripheralType: 'USART',
        instanceNumber: 3, signalFunction: 'TX',
      }))).toBe(true);
    });

    it('should not match instance outside range', () => {
      const pattern = pat(
        { type: 'range', prefix: 'USART', values: [1, 2, 3] },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART6_TX', {
        peripheralInstance: 'USART6', peripheralType: 'USART',
        instanceNumber: 6, signalFunction: 'TX',
      }))).toBe(false);
    });

    it('should match function in range', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'TIM' },
        { type: 'range', prefix: 'CH', values: [1, 2] },
      );
      expect(matchSignalPattern(pattern, sig('TIM1_CH1', {
        peripheralInstance: 'TIM1', peripheralType: 'TIM',
        instanceNumber: 1, signalFunction: 'CH1',
      }))).toBe(true);
      expect(matchSignalPattern(pattern, sig('TIM1_CH3', {
        peripheralInstance: 'TIM1', peripheralType: 'TIM',
        instanceNumber: 1, signalFunction: 'CH3',
      }))).toBe(false);
    });

    it('should not match range with trailing characters', () => {
      // CH[1,2] should NOT match CH1N
      const pattern = pat(
        { type: 'wildcard', prefix: 'TIM' },
        { type: 'range', prefix: 'CH', values: [1, 2] },
      );
      expect(matchSignalPattern(pattern, sig('TIM1_CH1N', {
        peripheralInstance: 'TIM1', peripheralType: 'TIM',
        instanceNumber: 1, signalFunction: 'CH1N',
      }))).toBe(false);
    });
  });

  // ========== Type normalization ==========

  describe('type normalization', () => {
    it('should match UART via USART normalization (wildcard)', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'USART' },
        { type: 'literal', value: 'TX' },
      );
      // UART4 has type UART which normalizes to USART
      expect(matchSignalPattern(pattern, sig('UART4_TX', {
        peripheralInstance: 'UART4', peripheralType: 'USART', // normalized
        instanceNumber: 4, signalFunction: 'TX',
      }))).toBe(true);
    });

    it('should match TIM via TIM1_8 normalization', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'TIM' },
        { type: 'literal', value: 'CH1' },
      );
      expect(matchSignalPattern(pattern, sig('TIM1_CH1', {
        peripheralInstance: 'TIM1', peripheralType: 'TIM', // normalized from TIM1_8
        instanceNumber: 1, signalFunction: 'CH1',
      }))).toBe(true);
    });
  });

  // ========== Signals without instance/function ==========

  describe('edge cases', () => {
    it('should not match signal without peripheralInstance', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'USART' },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('GPIO', {}))).toBe(false);
    });

    it('should not match signal without signalFunction', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'USART' },
        { type: 'literal', value: 'TX' },
      );
      expect(matchSignalPattern(pattern, sig('USART1', {
        peripheralInstance: 'USART1', peripheralType: 'USART',
        instanceNumber: 1,
      }))).toBe(false);
    });
  });

  // ========== expandPatternToCandidates ==========

  describe('expandPatternToCandidates', () => {
    // Build a minimal MCU with a few pins
    const mockMcu: Mcu = {
      refName: 'TEST_MCU',
      family: 'TEST',
      line: 'TEST',
      package: 'LQFP64',
      core: 'ARM Cortex-M4',
      frequency: 170,
      flash: 512,
      ram: 128,
      ioCount: 4,
      voltage: { min: 1.7, max: 3.6 },
      temperature: { min: -40, max: 85 },
      hasPowerPad: false,
      peripherals: [],
      pins: [
        {
          name: 'PA0', position: '1', type: 'I/O', isAssignable: true,
          gpioPort: 'A', gpioNumber: 0,
          signals: [
            sig('USART1_TX', {
              peripheralInstance: 'USART1', peripheralType: 'USART',
              instanceNumber: 1, signalFunction: 'TX',
            }),
            sig('TIM2_CH1', {
              peripheralInstance: 'TIM2', peripheralType: 'TIM',
              instanceNumber: 2, signalFunction: 'CH1',
            }),
          ],
        },
        {
          name: 'PA1', position: '2', type: 'I/O', isAssignable: true,
          gpioPort: 'A', gpioNumber: 1,
          signals: [
            sig('USART1_RX', {
              peripheralInstance: 'USART1', peripheralType: 'USART',
              instanceNumber: 1, signalFunction: 'RX',
            }),
          ],
        },
        {
          name: 'VDD', position: '3', type: 'Power', isAssignable: false,
          signals: [],
        },
      ] as any,
      pinByName: new Map(),
      pinByPosition: new Map(),
      pinByGpioName: new Map(),
      peripheralByInstance: new Map(),
      signalToPins: new Map(),
      typeToInstances: new Map(),
      peripheralSignals: new Map(),
      pinSignalSet: new Map(),
    };

    it('should find candidates matching a pattern', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'USART' },
        { type: 'literal', value: 'TX' },
      );
      const candidates = expandPatternToCandidates(pattern, mockMcu);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].signalName).toBe('USART1_TX');
      expect(candidates[0].pin.name).toBe('PA0');
    });

    it('should skip non-assignable pins', () => {
      const pattern = pat({ type: 'any' }, { type: 'any' });
      const candidates = expandPatternToCandidates(pattern, mockMcu);
      // VDD is not assignable, so only PA0 and PA1 signals
      expect(candidates.every(c => c.pin.isAssignable)).toBe(true);
    });

    it('should filter by allowed pins', () => {
      const pattern = pat(
        { type: 'wildcard', prefix: 'USART' },
        { type: 'any' },
      );
      const allowed = new Set(['PA0']);
      const candidates = expandPatternToCandidates(pattern, mockMcu, allowed);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].pin.name).toBe('PA0');
    });
  });
});
