import { solveConstraints, estimateComplexity } from './solver';
import type { SolverConfig } from './solver';
import { solveTwoPhase, runSharedPhase1, runPhase2Only } from './two-phase-solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import { solveRandomizedRestarts } from './randomized-solver';
import { solveCostGuided } from './cost-guided-solver';
import { solveDiverseInstances } from './diverse-solver';
import { solveAC3 } from './ac3-solver';
import { solveDynamicMRV } from './dynamic-mrv-solver';
import { solvePriorityBacktracking } from './priority-backtracking-solver';
import { solvePriorityTwoPhase } from './priority-two-phase-solver';
import { solvePriorityDiverse } from './priority-diverse-solver';
import { solvePriorityGroup } from './priority-group-solver';
import { solveMrvGroup } from './mrv-group-solver';
import { solveRatioMrvGroup } from './ratio-mrv-group-solver';
import { solveHybrid } from './hybrid-solver';
import { getSolverResourceMultiplier } from './solver-registry';
import { mergeResults } from './result-merger';
import { computePortPriority } from './port-priority';
import { estimateCandidateCost } from './cost-functions';
import { toWire } from './solution-transfer';
import type { Mcu, SolverResult } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import type { SolverVariable } from './solver';

/** Short display names for solver IDs, used in error/warning messages. */
const SOLVER_LABELS: Record<string, string> = {
  'backtracking': 'Backtracking',
  'cost-guided': 'Cost-Guided',
  'ac3': 'AC3',
  'dynamic-mrv': 'Dynamic-MRV',
  'priority-backtracking': 'Priority-BT',
  'randomized-restarts': 'Randomized',
  'two-phase': 'Two-Phase',
  'diverse-instances': 'Diverse',
  'priority-two-phase': 'Priority-TP',
  'priority-diverse': 'Priority-Diverse',
  'priority-group': 'Priority-Group',
  'mrv-group': 'MRV-Group',
  'ratio-mrv-group': 'Ratio-MRV',
  'hybrid': 'Hybrid',
};

function tagErrors(result: SolverResult, solverId: string): SolverResult {
  const label = SOLVER_LABELS[solverId] ?? solverId;
  for (const err of result.errors) {
    if (!err.message.startsWith(`${label}: `)) {
      err.message = `${label}: ${err.message}`;
    }
  }
  return result;
}

export interface SolverWorkerRequest {
  ast: ProgramNode;
  mcu: Mcu;
  config: Partial<SolverConfig>;
  solverType?: string;
  solverTypes?: string[];  // A2: multiple solvers in one worker
  twoPhaseConfig?: { maxGroups: number; maxSolutionsPerGroup: number };
  randomizedConfig?: { numRestarts: number };
}

// A2: Solvers that can share Phase 1 (use solvePhase2ForGroup)
const SHARED_PHASE1_SOLVERS = new Set(['two-phase', 'diverse-instances', 'priority-two-phase', 'priority-group']);

function getPhase2SortFn(
  solverId: string,
  costWeights: Map<string, number>
): ((vars: SolverVariable[]) => void) | undefined {
  switch (solverId) {
    case 'priority-two-phase':
    case 'priority-group':
      return (vars: SolverVariable[]) => {
        const p2Priority = computePortPriority(vars);
        const minCosts = new Map<SolverVariable, number>();
        for (const v of vars) {
          let minCost = Infinity;
          for (const ci of v.domain) {
            const cost = estimateCandidateCost(v.candidates[ci], costWeights);
            if (cost < minCost) minCost = cost;
          }
          minCosts.set(v, minCost);
        }
        vars.sort((a, b) => {
          const pa = p2Priority.get(a.portName) ?? 0;
          const pb = p2Priority.get(b.portName) ?? 0;
          if (pa !== pb) return pb - pa;
          const sizeA = a.domain.length, sizeB = b.domain.length;
          if (sizeA !== sizeB) return sizeA - sizeB;
          return (minCosts.get(b) ?? 0) - (minCosts.get(a) ?? 0);
        });
      };
    default:
      // MRV + cost (C1)
      return (vars: SolverVariable[]) => {
        const minCosts = new Map<SolverVariable, number>();
        for (const v of vars) {
          let minCost = Infinity;
          for (const ci of v.domain) {
            const cost = estimateCandidateCost(v.candidates[ci], costWeights);
            if (cost < minCost) minCost = cost;
          }
          minCosts.set(v, minCost);
        }
        vars.sort((a, b) => {
          const sizeA = a.domain.length, sizeB = b.domain.length;
          if (sizeA !== sizeB) return sizeA - sizeB;
          return (minCosts.get(b) ?? 0) - (minCosts.get(a) ?? 0);
        });
      };
  }
}

function runSingleSolver(
  st: string,
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig>,
  twoPhaseConfig: { maxGroups: number; maxSolutionsPerGroup: number } | undefined,
  randomizedConfig: { numRestarts: number } | undefined,
  complexity: 'easy' | 'medium' | 'hard' | 'very-hard'
): SolverResult {
  const multiplier = getSolverResourceMultiplier(st, complexity);
  const effectiveTimeoutMs = Math.round((config.timeoutMs ?? 5000) * multiplier.timeoutMultiplier);
  const effectiveMaxGroups = Math.max(1, Math.round((twoPhaseConfig?.maxGroups ?? 50) * multiplier.groupsMultiplier));
  const adjustedConfig = { ...config, timeoutMs: effectiveTimeoutMs };

  const buildTP = (): TwoPhaseConfig => ({
    maxGroups: effectiveMaxGroups,
    maxSolutionsPerGroup: twoPhaseConfig?.maxSolutionsPerGroup ?? 10,
    timeoutMs: effectiveTimeoutMs,
    costWeights: config.costWeights ?? new Map(),
    skipGpioMapping: config.skipGpioMapping,
  });

  let result: SolverResult;
  switch (st) {
    case 'two-phase': result = solveTwoPhase(ast, mcu, buildTP()); break;
    case 'randomized-restarts': result = solveRandomizedRestarts(ast, mcu, {
      numRestarts: randomizedConfig?.numRestarts ?? 5,
      maxSolutions: config.maxSolutions ?? 100, timeoutMs: effectiveTimeoutMs,
      costWeights: config.costWeights ?? new Map(), skipGpioMapping: config.skipGpioMapping,
    }); break;
    case 'cost-guided': result = solveCostGuided(ast, mcu, adjustedConfig); break;
    case 'diverse-instances': result = solveDiverseInstances(ast, mcu, buildTP()); break;
    case 'ac3': result = solveAC3(ast, mcu, adjustedConfig); break;
    case 'dynamic-mrv': result = solveDynamicMRV(ast, mcu, adjustedConfig); break;
    case 'priority-backtracking': result = solvePriorityBacktracking(ast, mcu, adjustedConfig); break;
    case 'priority-two-phase': result = solvePriorityTwoPhase(ast, mcu, buildTP()); break;
    case 'priority-diverse': result = solvePriorityDiverse(ast, mcu, {
      numRestarts: randomizedConfig?.numRestarts ?? 25,
      maxSolutions: config.maxSolutions ?? 100, timeoutMs: effectiveTimeoutMs,
      costWeights: config.costWeights ?? new Map(), skipGpioMapping: config.skipGpioMapping,
    }); break;
    case 'priority-group': result = solvePriorityGroup(ast, mcu, buildTP()); break;
    case 'mrv-group': result = solveMrvGroup(ast, mcu, buildTP()); break;
    case 'ratio-mrv-group': result = solveRatioMrvGroup(ast, mcu, buildTP()); break;
    case 'hybrid': result = solveHybrid(ast, mcu, buildTP()); break;
    default: result = solveConstraints(ast, mcu, adjustedConfig); break;
  }
  return tagErrors(result, st);
}

self.onmessage = (e: MessageEvent<SolverWorkerRequest>) => {
  try {
    const { ast, mcu, config, solverType, solverTypes, twoPhaseConfig, randomizedConfig } = e.data;

    const complexity = estimateComplexity(ast, mcu);

    // A2: Multi-solver mode - shared Phase 1 for two-phase solvers
    if (solverTypes && solverTypes.length > 0) {
      const sharedTypes = solverTypes.filter(s => SHARED_PHASE1_SOLVERS.has(s));
      const otherTypes = solverTypes.filter(s => !SHARED_PHASE1_SOLVERS.has(s));

      const labeled: Array<{ solverId: string; result: SolverResult }> = [];

      // Run shared Phase 1 once for all two-phase solvers
      if (sharedTypes.length > 0) {
        const multiplier = getSolverResourceMultiplier(sharedTypes[0], complexity);
        const tpConfig: TwoPhaseConfig = {
          maxGroups: Math.max(1, Math.round((twoPhaseConfig?.maxGroups ?? 50) * multiplier.groupsMultiplier)),
          maxSolutionsPerGroup: twoPhaseConfig?.maxSolutionsPerGroup ?? 10,
          timeoutMs: Math.round((config.timeoutMs ?? 5000) * multiplier.timeoutMultiplier),
          costWeights: config.costWeights ?? new Map(),
          skipGpioMapping: config.skipGpioMapping,
        };

        const phase1 = runSharedPhase1(ast, mcu, tpConfig);

        if (phase1 && phase1.groups.length > 0) {
          const costWeights = config.costWeights ?? new Map<string, number>();
          for (const st of sharedTypes) {
            const startTime = performance.now();
            const sortFn = getPhase2SortFn(st, costWeights);
            const result = runPhase2Only(phase1, mcu, tpConfig, startTime, sortFn);
            labeled.push({ solverId: st, result: tagErrors(result, st) });
          }
        } else {
          // Phase 1 failed - report error for each solver
          for (const st of sharedTypes) {
            const emptyResult: SolverResult = {
              mcuRef: mcu.refName, solutions: [],
              errors: phase1?.errors?.map(e => ({ ...e })) ?? [{ type: 'error', message: 'Phase 1: No valid assignments' }],
              statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
            };
            labeled.push({ solverId: st, result: tagErrors(emptyResult, st) });
          }
        }
      }

      // Run other solvers independently
      for (const st of otherTypes) {
        const result = runSingleSolver(st, ast, mcu, config, twoPhaseConfig, randomizedConfig, complexity);
        labeled.push({ solverId: st, result });
      }

      const merged = mergeResults(labeled, config.maxSolutions ?? 100);
      self.postMessage(toWire(merged));
      return;
    }

    // Single solver mode
    const result = runSingleSolver(
      solverType ?? 'backtracking', ast, mcu, config,
      twoPhaseConfig, randomizedConfig, complexity
    );
    self.postMessage(toWire(result));
  } catch (err) {
    self.postMessage({
      mcuRef: '',
      solutions: [],
      errors: [{ type: 'error', message: `Solver crashed: ${err instanceof Error ? err.message : String(err)}` }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
      _wire: true,
    });
  }
};
