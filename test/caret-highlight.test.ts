import { describe, it, expect, vi } from 'vitest';

// jsdom has no canvas, and constraint-minimap grabs a 2d context at module
// load (for colorWithAlpha), so the stub has to be installed before imports.
vi.hoisted(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext =
    () => new Proxy({}, { get: () => () => ({ width: 0, data: [0, 0, 0, 0] }) });
});
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { ConstraintMinimap } from '../src/ui/constraint-minimap';
import type { Assignment } from '../src/types';

const dir = join(__dirname, 'g474');
const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
const assignable = mcu.logicalPins.filter(p => p.isAssignable).length;

/** Full highlight the caret would produce on `line` of `src`. */
function hit(src: string, line: number, assignments: Assignment[] | null = null) {
  const m = new ConstraintMinimap();
  m.setMcu(mcu);
  m.setAssignments(assignments);
  m.update(parseConstraints(src, { macroLibrary: src }).ast, src.split('\n').length);
  return m.pinsForLine(line);
}

/** Pins the caret would ring on `line` of `src`. */
function ringed(src: string, line: number, assignments: Assignment[] | null = null): Set<string> {
  const m = new ConstraintMinimap();
  m.setMcu(mcu);
  m.setAssignments(assignments);
  m.update(parseConstraints(src, { macroLibrary: src }).ast, src.split('\n').length);
  return m.pinsForLine(line)?.pins ?? new Set();
}
/** Line number (1-based) of the line containing `needle`. */
const lineOf = (src: string, needle: string) =>
  src.split('\n').findIndex(l => l.includes(needle)) + 1;

describe('caret ring: bare IN / OUT', () => {
  it('an unconstrained OUT rings nothing', () => {
    const src = 'port P:\n  channel LED = OUT';
    expect(ringed(src, lineOf(src, 'LED')).size).toBe(0);
  });

  it('an unconstrained IN rings nothing', () => {
    const src = 'port P:\n  channel BTN = IN';
    expect(ringed(src, lineOf(src, 'BTN')).size).toBe(0);
  });

  it('an IN | OUT alternation rings nothing', () => {
    const src = 'port P:\n  channel IO = IN | OUT';
    expect(ringed(src, lineOf(src, 'IO')).size).toBe(0);
  });

  it('a hard placement rings exactly those pins', () => {
    const src = 'port P:\n  channel LED @ PA5 = OUT';
    expect([...ringed(src, lineOf(src, 'LED'))]).toEqual(['PA5']);
  });

  it('a multi-pin hard placement rings the whole set', () => {
    const src = 'port P:\n  channel LED @ PA5, PB2 = OUT';
    expect([...ringed(src, lineOf(src, 'LED'))].sort()).toEqual(['PA5', 'PB2']);
  });

  it('a negative placement alone still rings nothing', () => {
    const src = 'port P:\n  channel LED @ !PA5 = OUT';
    expect(ringed(src, lineOf(src, 'LED')).size).toBe(0);
  });

  it('a soft anchor alone still rings nothing (not a hard set)', () => {
    const src = 'port P:\n  channel LED @ ~PA5 = OUT';
    expect(ringed(src, lineOf(src, 'LED')).size).toBe(0);
  });

  it('a hard placement minus an exclusion rings the remainder', () => {
    const src = 'port P:\n  channel LED @ PA5, PB2, !PB2 = OUT';
    expect([...ringed(src, lineOf(src, 'LED'))]).toEqual(['PA5']);
  });
});

describe('caret ring: channels with a signal filter', () => {
  it('rings the pattern candidates', () => {
    const src = 'port P:\n  channel TX = USART*_TX';
    const pins = ringed(src, lineOf(src, 'TX'));
    expect(pins.size).toBeGreaterThan(0);
    expect(pins.size).toBeLessThan(assignable);
  });

  it('is no longer suppressed by the old half-the-package cap', () => {
    // `*_*` matches most of the package; with a real filter we now show it.
    const src = 'port P:\n  channel ANY = *_*';
    expect(ringed(src, lineOf(src, 'ANY')).size).toBeGreaterThan(assignable / 2);
  });

  it('a port line aggregates its filtered channels but drops a bare OUT', () => {
    const src = `port P:
  channel TX = USART*_TX
  channel LED = OUT`;
    const portPins = ringed(src, lineOf(src, 'port P:'));
    const txPins = ringed(src, lineOf(src, 'TX'));
    expect([...portPins].sort()).toEqual([...txPins].sort());
  });

  it('mixing a filter and a bare OUT keeps only the filter side', () => {
    const src = 'port P:\n  channel X = USART*_TX | OUT';
    const mixed = ringed(src, lineOf(src, 'X'));
    const plain = ringed('port P:\n  channel X = USART*_TX', 2);
    expect([...mixed].sort()).toEqual([...plain].sort());
  });
});

describe('caret ring: with a solution loaded', () => {
  const src = `port P:
  channel TX = USART*_TX
  channel LED = OUT`;
  const assignments: Assignment[] = [
    { portName: 'P', channelName: 'TX', pinName: 'PA9', signalName: 'USART1_TX', configurationName: 'P' } as Assignment,
    { portName: 'P', channelName: 'LED', pinName: 'PC13', signalName: 'GPIO_Output', configurationName: 'P' } as Assignment,
  ];

  it('rings the assigned pin of a bare OUT', () => {
    expect([...ringed(src, lineOf(src, 'LED'), assignments)]).toEqual(['PC13']);
  });

  it('rings the assigned pin of a filtered channel', () => {
    expect([...ringed(src, lineOf(src, 'TX'), assignments)]).toEqual(['PA9']);
  });

  it('a port line rings both', () => {
    expect([...ringed(src, lineOf(src, 'port P:'), assignments)].sort()).toEqual(['PA9', 'PC13']);
  });
});

describe('caret ring: require lines', () => {
  const SRC = `port P:
  channel TX = USART*_TX
  channel RX = USART*_RX
  channel CK = SPI*_SCK
  require same_instance(TX, RX)`;

  it('resolves to the require scope, not the enclosing port', () => {
    expect(hit(SRC, lineOf(SRC, 'require'))?.scope).toBe('require');
  });

  it('rings only the channels the require names', () => {
    const req = ringed(SRC, lineOf(SRC, 'require'));
    const tx = ringed(SRC, lineOf(SRC, 'channel TX'));
    const rx = ringed(SRC, lineOf(SRC, 'channel RX'));
    const ck = ringed(SRC, lineOf(SRC, 'channel CK'));
    expect([...req].sort()).toEqual([...new Set([...tx, ...rx])].sort());
    // Pins only CK can use must be absent (some pins carry both a USART and an
    // SPI signal, so the sets legitimately overlap).
    const ckOnly = [...ck].filter(p => !tx.has(p) && !rx.has(p));
    expect(ckOnly.length, 'fixture needs CK-exclusive pins').toBeGreaterThan(0);
    for (const p of ckOnly) expect(req.has(p), `CK-only pin ${p} must not be ringed`).toBe(false);
  });

  it('is narrower than the port line', () => {
    expect(ringed(SRC, lineOf(SRC, 'require')).size)
      .toBeLessThan(ringed(SRC, lineOf(SRC, 'port P:')).size);
  });

  it('a single-channel require rings just that channel', () => {
    const src = `port P:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require gpio_port(TX) == GPIOA`;
    expect([...ringed(src, lineOf(src, 'require'))].sort())
      .toEqual([...ringed(src, lineOf(src, 'channel TX'))].sort());
  });

  it('ignores string type filters and pattern literals', () => {
    const src = `port P:
  channel A = TIM*_CH1
  channel B = TIM*_CH2
  require same_instance(A, B, "TIM") & instance(A, "TIM") == TIM[1-5,8,20]`;
    const req = ringed(src, lineOf(src, 'require'));
    const ab = new Set([...ringed(src, lineOf(src, 'channel A')), ...ringed(src, lineOf(src, 'channel B'))]);
    expect([...req].sort()).toEqual([...ab].sort());
  });

  it('works inside a config block', () => {
    const src = `port P:
  channel TX
  channel RX
  channel CK

  config "u":
    TX = USART*_TX
    RX = USART*_RX
    CK = SPI*_SCK
    require same_instance(TX, RX)`;
    const req = ringed(src, lineOf(src, 'require'));
    const cfg = ringed(src, lineOf(src, 'config "u"'));
    expect(req.size).toBeGreaterThan(0);
    expect(req.size).toBeLessThan(cfg.size);
    const tx = ringed(src, lineOf(src, 'TX = USART'));
    const rx = ringed(src, lineOf(src, 'RX = USART'));
    const ckOnly = [...ringed(src, lineOf(src, 'CK = SPI'))].filter(p => !tx.has(p) && !rx.has(p));
    expect(ckOnly.length).toBeGreaterThan(0);
    for (const p of ckOnly) expect(req.has(p), p).toBe(false);
  });

  it('falls back to the enclosing scope when it names no local channel', () => {
    const src = `port P:
  channel TX = USART*_TX
  require instance(OTHER.TX) != instance(TX2)`;
    const h = hit(src, lineOf(src, 'require'));
    expect(h?.scope).toBe('port');
  });

  it('a bare IN/OUT named in a require stays suppressed', () => {
    const src = `port P:
  channel LED = OUT
  channel TX = USART*_TX
  require gpio_port(LED) == gpio_port(TX)`;
    const req = ringed(src, lineOf(src, 'require'));
    expect([...req].sort()).toEqual([...ringed(src, lineOf(src, 'channel TX'))].sort());
  });
});
