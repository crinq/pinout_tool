// ============================================================
// Phase 2 Diversity: Round-Robin Group Processing
//
// D6: Randomized candidate ordering (via shuffleSeed)
// D7: Round-robin group processing
// D8: Structural fingerprint quotas
// D9: Anti-correlated pin sampling (via pinUsageCount)
// D11: Adaptive per-group solution budget
// ============================================================

import type { Solution } from '../types';
import type { InstanceGroup } from './two-phase-solver';

// ============================================================
// Types
// ============================================================

/**
 * Generic per-group solver function.
 * Called with a group, solution budget, shuffle seed, and pin usage map.
 * Returns solutions found for that group.
 */
export interface GroupSolverFn {
  (group: InstanceGroup, maxSolutions: number, shuffleSeed: number,
   pinUsageCount?: Map<string, number>): Solution[];
}

export interface Phase2DiversityConfig {
  maxSolutionsPerGroup: number;
  solutionsPerRound: number;
  timeoutMs: number;
  startTime: number;
}

// ============================================================
// Fingerprinting
// ============================================================

/** Structural fingerprint: unique instance assignment signature */
function groupFingerprint(group: InstanceGroup): string {
  const entries: string[] = [];
  for (const [k, v] of group.assignments) {
    entries.push(`${k}=${v}`);
  }
  entries.sort();
  return entries.join(',');
}

// ============================================================
// Solution diversity measurement (D11)
// ============================================================

/** Compute average Jaccard distance on pin sets across solution pairs */
function solutionPinDiversity(solutions: Solution[]): number {
  if (solutions.length < 2) return 1;

  const pinSets: Set<string>[] = solutions.map(s => {
    const pins = new Set<string>();
    for (const ca of s.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName !== '<pinned>') pins.add(a.pinName);
      }
    }
    return pins;
  });

  let totalDist = 0;
  let pairs = 0;
  for (let i = 0; i < pinSets.length; i++) {
    for (let j = i + 1; j < pinSets.length; j++) {
      const setI = pinSets[i];
      const setJ = pinSets[j];
      let intersection = 0;
      for (const p of setI) {
        if (setJ.has(p)) intersection++;
      }
      const unionSize = setI.size + setJ.size - intersection;
      if (unionSize > 0) {
        totalDist += 1 - intersection / unionSize;
        pairs++;
      }
    }
  }
  return pairs > 0 ? totalDist / pairs : 0;
}

// ============================================================
// Pin usage tracking (D9)
// ============================================================

function updatePinUsage(pinUsage: Map<string, number>, solutions: Solution[]): void {
  for (const sol of solutions) {
    for (const ca of sol.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName !== '<pinned>') {
          pinUsage.set(a.pinName, (pinUsage.get(a.pinName) ?? 0) + 1);
        }
      }
    }
  }
}

// ============================================================
// Main: Round-Robin Phase 2 with Diversity
// ============================================================

export function runPhase2Diverse(
  groups: InstanceGroup[],
  solveGroup: GroupSolverFn,
  config: Phase2DiversityConfig,
): Solution[] {
  const { maxSolutionsPerGroup, solutionsPerRound, timeoutMs, startTime } = config;
  const numGroups = groups.length;
  if (numGroups === 0) return [];

  const maxRounds = Math.ceil(maxSolutionsPerGroup / solutionsPerRound);

  // Per-group state
  const groupSolutionCount = new Array<number>(numGroups).fill(0);
  const groupExhausted = new Array<boolean>(numGroups).fill(false);
  const groupLowDiversity = new Array<boolean>(numGroups).fill(false);
  const groupPinUsage: Map<string, number>[] = groups.map(() => new Map());
  const groupSolutions: Solution[][] = groups.map(() => []);

  // D8: Structural fingerprint quotas
  const fingerprints = groups.map(g => groupFingerprint(g));
  const uniqueFingerprints = new Set(fingerprints).size;
  const totalBudget = maxSolutionsPerGroup * numGroups;
  const maxPerFingerprint = Math.max(
    solutionsPerRound * 2,
    Math.ceil(totalBudget / Math.max(uniqueFingerprints, 1))
  );
  const fingerprintCount = new Map<string, number>();

  const allSolutions: Solution[] = [];

  for (let round = 0; round < maxRounds; round++) {
    let anyActive = false;

    for (let g = 0; g < numGroups; g++) {
      // Timeout check
      if (performance.now() - startTime > timeoutMs) return allSolutions;

      // Skip exhausted groups
      if (groupExhausted[g]) continue;

      // D8: Skip if fingerprint quota reached
      const fp = fingerprints[g];
      if ((fingerprintCount.get(fp) ?? 0) >= maxPerFingerprint) continue;

      // D11: Halve budget for low-diversity groups after round 1
      const effectiveBudget = groupLowDiversity[g]
        ? Math.max(1, Math.ceil(solutionsPerRound / 2))
        : solutionsPerRound;

      // Check per-group total budget
      const remaining = maxSolutionsPerGroup - groupSolutionCount[g];
      if (remaining <= 0) { groupExhausted[g] = true; continue; }
      const thisRoundBudget = Math.min(effectiveBudget, remaining);

      // D6: Round 0 is deterministic (seed=0), rounds 1+ use unique seeds
      const shuffleSeed = round === 0 ? 0 : g * 1000 + round;

      // Call solver
      const solutions = solveGroup(
        groups[g], thisRoundBudget, shuffleSeed, groupPinUsage[g]
      );

      if (solutions.length === 0) {
        groupExhausted[g] = true;
        continue;
      }

      anyActive = true;
      groupSolutionCount[g] += solutions.length;
      fingerprintCount.set(fp, (fingerprintCount.get(fp) ?? 0) + solutions.length);

      // D9: Update pin usage for anti-correlation in next rounds
      updatePinUsage(groupPinUsage[g], solutions);

      // D11: Track solutions for diversity check after round 1
      groupSolutions[g].push(...solutions);
      allSolutions.push(...solutions);
    }

    if (!anyActive) break;

    // D11: After round 1 (each group has initial solutions), assess diversity
    if (round === 1) {
      for (let g = 0; g < numGroups; g++) {
        if (groupExhausted[g] || groupSolutions[g].length < 2) continue;
        const diversity = solutionPinDiversity(groupSolutions[g]);
        if (diversity < 0.1) {
          groupLowDiversity[g] = true;
        }
      }
    }
  }

  return allSolutions;
}
