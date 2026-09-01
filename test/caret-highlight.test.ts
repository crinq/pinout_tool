import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseConstraints } from '../src/parser/constraint-parser';
import { resolveTemplates } from '../src/parser/template-resolver';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { buildPortColorMap } from '../src/ui/port-colors';
import type { Assignment, Mcu } from '../src/types';

// jsdom has no canvas 2D context and the minimap paints on construction and on
// every update. Stub just the calls it makes — pinsForLine is pure logic over
// the block model, so nothing under test depends on real rendering.
const canvasProto = globalThis.HTMLCanvasElement.prototype as unknown as {
  getContext: (id: string) => unknown;
};
canvasProto.getContext = () => ({
  clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {}, scale() {},
  beginPath() {}, arc() {}, stroke() {}, fill() {}, save() {}, restore() {},
  translate() {}, rotate() {},
  measureText: () => ({ width: 0 }),
  getImageData: () => ({ data: [0, 0, 0, 255] }),
  font: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
  shadowColor: '', shadowBlur: 0, globalAlpha: 1,
});

// Imported after the stub: the module grabs a 2D context at load time for its
// colour parsing, so a static import would run before the stub is in place.
const { ConstraintMinimap } = await import('../src/ui/constraint-minimap');
type ConstraintMinimap = InstanceType<typeof ConstraintMinimap>;

const mcu: Mcu = parseMcuXml(
  readFileSync(join(__dirname, 'g474/STM32G474R(B-C-E)Tx.xml'), 'utf-8'),
);

/** A minimap primed with a program, as the editor does on every reparse. */
function minimapFor(src: string, assignments: Assignment[] | null = null): ConstraintMinimap {
  const parsed = parseConstraints(src);
  expect(parsed.errors, parsed.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  const ast = resolveTemplates(parsed.ast!).ast;
  const m = new ConstraintMinimap();
  m.setMcu(mcu);
  m.setAssignments(assignments);
  m.update(ast, src.split('\n').length);
  return m;
}

const assign = (portName: string, channelName: string, pinName: string): Assignment => ({
  pinName, signalName: 'GPIO', portName, channelName, configurationName: 'c',
});

//        1  2                3                 4                     5
const SRC = `port PWR:
  group "rail_3v3": @ ~NW
    channel EN = OUT
    channel PGOOD = IN
  channel LOOSE = OUT

port CMD:
  channel TX
  channel RX
  config "uart":
    TX = USART*_TX
    RX = USART*_RX

mcu: STM32G4*
`;

describe('caret pin highlight', () => {
  describe('scope resolution', () => {
    const m = minimapFor(SRC);

    it('resolves a port header to the whole port', () => {
      const hit = m.pinsForLine(1)!;
      expect(hit.scope).toBe('port');
      expect(hit.label).toBe('PWR');
    });

    it('resolves a group header to that group', () => {
      const hit = m.pinsForLine(2)!;
      expect(hit.scope).toBe('group');
      expect(hit.label).toBe('rail_3v3');
    });

    it('resolves a channel line to that one channel', () => {
      const hit = m.pinsForLine(3)!;
      expect(hit.scope).toBe('channel');
      expect(hit.label).toBe('EN');
    });

    it('resolves a mapping line inside a config to its channel', () => {
      const hit = m.pinsForLine(11)!;
      expect(hit.scope).toBe('channel');
      expect(hit.label).toBe('TX');
    });

    it('resolves a config header to that config', () => {
      const hit = m.pinsForLine(10)!;
      expect(hit.scope).toBe('config');
      expect(hit.label).toBe('uart');
    });

    it('returns null outside every port', () => {
      expect(m.pinsForLine(14)).toBeNull();
    });

    it('carries the port colour the right pane draws', () => {
      const colors = buildPortColorMap(resolveTemplates(parseConstraints(SRC).ast!).ast);
      expect(m.pinsForLine(1)!.color).toBe(colors.get('PWR'));
      expect(m.pinsForLine(8)!.color).toBe(colors.get('CMD'));
    });
  });

  describe('pin sets', () => {
    it('narrows from a port to a group to a channel', () => {
      const m = minimapFor(`port P:
  group "g":
    channel TX = USART*_TX
    channel RX = USART*_RX
  channel SCK = SPI*_SCK`);
      const port = m.pinsForLine(1)!.pins;
      const group = m.pinsForLine(2)!.pins;
      const channel = m.pinsForLine(3)!.pins;

      expect(channel.size).toBeGreaterThan(0);
      expect(group.size).toBeGreaterThan(channel.size);
      expect(port.size).toBeGreaterThan(group.size);
      for (const p of channel) expect(group.has(p)).toBe(true);
      for (const p of group) expect(port.has(p)).toBe(true);
    });

    it('honours a group-level pin exclusion', () => {
      const m = minimapFor(`port P:
  group "g": @ !PA0
    channel A = OUT`);
      expect(m.pinsForLine(3)!.pins.has('PA0')).toBe(false);
    });

    it('prefers the assigned pins once a solution is loaded', () => {
      const m = minimapFor(SRC, [
        assign('PWR', 'EN', 'PA5'),
        assign('PWR', 'PGOOD', 'PA6'),
        assign('CMD', 'TX', 'PA9'),
      ]);
      expect([...m.pinsForLine(1)!.pins].sort()).toEqual(['PA5', 'PA6']);
      expect([...m.pinsForLine(3)!.pins]).toEqual(['PA5']);
    });

    it('highlights nothing for a channel the solution never placed', () => {
      // Pure-GPIO channels are commonly skipped by the solver. Falling back to
      // candidates would ring every GPIO on the package — a wash that hides the
      // pins actually placed — so a loaded solution is taken at its word.
      const m = minimapFor(SRC, [assign('PWR', 'EN', 'PA5')]);
      const loose = m.pinsForLine(5)!;
      expect(loose.label).toBe('LOOSE');
      expect(loose.pins.size).toBe(0);
    });

    it('stays quiet for an unconstrained channel with no solution loaded', () => {
      // `= OUT` matches nearly the whole package; ringing all of it says only
      // "unconstrained", so nothing is highlighted.
      const m = minimapFor(`port P:
  channel ANY = OUT`);
      expect(m.pinsForLine(2)!.pins.size).toBe(0);
    });

    it('still shows candidates for a channel that is actually constrained', () => {
      const m = minimapFor(`port P:
  channel TX = USART*_TX`);
      const pins = m.pinsForLine(2)!.pins;
      expect(pins.size).toBeGreaterThan(0);
      expect(pins.size).toBeLessThan(20);
    });
  });

  describe('macro-declared channels', () => {
    it('resolves a channel a macro declared inside a group', () => {
      const src = `macro efused(NAME):
  channel \${NAME}_EN = OUT
  channel \${NAME}_PGOOD = IN

port PWR:
  group "rail": @ ~NW
    efused(VBUS)
`;
      const m = minimapFor(src);
      // Every expanded line reports the call site, line 7.
      const hit = m.pinsForLine(7)!;
      expect(hit.scope).toBe('channel');
      expect(hit.label).toBe('VBUS_EN');
      // The group header still resolves to the group, covering both channels.
      const group = m.pinsForLine(6)!;
      expect(group.scope).toBe('group');
      expect(group.label).toBe('rail');
    });
  });
});
