import { describe, it, expect } from 'vitest';
import { parsePeripheralLibrary, DEFAULT_PERIPHERAL_LIBRARY, type Peripheral } from '../src/parser/peripheral-lib';
import { analyzeEditorContext, insertPeripheralLines } from '../src/ui/constraint-editor';

const USART: Peripheral = {
  name: 'USART',
  lines: ['TX = USART*_TX $u', 'RX = USART*_RX $u', 'require dma(TX, "USART_TX")', 'require dma(RX, "USART_RX")'],
};

describe('parsePeripheralLibrary', () => {
  it('splits #Name blocks into channels + require lines', () => {
    const peris = parsePeripheralLibrary(DEFAULT_PERIPHERAL_LIBRARY);
    const usart = peris.find(p => p.name === 'USART')!;
    expect(usart.lines).toEqual(USART.lines);
    const spi = peris.find(p => p.name === 'SPI')!;
    expect(spi.lines.filter(l => l.includes('=')).length).toBe(3); // SCK/MISO/MOSI
    expect(peris.some(p => p.name === 'SPI master + NSS')).toBe(true); // spaces in name
  });
});

describe('analyzeEditorContext', () => {
  const lines = ['port CMD:', '  channel X', '', '  config "c":', '    X = SPI*_MOSI'];
  it('detects a port with no enclosing config', () => {
    expect(analyzeEditorContext(lines, 1)).toMatchObject({ portIdx: 0, configIdx: -1, portHasConfig: true });
  });
  it('detects the enclosing config', () => {
    expect(analyzeEditorContext(lines, 4)).toMatchObject({ portIdx: 0, configIdx: 3, portHasConfig: true });
  });
  it('reports top level when not in a port', () => {
    expect(analyzeEditorContext(['mcu: STM32*', ''], 1).portIdx).toBe(-1);
  });
});

describe('insertPeripheralLines', () => {
  it('short form: inline channels + inline requires in a config-less port', () => {
    const lines = ['port CMD:', '  channel A'];
    const ctx = analyzeEditorContext(lines, 1);
    insertPeripheralLines(lines, ctx, USART);
    expect(lines).toEqual([
      'port CMD:',
      '  channel A',
      '  channel TX = USART*_TX $u',
      '  channel RX = USART*_RX $u',
      '  require dma(TX, "USART_TX")',
      '  require dma(RX, "USART_RX")',
    ]);
  });

  it('full form inside a config: adds channel decls to port, mappings/requires to config', () => {
    const lines = ['port CMD:', '  channel X', '', '  config "c":', '    X = SPI*_MOSI'];
    const ctx = analyzeEditorContext(lines, 4); // inside the config
    insertPeripheralLines(lines, ctx, USART);
    expect(lines).toEqual([
      'port CMD:',
      '  channel X',
      '  channel TX',
      '  channel RX',
      '',
      '  config "c":',
      '    X = SPI*_MOSI',
      '    TX = USART*_TX $u',
      '    RX = USART*_RX $u',
      '    require dma(TX, "USART_TX")',
      '    require dma(RX, "USART_RX")',
    ]);
  });

  it('new config: port has configs but cursor is outside one', () => {
    const lines = ['port CMD:', '  channel X', '', '  config "c":', '    X = SPI*_MOSI'];
    const ctx = analyzeEditorContext(lines, 1); // in port body, before the config
    insertPeripheralLines(lines, ctx, USART);
    expect(lines).toContain('  config "USART":');
    expect(lines).toContain('    TX = USART*_TX $u');
    expect(lines).toContain('  channel TX'); // decls added to port
  });

  it('uniquifies a $var that already exists so instances stay independent', () => {
    const lines = ['port CMD:', '  channel A = USART*_TX $u', '  channel B = USART*_RX $u'];
    const ctx = analyzeEditorContext(lines, 2);
    insertPeripheralLines(lines, ctx, USART);
    expect(lines.some(l => l === '  channel TX = USART*_TX $u2')).toBe(true);
    expect(lines.some(l => l === '  channel RX = USART*_RX $u2')).toBe(true);
  });
});
