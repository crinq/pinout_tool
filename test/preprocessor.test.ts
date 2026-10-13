import { describe, it, expect } from 'vitest';
import { preprocess, collectMacros, MAX_EXPANSION_DEPTH } from '../src/parser/preprocessor';
import { parseConstraints } from '../src/parser/constraint-parser';
import type { PortDeclNode, MappingNode, ChannelDeclNode } from '../src/parser/constraint-ast';

/** Expand with no library, so only the source's own macros are visible. */
const pre = (src: string) => preprocess(src, '');

/** Parse in isolation from the macro library. */
const parseOk = (src: string) => {
  const r = parseConstraints(src, { macroLibrary: '' });
  expect(r.errors, r.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return r.ast!;
};

const portOf = (src: string) =>
  parseOk(src).statements.find(s => s.type === 'port_decl') as PortDeclNode;

const channelNames = (p: PortDeclNode) => p.channels.map(c => c.name);
const mappings = (p: PortDeclNode) =>
  p.configs[0].body.filter((b): b is MappingNode => b.type === 'mapping');

describe('macro preprocessor', () => {
  describe('definitions', () => {
    it('strips definitions from the output', () => {
      const r = pre(`macro m(A):
  A = USART*_TX

port P:
  channel X
  config "c":
    m(X)`);
      expect(r.text).not.toContain('macro m');
      expect(r.errors).toEqual([]);
    });

    it('collects signatures without expanding', () => {
      const sigs = collectMacros(`macro a(X):
  X = OUT

macro b(X, Y):
  X = OUT
  Y = IN`);
      expect(sigs).toEqual([
        { name: 'a', params: ['X'] },
        { name: 'b', params: ['X', 'Y'] },
      ]);
    });

    it('reports an empty body', () => {
      const r = pre(`macro m(A):

port P:
  channel X`);
      expect(r.errors.map(e => e.message).join()).toContain('empty body');
    });
  });

  describe('substitution', () => {
    it('substitutes a bare parameter as a whole word only', () => {
      // The leading TX is the channel; the _TX inside the signal pattern is not.
      const p = portOf(`macro m(TX):
  TX = USART*_TX

port P:
  channel CMD_TX
  config "c":
    m(CMD_TX)`);
      const m = mappings(p)[0];
      expect(m.channelName).toBe('CMD_TX');
      expect(m.signalExprs[0].alternatives[0].raw).toBe('USART*_TX');
    });

    it('pastes ${param} into the middle of a name', () => {
      const p = portOf(`macro efused(NAME):
  channel ${'${NAME}'}_EN = OUT
  channel ${'${NAME}'}_PGOOD = IN

port PWR:
  efused(VBUS)`);
      expect(channelNames(p)).toEqual(['VBUS_EN', 'VBUS_PGOOD']);
    });

    it('substitutes every parameter in one pass, without cascading', () => {
      // A -> B then B -> x would wrongly turn the first mapping into x.
      const p = portOf(`macro m(A, B):
  A = USART*_TX
  B = USART*_RX

port P:
  channel B
  channel x
  config "c":
    m(B, x)`);
      expect(mappings(p).map(m => m.channelName)).toEqual(['B', 'x']);
    });

    it('leaves a ${...} that is not a parameter verbatim', () => {
      // Comment interpolation uses the same syntax and must survive untouched.
      const r = pre(`macro m(TX):
  TX = USART*_TX    # ${'${instance(TX)}'} on ${'${gpio_pin(TX)}'}

port P:
  channel A
  config "c":
    m(A)`);
      expect(r.text).toContain('${instance(A)}');
      expect(r.text).toContain('${gpio_pin(A)}');
    });

    it('takes no parameters at all', () => {
      const p = portOf(`macro dbg():
  channel SWDIO = *_SWDIO
  channel SWCLK = *_SWCLK

port DEBUG:
  dbg()`);
      expect(channelNames(p)).toEqual(['SWDIO', 'SWCLK']);
    });
  });

  describe('structure', () => {
    it('declares channels from inside a macro', () => {
      const p = portOf(`macro efused(NAME):
  channel ${'${NAME}'}_EN = OUT
  channel ${'${NAME}'}_PGOOD = IN
  channel ${'${NAME}'}_SNS = ADC*_IN[0-15]

port PWR:
  efused(VBUS)
  efused(VDDA)`);
      expect(channelNames(p)).toEqual([
        'VBUS_EN', 'VBUS_PGOOD', 'VBUS_SNS',
        'VDDA_EN', 'VDDA_PGOOD', 'VDDA_SNS',
      ]);
    });

    it('re-indents the body onto the call site', () => {
      // The body is written at 2 spaces but lands inside a config at 4.
      const p = portOf(`macro pair(A, B):
  A = USART*_TX
  B = USART*_RX

port P:
  channel X
  channel Y
  config "c":
    pair(X, Y)`);
      expect(mappings(p).map(m => m.channelName)).toEqual(['X', 'Y']);
    });

    it('emits a whole config block', () => {
      const p = portOf(`macro two_ways(A):
  config "fast":
    A = USART*_TX
  config "slow":
    A = SPI*_MOSI

port P:
  channel A
  two_ways(A)`);
      expect(p.configs.map(c => c.name)).toEqual(['fast', 'slow']);
    });
  });

  describe('channel NAME(args) shorthand', () => {
    it('declares the argument channel and applies the macro', () => {
      const p = portOf(`macro adc_in(IN):
  IN = ADC*_IN[0-15]

port P:
  channel adc_in(VBUS_SNS)`);
      expect(channelNames(p)).toEqual(['VBUS_SNS']);
      expect(mappings(p).map(m => m.channelName)).toEqual(['VBUS_SNS']);
    });

    it('declares every argument of a multi-argument macro', () => {
      const p = portOf(`macro i2c(SDA, SCL):
  SDA = I2C*_SDA
  SCL = I2C*_SCL
  require same_instance(SDA, SCL)

port P:
  channel i2c(BUS_SDA, BUS_SCL)`);
      expect(channelNames(p)).toEqual(['BUS_SDA', 'BUS_SCL']);
      expect(p.configs[0].body.map(b => b.type)).toEqual(['mapping', 'mapping', 'require']);
    });

    it('works inside a macro body, on a substituted name', () => {
      // The form that broke on a real project: a library macro whose body uses
      // the shorthand with a pasted channel name.
      const p = portOf(`macro adc_in(IN):
  IN = ADC*_IN[0-15]

macro efused(NAME):
  channel ${'${NAME}'}_EN = OUT
  channel adc_in(${'${NAME}'}_SNS)

port PWR:
  efused(VBUS)`);
      expect(channelNames(p)).toEqual(['VBUS_EN', 'VBUS_SNS']);
      expect(mappings(p).map(m => m.channelName)).toEqual(['VBUS_EN', 'VBUS_SNS']);
    });

    it('joins the enclosing group', () => {
      const p = portOf(`macro adc_in(IN):
  IN = ADC*_IN[0-15]

port P:
  group "rail": @ ~NW
    channel adc_in(SNS)`);
      expect(p.channels.map(c => [c.name, c.group])).toEqual([['SNS', 'rail']]);
    });

    it('declares only the arguments that are bare identifiers', () => {
      const p = portOf(`macro typed(CH, TYPE):
  CH = TIM*_CH[1-4]
  require type(CH) == TYPE

port P:
  channel typed(PWM, "TIM")`);
      expect(channelNames(p)).toEqual(['PWM']);
    });

    it('reports an unknown macro instead of a stray paren', () => {
      const r = pre(`port P:
  channel nope(A)`);
      expect(r.errors.map(e => e.message).join()).toContain("Unknown macro 'nope'");
    });

    it('leaves an ordinary channel declaration alone', () => {
      const p = portOf(`port P:
  channel A @ PA1 = OUT
  channel B = OUT`);
      expect(channelNames(p)).toEqual(['A', 'B']);
    });
  });

  describe('nesting and overloading', () => {
    it('expands a nested call whose argument was built by substitution', () => {
      const p = portOf(`macro adc_in(IN):
  IN = ADC*_IN[0-15]

macro sensed(NAME):
  channel ${'${NAME}'}_SNS
  adc_in(${'${NAME}'}_SNS)

port P:
  sensed(VBUS)`);
      expect(channelNames(p)).toEqual(['VBUS_SNS']);
      expect(mappings(p)[0].channelName).toBe('VBUS_SNS');
    });

    it('selects an overload by argument count', () => {
      const p = portOf(`macro m(A):
  A = USART*_TX

macro m(A, B):
  m(A)
  B = USART*_RX

port P:
  channel X
  channel Y
  config "c":
    m(X, Y)`);
      expect(mappings(p).map(m => m.channelName)).toEqual(['X', 'Y']);
    });

    it('does not treat an overload calling a smaller overload as recursion', () => {
      const r = pre(`macro m(A):
  A = USART*_TX

macro m(A, B):
  m(A)
  B = USART*_RX

port P:
  channel X
  channel Y
  config "c":
    m(X, Y)`);
      expect(r.errors).toEqual([]);
    });

    it('prefers a local definition over the library', () => {
      const r = preprocess(
        `port P:
  channel A
  channel B
  config "c":
    uart_port(A, B)`,
        `macro uart_port(TX, RX):
  TX = USART1_TX
  RX = USART1_RX`,
      );
      expect(r.text).toContain('USART1_TX');
    });
  });

  describe('errors', () => {
    it('reports an unknown macro', () => {
      const r = pre(`port P:
  channel A
  config "c":
    nope(A)`);
      expect(r.errors.map(e => e.message).join()).toContain("Unknown macro 'nope'");
    });

    it('reports a wrong argument count with the available arities', () => {
      const r = pre(`macro m(A, B):
  A = USART*_TX
  B = USART*_RX

port P:
  channel X
  config "c":
    m(X)`);
      const msg = r.errors.map(e => e.message).join();
      expect(msg).toContain('not found');
      expect(msg).toContain('m(2 args)');
    });

    it('detects direct recursion', () => {
      const r = pre(`macro loop(X):
  loop(X)

port P:
  channel A
  config "c":
    loop(A)`);
      expect(r.errors.map(e => e.message).join()).toContain('Recursive macro call');
    });

    it('detects mutual recursion within the depth limit', () => {
      const r = pre(`macro a(X):
  b(X)

macro b(X):
  a(X)

port P:
  channel A
  config "c":
    a(A)`);
      expect(r.errors.map(e => e.message).join()).toMatch(/Recursive macro call|expansion depth/);
      expect(MAX_EXPANSION_DEPTH).toBe(10);
    });
  });

  describe('line mapping', () => {
    it('reports an error inside an expansion at the call site', () => {
      //                     1              2      3   4    5        6
      const src = `macro m(A):\n  A = ***bad\n\nport P:\n  channel X\n  config "c":\n    m(X)`;
      const r = parseConstraints(src, { macroLibrary: '' });
      expect(r.errors.length).toBeGreaterThan(0);
      // Line 7 is the `m(X)` call; the faulty text lives on line 2.
      expect(r.errors[0].line).toBe(7);
    });

    it('keeps ordinary line numbers correct after an expansion', () => {
      const src = `macro m(A):\n  channel ${'${A}'}_1 = OUT\n  channel ${'${A}'}_2 = OUT\n\nport P:\n  m(X)\n  channel LAST = OUT`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      const last = port.channels.find(c => c.name === 'LAST') as ChannelDeclNode;
      expect(last.loc.line).toBe(7);
    });
  });
});

describe('ranges', () => {
  const lines = (src: string) => pre(src).text.split('\n').map(l => l.trim()).filter(Boolean);
  const errorsOf = (src: string) => pre(src).errors.map(e => e.message);

  it('zips a channel range with a signal range', () => {
    const p = portOf(`port FMC:
  channel A{0-2} = FMC_A{0-2}`);
    expect(channelNames(p)).toEqual(['A0', 'A1', 'A2']);
    expect(mappings(p).map(m => [m.channelName, m.loc.line])).toEqual([['A0', 2], ['A1', 2], ['A2', 2]]);
  });

  it('expands letters, lists and descending ranges', () => {
    expect(lines(`  channel P{A-C} = SPI1_{MOSI, MISO, 0-0}`)).toEqual([
      'channel PA = SPI1_MOSI', 'channel PB = SPI1_MISO', 'channel PC = SPI1_0',
    ]);
    expect(lines(`  D{0-2} = FMC_D{2-0}`)).toEqual(['D0 = FMC_D2', 'D1 = FMC_D1', 'D2 = FMC_D0']);
    expect(lines(`  channel x{a-b}`)).toEqual(['channel xa', 'channel xb']);
  });

  it('copies require and ?= lines, and expands the trailing comment', () => {
    expect(lines(`  require same_instance(A{0-1}, B{0-1})`)).toEqual([
      'require same_instance(A0, B0)', 'require same_instance(A1, B1)',
    ]);
    expect(lines(`  X{0-1} ?= OUT  # ${'$'}{gpio_pin(X{0-1})} ${'$'}{X}`)).toEqual([
      'X0 ?= OUT  # ${gpio_pin(X0)} ${X}', 'X1 ?= OUT  # ${gpio_pin(X1)} ${X}',
    ]);
  });

  it('ignores braces that are only in a comment', () => {
    expect(lines(`port P:  # {0-3}`)).toEqual(['port P:  # {0-3}']);
  });

  it('expands after macro substitution', () => {
    const p = portOf(`macro bus(N):
  channel ${'$'}{N}{0-1} = OUT

port P:
  bus(D)`);
    expect(channelNames(p)).toEqual(['D0', 'D1']);
  });

  it('rejects bad ranges and lines that are not channel/mapping/require', () => {
    expect(errorsOf(`  channel A{0-2} = FMC_A{0-1}`)[0]).toMatch(/same length/);
    expect(errorsOf(`  channel A{A-3}`)[0]).toMatch(/Invalid range item/);
    expect(errorsOf(`  channel A{0-5000}`)[0]).toMatch(/too large/);
    expect(errorsOf(`port P{0-1}:`)[0]).toMatch(/only allowed/);
    expect(errorsOf(`  config "C{0-1}":`)[0]).toMatch(/only allowed/);
    expect(errorsOf(`  group G{0-1}:`)[0]).toMatch(/only allowed/);
  });

  it('copies macro calls', () => {
    const p = portOf(`macro m(A, B):
  channel A
  channel B
  A = OUT
  B = IN

port P:
  m(X{0-1}, Y{A-B})`);
    expect(channelNames(p)).toEqual(['X0', 'YA', 'X1', 'YB']);
  });

  it('zero-pads when a bound has a leading zero', () => {
    expect(lines(`  channel D{08-10}`)).toEqual(['channel D08', 'channel D09', 'channel D10']);
    expect(lines(`  channel D{1-003}`)).toEqual(['channel D001', 'channel D002', 'channel D003']);
    expect(lines(`  channel D{0-2}`)).toEqual(['channel D0', 'channel D1', 'channel D2']);
  });
});
