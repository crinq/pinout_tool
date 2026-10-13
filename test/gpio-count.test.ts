import { it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { classifyProjectSolutions } from '../src/solver/solution-status';
import { serializeSolution, deserializeSolution } from '../src/storage';

// The peripherals view subtracts gpioCount (IN/OUT channels left unplaced by
// skip_gpio_mapping) from the free pins, so it must survive save/load.
const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));
const ast = parseConstraints(`
port P:
  channel TX = USART1_TX
  channel EN = OUT
  channel FAULT = IN
`).ast!;

it('keeps gpioCount through storage, and recomputes it for solutions saved without it', () => {
  const [sol] = solveConstraints(ast, mcu, { maxSolutions: 1, timeoutMs: 2000, costWeights: new Map(), skipGpioMapping: true }).solutions;
  expect(sol.gpioCount).toBe(2);

  const saved = JSON.parse(JSON.stringify(serializeSolution(sol)));
  expect(deserializeSolution(saved).gpioCount).toBe(2);

  delete saved.gpioCount; // as written before gpioCount was stored
  const old = deserializeSolution(saved);
  expect(old.gpioCount).toBe(0);
  expect(classifyProjectSolutions([old], ast, mcu, true).get(old)?.status).toBe('valid');
  expect(old.gpioCount).toBe(2);
});
