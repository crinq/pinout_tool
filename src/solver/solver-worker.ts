import { solveConstraints } from './solver';
import type { SolverConfig } from './solver';
import type { Mcu } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';

export interface SolverWorkerRequest {
  ast: ProgramNode;
  mcu: Mcu;
  config: Partial<SolverConfig>;
}

self.onmessage = (e: MessageEvent<SolverWorkerRequest>) => {
  try {
    const { ast, mcu, config } = e.data;
    const result = solveConstraints(ast, mcu, config);
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
