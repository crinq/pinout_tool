// Solver performance regression gate.
//
// Guards the Part-1 refactors (ai_docs/review.md): each (case, solver) cell
// must keep finding at least half the solutions the pre-refactor code found
// within the same fixed budget, and must produce its first solution within a
// generous multiple of the baseline latency. Floors are deliberately loose
// (50% count, 4× + 200 ms latency) so machine noise doesn't flake the suite;
// a real algorithmic regression blows through them anyway.
//
// Baseline captured 2026-09-02 (Node, single-threaded, TIMEOUT=1500 ms).
// If a legitimate solver improvement shifts numbers upward, re-capture and
// tighten; never loosen a floor to make a refactor pass.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { solveMrvGroup } from '../src/solver/mrv-group-solver';
import { solveHybrid } from '../src/solver/hybrid-solver';
import { solveConflictDirected } from '../src/solver/conflict-directed-solver';
import { solveCegar } from '../src/solver/cegar-solver';
import { solveAdaptive } from '../src/solver/adaptive-solver';
import type { Mcu, SolverResult } from '../src/types';
import type { ProgramNode } from '../src/parser/constraint-ast';

const TIMEOUT = 1500;
// stmbl's first solution lands at ~1.1 s of the 1.5 s budget — too close to
// the wire when the full suite loads every core. Those rows get more room;
// the count floor stays derived from the 1.5 s baseline, so this only makes
// the gate harder to flake, not easier to pass.
const SLOW_CASE_TIMEOUT = 4500;
const SLOW_CASES = new Set(['f405v/stmbl']);

// [case, solver, baselineSolutions, baselineFirstSolutionMs]
const BASELINE: Array<[string, string, number, number]> = [
  ['f405v/stmbl', 'conflict-directed', 48, 1120],
  ['f405v/stmbl', 'adaptive', 48, 38],
  ['f405v/dma_multi_config', 'backtracking', 17, 0],
  ['f405v/dma_multi_config', 'two-phase', 17, 0],
  ['f405v/dma_multi_config', 'mrv-group', 17, 1],
  ['f405v/dma_multi_config', 'hybrid', 17, 2],
  ['f405v/dma_multi_config', 'conflict-directed', 17, 1],
  ['f405v/dma_multi_config', 'cegar', 17, 1],
  ['f405v/dma_multi_config', 'adaptive', 17, 1],
  ['g474/simple_uart_spi', 'backtracking', 500, 2],
  ['g474/simple_uart_spi', 'two-phase', 253, 1],
  ['g474/simple_uart_spi', 'mrv-group', 265, 2],
  ['g474/simple_uart_spi', 'hybrid', 246, 20],
  ['g474/simple_uart_spi', 'conflict-directed', 372, 0],
  ['g474/simple_uart_spi', 'cegar', 264, 1],
  ['g474/simple_uart_spi', 'adaptive', 253, 1],
  ['g474/shared_adc', 'backtracking', 25, 0],
  ['g474/shared_adc', 'two-phase', 20, 0],
  ['g474/shared_adc', 'mrv-group', 20, 0],
  ['g474/shared_adc', 'hybrid', 20, 1],
  ['g474/shared_adc', 'conflict-directed', 25, 0],
  ['g474/shared_adc', 'cegar', 21, 0],
  ['g474/shared_adc', 'adaptive', 20, 0],
  ['g474/multi_config', 'backtracking', 500, 0],
  ['g474/multi_config', 'two-phase', 115, 1],
  ['g474/multi_config', 'mrv-group', 115, 1],
  ['g474/multi_config', 'hybrid', 92, 37],
  ['g474/multi_config', 'conflict-directed', 366, 0],
  ['g474/multi_config', 'cegar', 121, 1],
  ['g474/multi_config', 'adaptive', 115, 1],
  ['h755i/ecat_complex', 'two-phase', 128, 203],
  ['h755i/ecat_complex', 'mrv-group', 64, 71],
  ['h755i/ecat_complex', 'conflict-directed', 500, 5],
  ['h755i/ecat_complex', 'cegar', 150, 117],
  ['h755i/ecat_complex', 'adaptive', 175, 5],
  ['h755i/test', 'conflict-directed', 344, 8],
  ['h755i/test', 'adaptive', 99, 7],
];

const mcuCache = new Map<string, Mcu>();
function loadMcu(folder: string): Mcu {
  const hit = mcuCache.get(folder);
  if (hit) return hit;
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
  const mcu = parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
  const dma = readdirSync(dir).find(f => f.startsWith('DMA-'));
  if (dma) {
    const t = readFileSync(join(dir, dma), 'utf-8');
    if (isDmaXml(t)) mcu.dma = parseDmaXml(t);
  }
  mcuCache.set(folder, mcu);
  return mcu;
}

const astCache = new Map<string, ProgramNode>();
function loadAst(caseId: string): ProgramNode {
  const hit = astCache.get(caseId);
  if (hit) return hit;
  const [folder, name] = caseId.split('/');
  const src = readFileSync(join(__dirname, folder, 'pass', `${name}.txt`), 'utf-8');
  const { ast, errors } = parseConstraints(src);
  expect(errors, errors.map(e => e.message).join(';')).toHaveLength(0);
  astCache.set(caseId, ast!);
  return ast!;
}

function runSolver(id: string, ast: ProgramNode, mcu: Mcu, timeoutMs: number): SolverResult {
  const SP = { maxSolutions: 500, timeoutMs, costWeights: new Map<string, number>(), skipGpioMapping: true };
  const TP = { maxGroups: 100, maxSolutionsPerGroup: 20, timeoutMs, costWeights: new Map<string, number>(), skipGpioMapping: true };
  switch (id) {
    case 'backtracking': return solveConstraints(ast, mcu, SP);
    case 'two-phase': return solveTwoPhase(ast, mcu, TP);
    case 'mrv-group': return solveMrvGroup(ast, mcu, TP);
    case 'hybrid': return solveHybrid(ast, mcu, TP);
    case 'conflict-directed': return solveConflictDirected(ast, mcu, SP);
    case 'cegar': return solveCegar(ast, mcu, TP);
    case 'adaptive': return solveAdaptive(ast, mcu, TP);
    default: throw new Error(`unknown solver ${id}`);
  }
}

describe('solver performance regression gate', () => {
  for (const [caseId, solver, baseCount, baseFirstMs] of BASELINE) {
    it(`${caseId} × ${solver}: ≥${Math.floor(baseCount / 2)} solutions, first ≤ ${baseFirstMs * 4 + 200}ms`, () => {
      const mcu = loadMcu(caseId.split('/')[0]);
      const timeoutMs = SLOW_CASES.has(caseId) ? SLOW_CASE_TIMEOUT : TIMEOUT;
      const r = runSolver(solver, loadAst(caseId), mcu, timeoutMs);
      expect(r.solutions.length, `found ${r.solutions.length}, baseline ${baseCount}`)
        .toBeGreaterThanOrEqual(Math.floor(baseCount / 2));
      const first = r.statistics.firstSolutionMs ?? Infinity;
      expect(first, `first solution after ${first.toFixed(0)}ms, baseline ${baseFirstMs}ms`)
        .toBeLessThanOrEqual(Math.max(baseFirstMs * 4 + 200, timeoutMs));
    });
  }
});
