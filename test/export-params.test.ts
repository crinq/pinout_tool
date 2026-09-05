import { describe, it, expect, beforeEach } from 'vitest';

// In-memory localStorage shim (vitest jsdom build doesn't expose a usable one).
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}
installLocalStorage();
import {
  parseExportParams, coerceParamValue, defaultParamValues,
  loadParamValues, saveParamValues,
} from '../src/export-params';

const CODE = `// id: demo
// name: Demo
// param: header bool = true | Header row | Include a header row
// param: sep string = , | Separator | Column separator character
// param: fmt enum(csv,tsv,md) = tsv | Format | Output format
// param: width int = 20 | Column width | Pad columns to this many chars
// param: scale float = 1.5 | Scale | Scale factor
return 'x';`;

describe('parseExportParams', () => {
  it('parses every declared type with defaults, labels and docs', () => {
    const params = parseExportParams(CODE);
    expect(params.map(p => p.key)).toEqual(['header', 'sep', 'fmt', 'width', 'scale']);
    expect(params[0]).toMatchObject({ type: 'bool', default: true, label: 'Header row', doc: 'Include a header row' });
    expect(params[1]).toMatchObject({ type: 'string', default: ',' });
    expect(params[2]).toMatchObject({ type: 'enum', default: 'tsv', options: ['csv', 'tsv', 'md'] });
    expect(params[3]).toMatchObject({ type: 'int', default: 20 });
    expect(params[4]).toMatchObject({ type: 'float', default: 1.5 });
  });

  it('ignores malformed lines, duplicate keys and enums without options', () => {
    const params = parseExportParams(`// param: broken
// param: x int = 1 | X | first
// param: x int = 2 | X | duplicate
// param: e enum() = a | E | no options
// param: y bool = notabool | Y | bad default falls back
`);
    expect(params.map(p => p.key)).toEqual(['x', 'y']);
    expect(params[0].default).toBe(1);
    expect(params[1].default).toBe(false);
  });

  it('returns [] for code without param lines', () => {
    expect(parseExportParams("return 'x';")).toEqual([]);
  });
});

describe('coerceParamValue', () => {
  const enumP = parseExportParams('// param: f enum(a,b) = a | F | d')[0];
  it('rejects out-of-range values', () => {
    expect(coerceParamValue(enumP, 'c')).toBeNull();
    expect(coerceParamValue(enumP, 'b')).toBe('b');
    const intP = parseExportParams('// param: n int = 1 | N | d')[0];
    expect(coerceParamValue(intP, 2.5)).toBeNull();
    expect(coerceParamValue(intP, '7')).toBe(7);
  });
});

describe('persistence', () => {
  beforeEach(() => localStorage.clear());
  const params = parseExportParams(CODE);

  it('round-trips values and merges over defaults', () => {
    saveParamValues('demo', { header: false, fmt: 'md', width: 5 });
    const v = loadParamValues('demo', params);
    expect(v).toEqual({ header: false, sep: ',', fmt: 'md', width: 5, scale: 1.5 });
  });

  it('drops stored values that no longer fit the declaration', () => {
    saveParamValues('demo', { fmt: 'xml', width: 'wide', header: true });
    const v = loadParamValues('demo', params);
    expect(v.fmt).toBe('tsv');       // removed enum option → default
    expect(v.width).toBe(20);        // wrong type → default
    expect(v.header).toBe(true);
  });

  it('defaults when nothing stored', () => {
    expect(loadParamValues('never-saved', params)).toEqual(defaultParamValues(params));
  });
});

describe('end to end: built-in example export', () => {
  it('declares params and honors them through the executor', async () => {
    const { DEFAULT_EXPORTS } = await import('../src/defaults');
    const fn = DEFAULT_EXPORTS.find(f => f.id === 'example-pin-list')!;
    expect(fn).toBeDefined();
    const params = parseExportParams(fn.code);
    expect(params.map(p => p.key)).toEqual(['sortby', 'header']);

    const run = (values: Record<string, unknown>, ports: object[] = []): string => {
      const exec = new Function(
        'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
        fn.code,
      );
      return exec(
        'STM32TEST', 'LQFP48',
        [
          { pinName: 'PB1', signalName: 'USART1_RX', portName: 'U', channelName: 'RX', configurationName: 'c' },
          { pinName: 'PA9', signalName: 'USART1_TX', portName: 'U', channelName: 'TX', configurationName: 'c' },
        ],
        [], [], ports, {}, values,
      ) as string;
    };

    const withHeader = run(defaultParamValues(params));
    expect(withHeader).toContain('STM32TEST');
    expect(withHeader).toContain('Pin');
    // pin order: PA9 before PB1
    expect(withHeader.indexOf('PA9')).toBeLessThan(withHeader.indexOf('PB1'));

    const bare = run({ sortby: 'port', header: false });
    expect(bare).not.toContain('STM32TEST');
    expect(bare).not.toContain('Pin ');
    // port order: U.RX (PB1) before U.TX (PA9)
    expect(bare.indexOf('PB1')).toBeLessThan(bare.indexOf('PA9'));

    // declared-but-unmapped channels are listed; mapped ones are not repeated
    const withPorts = run(defaultParamValues(params), [
      { name: 'U', channels: [{ name: 'RX' }, { name: 'TX' }] },
      { name: 'GPIO', channels: [{ name: 'IN' }, { name: 'OUT' }] },
    ]);
    expect(withPorts).toContain('Unmapped channels:');
    expect(withPorts).toContain('GPIO.IN');
    expect(withPorts).toContain('GPIO.OUT');
    expect((withPorts.match(/U\.RX/g) ?? []).length).toBe(1);
  });
});
