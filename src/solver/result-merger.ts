import type { SolverResult, SolverStats } from '../types';
import { newStats, deduplicateSolutions } from './solver';

export interface LabeledSolverResult {
  solverId: string;
  result: SolverResult;
}

export function mergeResults(
  labeled: LabeledSolverResult[],
  maxSolutions: number
): SolverResult {
  if (labeled.length === 0) {
    return {
      mcuRef: '',
      solutions: [],
      errors: [{ type: 'warning', message: 'No solver results to merge' }],
      statistics: newStats(0),
    };
  }

  // Single result - fast path (just tag origins)
  if (labeled.length === 1) {
    const { solverId, result } = labeled[0];
    for (const sol of result.solutions) {
      sol.solverOrigin = solverId;
    }
    return result;
  }

  // Tag each solution with its solver origin
  for (const { solverId, result } of labeled) {
    for (const sol of result.solutions) {
      sol.solverOrigin = solverId;
    }
  }

  // Concat all solutions, sort by cost, dedup, trim
  const allSolutions = labeled.flatMap(l => l.result.solutions);
  allSolutions.sort((a, b) => a.totalCost - b.totalCost);
  const deduped = deduplicateSolutions(allSolutions);
  const trimmed = deduped.slice(0, maxSolutions);
  trimmed.forEach((s, i) => s.id = i);

  // Merge errors (unique messages only)
  const seenErrors = new Set<string>();
  const mergedErrors = [];
  for (const { result } of labeled) {
    for (const err of result.errors) {
      if (!seenErrors.has(err.message)) {
        seenErrors.add(err.message);
        mergedErrors.push(err);
      }
    }
  }

  // Merge statistics
  const perSolver: Record<string, SolverStats> = {};
  let totalCombinations = 0;
  let evaluatedCombinations = 0;
  let maxSolveTime = 0;
  let maxConfigCombinations = 0;
  let firstSolutionMs: number | undefined;
  let lastSolutionMs: number | undefined;

  for (const { solverId, result } of labeled) {
    perSolver[solverId] = { ...result.statistics };
    totalCombinations += result.statistics.totalCombinations;
    evaluatedCombinations += result.statistics.evaluatedCombinations;
    maxSolveTime = Math.max(maxSolveTime, result.statistics.solveTimeMs);
    maxConfigCombinations = Math.max(maxConfigCombinations, result.statistics.configCombinations);
    const f = result.statistics.firstSolutionMs;
    if (f !== undefined && (firstSolutionMs === undefined || f < firstSolutionMs)) firstSolutionMs = f;
    const l = result.statistics.lastSolutionMs;
    if (l !== undefined && (lastSolutionMs === undefined || l > lastSolutionMs)) lastSolutionMs = l;
  }

  return {
    mcuRef: labeled[0].result.mcuRef,
    solutions: trimmed,
    errors: mergedErrors,
    statistics: {
      totalCombinations,
      evaluatedCombinations,
      validSolutions: trimmed.length,
      solveTimeMs: maxSolveTime,
      configCombinations: maxConfigCombinations,
      firstSolutionMs,
      lastSolutionMs,
      perSolver,
    },
  };
}
