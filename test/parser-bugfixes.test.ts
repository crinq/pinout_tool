// Regression tests for the parser-layer bugs found in the 2026-09 audit
// (ai_docs/report.md #13–#21). One describe block per bug.

import { describe, it, expect } from 'vitest';
import { parseConstraints, parseSearchPattern } from '../src/parser/constraint-parser';
import { expandPatternToCandidates } from '../src/solver/pattern-matcher';
import { globToRegex } from '../src/mcu-matcher';
import { parseMcuJsonDoc, type McuJsonDocument } from '../src/parser/mcu-json-parser';
import type { PortDeclNode } from '../src/parser/constraint-ast';

function portOf(source: string): PortDeclNode {
  const r = parseConstraints(source);
  expect(r.errors).toEqual([]);
  const port = r.ast!.statements.find(s => s.type === 'port_decl') as PortDeclNode;
  expect(port).toBeDefined();
  return port;
}

describe('#13 preprocessor must not eat parenthesized require lines', () => {
  it('accepts `require (A & B)` with a space', () => {
    const r = parseConstraints(
      'port A:\n' +
      '  channel TX = USART*_TX\n' +
      '  channel RX = USART*_RX\n' +
      '  require (TX & RX)\n'
    );
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r.ast)).toContain('"require"');
  });

  it('accepts `require(same_instance(TX, RX))` without a space', () => {
    const r = parseConstraints(
      'port A:\n' +
      '  channel TX = USART*_TX\n' +
      '  channel RX = USART*_RX\n' +
      '  require(same_instance(TX, RX))\n'
    );
    expect(r.errors).toEqual([]);
  });

  it('still reports genuinely unknown macros', () => {
    const r = parseConstraints('port A:\n  channel TX = USART*_TX\n  frobnicate(TX)\n');
    expect(r.errors.some(e => e.message.includes("Unknown macro 'frobnicate'"))).toBe(true);
  });
});

describe('#14 CRLF input', () => {
  it('parses Windows line endings without errors', () => {
    const r = parseConstraints('port A:\r\n  channel X = TIM*_CH1\r\n');
    expect(r.errors).toEqual([]);
    expect(r.ast!.statements.length).toBeGreaterThan(0);
  });
});

describe('#15 range expansion limits', () => {
  it('rejects an absurdly large range instead of materializing it', () => {
    const r = parseConstraints('port A:\n  channel X = TIM[1-999999999]_CH1\n');
    expect(r.errors.some(e => e.message.includes('too large'))).toBe(true);
  });

  it('rejects a reversed range instead of silently matching nothing', () => {
    const r = parseConstraints('port A:\n  channel X = TIM[3-1]_CH1\n');
    expect(r.errors.some(e => e.message.includes('end is less than start'))).toBe(true);
  });

  it('still expands a normal range', () => {
    const r = parseConstraints('port A:\n  channel X = TIM[1-4]_CH1\n');
    expect(r.errors).toEqual([]);
  });
});

describe('#16 glob bracket numeric ranges', () => {
  it('treats [4-7] as a numeric range like signal patterns do', () => {
    const re = globToRegex('STM32F[4-7]*');
    expect(re.test('STM32F405RG')).toBe(true);
    expect(re.test('STM32F746ZG')).toBe(true);
    expect(re.test('STM32F103VB')).toBe(false);
  });

  it('supports mixed ranges and alternatives [1-5,8,20]', () => {
    const re = globToRegex('TIM[1-5,8,20]');
    expect(re.test('TIM3')).toBe(true);
    expect(re.test('TIM8')).toBe(true);
    expect(re.test('TIM20')).toBe(true);
    expect(re.test('TIM6')).toBe(false);
  });

  it('keeps plain comma alternatives working', () => {
    const re = globToRegex('STM32F[405,407]*');
    expect(re.test('STM32F405RG')).toBe(true);
    expect(re.test('STM32F401RE')).toBe(false);
  });
});

describe('#17 JSON MCU without cores', () => {
  it('reports frequency 0 instead of -Infinity', () => {
    const doc: McuJsonDocument = {
      name: 'TEST1', family: 'TEST',
      packages: [{ name: 'LQFP48', variant: 'TEST1V', pins: [{ position: '1', names: ['PA0'], type: 'io' }] }],
    };
    const mcus = parseMcuJsonDoc(doc);
    expect(mcus).toHaveLength(1);
    expect(mcus[0].frequency).toBe(0);
  });
});

describe('#18 multi-token peripheral instances', () => {
  const doc: McuJsonDocument = {
    name: 'TEST2', family: 'TEST',
    peripherals: [
      { name: 'USB_OTG_HS', kind: 'usb' },
      { name: 'SPI1', kind: 'spi', dma_channels: [{ signal: 'I2S_CK', dma: ['DMA1_CH1'] }] },
      { name: 'USB_OTG_FS', kind: 'usb', dma_channels: [{ signal: 'USB_OTG_FS', dma: ['DMA1_CH2'] }] },
    ],
    gpios: [
      { name: 'PA3', alternate_functions: { '10': 'USB_OTG_HS_ULPI_STP' } },
      { name: 'PA5', alternate_functions: { '5': 'SPI1_I2S_CK' } },
      { name: 'PA11', alternate_functions: { '10': 'USB_OTG_FS_DP' } },
    ],
    dma_controllers: [{
      name: 'DMA1',
      channels: [{ name: 'DMA1_CH1', channel: 1 }, { name: 'DMA1_CH2', channel: 2 }],
    }],
    packages: [{
      name: 'LQFP48', variant: 'TEST2V',
      pins: [
        { position: '1', names: ['PA3'], type: 'io' },
        { position: '2', names: ['PA5'], type: 'io' },
        { position: '3', names: ['PA11'], type: 'io' },
      ],
    }],
  };
  const mcu = parseMcuJsonDoc(doc)[0];

  it('keeps the declared instance name on signals instead of truncating at the first underscore', () => {
    const pa3 = mcu.logicalPins.find(l => l.name === 'PA3')!;
    const sig = pa3.signals.find(s => s.name.startsWith('USB'))!;
    expect(sig.peripheralInstance).toBe('USB_OTG_HS');
    expect(sig.name).toBe('USB_OTGHSULPISTP');   // collapsed name unchanged
  });

  it('keeps signalFunction on the collapsed convention so patterns still match', () => {
    // Regression: `channel DP = USB*_OTGFSDP` (stdlib usb_port style) broke
    // when signalFunction was shortened to "DP" — patterns match
    // instancePart × signalFunction, both on the collapsed convention.
    const pa11 = mcu.logicalPins.find(l => l.name === 'PA11')!;
    const sig = pa11.signals.find(s => s.name === 'USB_OTGFSDP')!;
    expect(sig.signalFunction).toBe('OTGFSDP');
    expect(sig.peripheralInstance).toBe('USB_OTG_FS');
    const pattern = parseSearchPattern('USB*_OTGFSDP')!;
    const candidates = expandPatternToCandidates(pattern, mcu);
    expect(candidates.map(c => c.pin.name)).toEqual(['PA11']);
  });

  it('does not synthesize a duplicate truncated instance', () => {
    const usbInstances = mcu.peripherals.filter(p => p.instanceName.startsWith('USB'));
    expect(usbInstances.map(p => p.instanceName).sort()).toEqual(['USB_OTG_FS', 'USB_OTG_HS']);
  });

  it('collapses DMA signal keys so multi-token signal entries match pin signals', () => {
    expect(mcu.dma).toBeDefined();
    expect([...mcu.dma!.signalToDmaStreams.keys()]).toContain('SPI1_I2SCK');
  });

  it('indexes instance-level DMA for underscored instance names', () => {
    expect([...mcu.dma!.instanceToDmaStreams.keys()]).toContain('USB_OTG_FS');
  });
});

describe('#19 ioCount counts physical pads, not remap variants', () => {
  it('a pad with two bonded names counts once', () => {
    const doc: McuJsonDocument = {
      name: 'TEST3', family: 'TEST',
      packages: [{
        name: 'UFQFPN20', variant: 'TEST3V',
        pins: [
          { position: '1', names: ['PA0', 'PA2'], type: 'io' },   // shared bond pad
          { position: '2', names: ['PA1'], type: 'io' },
          { position: '3', names: ['VDD'], type: 'power' },
        ],
      }],
    };
    const mcu = parseMcuJsonDoc(doc)[0];
    expect(mcu.ioCount).toBe(2);
  });
});

describe('#20 glob ? accepted by the DSL', () => {
  it('parses mcu: filter containing ?', () => {
    const r = parseConstraints('mcu: STM32F4?5\n');
    expect(r.errors).toEqual([]);
  });

  it('matcher treats ? as a single character', () => {
    expect(globToRegex('STM32F4?5*').test('STM32F405RG')).toBe(true);
    expect(globToRegex('STM32F4?5*').test('STM32F445RE')).toBe(true);
    expect(globToRegex('STM32F4?5*').test('STM32F415')).toBe(true);
  });
});

describe('#21 pin anchors beyond port K', () => {
  it('classifies @ ~PZ0 as a near-pin anchor, not a package position', () => {
    const port = portOf('port A:\n  channel X @ ~PZ0 = TIM*_CH1\n');
    const anchor = port.channels[0].anchor!;
    expect(anchor.kind).toBe('near_pin');
    expect(anchor.target).toBe('PZ0');
  });

  it('still classifies BGA positions and regions correctly', () => {
    const posPort = portOf('port A:\n  channel X @ ~A7 = TIM*_CH1\n');
    expect(posPort.channels[0].anchor!.kind).toBe('near_pos');
    const regPort = portOf('port B:\n  channel X @ ~NW = TIM*_CH1\n');
    expect(regPort.channels[0].anchor!.kind).toBe('near_region');
  });
});
