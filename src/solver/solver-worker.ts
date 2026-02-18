import { solveConstraints } from './solver';
import type { SolverConfig } from './solver';
import { solveTwoPhase } from './two-phase-solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import { solveRandomizedRestarts } from './randomized-solver';
import { solveCostGuided } from './cost-guided-solver';
import { solveDiverseInstances } from './diverse-solver';
import { solveAC3 } from './ac3-solver';
import { solveDynamicMRV } from './dynamic-mrv-solver';
import type { Mcu } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';

export interface SolverWorkerRequest {
  ast: ProgramNode;
  mcu: Mcu;
  config: Partial<SolverConfig>;
  solverType?: string;
  twoPhaseConfig?: { maxGroups: number; maxSolutionsPerGroup: number };
  randomizedConfig?: { numRestarts: number };
}

self.onmessage = (e: MessageEvent<SolverWorkerRequest>) => {
  try {
    const { ast, mcu, config, solverType, twoPhaseConfig, randomizedConfig } = e.data;

    const buildTwoPhaseConfig = (): TwoPhaseConfig => ({
      maxGroups: twoPhaseConfig?.maxGroups ?? 50,
      maxSolutionsPerGroup: twoPhaseConfig?.maxSolutionsPerGroup ?? 10,
      timeoutMs: config.timeoutMs ?? 5000,
      costWeights: config.costWeights ?? new Map(),
    });

    let result;
    switch (solverType) {
      case 'two-phase':
        result = solveTwoPhase(ast, mcu, buildTwoPhaseConfig());
        break;

      case 'randomized-restarts':
        result = solveRandomizedRestarts(ast, mcu, {
          numRestarts: randomizedConfig?.numRestarts ?? 5,
          maxSolutions: config.maxSolutions ?? 100,
          timeoutMs: config.timeoutMs ?? 5000,
          costWeights: config.costWeights ?? new Map(),
        });
        break;

      case 'cost-guided':
        result = solveCostGuided(ast, mcu, config);
        break;

      case 'diverse-instances':
        result = solveDiverseInstances(ast, mcu, buildTwoPhaseConfig());
        break;

      case 'ac3':
        result = solveAC3(ast, mcu, config);
        break;

      case 'dynamic-mrv':
        result = solveDynamicMRV(ast, mcu, config);
        break;

      default:
        result = solveConstraints(ast, mcu, config);
        break;
    }

    self.postMessage(result);
  } catch (err) {
    // Send error back as a solver result so the UI can display it
    self.postMessage({
      mcuRef: '',
      solutions: [],
      errors: [{ type: 'error', message: `Solver crashed: ${err instanceof Error ? err.message : String(err)}` }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
    });
  }
};
