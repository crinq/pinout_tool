import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { DEFAULT_MACRO_LIBRARY } from '../src/parser/stdlib-macros';
import type { PortDeclNode, RequireNode, BinaryExprNode } from '../src/parser/constraint-ast';

const mcu = parseMcuXml(readFileSync(join(__dirname, 'g474/STM32G474R(B-C-E)Tx.xml'), 'utf-8'));

const instancesFor = (src: string) => {
  const r = solveConstraints(parseConstraints(src).ast!, mcu,
    { maxSolutions: 400, timeoutMs: 20000, costWeights: new Map() });
  const inst = new Set(r.solutions
    .flatMap(s => s.configAssignments.flatMap(c => c.assignments))
    .map(a => a.signalName.split('_')[0]));
  return { count: r.solutions.length, instances: [...inst].sort() };
};

describe('the default macro library is valid', () => {
  it('parses without errors, so it can be saved unchanged', () => {
    // Regression: `require instance(A, "TIM") == TIM[1-5,8,20]` on line 35 did
    // not parse — the expression grammar had no pattern value — so the Save
    // button rejected the untouched default library.
    const r = parseConstraints(DEFAULT_MACRO_LIBRARY.trim());
    expect(r.errors.map(e => `L${e.line}: ${e.message}`)).toEqual([]);
  });
});

describe('peripheral pattern as a value', () => {
  it('parses to a pattern_literal, not an ident', () => {
    const ast = parseConstraints(`port P:
  channel A
  config "c":
    A = TIM*_CH1
    require instance(A, "TIM") == TIM[1-5,8,20]`).ast!;
    const port = ast.statements.find(s => s.type === 'port_decl') as PortDeclNode;
    const req = port.configs[0].body.find(b => b.type === 'require') as RequireNode;
    const rhs = (req.expression as BinaryExprNode).right;
    expect(rhs.type).toBe('pattern_literal');
    expect(rhs.type === 'pattern_literal' && rhs.text).toBe('TIM[1-5,8,20]');
  });

  it('a bare identifier is still a channel reference', () => {
    const ast = parseConstraints(`port P:
  channel A
  channel B
  config "c":
    A = TIM*_CH1
    B = TIM*_CH2
    require instance(A) == instance(B)`).ast!;
    const port = ast.statements.find(s => s.type === 'port_decl') as PortDeclNode;
    const req = port.configs[0].body.find(b => b.type === 'require') as RequireNode;
    expect((req.expression as BinaryExprNode).right.type).toBe('function_call');
  });

  it('restricts the instance set — the stdlib encoder case', () => {
    const { count, instances } = instancesFor(`port E:
  channel A
  channel B
  config "e":
    encoder(A, B)`);
    expect(count).toBeGreaterThan(0);
    // G474 also has TIM15/16/17 with CH1/CH2 — the pattern must exclude them.
    expect(instances).toEqual(['TIM1', 'TIM2', 'TIM20', 'TIM3', 'TIM4', 'TIM5', 'TIM8']);
  });

  it('a range pattern narrows further', () => {
    const { instances } = instancesFor(`port E:
  channel A
  channel B
  config "e":
    A = TIM*_CH[1,2]
    B = TIM*_CH[1,2]
    require same_instance(A, B, "TIM")
    require instance(A, "TIM") == TIM[3-4]`);
    expect(instances).toEqual(['TIM3', 'TIM4']);
  });

  it('!= inverts the match', () => {
    const { instances } = instancesFor(`port E:
  channel A
  config "e":
    A = TIM*_CH1
    require instance(A, "TIM") != TIM[1-5,8,20]`);
    expect(instances.length).toBeGreaterThan(0);
    for (const i of instances) expect(['TIM1','TIM2','TIM3','TIM4','TIM5','TIM8','TIM20']).not.toContain(i);
  });

  it('a wildcard pattern works too', () => {
    const { count } = instancesFor(`port E:
  channel A
  config "e":
    A = TIM*_CH1
    require instance(A, "TIM") == TIM*`);
    expect(count).toBeGreaterThan(0);
  });

  it('an unsatisfiable pattern yields no solutions', () => {
    expect(instancesFor(`port E:
  channel A
  config "e":
    A = TIM*_CH1
    require instance(A, "TIM") == TIM[99]`).count).toBe(0);
  });
});
