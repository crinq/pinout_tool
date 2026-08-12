import { describe, it, expect } from 'vitest';
import { parsePeripheralLibrary, DEFAULT_PERIPHERAL_LIBRARY, type Peripheral } from '../src/parser/peripheral-lib';
import { analyzeEditorContext, insertPeripheralLines, opensHelperMenu } from '../src/ui/constraint-editor';

const USART: Peripheral = {
  name: 'USART',
  lines: ['TX = USART*_TX $u', 'RX = USART*_RX $u', 'require dma(TX, "USART_TX")', 'require dma(RX, "USART_RX")'],
};

describe('parsePeripheralLibrary', () => {
  it('splits #Name blocks into channels + require lines', () => {
    const peris = parsePeripheralLibrary(DEFAULT_PERIPHERAL_LIBRARY);
    // USART is the documented reference block; assert it exactly.
    expect(peris.find(p => p.name === 'USART')!.lines).toEqual(USART.lines);
    // Every block must be non-empty and carry at least one mapping line.
    expect(peris.length).toBeGreaterThan(1);
    for (const p of peris) {
      expect(p.name, 'block name must be non-empty').not.toBe('');
      expect(p.lines.some(l => /^[A-Za-z0-9_]+\s*=/.test(l)), `${p.name} has a mapping`).toBe(true);
    }
  });

  it('parses names with spaces and separates mappings from requires', () => {
    const peris = parsePeripheralLibrary(`#SPI master + NSS
SCK = SPI*_SCK $s
MOSI = SPI*_MOSI $s
require dma(MOSI, "SPI_TX")

#I2C
SCL = I2C*_SCL $i`);
    expect(peris.map(p => p.name)).toEqual(['SPI master + NSS', 'I2C']);
    expect(peris[0].lines.filter(l => l.startsWith('require')).length).toBe(1);
    expect(peris[0].lines.filter(l => l.includes('=') && !l.startsWith('require')).length).toBe(2);
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

describe('opensHelperMenu (double-click gating)', () => {
  it('opens on whitespace / empty selections', () => {
    expect(opensHelperMenu('')).toBe(true);        // clicked past end of line
    expect(opensHelperMenu('  ')).toBe(true);      // clicked indentation
    expect(opensHelperMenu('\n')).toBe(true);      // blank line
    expect(opensHelperMenu('\t')).toBe(true);
  });

  it('stays out of the way when text was selected', () => {
    expect(opensHelperMenu('channel')).toBe(false);        // double-click a word
    expect(opensHelperMenu('  channel TX = OUT')).toBe(false); // triple-click a line
    expect(opensHelperMenu('USART*_TX')).toBe(false);
  });
});
