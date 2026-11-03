import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { runSingleSolver } from '../src/solver/solver-worker-impl';
import { isInternalPin } from '../src/solver/pattern-matcher';
import type { PortDeclNode } from '../src/parser/constraint-ast';
import type { Solution } from '../src/types';

// F405: TIM6/TIM7 have no pins; their update requests TIM6_UP / TIM7_UP exist
// only in the DMA data. TIM1 has both TIM1_UP and TIM1_CH1 requests.
const dir = join(__dirname, 'f405v');
const mcu = parseMcuXml(readFileSync(join(dir, 'STM32F405VGTx.xml'), 'utf-8'));
mcu.dma = parseDmaXml(readFileSync(join(dir, 'DMA-STM32F417_dma_v2_0_Modes.xml'), 'utf-8'));

const LOG = `
port LOG:
  channel TX = USART1_TX
  internal TRG = TIM[6,7]_UP
  internal UPD = TIM1_UP
  internal CC = TIM1_CH1
  require dma(TX, "USART_TX")
  require dma(TRG)
  require dma(UPD)
  require dma(CC)
`;
const solve = (src: string) =>
  solveConstraints(parseConstraints(src).ast!, mcu, { maxSolutions: 5, timeoutMs: 3000, costWeights: new Map([['pin_count', 1]]) });
const flat = (s: Solution) => s.configAssignments.flatMap(ca => ca.assignments);
const on = (s: Solution, ch: string) => flat(s).find(a => a.channelName === ch);

describe('internal channels', () => {
  it('parse: no @, ranges allowed', () => {
    const port = parseConstraints('port P:\n  internal T{0-1} = TIM{6-7}_UP\n').ast!.statements[0] as PortDeclNode;
    expect(port.channels.map(c => [c.name, c.internal])).toEqual([['T0', true], ['T1', true]]);
    expect(parseConstraints('port P:\n  internal T @ PA1 = TIM6_UP\n').errors[0].message).toMatch(/has no pin/);
  });

  it('claim a signal and its instance (incl. pinless TIM6/7), get DMA streams, use no pins', () => {
    const r = solve(LOG);
    expect(r.solutions.length, r.errors.map(e => e.message).join('; ')).toBeGreaterThan(0);
    for (const s of r.solutions) {
      expect(['TIM6_UP', 'TIM7_UP']).toContain(on(s, 'TRG')!.signalName);
      // two internal channels share TIM1 through different signals
      expect(on(s, 'UPD')!.signalName).toBe('TIM1_UP');
      expect(on(s, 'CC')!.signalName).toBe('TIM1_CH1');
      for (const ch of ['TRG', 'UPD', 'CC']) expect(isInternalPin(on(s, ch)!.pinName)).toBe(true);
      expect(s.costs.get('pin_count')).toBe(1);                  // only USART1_TX has a pin
      const dma = s.configAssignments[0].dmaStreamAssignment!;
      for (const ch of ['TRG', 'UPD', 'CC']) expect(dma.get(on(s, ch)!.signalName)).toBeDefined();
    }
  });

  it('respect reserve: and instance exclusivity across ports', () => {
    const reserved = solve(`reserve: TIM6\n${LOG}`);
    expect(reserved.solutions.every(s => on(s, 'TRG')!.signalName === 'TIM7_UP')).toBe(true);

    // OTHER takes TIM7 for itself, so LOG's TRG must use TIM6
    const both = solve(`${LOG}\nport OTHER:\n  internal T = TIM7_UP\n  require dma(T)\n`);
    expect(both.solutions.length).toBeGreaterThan(0);
    for (const s of both.solutions) {
      expect(flat(s).find(a => a.portName === 'LOG' && a.channelName === 'TRG')!.signalName).toBe('TIM6_UP');
    }
    // one signal, one port — even when shared
    expect(solve(`shared: TIM6\nport A:\n  internal T = TIM6_UP\nport B:\n  internal T = TIM6_UP\n`).solutions).toEqual([]);
  });

  it.each([
    'backtracking', 'cost-guided', 'ac3', 'dynamic-mrv', 'priority-backtracking', 'randomized-restarts',
    'two-phase', 'diverse-instances', 'priority-two-phase', 'priority-diverse',
    'priority-group', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'conflict-directed', 'cegar', 'lns-repair', 'adaptive',
  ])('%s solves them', (id) => {
    const r = runSingleSolver(id, parseConstraints(LOG).ast!, mcu,
      { maxSolutions: 3, timeoutMs: 2000, costWeights: new Map() },
      { maxGroups: 20, maxSolutionsPerGroup: 3 }, { numRestarts: 3 }, 'easy');
    expect(r.solutions.length, r.errors.map(e => e.message).join('; ')).toBeGreaterThan(0);
    for (const s of r.solutions) expect(['TIM6_UP', 'TIM7_UP']).toContain(on(s, 'TRG')!.signalName);
  });
});
