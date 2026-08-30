import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { runPreSolveChecks, solveConstraints } from '../src/solver/solver';

// STM32F103C8 / LQFP48 has 2 ADC instances.
const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));

const adcPorts = (n: number) =>
  Array.from({ length: n }, (_, i) => `port P${i}:\n  channel S\n  config "a":\n    adc(S)`).join('\n');
const errorsFor = (src: string) =>
  runPreSolveChecks(parseConstraints(src).ast!, mcu).filter(e => e.type === 'error').map(e => e.message);

describe('instance-count check respects `shared:`', () => {
  it('5 ports needing ADC pass when the instances are shared', () => {
    // Regression: the count assumed one instance per port and never looked at
    // `shared:`, so this failed with "Not enough ADC instances: 5 needed … 2 available".
    const errs = errorsFor(`shared: ADC1, ADC2\n${adcPorts(5)}`);
    expect(errs.filter(m => /Not enough ADC instances/.test(m))).toEqual([]);
  });

  it('and actually solves', () => {
    const r = solveConstraints(parseConstraints(`shared: ADC1, ADC2\n${adcPorts(5)}`).ast!, mcu,
      { maxSolutions: 5, timeoutMs: 15000, costWeights: new Map() });
    expect(r.solutions.length).toBeGreaterThan(0);
  });

  it('a wildcard share works too', () => {
    expect(errorsFor(`shared: ADC*\n${adcPorts(5)}`).filter(m => /Not enough ADC/.test(m))).toEqual([]);
  });

  it('still reports over-subscription when nothing is shared', () => {
    expect(errorsFor(adcPorts(5)).some(m => /Not enough ADC instances: 5 needed/.test(m))).toBe(true);
  });

  it('sharing one type does not silence another', () => {
    // ADC shared, but 4 ports each needing an exclusive SPI (F103C8 has 2).
    const src = `shared: ADC1, ADC2
${Array.from({ length: 4 }, (_, i) =>
  `port S${i}:\n  channel M\n  channel C\n  config "s":\n    M = SPI*_MOSI\n    C = SPI*_SCK\n    require same_instance(M, C)`).join('\n')}`;
    expect(errorsFor(src).some(m => /Not enough SPI instances/.test(m))).toBe(true);
  });
});
