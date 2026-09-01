import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { classifyProjectSolutions } from '../src/solver/solution-status';
import { serializeSolution, deserializeSolution } from '../src/storage';
import type { Solution } from '../src/types';

const dir = join(__dirname, 'g474');
const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));

const SRC = `port CMD:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)`;
const ast = parseConstraints(SRC, { macroLibrary: SRC }).ast!;

const solved = solveConstraints(ast, mcu, { maxSolutions: 3, timeoutMs: 5000, costWeights: new Map() }).solutions;
/** What the project list holds after a save/reload cycle. */
const restored = (): Solution[] =>
  solved.map(s => deserializeSolution(JSON.parse(JSON.stringify(serializeSolution(s)))));

describe('validity badges depend on the solution\'s own MCU', () => {
  it('a round-tripped solution still classifies', () => {
    const v = classifyProjectSolutions(restored(), ast, mcu, true);
    expect(v.size).toBe(solved.length);
    expect([...v.values()].every(v2 => v2.status === 'valid')).toBe(true);
  });

  it('no verdict at all when the loaded MCU is a different part', () => {
    // This is the missing-badge case: classifyProjectSolutions skips any
    // solution whose mcuRef differs, so a project whose MCU was never loaded
    // (or loaded as a different part) shows no badges on any row.
    const other = { ...mcu, refName: 'STM32F103C8Tx' } as typeof mcu;
    expect(classifyProjectSolutions(restored(), ast, other, true).size).toBe(0);
  });

  it('solutions carry the mcuRef needed to load the right part', () => {
    // The fix for "clicking a solution from another MCU does nothing" and for
    // the missing badges both rely on this field surviving the round trip.
    for (const s of restored()) expect(s.mcuRef).toBe(mcu.refName);
  });

  it('a version saved without an mcuRef can recover it from its solutions', () => {
    // buildCurrentVersion stores `currentMcu?.refName ?? ''`, so a project
    // saved while no MCU was loaded has an empty mcuRef; loadProjectVersion
    // falls back to the solutions' own ref.
    const version = { mcuRef: '', solutions: restored().map(serializeSolution) };
    const recovered = version.mcuRef || version.solutions.find(s => s.mcuRef)?.mcuRef;
    expect(recovered).toBe(mcu.refName);
  });

  it('the fallback yields nothing when there is genuinely no MCU anywhere', () => {
    const version = { mcuRef: '', solutions: [] as ReturnType<typeof serializeSolution>[] };
    expect(version.mcuRef || version.solutions.find(s => s.mcuRef)?.mcuRef).toBeFalsy();
  });
});
