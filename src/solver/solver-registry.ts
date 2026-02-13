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
  id: 'backtracking',
  name: 'Backtracking CSP',
  description: 'Constraint satisfaction with MRV heuristic and eager pruning',
});
