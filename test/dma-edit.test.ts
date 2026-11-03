import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints, setFixedAssignments } from '../src/solver/solver';
import { SolutionEditor } from '../src/solver/solution-editor';
import { classifyProjectSolutions } from '../src/solver/solution-status';
import { serializeSolution, deserializeSolution } from '../src/storage';
import type { Solution } from '../src/types';

const dir = join(__dirname, 'f405v');
const mcu = parseMcuXml(readFileSync(join(dir, 'STM32F405VGTx.xml'), 'utf-8'));
mcu.dma = parseDmaXml(readFileSync(join(dir, 'DMA-STM32F417_dma_v2_0_Modes.xml'), 'utf-8'));
// F405: USART3_TX can use DMA1 stream 3 or 4 (→ move); I2C1_TX and TIM2_CH4
// both can use DMA1 stream 6 or 7 (→ swap).
const ast = parseConstraints(`
port SER:
  channel TX = USART3_TX
  require dma(TX)

port I2C:
  channel SDA = I2C1_SDA
  channel SCL = I2C1_SCL
  require dma(SDA, "I2C_TX")

port PWM:
  channel CH = TIM2_CH4
  require dma(CH)
`).ast!;

afterEach(() => setFixedAssignments(null));

const base = solveConstraints(ast, mcu, { maxSolutions: 1, timeoutMs: 5000, costWeights: new Map() }).solutions[0];
/** trigger → stream, merged over combos */
const dmaOf = (s: Solution) => new Map(s.configAssignments.flatMap(ca => [...(ca.dmaStreamAssignment ?? [])]));
const tx1 = 'USART3_TX';

describe('DMA edits in the solution editor', () => {

  it('moves a stream, keeps it through further edits, and undoes', () => {
    const ed = SolutionEditor.fromSolution(base, ast, mcu, new Map(), false)!;
    const before = dmaOf(ed.toSolution()).get(tx1)!;
    const move = ed.listDmaEdits('SER', 'USART3', before).find(c => c.label.startsWith(`Move DMA ${tx1}`));
    expect(move, 'a free stream to move to').toBeDefined();
    move!.apply();
    const after = dmaOf(ed.toSolution()).get(tx1)!;
    expect(after).not.toBe(before);
    ed.undo();
    expect(dmaOf(ed.toSolution()).get(tx1)).toBe(before);
  });

  it("swaps two requests' streams", () => {
    const ed = SolutionEditor.fromSolution(base, ast, mcu, new Map(), false)!;
    const d = dmaOf(ed.toSolution());
    const swap = ed.listDmaEdits('I2C', 'I2C1', d.get('I2C1_TX')!).find(c => c.label.includes('↔ PWM TIM2_CH4'));
    expect(swap, 'I2C1_TX ↔ TIM2_CH4').toBeDefined();
    swap!.apply();
    const e = dmaOf(ed.toSolution());
    expect(e.get('I2C1_TX')).toBe(d.get('TIM2_CH4'));
    expect(e.get('TIM2_CH4')).toBe(d.get('I2C1_TX'));
  });

  it('unassign leaves the request without a stream: invalid, kept through storage, fixed by solve from solution', () => {
    const ed = SolutionEditor.fromSolution(base, ast, mcu, new Map(), false)!;
    // Swap first, so the kept streams differ from what a free allocation picks.
    const free = dmaOf(ed.toSolution());
    ed.listDmaEdits('I2C', 'I2C1', free.get('I2C1_TX')!).find(c => c.label.includes('↔ PWM TIM2_CH4'))!.apply();
    const stream = dmaOf(ed.toSolution()).get(tx1)!;
    ed.listDmaEdits('SER', 'USART3', stream).find(c => c.label.startsWith('Unassign DMA'))!.apply();
    const edited = ed.toSolution();
    expect(edited.dmaUnassigned).toEqual([tx1]);
    expect(dmaOf(edited).has(tx1)).toBe(false);
    expect(classifyProjectSolutions([edited], ast, mcu, true).get(edited)?.reasons)
      .toContainEqual(`DMA request ${tx1} has no stream`);

    const reloaded = deserializeSolution(JSON.parse(JSON.stringify(serializeSolution(edited))));
    expect(reloaded.dmaUnassigned).toEqual([tx1]);
    expect(dmaOf(reloaded)).toEqual(dmaOf(edited));

    // Solve from it: pins + the other streams stay, the cleared request gets one again.
    setFixedAssignments(edited.configAssignments.flatMap(ca => ca.assignments), dmaOf(edited));
    const r = solveConstraints(ast, mcu, { maxSolutions: 3, timeoutMs: 5000, costWeights: new Map() });
    expect(r.solutions.length).toBeGreaterThan(0);
    for (const s of r.solutions) {
      const d = dmaOf(s);
      expect(d.get(tx1)).toBeDefined();
      expect(d.get('I2C1_TX')).toBe(free.get('TIM2_CH4'));   // still swapped
      expect(d.get('TIM2_CH4')).toBe(free.get('I2C1_TX'));
    }
  });
});

it('storage keeps DMA streams', () => {
  const reloaded = deserializeSolution(JSON.parse(JSON.stringify(serializeSolution(base))));
  expect(dmaOf(reloaded)).toEqual(dmaOf(base));
  expect(dmaOf(base).size).toBeGreaterThan(0);
});
