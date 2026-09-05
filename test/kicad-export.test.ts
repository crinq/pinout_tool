// Structural validation of the KiCad schematic export function.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { declaredPortChannels } from '../src/ui/package-viewer';
import { parseExportParams, defaultParamValues } from '../src/export-params';
import type { Mcu } from '../src/types';

function loadMcu(folder: string): Mcu {
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const fnSource = readFileSync(join(__dirname, '../src/defaults/exports/kicad-schematic.js'), 'utf-8');
const params = parseExportParams(fnSource);

function run(mcu: Mcu, assignments: object[], overrides: Record<string, unknown> = {}, ports: object[] = []) {
  const exec = new Function(
    'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
    'docs', 'constraintsHeader', 'mcuInfo',
    fnSource,
  );
  const pins = mcu.logicalPins.map(p => ({
    name: p.name, position: p.physical.position, type: p.type,
    gpioPort: p.gpioPort, gpioNumber: p.gpioNumber, isAssignable: p.isAssignable,
    signals: p.signals.map(s => ({
      name: s.name, peripheralInstance: s.peripheralInstance,
      peripheralType: s.peripheralType, signalFunction: s.signalFunction,
    })),
  }));
  return exec(
    mcu.refName, mcu.package, assignments, mcu.peripherals, pins, ports, {},
    { ...defaultParamValues(params), ...overrides },
    { datasheet: 'https://example.com/ds.pdf' }, 'servo drive controller\nsecond line',
    `${mcu.refName} | ${mcu.package} | 168MHz`,
  ) as { filename: string; content: string; mimeType: string };
}

const ASSIGN = [
  { pinName: 'PA9', signalName: 'USART1_TX', portName: 'CMD', channelName: 'TX', configurationName: 'c', channelComment: 'to host' },
  { pinName: 'PA10', signalName: 'USART1_RX', portName: 'CMD', channelName: 'RX', configurationName: 'c', channelComment: null },
  { pinName: 'PH0', signalName: 'RCC_OSCIN', portName: 'CLOCK', channelName: 'IN', configurationName: 'c', channelComment: null },
  { pinName: 'PH1', signalName: 'RCC_OSCOUT', portName: 'CLOCK', channelName: 'OUT', configurationName: 'c', channelComment: null },
];

const balanced = (s: string): boolean => {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') d++;
    else if (c === ')') { d--; if (d < 0) return false; }
  }
  return d === 0;
};

describe('KiCad schematic export', () => {
  const mcu = loadMcu('f405v');
  const out = run(mcu, ASSIGN);

  it('produces a balanced, well-formed document', () => {
    expect(out.filename).toBe(`${mcu.refName}.kicad_sch`);
    expect(out.content.startsWith('(kicad_sch')).toBe(true);
    expect(balanced(out.content)).toBe(true);
    expect(out.content).toContain('(sheet_instances');
    writeFileSync(join(__dirname, '../node_modules/.cache/kicad-export-sample.kicad_sch'), out.content);
  });

  it('embeds all library symbols and the generated MCU symbol', () => {
    for (const id of ['"Device:C"', '"Device:R"', '"Device:Crystal_GND24_Small"', '"power:GND"', '"power:+3.3V"', '"power:+3.3VA"']) {
      expect(out.content).toContain(`(symbol ${id}`);
    }
    expect(out.content).toContain(`(symbol "pinout_tool:${mcu.refName}"`);
    expect(out.content).toContain(`(property "Value" "${mcu.refName}"`);
    expect(out.content).toContain('(property "Datasheet" "https://example.com/ds.pdf"');
    // Description carries the MCU summary line; constraints header is the fallback.
    expect(out.content).toContain(`(property "Description" "${mcu.refName} | ${mcu.package} | 168MHz"`);
    expect(out.content).toContain('(property "Footprint" "Package_QFP:LQFP-100_14x14mm_P0.5mm"');
  });

  it('has one MCU pin per physical pad with alternates and selected functions', () => {
    const pads = new Set(mcu.logicalPins.map(p => p.physical.position));
    for (const pad of pads) {
      expect(out.content).toContain(`(number "${pad}"`);
    }
    // alternate list on PA9 includes its other functions
    expect(out.content).toMatch(/\(alternate "USART1_CK" bidirectional line\)/);
    // selected alternate on the placed instance
    expect(out.content).toMatch(/\(alternate "USART1_TX"\)/);
  });

  it('labels mapped pins PORT.CHANNEL and notes channel comments', () => {
    expect(out.content).toContain('(label "CMD.TX"');
    expect(out.content).toContain('(label "CMD.RX"');
    expect(out.content).toContain('(text "to host"');
  });

  it('adds dangling labels + comments for unmapped channels', () => {
    const o = run(mcu, ASSIGN, {}, [
      { name: 'GPIO', channels: [{ name: 'IN', comment: 'spare input' }, { name: 'OUT', comment: null }] },
      { name: 'CMD', channels: [{ name: 'TX', comment: null }, { name: 'RX', comment: null }] },
    ]);
    expect(o.content).toContain('(label "GPIO.IN"');
    expect(o.content).toContain('(label "GPIO.OUT"');
    expect(o.content).toContain('(text "spare input"');
    // mapped channels keep exactly their pin label, no extra dangling one
    expect((o.content.match(/\(label "CMD\.TX"/g) ?? []).length).toBe(1);
  });

  it('hierarchical-label column and no-connect crosses', () => {
    const ports = [
      { name: 'CMD', channels: [{ name: 'TX', comment: null }, { name: 'RX', comment: null }] },
      { name: 'GPIO', channels: [{ name: 'IN', comment: 'spare' }] },
    ];
    const o = run(mcu, ASSIGN, { hier: true }, ports);
    expect(o.content).toContain('(hierarchical_label "CMD.TX"');
    expect(o.content).toContain('(hierarchical_label "GPIO.IN"');
    // mapped channel: label at the pin AND in the interface column
    expect((o.content.match(/\(label "CMD\.TX"/g) ?? []).length).toBe(2);
    // unmapped channel: interface column AND a free drag-target label below it
    expect((o.content.match(/\(label "GPIO\.IN"/g) ?? []).length).toBe(2);
    expect((o.content.match(/\(hierarchical_label "GPIO\.IN"/g) ?? []).length).toBe(1);
    // nc defaults on: all unused GPIO/misc pins get a cross, mapped pins none
    expect((o.content.match(/\(no_connect/g) ?? []).length).toBeGreaterThan(50);
    const off = run(mcu, ASSIGN, { hier: false, nc: false });
    expect(off.content).not.toContain('(hierarchical_label');
    expect(off.content).not.toContain('(no_connect');
  });

  it('places power symbols, decoupling bank, VCAP caps and crystal', () => {
    const gndCount = (out.content.match(/\(lib_id "power:GND"\)/g) ?? []).length;
    expect(gndCount).toBeGreaterThan(mcu.logicalPins.filter(p => p.name.startsWith('VSS')).length);
    expect(out.content).toContain('"2.2uF"');
    expect(out.content).toContain('"100nF"');
    expect(out.content).toContain('"1uF"');
    expect(out.content).toContain('(label "VCAP_1"');
    expect(out.content).toContain('(lib_id "Device:Crystal_GND24_Small")');
    expect(out.content).toContain('"12pF"');
    expect(out.content).toContain('"1k"');
    expect(out.content).toContain('(label "CLOCK.IN"');
    expect(out.content).toContain('(label "CLOCK.OUT"');
    expect(out.content).toContain('(label "NRST"');
    expect(out.content).toContain('(label "BOOT0"');
    expect(out.content).toContain('"10k"');
  });

  it('honors the placement parameters', () => {
    const bare = run(mcu, ASSIGN, { power: false, caps: false, crystal: false });
    expect(balanced(bare.content)).toBe(true);
    expect(bare.content).not.toContain('(lib_id "Device:Crystal_GND24_Small")');
    expect(bare.content).not.toContain('"100nF"');
    expect(bare.content).not.toContain('(lib_id "power:GND")');
    // labels on mapped pins stay
    expect(bare.content).toContain('(label "CMD.TX"');
  });

  it('renames overridden power symbols', () => {
    const o = run(mcu, ASSIGN, { gnd: 'GNDD', v33: '+3V3' });
    expect(balanced(o.content)).toBe(true);
    expect(o.content).toContain('(symbol "power:GNDD"');
    expect(o.content).toContain('(lib_id "power:GNDD")');
    expect(o.content).toContain('(symbol "power:+3V3"');
    expect(o.content).not.toContain('(lib_id "power:GND")');
  });
});

describe('declaredPortChannels', () => {
  it('resolves `port X from Y` inheritance, child channels first', () => {
    const src = [
      'port ENC0:',
      '  channel MA = SPI*_SCK',
      '  channel SL = SPI*_MISO',
      'port ENC1 from ENC0:',
      'port ENC2 from ENC0:',
      '  channel MO_txen = OUT',
      '',
    ].join('\n');
    const m = declaredPortChannels(src);
    expect(m.get('ENC1')).toEqual(['MA', 'SL']);
    expect(m.get('ENC2')).toEqual(['MO_txen', 'MA', 'SL']);
  });
});
