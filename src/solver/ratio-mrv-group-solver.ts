// ============================================================
// Ratio MRV Group Solver
//
// Variant of the MRV Group solver using normalized port priority:
// priority = total_unique_pins / number_of_channels
// This ratio (average candidates per signal) normalizes priority
// better than raw pin count for ports with varying channel counts.
// ============================================================

import type { Mcu, SolverResult } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import type { TwoPhaseConfig } from './two-phase-solver';
import { solveMrvGroup } from './mrv-group-solver';
import { computeNormalizedPortPriority } from './port-priority';

export function solveRatioMrvGroup(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  return solveMrvGroup(ast, mcu, config, computeNormalizedPortPriority);
}
