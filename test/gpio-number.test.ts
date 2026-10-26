import { it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';

const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));
const SRC = `
port P:
  channel A @ PA1 = IN
  channel B @ PB1, PB2 = IN
`;
const pinsOf = (src: string, skipGpioMapping: boolean) =>
  solveConstraints(parseConstraints(src).ast!, mcu, { maxSolutions: 10, timeoutMs: 2000, costWeights: new Map(), skipGpioMapping })
    .solutions.map(s => Object.fromEntries(s.configAssignments[0].assignments.map(a => [a.channelName, a.pinName])));

it.each([true, false])('gpio_number keeps PA1 and PB1 apart (skip_gpio_mapping=%s)', (skip) => {
  const sols = pinsOf(`${SRC}  require gpio_number(A) != gpio_number(B)\n`, skip);
  expect(sols.length).toBeGreaterThan(0);
  for (const s of sols) expect(s).toEqual({ A: 'PA1', B: 'PB2' });
});

it('without a require the IN channels stay unplaced under skip_gpio_mapping', () => {
  expect(pinsOf(SRC, true)).toEqual([{}]);
});

it('an IN/OUT channel named only by a $var same_instance stays unplaced', () => {
  // $u is port-wide, so config "G" also gets same_instance(TX, EN) — with EN
  // = OUT there. Placing EN would make that unsatisfiable (a GPIO pin has no
  // USART instance); only pin-level functions should pull a channel in.
  const sols = pinsOf(`
port E:
  channel TX
  channel EN
  config "U":
    TX = USART*_TX $u
    EN = USART*_RTS $u
  config "G":
    TX = USART*_TX
    EN = OUT
`, true);
  expect(sols.length).toBeGreaterThan(0);
});
