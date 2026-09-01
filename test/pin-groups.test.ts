import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseConstraints } from '../src/parser/constraint-parser';
import { resolveTemplates } from '../src/parser/template-resolver';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { extractPorts } from '../src/solver/solver';
import { buildAnchors, filterByHardAnchors } from '../src/solver/pin-anchors';
import { getCostFunction, setActiveAnchors } from '../src/solver/cost-functions';
import type { PortDeclNode, ProgramNode } from '../src/parser/constraint-ast';
import type { Mcu, Solution } from '../src/types';

const mcu: Mcu = parseMcuXml(
  readFileSync(join(__dirname, 'g474/STM32G474R(B-C-E)Tx.xml'), 'utf-8'),
);

function parseOk(src: string): ProgramNode {
  const r = parseConstraints(src);
  expect(r.errors, r.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return resolveTemplates(r.ast!).ast;
}

const portOf = (src: string) =>
  parseOk(src).statements.find(s => s.type === 'port_decl') as PortDeclNode;

/** A one-config solution from (channel, pin) pairs. */
function solution(port: string, pins: Array<[string, string]>): Solution {
  return {
    configAssignments: [{
      configCombination: new Map([[port, 'c']]),
      assignments: pins.map(([channelName, pinName]) => ({
        pinName, signalName: 'x', portName: port, channelName, configurationName: 'c',
      })),
    }],
    cost: 0,
    costBreakdown: {},
  } as unknown as Solution;
}

describe('port groups', () => {
  describe('parsing', () => {
    it('tags every member channel with its group', () => {
      const port = portOf(`port PWR:
  group "rail_3v3":
    channel EN = OUT
    channel PGOOD = IN
  group "rail_1v8":
    channel EN2 = OUT`);
      expect(port.channels.map(c => [c.name, c.group])).toEqual([
        ['EN', 'rail_3v3'], ['PGOOD', 'rail_3v3'], ['EN2', 'rail_1v8'],
      ]);
      expect(port.groups?.map(g => g.name)).toEqual(['rail_3v3', 'rail_1v8']);
    });

    it('mixes grouped and ungrouped channels in one port', () => {
      const port = portOf(`port P:
  channel LOOSE = OUT
  group "g":
    channel A = OUT
  channel ALSO_LOOSE = OUT`);
      expect(port.channels.map(c => c.group)).toEqual([undefined, 'g', undefined]);
    });

    it('sends inline mappings from a group to the port config', () => {
      const port = portOf(`port P:
  group "g":
    channel TX = USART*_TX
    channel RX = USART*_RX
    require same_instance(TX, RX)`);
      expect(port.configs).toHaveLength(1);
      expect(port.configs[0].body.map(b => b.type))
        .toEqual(['mapping', 'mapping', 'require']);
    });

    it('accepts every @ form on the group header', () => {
      const port = portOf(`port P:
  group "soft": @ ~NW
    channel A = OUT
  group "hard": @ PA1, !PB1
    channel B = OUT`);
      const [soft, hard] = port.groups!;
      expect(soft.anchor).toEqual({ kind: 'near_region', target: 'NW' });
      expect(hard.anchorFixedPins).toEqual(['PA1']);
      expect(hard.anchorExcludedPins).toEqual(['PB1']);
    });

    it('takes channels declared by a macro expanded inside a group', () => {
      const port = portOf(`macro efused(NAME):
  channel \${NAME}_EN = OUT
  channel \${NAME}_PGOOD = IN

port PWR:
  group "rail": @ ~NW
    efused(VBUS)`);
      expect(port.channels.map(c => [c.name, c.group])).toEqual([
        ['VBUS_EN', 'rail'], ['VBUS_PGOOD', 'rail'],
      ]);
    });

    it('errors on a group without a body', () => {
      const r = parseConstraints(`port P:
  group "g":
  channel A = OUT`);
      expect(r.errors.map(e => e.message).join()).toContain('Expected indented block after group');
    });
  });

  describe('templates', () => {
    it('inherits groups from a template and overrides one by name', () => {
      const ast = parseOk(`port base:
  group "g1": @ ~NW
    channel A = OUT
  group "g2": @ ~SE
    channel B = OUT

port DERIVED from base:
  group "g2": @ ~NE
    channel C = OUT`);
      const derived = ast.statements.find(
        s => s.type === 'port_decl' && s.name === 'DERIVED',
      ) as PortDeclNode;
      expect(derived.groups?.map(g => g.name)).toEqual(['g1', 'g2']);
      expect(derived.groups?.find(g => g.name === 'g2')?.anchor)
        .toEqual({ kind: 'near_region', target: 'NE' });
    });
  });

  describe('exclusions', () => {
    it('bars a group-excluded pin from every member', () => {
      const ast = parseOk(`port P:
  channel FREE = OUT
  group "g": @ !PA1
    channel A = OUT
    channel B = OUT`);
      const port = extractPorts(ast).get('P')!;
      expect([...port.channels.get('A')!.excludedPins!]).toEqual(['PA1']);
      expect([...port.channels.get('B')!.excludedPins!]).toEqual(['PA1']);
      expect(port.channels.get('FREE')!.excludedPins).toBeUndefined();
    });

    it('unions a group exclusion with the channel\'s own', () => {
      const ast = parseOk(`port P:
  group "g": @ !PA1
    channel A @ !PB2 = OUT`);
      const port = extractPorts(ast).get('P')!;
      expect([...port.channels.get('A')!.excludedPins!].sort()).toEqual(['PA1', 'PB2']);
    });
  });

  describe('anchors', () => {
    it('applies a group anchor to each member and records membership', () => {
      const ast = parseOk(`port P:
  channel LOOSE = OUT
  group "g": @ ~NW
    channel A = OUT
    channel B = OUT`);
      const anchors = buildAnchors(ast, mcu);
      expect(anchors.byChannel.has('P\0A')).toBe(true);
      expect(anchors.byChannel.has('P\0B')).toBe(true);
      expect(anchors.byChannel.has('P\0LOOSE')).toBe(false);
      expect(anchors.groupOfChannel.get('P\0A')).toBe('g');
      expect(anchors.groupOfChannel.has('P\0LOOSE')).toBe(false);
    });

    it('drops solutions that miss a hard group pin', () => {
      const ast = parseOk(`port P:
  group "g": @ PA1
    channel A = OUT
    channel B = OUT`);
      const anchors = buildAnchors(ast, mcu);
      expect(anchors.hardGroupPins).toEqual([
        { portName: 'P', channels: ['A', 'B'], pins: ['PA1'] },
      ]);

      const hit = solution('P', [['A', 'PA1'], ['B', 'PA2']]);
      const miss = solution('P', [['A', 'PA3'], ['B', 'PA2']]);
      expect(filterByHardAnchors([hit, miss], anchors)).toEqual([hit]);
    });
  });

  describe('pin_group_clustering cost', () => {
    const cost = getCostFunction('pin_group_clustering')!;

    it('is registered', () => {
      expect(cost).toBeDefined();
    });

    it('costs nothing when no channel is grouped', () => {
      const ast = parseOk(`port P:
  channel A = OUT
  channel B = OUT`);
      setActiveAnchors(buildAnchors(ast, mcu));
      expect(cost.compute(solution('P', [['A', 'PA0'], ['B', 'PC13']]), mcu)).toBe(0);
    });

    it('prefers a tight group over a spread one', () => {
      const ast = parseOk(`port P:
  group "g":
    channel A = OUT
    channel B = OUT`);
      setActiveAnchors(buildAnchors(ast, mcu));
      const tight = cost.compute(solution('P', [['A', 'PA0'], ['B', 'PA1']]), mcu);
      const spread = cost.compute(solution('P', [['A', 'PA0'], ['B', 'PC13']]), mcu);
      expect(tight).toBeLessThan(spread);
    });

    it('scores each group separately rather than the whole port', () => {
      // Two tight groups far apart must cost less than one port-wide spread,
      // which is the distinction pin_clustering cannot make.
      const ast = parseOk(`port P:
  group "near":
    channel A = OUT
    channel B = OUT
  group "far":
    channel C = OUT
    channel D = OUT`);
      setActiveAnchors(buildAnchors(ast, mcu));
      const grouped = cost.compute(
        solution('P', [['A', 'PA0'], ['B', 'PA1'], ['C', 'PC13'], ['D', 'PC14']]), mcu,
      );
      const interleaved = cost.compute(
        solution('P', [['A', 'PA0'], ['B', 'PC13'], ['C', 'PA1'], ['D', 'PC14']]), mcu,
      );
      expect(grouped).toBeLessThan(interleaved);
      expect(getCostFunction('pin_clustering')!.compute(
        solution('P', [['A', 'PA0'], ['B', 'PA1'], ['C', 'PC13'], ['D', 'PC14']]), mcu,
      )).toBe(getCostFunction('pin_clustering')!.compute(
        solution('P', [['A', 'PA0'], ['B', 'PC13'], ['C', 'PA1'], ['D', 'PC14']]), mcu,
      ));
    });
  });
});
