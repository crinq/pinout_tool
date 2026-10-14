// KiCad label-strip export: pasteable wire/label/text fragments.
import { describe, it, expect } from 'vitest';
import { DEFAULT_EXPORTS } from '../src/defaults';
import { parseExportParams, defaultParamValues } from '../src/export-params';

const fn = DEFAULT_EXPORTS.find(f => f.id === 'kicad-labels')!;
const params = parseExportParams(fn.code);

const ASSIGN = [
  // COM.TX on two pins (two configs), one of them carrying two signals
  { pinName: 'PA1', signalName: 'USART1_TX', portName: 'COM', channelName: 'TX', configurationName: 'a' },
  { pinName: 'PA1', signalName: 'TIM1_CH2', portName: 'COM', channelName: 'TX', configurationName: 'b' },
  { pinName: 'PA2', signalName: 'USART2_TX', portName: 'COM', channelName: 'TX', configurationName: 'c' },
  { pinName: 'PB2', signalName: 'USART1_RX', portName: 'COM', channelName: 'RX', configurationName: 'a' },
];
const PORTS = [
  { name: 'COM', channels: [{ name: 'TX' }, { name: 'RX' }, { name: 'TX_EN' }] },
];

function run(overrides: Record<string, unknown> = {}, ports: object[] = PORTS): string {
  const exec = new Function(
    'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
    'docs', 'constraintsHeader', 'mcuInfo',
    fn.code,
  );
  return exec('STM32TEST', 'LQFP48', ASSIGN, [], [], ports, {},
    { ...defaultParamValues(params), ...overrides }, null, null, null) as string;
}

const balanced = (s: string): boolean => {
  let d = 0, str = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '(') d++;
    else if (c === ')') { d--; if (d < 0) return false; }
  }
  return d === 0;
};

describe('kicad-labels export', () => {
  it('declares the four options', () => {
    expect(params.map(p => p.key)).toEqual(['bus', 'shortbus', 'gpiolist', 'freelist']);
  });

  it('freelist option appends labels for unmapped GPIO pins only', () => {
    const exec = new Function(
      'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
      'docs', 'constraintsHeader', 'mcuInfo',
      fn.code,
    );
    const pins = [{ name: 'PA1' }, { name: 'PA2' }, { name: 'PA3' }, { name: 'PB2' }, { name: 'VSS' }];
    const out = exec('T', 'LQFP48', ASSIGN, [], pins, PORTS, {},
      { ...defaultParamValues(params), freelist: true }, null, null, null) as string;
    expect(out).toContain('(label "PA3"');       // unused gpio
    expect(out).not.toContain('(label "VSS"');   // not a gpio
    // mapped pins appear only on their channel rows, not in the free stack
    expect((out.match(/\(label "PA1"/g) ?? []).length).toBe(1);
  });

  it('gpiolist option stacks every GPIO pin, mapped and unused', () => {
    const exec = new Function(
      'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
      'docs', 'constraintsHeader', 'mcuInfo',
      fn.code,
    );
    const pins = [{ name: 'PA1' }, { name: 'PA2' }, { name: 'PA3' }, { name: 'PB2' }, { name: 'VSS' }];
    const out = exec('T', 'LQFP48', ASSIGN, [], pins, PORTS, {},
      { ...defaultParamValues(params), gpiolist: true }, null, null, null) as string;
    const stackX = (pin: string) => [...out.matchAll(new RegExp(`\\(label "${pin}"\\s*\\(at ([\\d.]+) `, 'g'))].map(m => m[1]);
    expect(stackX('PA3')).toEqual(['25.4']);          // unused gpio, in the gpio stack
    expect(stackX('PA1')).toContain('25.4');          // mapped gpio, in the gpio stack too
    expect(out).not.toContain('(label "VSS"');        // not a gpio
  });

  it('emits one row per mapped pin, repeats multi-pin channels, leaves unmapped open', () => {
    const out = run();
    expect(balanced(out)).toBe(true);
    expect((out.match(/\(label "COM\.TX"/g) ?? []).length).toBe(2);   // PA1 + PA2
    expect((out.match(/\(label "COM\.RX"/g) ?? []).length).toBe(1);
    expect((out.match(/\(label "COM\.TX_EN"/g) ?? []).length).toBe(1); // unmapped, left label only
    expect(out).toContain('(label "PA1"');
    expect(out).toContain('(label "PA2"');
    expect(out).toContain('(label "PB2"');
    expect((out.match(/\(wire/g) ?? []).length).toBe(4);               // 4 rows
    // multi-config pin lists both signals in one comment
    expect(out).toContain('(text "USART1_TX, TIM1_CH2"');
    expect(out).toContain('(text "USART2_TX"');
    // 5.08 trace on the first row
    const w0 = /\(wire\s*\(pts\s*\(xy ([\d.]+) 25\.4\) \(xy ([\d.]+) 25\.4\)/.exec(out)!;
    expect(Number(w0[2]) - Number(w0[1])).toBeCloseTo(5.08, 5);
    expect(out).not.toContain('(bus');
  });

  it('bus option groups channels per port on a labeled bus', () => {
    const out = run({ bus: true });
    expect(balanced(out)).toBe(true);
    expect(out).toContain('(label "COM(TX, RX, TX_EN)"');
    expect((out.match(/\(bus_entry/g) ?? []).length).toBe(4);          // one per row
    expect((out.match(/\(bus\n/g) ?? []).length).toBe(2);              // horizontal + vertical
    expect((out.match(/\(label "COM\.TX"/g) ?? []).length).toBe(2);
    expect(out).toContain('(label "PA1"');
  });

  it('shortbus collapses numbered channels into ranges in the bus label', () => {
    const mem = [{
      name: 'MEM',
      channels: ['RAM_D0', 'RAM_D1', 'RAM_D2', 'RAM_D5', 'RAM_CLK'].map(name => ({ name })),
    }];
    const on = run({ bus: true }, mem);     // shortbus defaults on
    expect(on).toContain('(label "MEM(RAM_D[0..2], RAM_D5, RAM_CLK)"');
    const off = run({ bus: true, shortbus: false }, mem);
    expect(off).toContain('(label "MEM(RAM_D0, RAM_D1, RAM_D2, RAM_D5, RAM_CLK)"');
    // channel rows keep their full names either way
    expect((on.match(/\(label "MEM\.RAM_D0"/g) ?? []).length).toBe(1);
  });

  it('bus traces stretch to the port\'s longest channel label, uniformly', () => {
    const mem = [{
      name: 'MEM',
      channels: [{ name: 'RAM_SDCKE0' }, { name: 'CLK' }],
    }];
    const out = run({ bus: true }, mem);
    const wires = [...out.matchAll(/\(wire\s*\(pts\s*\(xy ([\d.]+) ([\d.]+)\) \(xy ([\d.]+) \2\)/g)]
      .map(m => Number(m[3]) - Number(m[1]));
    // MEM rows come first, then the assignment-only COM bus
    expect(wires.length).toBe(5);
    expect(wires[0]).toBe(wires[1]);                       // same length per bus
    expect(wires[0]).toBeGreaterThan(15.24);               // "MEM.RAM_SDCKE0" needs more
    expect(Math.round(wires[0] * 100) % 254).toBe(0);      // on grid
    // short names keep the default length
    expect(wires.slice(2).every(l => Math.abs(l - 15.24) < 1e-9)).toBe(true);
  });

  it('gpio stacks leave a free line between port groups', () => {
    const out = run({ gpiolist: true });
    // the stack occupies the first column at x = 25.4
    const at = (pin: string) => {
      const ms = [...out.matchAll(new RegExp(`\\(label "${pin}"\\s*\\(at ([\\d.]+) ([\\d.]+) 0\\)`, 'g'))];
      return Number(ms.find(m => m[1] === '25.4')![2]);
    };
    expect(at('PA2') - at('PA1')).toBeCloseTo(2.54, 5);    // same port: adjacent
    expect(at('PB2') - at('PA2')).toBeCloseTo(5.08, 5);    // port change: one free line
  });

  it('columns run left to right: all GPIOs, free GPIOs, channel list', () => {
    const exec = new Function(
      'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
      'docs', 'constraintsHeader', 'mcuInfo',
      fn.code,
    );
    const pins = [{ name: 'PA1' }, { name: 'PA3' }];
    const out = exec('T', 'LQFP48', ASSIGN, [], pins, PORTS, {},
      { ...defaultParamValues(params), gpiolist: true, freelist: true }, null, null, null) as string;
    const xOf = (re: RegExp) => Number(re.exec(out)![1]);
    const mappedX = xOf(/\(label "PB2"\s*\(at ([\d.]+) [\d.]+ 0\)/);          // gpio stack (col 1)
    // PA3 sits in both stacks now; its second label is the free stack (col 2)
    const freeX = Number([...out.matchAll(/\(label "PA3"\s*\(at ([\d.]+) [\d.]+ 0\)/g)][1][1]);
    const wireX = xOf(/\(wire\s*\(pts\s*\(xy ([\d.]+) 25\.4\)/);              // channel rows (col 3)
    expect(mappedX).toBe(25.4);
    expect(freeX).toBeGreaterThan(mappedX);
    expect(wireX).toBeGreaterThan(freeX);
  });

  it('doc headers above each list, unmapped channels comment their function', () => {
    const exec = new Function(
      'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
      'docs', 'constraintsHeader', 'mcuInfo',
      fn.code,
    );
    const ports = [{
      name: 'COM',
      channels: [
        { name: 'TX', functions: ['USART*_TX'] },
        { name: 'TX_EN', functions: ['OUT'] },
      ],
    }];
    const out = exec('T', 'LQFP48', ASSIGN, [], [{ name: 'PA3' }], ports, {},
      { ...defaultParamValues(params), gpiolist: true, freelist: true }, null, null, null) as string;
    expect(out).toContain('(text "gpio labels"');
    expect(out).toContain('(text "free gpios"');
    expect(out).toContain('(text "gpio mapping"');
    expect(out).toContain('(text "OUT"');                 // unmapped TX_EN function
    expect(out).toContain('(text "USART1_TX, TIM1_CH2"'); // mapped: real signals, not pattern
  });

  it('channel line comments form a second aligned comment column', () => {
    const exec = new Function(
      'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
      'docs', 'constraintsHeader', 'mcuInfo',
      fn.code,
    );
    const ports = [{
      name: 'COM',
      channels: [
        { name: 'TX', functions: ['USART*_TX'], comment: 'to host' },
        { name: 'TX_EN', functions: ['OUT'], comment: 'rs485 driver enable' },
      ],
    }];
    const out = exec('T', 'LQFP48', ASSIGN, [], [], ports, {},
      defaultParamValues(params), null, null, null) as string;
    const xOf = (t: string) => Number(new RegExp(`\\(text "${t}"[\\s\\S]*?\\(at ([\\d.]+) ([\\d.]+)`).exec(out)!.slice(1, 2)[0]);
    expect(out).toContain('(text "to host"');
    expect(out).toContain('(text "rs485 driver enable"');
    // both comments sit in the same column, right of the signal comments
    expect(xOf('to host')).toBe(xOf('rs485 driver enable'));
    expect(xOf('to host')).toBeGreaterThan(xOf('USART1_TX, TIM1_CH2'));
  });

  it('gpiolist option appends one label per mapped pin', () => {
    const out = run({ gpiolist: true });
    // PA1 appears on its row and once more in the stack
    expect((out.match(/\(label "PA1"/g) ?? []).length).toBe(2);
    expect((out.match(/\(label "PB2"/g) ?? []).length).toBe(2);
    const without = run();
    expect((without.match(/\(label "PA1"/g) ?? []).length).toBe(1);
  });
});
