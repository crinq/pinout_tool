import type { Solver } from './solver-interface';

// ============================================================
// Solver Tier Classification (A1)
// ============================================================

const SOLVER_TIERS: Record<string, 'simple' | 'two-phase' | 'group'> = {
  'backtracking': 'simple',
  'cost-guided': 'simple',
  'ac3': 'simple',
  'dynamic-mrv': 'simple',
  'priority-backtracking': 'simple',
  'randomized-restarts': 'simple',
  'two-phase': 'two-phase',
  'diverse-instances': 'two-phase',
  'priority-two-phase': 'two-phase',
  'priority-diverse': 'two-phase',
  'priority-group': 'group',
  'mrv-group': 'group',
  'ratio-mrv-group': 'group',
  'hybrid': 'group',
};

export function getSolverResourceMultiplier(
  solverId: string,
  complexity: 'easy' | 'medium' | 'hard' | 'very-hard'
): { timeoutMultiplier: number; groupsMultiplier: number } {
  const tier = SOLVER_TIERS[solverId] ?? 'simple';

  switch (complexity) {
    case 'easy':
      return tier === 'group' ? { timeoutMultiplier: 0.5, groupsMultiplier: 0.5 }
        : tier === 'two-phase' ? { timeoutMultiplier: 0.7, groupsMultiplier: 0.5 }
        : { timeoutMultiplier: 1.0, groupsMultiplier: 1.0 };
    case 'medium':
      return { timeoutMultiplier: 1.0, groupsMultiplier: 1.0 };
    case 'hard':
      return tier === 'group' ? { timeoutMultiplier: 1.5, groupsMultiplier: 1.5 }
        : tier === 'two-phase' ? { timeoutMultiplier: 1.0, groupsMultiplier: 1.0 }
        : { timeoutMultiplier: 0.5, groupsMultiplier: 1.0 };
    case 'very-hard':
      return tier === 'group' ? { timeoutMultiplier: 2.0, groupsMultiplier: 2.0 }
        : tier === 'two-phase' ? { timeoutMultiplier: 1.0, groupsMultiplier: 1.0 }
        : { timeoutMultiplier: 0.3, groupsMultiplier: 1.0 };
  }
}

// ============================================================
// Solver Registry
// ============================================================

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
  description: 'Backtracking with forward checking - propagates pin/instance exclusivity to prune domains',
});

registerSolver({
  id: 'dynamic-mrv',
  name: 'Dynamic MRV',
  description: 'Dynamically picks the most constrained variable at each step with forward checking',
});

registerSolver({
  id: 'priority-backtracking',
  name: 'Priority Backtracking',
  description: 'Backtracking that maps constrained peripherals first (fewer available pins = higher priority)',
});

registerSolver({
  id: 'priority-two-phase',
  name: 'Priority Two-Phase',
  description: 'Two-phase solver that maps constrained peripherals first in both phases',
});

registerSolver({
  id: 'priority-diverse',
  name: 'Priority Diverse',
  description: 'Priority ordering with multi-round shuffled exploration for diverse groups',
});

registerSolver({
  id: 'priority-group',
  name: 'Priority Group',
  description: 'Diverse instance groups with instance permutation and priority-ordered pin assignment',
});

registerSolver({
  id: 'mrv-group',
  name: 'MRV Group',
  description: 'Diverse instance groups with instance permutation and dynamic MRV pin assignment',
});

registerSolver({
  id: 'ratio-mrv-group',
  name: 'Ratio MRV Group',
  description: 'MRV Group with normalized priority (candidates per signal ratio instead of raw pin count)',
});

registerSolver({
  id: 'hybrid',
  name: 'Hybrid (Single-Phase + Two-Phase)',
  description: 'Runs priority-backtracking, extracts instance groups from solutions, permutes symmetric ports, then runs Phase 2',
});
