// ============================================================
// Adaptive Portfolio Scheduler
//
// Event-driven phase pipeline over the three complex-problem
// solvers, with budget that flows to whatever is productive:
//
//   probe    — complexity estimate; easy problems go straight to
//              the two-phase default (no scheduling overhead)
//   race     — LNS repair gets a short anytime slice (fast first
//              solution), then conflict-directed gets a learning
//              slice; each stage's unused time rolls forward
//   diversify— CEGAR gets the remaining budget, SEEDED with the
//              instance groups extracted from the race solutions
//              (the hybrid trick, systematized): known-routable
//              structures probe first, nogood learning steers
//              discovery to new ones
//
// Solvers exit their slice early when they hit their solution cap —
// leftover time automatically extends the later phases.
//
// ponytail: rule-based reallocation, not a UCB bandit — phases are
// few and ordered by their time-to-first-solution profile; upgrade
// to preemptive round-robin slicing if runs show starved phases.
// ============================================================

import type { Mcu, SolverResult } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import { estimateComplexity, resolveAllVariables, extractPorts, resolveReservePatterns, extractSharedPatterns, partitionGpioVariables, isGpioVariable } from './solver';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros, getStdlibTemplates } from '../parser/stdlib-macros';
import type { TwoPhaseConfig } from './two-phase-solver';
import { buildInstanceVariables, type InstanceGroup } from './two-phase-solver';
import { solveTwoPhase } from './two-phase-solver';
import { solveLnsRepair } from './lns-solver';
import { solveConflictDirected } from './conflict-directed-solver';
import { solveCegar } from './cegar-solver';
import { extractInstanceGroupsFromSolutions } from './hybrid-solver';
import { mergeResults, type LabeledSolverResult } from './result-merger';

const LNS_SLICE_FRACTION = 0.2;
const LNS_SLICE_CAP_MS = 1500;
const CDS_SLICE_FRACTION = 0.25;
const RACE_SOLUTION_CAP = 64; // per race stage — existence + group material, not exhaustion

export function solveAdaptive(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  const startTime = performance.now();
  const totalMs = config.timeoutMs;
  const remaining = () => Math.max(0, totalMs - (performance.now() - startTime));

  // ---------- probe ----------
  const complexity = estimateComplexity(ast, mcu);
  if (complexity === 'easy') {
    // Scheduling overhead would only slow these down
    return solveTwoPhase(ast, mcu, config);
  }

  const baseConfig = {
    costWeights: config.costWeights,
    skipGpioMapping: config.skipGpioMapping,
    maxSolutions: RACE_SOLUTION_CAP,
  };
  const labeled: LabeledSolverResult[] = [];

  // ---------- race: LNS (anytime) ----------
  const lnsBudget = Math.min(totalMs * LNS_SLICE_FRACTION, LNS_SLICE_CAP_MS);
  const lnsResult = solveLnsRepair(ast, mcu, { ...baseConfig, timeoutMs: lnsBudget });
  labeled.push({ solverId: 'lns-repair', result: lnsResult });

  // ---------- race: conflict-directed (learning) ----------
  const cdsBudget = Math.min(remaining(), totalMs * CDS_SLICE_FRACTION);
  if (cdsBudget > 100) {
    const cdsResult = solveConflictDirected(ast, mcu, { ...baseConfig, timeoutMs: cdsBudget });
    labeled.push({ solverId: 'conflict-directed', result: cdsResult });
  }

  // ---------- diversify: CEGAR seeded with race groups ----------
  const cegarBudget = remaining();
  if (cegarBudget > 200) {
    const seedGroups = extractSeedGroups(ast, mcu, config, labeled);
    const cegarResult = solveCegar(ast, mcu, { ...config, timeoutMs: cegarBudget }, seedGroups);
    labeled.push({ solverId: 'cegar', result: cegarResult });
  }

  const merged = mergeResults(labeled, config.maxGroups * config.maxSolutionsPerGroup);
  merged.statistics.solveTimeMs = performance.now() - startTime;
  return merged;
}

/** Reverse-map race solutions to instance groups (setup mirrors the solvers'). */
function extractSeedGroups(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig,
  labeled: LabeledSolverResult[]
): InstanceGroup[] {
  const solutions = labeled.flatMap(l => l.result.solutions);
  if (solutions.length === 0) return [];

  const { ast: expandedAst } = expandAllMacros(ast, getStdlibMacros(), getStdlibTemplates());
  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  extractSharedPatterns(expandedAst);
  const reservedPinSet = new Set(reserved.pins);
  const reservedPeripheralSet = new Set(reserved.peripherals);
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);
  const { solveVars } = partitionGpioVariables(
    allVariables.filter(v => v.domain.length > 0 || !v.optional),
    !!config.skipGpioMapping
  );
  const instanceVars = buildInstanceVariables(solveVars.filter(v => !isGpioVariable(v)));
  return extractInstanceGroupsFromSolutions(solutions, instanceVars);
}
