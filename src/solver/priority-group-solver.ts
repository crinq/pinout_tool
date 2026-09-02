// ============================================================
// Priority Group Solver
//
// solveMrvGroup with the two-phase Phase-2 engine: identical diverse
// Phase 1 / Phase 1.5 discovery, but pin assignment runs through
// solvePhase2ForGroup with priority-ordered variables and C2 cost
// pruning. (This file used to be a 320-line copy of mrv-group-solver
// whose constants and fixes kept drifting — see ratio-mrv-group for
// the same wrapper pattern.)
// ============================================================

import type { Mcu, SolverResult } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import type { TwoPhaseConfig } from './two-phase-solver';
import { solveMrvGroup } from './mrv-group-solver';
import { computePortPriority } from './port-priority';

export function solvePriorityGroup(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  return solveMrvGroup(ast, mcu, config, computePortPriority, 'two-phase');
}
