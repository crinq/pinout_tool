import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml } from '../src/parser/dma-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConflictDirected } from '../src/solver/conflict-directed-solver';
import { solveCegar } from '../src/solver/cegar-solver';
import { solveLnsRepair } from '../src/solver/lns-solver';
import { solveAdaptive } from '../src/solver/adaptive-solver';
import type { Mcu, Solution, SolverResult } from '../src/types';

// ============================================================
// Shared fixtures / validation helpers
// ============================================================

const TEST_DIR = __dirname;

function loadMcu(folder: string): Mcu {
  const folderPath = join(TEST_DIR, folder);
  const xmlFiles = readdirSync(folderPath).filter(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'));
  const mcu = parseMcuXml(readFileSync(join(folderPath, xmlFiles[0]), 'utf-8'));
  const dmaFiles = readdirSync(folderPath).filter(f => f.startsWith('DMA-') && f.endsWith('.xml'));
  if (dmaFiles.length > 0) {
    const dmaContent = readFileSync(join(folderPath, dmaFiles[0]), 'utf-8');
    if (isDmaXml(dmaContent)) mcu.dma = parseDmaXml(dmaContent);
  }
  return mcu;
}

function loadCase(folder: string, name: string) {
  const mcu = loadMcu(folder);
  const text = readFileSync(join(TEST_DIR, folder, 'pass', `${name}.txt`), 'utf-8');
  const { ast, errors } = parseConstraints(text);
  expect(errors.filter(e => e.type === 'error')).toEqual([]);
  return { mcu, ast: ast! };
}

/** Structural invariants every solution must satisfy (mirrors solver.test.ts checks). */
function validateSolutions(result: SolverResult): void {
  for (const sol of result.solutions.slice(0, 50)) {
    for (const ca of sol.configAssignments) {
      const pinOwner = new Map<string, string>();
      const portConfigPins = new Set<string>();
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        // Cross-port pin exclusivity within an active combo
        const owner = pinOwner.get(a.pinName);
        expect(owner === undefined || owner === a.portName,
          `pin ${a.pinName} shared across ports ${owner} and ${a.portName}`).toBe(true);
        pinOwner.set(a.pinName, a.portName);
        // Within (port, config): pin used once
        const key = `${a.portName}\0${a.configurationName}\0${a.pinName}`;
        expect(portConfigPins.has(key), `pin ${a.pinName} reused within ${a.portName}/${a.configurationName}`).toBe(false);
        portConfigPins.add(key);
      }
    }
  }
}

const COST_WEIGHTS = new Map<string, number>([
  ['pin_count', 1], ['port_spread', 0.2], ['peripheral_count', 0.5],
  ['debug_pin_penalty', 0], ['pin_clustering', 0], ['pin_proximity', 1],
]);

// ============================================================
// Conflict-Directed Solver (CDS)
// ============================================================

describe('conflict-directed solver', () => {
  it('solves a simple problem (g474/simple_uart_spi)', () => {
    const { mcu, ast } = loadCase('g474', 'simple_uart_spi');
    const result = solveConflictDirected(ast, mcu, {
      maxSolutions: 200, timeoutMs: 5000, costWeights: COST_WEIGHTS,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves a DMA-constrained problem (f405v/dma_uart)', () => {
    const { mcu, ast } = loadCase('f405v', 'dma_uart');
    const result = solveConflictDirected(ast, mcu, {
      maxSolutions: 100, timeoutMs: 5000, costWeights: COST_WEIGHTS,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves the hard case (h755i/ecat_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_complex');
    const result = solveConflictDirected(ast, mcu, {
      maxSolutions: 100, timeoutMs: 10000, costWeights: COST_WEIGHTS, skipGpioMapping: true,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  }, 15000);

  it('matches backtracking solution validity on multi-config (g474/multi_config)', () => {
    const { mcu, ast } = loadCase('g474', 'multi_config');
    const result = solveConflictDirected(ast, mcu, {
      maxSolutions: 100, timeoutMs: 5000, costWeights: COST_WEIGHTS,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves the very hard case (h755i/ecat_more_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_more_complex');
    const result = solveConflictDirected(ast, mcu, {
      maxSolutions: 50, timeoutMs: 10000, costWeights: COST_WEIGHTS, skipGpioMapping: true,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  }, 15000);
});

// ============================================================
// CEGAR Instance-Refinement Solver (CIR)
// ============================================================

describe('cegar solver', () => {
  const TP = (timeoutMs: number) => ({
    maxGroups: 100, maxSolutionsPerGroup: 10, timeoutMs, costWeights: COST_WEIGHTS,
  });

  it('solves a simple problem (g474/simple_uart_spi)', () => {
    const { mcu, ast } = loadCase('g474', 'simple_uart_spi');
    const result = solveCegar(ast, mcu, TP(5000));
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves a DMA-constrained problem (f405v/dma_multi_port)', () => {
    const { mcu, ast } = loadCase('f405v', 'dma_multi_port');
    const result = solveCegar(ast, mcu, TP(5000));
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  // Budget stays generous on purpose. These assert `> 0` with no inconclusive
  // escape, and the solve is CPU-bound: cut to 2s it still returns ~1200
  // solutions when run alone, but starves to 0 under full-suite parallelism.
  it('solves the hard case with structural diversity (h755i/ecat_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_complex');
    const result = solveCegar(ast, mcu, { ...TP(10000), skipGpioMapping: true });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  }, 30000);   // 10s solve + validating ~1300 solutions; needs slack under load

  it('solves the very hard case (h755i/ecat_more_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_more_complex');
    const result = solveCegar(ast, mcu, { ...TP(10000), skipGpioMapping: true });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  }, 30000);
});

// ============================================================
// LNS Repair Solver
// ============================================================

describe('lns-repair solver', () => {
  it('solves a simple problem (g474/simple_uart_spi)', () => {
    const { mcu, ast } = loadCase('g474', 'simple_uart_spi');
    const result = solveLnsRepair(ast, mcu, {
      maxSolutions: 50, timeoutMs: 5000, costWeights: COST_WEIGHTS,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves a DMA-constrained problem (f405v/dma_uart)', () => {
    const { mcu, ast } = loadCase('f405v', 'dma_uart');
    const result = solveLnsRepair(ast, mcu, {
      maxSolutions: 20, timeoutMs: 5000, costWeights: COST_WEIGHTS,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves the hard case fast (h755i/ecat_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_complex');
    const result = solveLnsRepair(ast, mcu, {
      maxSolutions: 20, timeoutMs: 10000, costWeights: COST_WEIGHTS, skipGpioMapping: true,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  }, 15000);

  it('solves the very hard case (h755i/ecat_more_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_more_complex');
    const result = solveLnsRepair(ast, mcu, {
      maxSolutions: 20, timeoutMs: 10000, costWeights: COST_WEIGHTS, skipGpioMapping: true,
    });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  }, 15000);
});

// ============================================================
// Adaptive Portfolio Scheduler
// ============================================================

describe('adaptive solver', () => {
  const TP = (timeoutMs: number) => ({
    maxGroups: 100, maxSolutionsPerGroup: 10, timeoutMs, costWeights: COST_WEIGHTS,
  });

  it('handles an easy problem via the two-phase fast path (g474/shared_adc)', () => {
    const { mcu, ast } = loadCase('g474', 'shared_adc');
    const result = solveAdaptive(ast, mcu, TP(5000));
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
  });

  it('solves the hard case (h755i/ecat_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_complex');
    const result = solveAdaptive(ast, mcu, { ...TP(8000), skipGpioMapping: true });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
    // 30s harness cap: the solver budget is 8s, but under full-suite CPU load
    // the wall-clock can exceed 15s while still solving within its budget.
  }, 30000);

  it('solves the very hard case (h755i/ecat_more_complex)', () => {
    const { mcu, ast } = loadCase('h755i', 'ecat_more_complex');
    const result = solveAdaptive(ast, mcu, { ...TP(8000), skipGpioMapping: true });
    expect(result.solutions.length).toBeGreaterThan(0);
    validateSolutions(result);
    // 30s harness cap: the solver budget is 8s, but under full-suite CPU load
    // the wall-clock can exceed 15s while still solving within its budget.
  }, 30000);
});
