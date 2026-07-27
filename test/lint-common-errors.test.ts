import { describe, it, expect } from 'vitest';
import { parseCommonErrorsLibrary, lintForCommonErrors, DEFAULT_COMMON_ERRORS_LIBRARY } from '../src/parser/lint-common-errors';
import { parseConstraints } from '../src/parser/constraint-parser';
import { expandAllMacros } from '../src/parser/macro-expander';

function expand(src: string) {
  const { ast } = parseConstraints(src);
  return expandAllMacros(ast, new Map(), new Map()).ast;
}

describe('lint-common-errors', () => {
  const lib = parseCommonErrorsLibrary(DEFAULT_COMMON_ERRORS_LIBRARY);

  it('catches classic MISO/MOSI swap in a channel name', () => {
    const ast = expand(`
port SPI:
  channel enc_miso = SPI*_MOSI
  channel enc_mosi = SPI*_MISO
`);
    const warnings = lintForCommonErrors(ast, lib);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].channelName).toBe('enc_miso');
    expect(warnings[0].message).toMatch(/miso.*MOSI|MOSI.*miso/);
  });

  it('catches TX/RX swap', () => {
    const ast = expand(`
port UART:
  channel tx = USART*_RX
  channel rx = USART*_TX
`);
    const warnings = lintForCommonErrors(ast, lib);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('no warning when tokens match', () => {
    const ast = expand(`
port UART:
  channel tx = USART*_TX
  channel rx = USART*_RX
`);
    expect(lintForCommonErrors(ast, lib)).toHaveLength(0);
  });

  it('no warning when channel name has no lint token', () => {
    const ast = expand(`
port DATA:
  channel out = USART*_TX
  channel in = USART*_RX
`);
    // "in"/"out" aren't in the default lib.
    expect(lintForCommonErrors(ast, lib)).toHaveLength(0);
  });

  it('word-boundary rule: "context" does NOT match "tx"', () => {
    // If we naively did substring, `context` would match `tx` — check
    // that word-boundary is enforced.
    const ast = expand(`
port CTX:
  channel context = USART*_RX
`);
    // channel token "tx" only matches at word boundary, "context" has no
    // boundary before the "tx". No warning expected.
    expect(lintForCommonErrors(ast, lib)).toHaveLength(0);
  });

  it('empty lib → no warnings', () => {
    const ast = expand(`
port SPI:
  channel enc_miso = SPI*_MOSI
`);
    expect(lintForCommonErrors(ast, parseCommonErrorsLibrary(''))).toHaveLength(0);
  });

  it('ignores comments and blank lines in lib', () => {
    const lib2 = parseCommonErrorsLibrary(`
# a comment
foo bar

# another comment
baz qux
`);
    expect(lib2.groups).toHaveLength(2);
    expect(lib2.siblingsByToken.get('foo')?.has('bar')).toBe(true);
  });

  it('ignores single-token lines (nothing to swap with)', () => {
    const lib2 = parseCommonErrorsLibrary('only');
    expect(lib2.groups).toHaveLength(0);
  });

  it('catches TIM CH1/CH2 swap', () => {
    const ast = expand(`
port MOT:
  channel A_ch1 = TIM*_CH2
  channel A_ch2 = TIM*_CH1
`);
    expect(lintForCommonErrors(ast, lib).length).toBeGreaterThanOrEqual(2);
  });
});
