import type { Solver } from './solver-interface';

const solvers: Solver[] = [];

export function registerSolver(solver: Solver): void {
  solvers.push(solver);
}

export function getSolvers(): Solver[] {
  return [...solvers];
}

export function getSolverById(id: string): Solver | undefined {
  return solvers.find(s => s.id === id);
}

// Register built-in solvers
registerSolver({
  id: 'two-phase',
  name: 'Two-Phase (Instance + Pin)',
  description: 'First assigns peripheral instances, then solves pin mappings per group',
});

registerSolver({
  id: 'backtracking',
  name: 'Backtracking CSP',
  description: 'Constraint satisfaction with MRV heuristic and eager pruning',
});

registerSolver({
  id: 'randomized-restarts',
  name: 'Randomized Restarts',
  description: 'Runs backtracking N times with shuffled candidate orderings for diverse solutions',
});

registerSolver({
  id: 'cost-guided',
  name: 'Cost-Guided',
  description: 'Backtracking with candidates sorted by estimated cost (proximity, spread, debug penalty)',
});

registerSolver({
  id: 'diverse-instances',
  name: 'Diverse Instances (Two-Phase)',
  description: 'Two-phase solver with multi-round shuffled instance exploration for diverse groups',
});

registerSolver({
  id: 'ac3',
  name: 'AC-3 Forward Checking',
  description: 'Backtracking with forward checking — propagates pin/instance exclusivity to prune domains',
});

registerSolver({
  id: 'dynamic-mrv',
  name: 'Dynamic MRV',
  description: 'Dynamically picks the most constrained variable at each step with forward checking',
});
