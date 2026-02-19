import { describe, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { solveRandomizedRestarts } from '../src/solver/randomized-solver';
import { solveCostGuided } from '../src/solver/cost-guided-solver';
import { solveDiverseInstances } from '../src/solver/diverse-solver';
import { solveAC3 } from '../src/solver/ac3-solver';
import { solveDynamicMRV } from '../src/solver/dynamic-mrv-solver';
import type { Mcu, Solution, SolverResult } from '../src/types';
import type { ProgramNode } from '../src/parser/constraint-ast';

// ============================================================
// Config
// ============================================================

const MAX_SOLUTIONS = 1000;
const TIMEOUT_MS = 10_000;

const COST_WEIGHTS = new Map([
  ['pin_count', 1],
  ['port_spread', 0.5],
  ['peripheral_count', 0.5],
  ['debug_pin_penalty', 0],
  ['pin_clustering', 0.1],
  ['pin_proximity', 1],
]);

const BASIC_CONFIG = {
  maxSolutions: MAX_SOLUTIONS,
  timeoutMs: TIMEOUT_MS,
  costWeights: COST_WEIGHTS,
};

const TWO_PHASE_CONFIG = {
  maxGroups: 50,
  maxSolutionsPerGroup: 50,
  timeoutMs: TIMEOUT_MS,
  costWeights: COST_WEIGHTS,
};

// ============================================================
// Solver definitions
// ============================================================

interface SolverDef {
  id: string;
  run: (ast: ProgramNode, mcu: Mcu) => SolverResult;
}

const solvers: SolverDef[] = [
  {
    id: 'backtracking',
    run: (ast, mcu) => solveConstraints(ast, mcu, BASIC_CONFIG),
  },
  {
    id: 'two-phase',
    run: (ast, mcu) => solveTwoPhase(ast, mcu, TWO_PHASE_CONFIG),
  },
  {
    id: 'randomized-restarts',
    run: (ast, mcu) => solveRandomizedRestarts(ast, mcu, {
      numRestarts: 10,
      maxSolutions: MAX_SOLUTIONS,
      timeoutMs: TIMEOUT_MS,
      costWeights: COST_WEIGHTS,
    }),
  },
  {
    id: 'cost-guided',
    run: (ast, mcu) => solveCostGuided(ast, mcu, BASIC_CONFIG),
  },
  {
    id: 'diverse-instances',
    run: (ast, mcu) => solveDiverseInstances(ast, mcu, TWO_PHASE_CONFIG),
  },
  {
    id: 'ac3',
    run: (ast, mcu) => solveAC3(ast, mcu, BASIC_CONFIG),
  },
  {
    id: 'dynamic-mrv',
    run: (ast, mcu) => solveDynamicMRV(ast, mcu, BASIC_CONFIG),
  },
];

// ============================================================
// Test data discovery (pass cases only)
// ============================================================

const TEST_DIR = join(__dirname);

interface TestCase {
  label: string;       // e.g. "g474/simple_uart_spi"
  mcuFile: string;
  constraintFile: string;
}

function discoverPassCases(): TestCase[] {
  const cases: TestCase[] = [];
  const folders = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const folder of folders) {
    const folderPath = join(TEST_DIR, folder.name);
    const xmlFiles = readdirSync(folderPath).filter(f => f.endsWith('.xml'));
    if (xmlFiles.length === 0) continue;
    const mcuFile = join(folderPath, xmlFiles[0]);

    const passDir = join(folderPath, 'pass');
    if (!existsSync(passDir)) continue;
    const passFiles = readdirSync(passDir).filter(f => f.endsWith('.txt'));
    for (const f of passFiles) {
      cases.push({
        label: `${folder.name}/${basename(f, '.txt')}`,
        mcuFile,
        constraintFile: join(passDir, f),
      });
    }
  }
  return cases;
}

// ============================================================
// Metrics
// ============================================================

interface BenchmarkRow {
  testCase: string;
  solver: string;
  solutions: number;
  runtimeMs: number;
  minCost: number;
  avgCost: number;
  maxCost: number;
  groups: number;
  errors: number;
}

function countGroups(solutions: Solution[]): number {
  const keys = new Set<string>();
  for (const sol of solutions) {
    const parts: string[] = [];
    const sortedPorts = [...sol.portPeripherals.keys()].sort();
    for (const port of sortedPorts) {
      const peripherals = [...sol.portPeripherals.get(port)!].sort();
      parts.push(`${port}:${peripherals.join(',')}`);
    }
    keys.add(parts.join('|'));
  }
  return keys.size;
}

function collectMetrics(testCase: string, solverId: string, result: SolverResult): BenchmarkRow {
  const costs = result.solutions.map(s => s.totalCost);
  const sum = costs.reduce((a, b) => a + b, 0);
  return {
    testCase,
    solver: solverId,
    solutions: result.solutions.length,
    runtimeMs: result.statistics.solveTimeMs,
    minCost: costs.length > 0 ? Math.min(...costs) : 0,
    avgCost: costs.length > 0 ? sum / costs.length : 0,
    maxCost: costs.length > 0 ? Math.max(...costs) : 0,
    groups: countGroups(result.solutions),
    errors: result.errors.length,
  };
}

// ============================================================
// Report generation
// ============================================================

function generateReport(rows: BenchmarkRow[]): string {
  const lines: string[] = [];
  lines.push('# Solver Benchmark Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Max solutions: ${MAX_SOLUTIONS}, Timeout: ${TIMEOUT_MS}ms`);
  lines.push('');

  // Group by test case
  const byTestCase = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    const list = byTestCase.get(row.testCase) ?? [];
    list.push(row);
    byTestCase.set(row.testCase, list);
  }

  for (const [tc, tcRows] of byTestCase) {
    lines.push(`## ${tc}`);
    lines.push('');
    lines.push('| Solver | Solutions | Groups | Runtime (ms) | Min Cost | Avg Cost | Max Cost | Errors |');
    lines.push('|--------|----------:|-------:|-------------:|---------:|---------:|---------:|-------:|');
    for (const row of tcRows) {
      lines.push(
        `| ${row.solver} | ${row.solutions} | ${row.groups} | ${row.runtimeMs.toFixed(0)} | ${row.minCost.toFixed(1)} | ${row.avgCost.toFixed(1)} | ${row.maxCost.toFixed(1)} | ${row.errors} |`
      );
    }
    lines.push('');
  }

  // Summary table across all test cases
  lines.push('## Summary (averages across all test cases)');
  lines.push('');

  const bySolver = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    const list = bySolver.get(row.solver) ?? [];
    list.push(row);
    bySolver.set(row.solver, list);
  }

  lines.push('| Solver | Avg Solutions | Avg Groups | Avg Runtime (ms) | Avg Min Cost |');
  lines.push('|--------|-------------:|-----------:|-----------------:|-------------:|');
  for (const [solver, sRows] of bySolver) {
    const n = sRows.length;
    const avgSol = sRows.reduce((a, r) => a + r.solutions, 0) / n;
    const avgGrp = sRows.reduce((a, r) => a + r.groups, 0) / n;
    const avgTime = sRows.reduce((a, r) => a + r.runtimeMs, 0) / n;
    const avgMinCost = sRows.reduce((a, r) => a + r.minCost, 0) / n;
    lines.push(
      `| ${solver} | ${avgSol.toFixed(1)} | ${avgGrp.toFixed(1)} | ${avgTime.toFixed(0)} | ${avgMinCost.toFixed(2)} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Benchmark test
// ============================================================

describe('Solver benchmark', () => {
  const testCases = discoverPassCases();
  const mcuCache = new Map<string, Mcu>();
  const allRows: BenchmarkRow[] = [];

  function getMcu(mcuFile: string): Mcu {
    if (!mcuCache.has(mcuFile)) {
      mcuCache.set(mcuFile, parseMcuXml(readFileSync(mcuFile, 'utf-8')));
    }
    return mcuCache.get(mcuFile)!;
  }

  for (const tc of testCases) {
    for (const solver of solvers) {
      it(`${solver.id} on ${tc.label}`, { timeout: 60_000 }, () => {
        const mcu = getMcu(tc.mcuFile);
        const constraintText = readFileSync(tc.constraintFile, 'utf-8');
        const { ast } = parseConstraints(constraintText);
        if (!ast) throw new Error(`Failed to parse ${tc.constraintFile}`);

        const result = solver.run(ast, mcu);
        const row = collectMetrics(tc.label, solver.id, result);
        allRows.push(row);
      });
    }
  }

  it('writes benchmark report', () => {
    const report = generateReport(allRows);
    const outPath = join(TEST_DIR, 'solver_benchmark.md');
    writeFileSync(outPath, report, 'utf-8');
    console.log(`\nBenchmark report written to ${outPath}`);
    console.log(`${allRows.length} runs (${testCases.length} test cases x ${solvers.length} solvers)\n`);
  });
});
