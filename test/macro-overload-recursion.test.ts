import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import { expandAllMacros } from '../src/parser/macro-expander';
import { getStdlibMacros, getStdlibTemplates } from '../src/parser/stdlib-macros';
import type { PortDeclNode, MappingNode, ConfigBodyNode } from '../src/parser/constraint-ast';

const expand = (src: string) =>
  expandAllMacros(parseConstraints(src).ast!, getStdlibMacros(), getStdlibTemplates());
const bodyOf = (r: ReturnType<typeof expand>): ConfigBodyNode[] =>
  (r.ast.statements.find(s => s.type === 'port_decl') as PortDeclNode).configs[0].body;
const mapped = (b: ConfigBodyNode[]) =>
  b.filter((i): i is MappingNode => i.type === 'mapping').map(m => m.channelName);

describe('macro overloads are not recursion', () => {
  it('stdlib encoder(A,B,Z) may call encoder(A,B)', () => {
    // Regression: the recursion guard was keyed by bare name while lookup was
    // keyed by name/arity, so the inner 2-arg call was dropped and A/B never
    // got mapped.
    const r = expand(`port ENC:
  channel A
  channel B
  channel Z
  config "e":
    encoder(A, B, Z)`);
    expect(r.errors).toEqual([]);
    expect(mapped(bodyOf(r))).toEqual(['A', 'B', 'Z']);
    expect(bodyOf(r).filter(i => i.type === 'require')).toHaveLength(3);
  });

  it('still catches real self-recursion', () => {
    const r = expand(`macro loop(X):
  loop(X)

port P:
  channel A
  config "c":
    loop(A)`);
    expect(r.errors.map(e => e.message).join()).toMatch(/Recursive macro call/);
  });

  it('still catches mutual recursion between overloads', () => {
    const r = expand(`macro ping(X):
  pong(X, X)

macro pong(X, Y):
  ping(X)

port P:
  channel A
  config "c":
    ping(A)`);
    expect(r.errors.map(e => e.message).join()).toMatch(/Recursive macro call/);
  });

  it('names the arity in the error', () => {
    const r = expand(`macro loop(X):
  loop(X)

port P:
  channel A
  config "c":
    loop(A)`);
    expect(r.errors[0].message).toContain('(1 args)');
  });
});
