import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuJson } from '../src/parser/mcu-json-parser';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, setIrqScope, runPreSolveChecks, type IrqScope } from '../src/solver/solver';
import { applySettingsOverrides, DEFAULT_SETTINGS } from '../src/settings';

// F103VB (vendor JSON): ADC1 and ADC2 share the ADC1_2 vector; TIM1 has
// separate BRK / CC / TRG_COM / UP vectors; USART1 has its own.
const mcu = parseMcuJson(readFileSync(join(__dirname, 'fixtures/stm32f103vb.json'), 'utf-8'))[0];
const solve = (src: string, scope: IrqScope = 'port') => {
  setIrqScope(scope);
  return solveConstraints(parseConstraints(src).ast!, mcu, { maxSolutions: 3, timeoutMs: 3000, costWeights: new Map() });
};
afterEach(() => setIrqScope('port'));

const adcPort = (name: string, ch: string, sig: string) =>
  `port ${name}:\n  channel ${ch} = ${sig}\n  require irq(${ch})\n`;

describe('irq()', () => {
  it('needs an interrupt line on the mapped instance; the filter picks type / signal', () => {
    const r = solve(`
port U:
  channel TX = USART*_TX
  internal tim = TIM1_UP
  require irq(TX)
  require irq(tim, "TIM_BRK")
`);
    expect(r.solutions.length).toBeGreaterThan(0);
    // no such interrupt signal → never satisfied
    expect(solve(`port U:\n  internal tim = TIM1_UP\n  require irq(tim, "TIM_NOPE")\n`).solutions).toEqual([]);
  });

  it('two ports on a shared vector: exclusive per port, free with global', () => {
    const src = adcPort('A', 'S', 'ADC1_IN0') + adcPort('B', 'S', 'ADC2_IN1');
    expect(solve(src, 'port').solutions).toEqual([]);
    expect(solve(src, 'global').solutions.length).toBeGreaterThan(0);
  });

  it('one port, two channels on a shared vector: fine per port, conflict per channel', () => {
    const src = `port A:\n  channel S = ADC1_IN0\n  channel T = ADC2_IN1\n  require irq(S)\n  require irq(T)\n`;
    expect(solve(src, 'port').solutions.length).toBeGreaterThan(0);
    expect(solve(src, 'channel').solutions).toEqual([]);
  });

  it('two configs of one port on a shared vector: fine per port, conflict per config', () => {
    const src = `
port A:
  channel S
  config "one":
    S = ADC1_IN0
    require irq(S)
  config "two":
    S = ADC2_IN1
    require irq(S)
`;
    expect(solve(src, 'port').solutions.length).toBeGreaterThan(0);
    expect(solve(src, 'config').solutions).toEqual([]);
  });

  it('an alternative under | does not claim a vector', () => {
    const src = adcPort('A', 'S', 'ADC1_IN0')
      + `port B:\n  channel S = ADC2_IN1\n  require irq(S) | type(S) == "ADC"\n`;
    expect(solve(src, 'port').solutions.length).toBeGreaterThan(0);
  });

  it('without interrupt data (CubeMX XML) is a pre-solve error', () => {
    const xml = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));
    const errs = runPreSolveChecks(parseConstraints(adcPort('A', 'S', 'ADC1_IN0')).ast!, xml);
    expect(errs.map(e => e.message)).toContainEqual(expect.stringMatching(/irq\(\) but no interrupt data/));
  });

  it('irq_exclusive in a settings block', () => {
    const ok = applySettingsOverrides(parseConstraints('settings:\n  irq_exclusive: "channel"\n').ast!, DEFAULT_SETTINGS, new Set());
    expect(ok.settings.irqExclusive).toBe('channel');
    const bad = applySettingsOverrides(parseConstraints('settings:\n  irq_exclusive: "pin"\n').ast!, DEFAULT_SETTINGS, new Set());
    expect(bad.errors[0]).toMatch(/irq_exclusive expects/);
  });
});
