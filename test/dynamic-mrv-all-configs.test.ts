import { it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { runSingleSolver } from '../src/solver/solver-worker-impl';

// Regression: the dynamic-MRV search emitted a solution once a config's
// variables had been wiped by propagation, covering only the combos that
// avoided that config — e.g. a port solved for SPI with its UART/TIM configs
// silently missing. Every config must be routed in every solution.
const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));

// B owns USART2, so A's config "y" can never be routed: the whole problem is
// infeasible. B.R has the smallest domain, so MRV assigns it first and the
// propagation then wipes A.y while config "x" still looks viable.
const SRC = `
port A:
  channel T
  config "x":
    T = USART1_TX
  config "y":
    T = USART2_*

port B:
  channel R = USART2_RX
`;

it.each(['dynamic-mrv', 'mrv-group', 'ratio-mrv-group'])('%s never drops a config', (id) => {
  const r = runSingleSolver(id, parseConstraints(SRC).ast!, mcu,
    { maxSolutions: 5, timeoutMs: 2000, costWeights: new Map() },
    { maxGroups: 10, maxSolutionsPerGroup: 5 }, { numRestarts: 3 }, 'easy');
  expect(r.solutions).toEqual([]);
});
