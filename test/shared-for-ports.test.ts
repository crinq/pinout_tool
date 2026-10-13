import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { runPreSolveChecks, solveConstraints, extractSharedPatterns, instanceShareKey } from '../src/solver/solver';
import { runSingleSolver } from '../src/solver/solver-worker-impl';
import type { SharedDeclNode } from '../src/parser/constraint-ast';

// STM32F103C8: TIM1 is the only timer with a BKIN input.
const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));

const PORTS = `
port PWM:
  channel A = TIM*_CH1

port STO:
  channel sto = TIM*_BKIN
  require same_instance(sto, PWM.A)
`;

const ast = (src: string) => {
  const r = parseConstraints(src, { macroLibrary: '' });
  expect(r.errors).toEqual([]);
  return r.ast!;
};
const solve = (src: string) =>
  solveConstraints(ast(src), mcu, { maxSolutions: 5, timeoutMs: 5000, costWeights: new Map() });
const errorsFor = (src: string) =>
  runPreSolveChecks(ast(src), mcu).filter(e => e.type === 'error').map(e => e.message);

describe('shared: <patterns> for <ports>', () => {
  it('parses the port list', () => {
    const [limited, global] = ast(`shared: TIM*, ADC1 for PWM, STO\nshared: ADC2`).statements as SharedDeclNode[];
    expect(limited.ports).toEqual(['PWM', 'STO']);
    expect(limited.patterns).toHaveLength(2);
    expect(global.ports).toBeUndefined();
  });

  it('lets the listed ports hold one instance together', () => {
    const r = solve(`shared: TIM* for PWM, STO\n${PORTS}`);
    expect(r.solutions.length).toBeGreaterThan(0);
    for (const s of r.solutions) {
      expect(new Set(s.configAssignments[0].assignments.map(a => a.signalName.split('_')[0]))).toEqual(new Set(['TIM1']));
    }
  });

  it.each([
    'backtracking', 'cost-guided', 'ac3', 'dynamic-mrv', 'priority-backtracking', 'randomized-restarts',
    'two-phase', 'diverse-instances', 'priority-two-phase', 'priority-diverse',
    'priority-group', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'conflict-directed', 'cegar', 'lns-repair', 'adaptive',
  ])('%s honours it', (id) => {
    const r = runSingleSolver(id, ast(`shared: TIM* for PWM, STO\n${PORTS}`), mcu,
      { maxSolutions: 3, timeoutMs: 2000, costWeights: new Map() },
      { maxGroups: 20, maxSolutionsPerGroup: 2 }, { numRestarts: 3 }, 'easy');
    expect(r.solutions.length).toBeGreaterThan(0);
  });

  it('stays exclusive without the share', () => {
    expect(solve(PORTS).solutions).toEqual([]);
  });

  it('keeps other ports off the shared instance', () => {
    const other = `\nport OTHER:\n  channel X = TIM1_CH2\n`;
    expect(solve(`shared: TIM* for PWM, STO\n${PORTS}${other}`).solutions).toEqual([]);
    expect(solve(`shared: TIM* for PWM, STO, OTHER\n${PORTS}${other}`).solutions.length).toBeGreaterThan(0);
  });

  it('reports an unknown port', () => {
    expect(errorsFor(`shared: TIM* for PWM, STOP\n${PORTS}`)).toContainEqual(expect.stringMatching(/Unknown port "STOP"/));
  });

  it('merges groups that name a common port, and only for matching instances', () => {
    const p = extractSharedPatterns(ast(`shared: TIM* for A, B\nshared: TIM1 for B, C\nshared: ADC* for D, E`));
    const key = (inst: string, port: string) => instanceShareKey(inst, port, p);
    expect(key('TIM1', 'A')).toBe(key('TIM1', 'C'));
    expect(key('TIM2', 'A')).toBe(key('TIM2', 'B'));
    expect(key('TIM2', 'C')).toBe('C');
    expect(key('TIM1', 'D')).toBe('D');
    expect(key('ADC1', 'D')).toBe(key('ADC1', 'E'));
  });
});
