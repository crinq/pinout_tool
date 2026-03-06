import { describe, it, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { fork, execSync } from 'child_process';
import { tmpdir } from 'os';

// ============================================================
// Config
// ============================================================

const MAX_SOLUTIONS = 5000;
const TIMEOUT_MS = 5_000;

const COST_WEIGHTS: [string, number][] = [
  ['pin_count', 1],
  ['port_spread', 0.5],
  ['peripheral_count', 0.5],
  ['debug_pin_penalty', 0],
  ['pin_clustering', 0.0],
  ['pin_proximity', 1],
];

const TWO_PHASE_CONFIG = {
  maxGroups: 500,
  maxSolutionsPerGroup: 200,
};

const NUM_RESTARTS = 150;

const SOLVER_IDS = [
  'backtracking',
  'two-phase',
  'randomized-restarts',
  'cost-guided',
  'diverse-instances',
  'ac3',
  'dynamic-mrv',
  'priority-backtracking',
  'priority-two-phase',
  'priority-diverse',
  'priority-group',
  'mrv-group',
  'ratio-mrv-group',
];

// ============================================================
// Test data discovery (pass cases only)
// ============================================================

const TEST_DIR = join(__dirname);

interface TestCase {
  label: string;
  mcuFile: string;
  constraintFile: string;
}

function discoverPassCases(): TestCase[] {
  const cases: TestCase[] = [];
  const folders = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const folder of folders) {
    const folderPath = join(TEST_DIR, folder.name);
    const xmlFiles = readdirSync(folderPath).filter(f => f.endsWith('.xml') && !f.startsWith('DMA-'));
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
// Worker compilation and runner
// ============================================================

let compiledWorkerPath: string;

function compileWorker(): string {
  const projectRoot = join(__dirname, '..');
  const outfile = join(projectRoot, 'node_modules', '.cache', 'benchmark-worker.mjs');
  const entryPoint = join(__dirname, 'benchmark-worker.ts');
  execSync(`mkdir -p ${JSON.stringify(join(projectRoot, 'node_modules', '.cache'))}`, { stdio: 'pipe' });
  execSync(
    `npx esbuild ${JSON.stringify(entryPoint)} --bundle --platform=node --format=esm --outfile=${JSON.stringify(outfile)} --external:fs --external:path --external:child_process --external:worker_threads --external:os --external:jsdom`,
    { cwd: projectRoot, stdio: 'pipe' }
  );
  return outfile;
}

interface WorkerResult {
  solutions: { totalCost: number; portPeripherals: [string, string[]][] }[];
  errors: { type: string; message: string }[];
  statistics: { solveTimeMs: number; firstSolutionMs?: number; lastSolutionMs?: number };
}

function runSolverInProcess(solverId: string, tc: TestCase): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(compiledWorkerPath, [], {
      serialization: 'json',
      stdio: 'pipe',
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        solutions: [],
        errors: [{ type: 'error', message: `Solver timeout (${TIMEOUT_MS}ms)` }],
        statistics: { solveTimeMs: TIMEOUT_MS },
      });
    }, TIMEOUT_MS + 10_000);

    child.on('message', (msg: any) => {
      clearTimeout(timer);
      if (msg.error) {
        resolve({
          solutions: [],
          errors: [{ type: 'error', message: msg.error }],
          statistics: { solveTimeMs: 0 },
        });
      } else {
        resolve(msg as WorkerResult);
      }
      child.kill();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        resolve({
          solutions: [],
          errors: [{ type: 'error', message: `Worker exited with code ${code}` }],
          statistics: { solveTimeMs: 0 },
        });
      }
    });

    child.send({
      solverId,
      mcuFile: tc.mcuFile,
      constraintFile: tc.constraintFile,
      maxSolutions: MAX_SOLUTIONS,
      timeoutMs: TIMEOUT_MS,
      costWeights: COST_WEIGHTS,
      twoPhaseConfig: TWO_PHASE_CONFIG,
      numRestarts: NUM_RESTARTS,
    });
  });
}

// ============================================================
// Metrics
// ============================================================

interface BenchmarkRow {
  testCase: string;
  solver: string;
  solutions: number;
  runtimeMs: number;
  firstSolutionMs: number;
  lastSolutionMs: number;
  minCost: number;
  avgCost: number;
  maxCost: number;
  groups: number;
  errors: number;
}

function countGroups(solutions: WorkerResult['solutions']): number {
  const keys = new Set<string>();
  for (const sol of solutions) {
    const parts: string[] = [];
    const sortedPorts = sol.portPeripherals.map(([k]) => k).sort();
    for (const port of sortedPorts) {
      const entry = sol.portPeripherals.find(([k]) => k === port);
      const peripherals = entry ? [...entry[1]].sort() : [];
      parts.push(`${port}:${peripherals.join(',')}`);
    }
    keys.add(parts.join('|'));
  }
  return keys.size;
}

function collectMetrics(testCase: string, solverId: string, result: WorkerResult): BenchmarkRow {
  const costs = result.solutions.map(s => s.totalCost);
  const sum = costs.reduce((a, b) => a + b, 0);
  return {
    testCase,
    solver: solverId,
    solutions: result.solutions.length,
    runtimeMs: result.statistics.solveTimeMs,
    firstSolutionMs: result.statistics.firstSolutionMs ?? 0,
    lastSolutionMs: result.statistics.lastSolutionMs ?? 0,
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

  const byTestCase = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    const list = byTestCase.get(row.testCase) ?? [];
    list.push(row);
    byTestCase.set(row.testCase, list);
  }

  for (const [tc, tcRows] of byTestCase) {
    lines.push(`## ${tc}`);
    lines.push('');
    lines.push('| Solver | Solutions | Groups | Runtime | 1st Sol | Last Sol | ms/Sol | ms/Grp | Min Cost | Avg Cost | Max Cost | Errors |');
    lines.push('|--------|----------:|-------:|--------:|--------:|---------:|-------:|-------:|---------:|---------:|---------:|-------:|');
    for (const row of tcRows) {
      const msSol = row.solutions > 0 ? (row.runtimeMs / row.solutions).toFixed(1) : '-';
      const msGrp = row.groups > 0 ? (row.runtimeMs / row.groups).toFixed(1) : '-';
      const first = row.solutions > 0 ? row.firstSolutionMs.toFixed(0) : '-';
      const last = row.solutions > 0 ? row.lastSolutionMs.toFixed(0) : '-';
      lines.push(
        `| ${row.solver} | ${row.solutions} | ${row.groups} | ${row.runtimeMs.toFixed(0)} | ${first} | ${last} | ${msSol} | ${msGrp} | ${row.minCost.toFixed(1)} | ${row.avgCost.toFixed(1)} | ${row.maxCost.toFixed(1)} | ${row.errors} |`
      );
    }
    lines.push('');
  }

  lines.push('## Summary (averages across all test cases)');
  lines.push('');

  const bySolver = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    const list = bySolver.get(row.solver) ?? [];
    list.push(row);
    bySolver.set(row.solver, list);
  }

  lines.push('| Solver | Avg Solutions | Avg Groups | Avg Runtime | Avg 1st Sol | Avg Last Sol | Avg ms/Sol | Avg ms/Grp | Avg Min Cost |');
  lines.push('|--------|-------------:|-----------:|------------:|------------:|-------------:|-----------:|-----------:|-------------:|');
  for (const [solver, sRows] of bySolver) {
    const n = sRows.length;
    const avgSol = sRows.reduce((a, r) => a + r.solutions, 0) / n;
    const avgGrp = sRows.reduce((a, r) => a + r.groups, 0) / n;
    const avgTime = sRows.reduce((a, r) => a + r.runtimeMs, 0) / n;
    const avgFirst = sRows.reduce((a, r) => a + r.firstSolutionMs, 0) / n;
    const avgLast = sRows.reduce((a, r) => a + r.lastSolutionMs, 0) / n;
    const withSolutions = sRows.filter(r => r.solutions > 0);
    const avgMsSol = withSolutions.length > 0
      ? withSolutions.reduce((a, r) => a + r.runtimeMs / r.solutions, 0) / withSolutions.length : 0;
    const withGroups = sRows.filter(r => r.groups > 0);
    const avgMsGrp = withGroups.length > 0
      ? withGroups.reduce((a, r) => a + r.runtimeMs / r.groups, 0) / withGroups.length : 0;
    const avgMinCost = sRows.reduce((a, r) => a + r.minCost, 0) / n;
    lines.push(
      `| ${solver} | ${avgSol.toFixed(1)} | ${avgGrp.toFixed(1)} | ${avgTime.toFixed(0)} | ${avgFirst.toFixed(0)} | ${avgLast.toFixed(0)} | ${avgMsSol.toFixed(1)} | ${avgMsGrp.toFixed(0)} | ${avgMinCost.toFixed(2)} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Benchmark test — all solvers in parallel per test case
// ============================================================

describe('Solver benchmark', () => {
  const testCases = discoverPassCases();
  const allRows: BenchmarkRow[] = [];

  beforeAll(() => {
    compiledWorkerPath = compileWorker();
  });

  for (const tc of testCases) {
    it(`all solvers on ${tc.label}`, { timeout: TIMEOUT_MS + 30_000 }, async () => {
      const results = await Promise.all(
        SOLVER_IDS.map(async (solverId) => {
          try {
            const result = await runSolverInProcess(solverId, tc);
            if (result.errors.length > 0) {
              console.log(`    [${solverId}] errors: ${result.errors.map(e => e.message).join('; ')}`);
            }
            return collectMetrics(tc.label, solverId, result);
          } catch (err) {
            console.log(`    [${solverId}] EXCEPTION: ${err}`);
            return {
              testCase: tc.label,
              solver: solverId,
              solutions: 0,
              runtimeMs: 0,
              firstSolutionMs: 0,
              lastSolutionMs: 0,
              minCost: 0,
              avgCost: 0,
              maxCost: 0,
              groups: 0,
              errors: 1,
            } as BenchmarkRow;
          }
        })
      );

      allRows.push(...results);

      for (const row of results) {
        const status = row.solutions > 0 ? '✓' : '✗';
        console.log(`  ${status} ${row.solver}: ${row.solutions} solutions, ${row.groups} groups, ${row.runtimeMs.toFixed(0)}ms${row.errors > 0 ? ' [ERRORS]' : ''}`);
      }
    });
  }

  it('writes benchmark report', () => {
    const report = generateReport(allRows);
    const outPath = join(TEST_DIR, 'solver_benchmark.md');
    writeFileSync(outPath, report, 'utf-8');
    console.log(`\nBenchmark report written to ${outPath}`);
    console.log(`${allRows.length} runs (${testCases.length} test cases x ${SOLVER_IDS.length} solvers)\n`);
  });
});
