import { describe, it, expect, vi } from 'vitest';

// jsdom has no canvas, and constraint-minimap takes a 2d context at module load.
vi.hoisted(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext =
    () => new Proxy({}, { get: () => () => ({ width: 0, data: [0, 0, 0, 0] }) });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} };
});

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { ConstraintEditor } from '../src/ui/constraint-editor';

const dir = join(__dirname, 'g474');
const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));

vi.useFakeTimers();

const SRC = `port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX

port SPI1:
  channel SCK = SPI*_SCK
`;

/** Pins the editor broadcasts with the caret parked on `line` (1-based). */
function ringedAt(line: number, src = SRC): Set<string> {
  const editor = new ConstraintEditor();
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.createView(host);
  editor.onStateChange({ type: 'mcu-loaded', mcu } as unknown as Record<string, unknown>);
  editor.setText(src);
  // setText only schedules the parse; the minimap needs the AST to resolve a line.
  vi.runAllTimers();

  let last = new Set<string>();
  editor.onHighlightPins((pins) => { last = pins; });
  (editor as unknown as { setCursorToLine(l: number): void }).setCursorToLine(line);
  return last;
}
const lineOf = (needle: string, src = SRC) =>
  src.split('\n').findIndex(l => l.includes(needle)) + 1;

describe('caret on a blank line', () => {
  it('a channel line still rings its pins', () => {
    expect(ringedAt(lineOf('channel TX')).size).toBeGreaterThan(0);
  });

  it('the blank line between two ports rings nothing', () => {
    const blank = lineOf('channel RX') + 1;
    expect(SRC.split('\n')[blank - 1].trim()).toBe('');
    expect(ringedAt(blank).size).toBe(0);
  });

  it('does not fall back to the port above it', () => {
    const blank = lineOf('channel RX') + 1;
    expect(ringedAt(blank).size).toBeLessThan(ringedAt(lineOf('port CMD:')).size);
  });

  it('a blank line inside a port body rings nothing', () => {
    const src = `port CMD:
  channel TX = USART*_TX

  channel RX = USART*_RX`;
    expect(ringedAt(3, src).size).toBe(0);
    expect(ringedAt(2, src).size).toBeGreaterThan(0);
  });

  it('a whitespace-only line counts as blank', () => {
    const src = 'port CMD:\n  channel TX = USART*_TX\n   \n';
    expect(ringedAt(3, src).size).toBe(0);
  });

  it('the trailing blank line after the last port rings nothing', () => {
    expect(ringedAt(SRC.split('\n').length).size).toBe(0);
  });

  it('moving back onto a real line restores the ring', () => {
    const blank = lineOf('channel RX') + 1;
    expect(ringedAt(blank).size).toBe(0);
    expect(ringedAt(lineOf('channel SCK')).size).toBeGreaterThan(0);
  });
});
