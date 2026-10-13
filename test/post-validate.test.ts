import { it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { maybePostValidate } from '../src/solver/solver-worker-impl';

const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));
const ast = parseConstraints(`
port A:
  channel T
  config "x":
    T = USART1_TX
  config "y":
    T = USART2_TX
`).ast!;

it('drops solutions that fail the validity check and says which solver made them', () => {
  const r = solveConstraints(ast, mcu, { maxSolutions: 2, timeoutMs: 2000, costWeights: new Map() });
  expect(r.solutions).toHaveLength(2);
  // Break the second one the way the old dynamic-MRV bug did: config "y" missing.
  const broken = r.solutions[1];
  broken.configAssignments = broken.configAssignments.map(ca => ({
    ...ca, assignments: ca.assignments.filter(a => a.configurationName !== 'y'),
  }));
  broken.solverOrigin = 'mrv-group';
  const good = r.solutions[0];

  const off = maybePostValidate({ ...r, solutions: [...r.solutions], errors: [] }, ast, mcu, { postValidate: false });
  expect(off.solutions).toHaveLength(2);

  const on = maybePostValidate({ ...r, solutions: [...r.solutions], errors: [] }, ast, mcu, { postValidate: true });
  expect(on.solutions).toEqual([good]);
  expect(on.errors.map(e => e.message)).toEqual([
    expect.stringMatching(/^MRV-Group: post-validation removed 1 invalid solution\(s\) — .*T = USART2_TX not satisfied/),
  ]);
});
