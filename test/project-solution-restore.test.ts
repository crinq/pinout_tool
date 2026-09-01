import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext =
    () => new Proxy({}, { get: () => () => ({ width: 0, data: [0, 0, 0, 0] }) });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} };
});

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { ProjectSolutions } from '../src/ui/project-solutions';
import { ConstraintEditor } from '../src/ui/constraint-editor';
import type { Solution, Assignment } from '../src/types';

const dir = join(__dirname, 'g474');
const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));

const solution = (id: number, pin: string): Solution => ({
  id,
  mcuRef: mcu.refName,
  configAssignments: [{
    configurationName: 'CMD',
    assignments: [{
      portName: 'CMD', channelName: 'TX', pinName: pin,
      signalName: 'USART1_TX', configurationName: 'CMD',
    } as Assignment],
  }],
  portPeripherals: new Map<string, Set<string>>([['CMD', new Set(['USART1'])]]),
  costs: new Map<string, number>(),
  totalCost: 0,
  gpioCount: 0,
  optionalTotal: 0,
  optionalFulfilled: 0,
} as unknown as Solution);

function mount() {
  const p = new ProjectSolutions();
  const host = document.createElement('div');
  document.body.appendChild(host);
  p.createView(host);
  return p;
}

describe('restoring a project\'s stored solutions', () => {
  it('selects nothing', () => {
    // Regression: setSolutions auto-selected row 0 on project load, so a
    // reloaded project showed a highlighted row while the viewer stayed empty
    // (the MCU is still loading when the broadcast goes out).
    const p = mount();
    p.setSolutions([solution(1, 'PA9'), solution(2, 'PB6')]);
    expect(p.getSelectedSolutions()).toEqual([]);
  });

  it('does not announce a selection', () => {
    const p = mount();
    const picked: Solution[] = [];
    p.onSolutionSelected(s => picked.push(s));
    p.setSolutions([solution(1, 'PA9')]);
    expect(picked).toEqual([]);
  });

  it('still lists them', () => {
    const p = mount();
    p.setSolutions([solution(1, 'PA9'), solution(2, 'PB6')]);
    expect(p.getSolutions().map(s => s.id)).toEqual([1, 2]);
  });

  it('replaces a previous project\'s selection rather than keeping it', () => {
    const p = mount();
    p.setSolutions([solution(1, 'PA9')]);
    p.addSolution(solution(9, 'PB6'));          // user picks one -> selected
    expect(p.getSelectedSolutions().length).toBe(1);
    p.setSolutions([solution(3, 'PC10')]);      // open another project
    expect(p.getSelectedSolutions()).toEqual([]);
  });

  it('a solution the user adds is still selected', () => {
    const p = mount();
    const picked: Solution[] = [];
    p.onSolutionSelected(s => picked.push(s));
    p.addSolution(solution(1, 'PA9'));
    expect(picked.length).toBe(1);
    expect(p.getSelectedSolutions().length).toBe(1);
  });
});

describe('clearing a solution releases the caret highlight', () => {
  vi.useFakeTimers();
  const SRC = 'port CMD:\n  channel TX = USART*_TX';
  const assigned: Assignment[] = [{
    portName: 'CMD', channelName: 'TX', pinName: 'PA9',
    signalName: 'USART1_TX', configurationName: 'CMD',
  } as Assignment];

  /** An editor with the source loaded and a listener already attached. */
  function makeEditor() {
    const editor = new ConstraintEditor();
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.createView(host);
    let last = new Set<string>();
    // Attached before any state change: the editor moves the caret itself when
    // a solution arrives, and refreshCaretHighlight() no-ops on a repeat line.
    editor.onHighlightPins(pins => { last = pins; });
    editor.onStateChange({ type: 'mcu-loaded', mcu } as unknown as Record<string, unknown>);
    editor.setText(SRC);
    vi.runAllTimers();
    const priv = editor as unknown as { caretLine: number; setCursorToLine(l: number): void };
    return {
      editor,
      /** Park the caret on the mapping line and return what gets broadcast. */
      ring(): Set<string> {
        priv.caretLine = -1;
        priv.setCursorToLine(2);
        return last;
      },
      select(assignments: Assignment[]) {
        editor.onStateChange({
          type: 'solution-selected', assignments, portColors: new Map(),
        } as unknown as Record<string, unknown>);
      },
    };
  }

  it('rings the assigned pin while a solution is selected', () => {
    const e = makeEditor();
    e.select(assigned);
    expect([...e.ring()]).toEqual(['PA9']);
  });

  it('goes back to the pattern candidates once the solution is cleared', () => {
    const e = makeEditor();
    const unsolved = [...e.ring()];
    expect(unsolved.length).toBeGreaterThan(1);

    e.select(assigned);
    expect([...e.ring()]).toEqual(['PA9']);

    // This is what opening another project broadcasts.
    e.select([]);
    expect([...e.ring()]).toEqual(unsolved);
  });
});
