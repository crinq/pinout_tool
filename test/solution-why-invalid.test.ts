import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { classifyProjectSolutions, MAX_REASONS } from '../src/solver/solution-status';
import type { Solution } from '../src/types';

const dir = join(__dirname, 'g474');
const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
const parse = (s: string) => parseConstraints(s, { macroLibrary: s }).ast!;

const ORIG = `port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)`;

const solved: Solution[] = solveConstraints(parse(ORIG), mcu,
  { maxSolutions: 2, timeoutMs: 5000, costWeights: new Map() }).solutions;

/** Verdict for the first stored solution against edited constraints. */
const verdict = (src: string) =>
  [...classifyProjectSolutions(solved, parse(src), mcu, true).values()][0];

describe('why a stored solution is invalid', () => {
  it('a still-matching solution is valid with no reasons', () => {
    const v = verdict(ORIG);
    expect(v.status).toBe('valid');
    expect(v.reasons).toEqual([]);
  });

  it('names an unsatisfied channel with its line and pattern', () => {
    const v = verdict(`port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX
  channel DIO = *_SWDIO
  require same_instance(TX, RX)`);
    expect(v.status).toBe('invalid');
    expect(v.reasons).toEqual(['line 4: channel DIO = *_SWDIO not satisfied']);
  });

  it('names a failing require with its line and source form', () => {
    const v = verdict(`port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)
  require instance(TX, "USART") == USART[3]`);
    expect(v.status).toBe('invalid');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatch(/^line 5: require instance\(TX, "USART"\) == USART\[3\] not satisfied$/);
  });

  it('explains an `extra` verdict too', () => {
    const v = verdict('port CMD:\n  channel TX = USART*_TX');
    expect(v.status).toBe('extra');
    expect(v.reasons.join()).toMatch(/CMD\.RX on \w+ is not in the current constraints/);
  });

  it('caps the list and says how many were left out', () => {
    const v = verdict(`port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX
  channel A = SPI*_SCK
  channel B = SPI*_MOSI
  channel C = I2C*_SCL
  channel D = I2C*_SDA
  channel E = SPI*_MISO
  channel F = TIM*_CH1`);
    expect(v.status).toBe('invalid');
    expect(v.reasons).toHaveLength(MAX_REASONS + 1);
    expect(v.reasons[MAX_REASONS]).toMatch(/^…and \d+ more$/);
    for (const r of v.reasons.slice(0, MAX_REASONS)) expect(r).toMatch(/^line \d+: /);
  });

  it('reasons are ordered by source line', () => {
    const v = verdict(`port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX
  channel A = SPI*_SCK
  channel B = I2C*_SCL`);
    const lines = v.reasons.map(r => Number(/^line (\d+):/.exec(r)?.[1] ?? 0));
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('every reason is a single line, so the tooltip stays readable', () => {
    const v = verdict('port CMD:\n  channel TX = USART*_TX\n  channel Z = SPI*_SCK');
    for (const r of v.reasons) {
      expect(r).not.toContain('\n');
      expect(r.length).toBeLessThan(120);
    }
  });
});
