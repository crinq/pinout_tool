// ============================================================
// Bipartite matching (Kuhn's augmenting paths)
//
// Dependency-free so both the instance-feasibility oracle and the GPIO
// availability check can use it without an import cycle.
// ============================================================

export interface MatchingResult {
  /** -1 when a perfect matching exists, else the first unmatchable variable index */
  unmatched: number;
  pinToVar: Int32Array; // pin slot -> variable index (or -1)
  pinIndex: Map<string, number>;
}

/** Kuhn's augmenting-path matching. Small graphs (≤ ~80 vars) — no need for Hopcroft-Karp. */
export function maximumMatching(active: number[], pinLists: string[][]): MatchingResult {
  const pinIndex = new Map<string, number>();
  for (const vi of active) {
    for (const p of pinLists[vi]) {
      if (!pinIndex.has(p)) pinIndex.set(p, pinIndex.size);
    }
  }
  const pinToVar = new Int32Array(pinIndex.size).fill(-1);
  const visited = new Uint8Array(pinIndex.size);

  const tryAugment = (vi: number): boolean => {
    for (const p of pinLists[vi]) {
      const pi = pinIndex.get(p)!;
      if (visited[pi]) continue;
      visited[pi] = 1;
      if (pinToVar[pi] === -1 || tryAugment(pinToVar[pi])) {
        pinToVar[pi] = vi;
        return true;
      }
    }
    return false;
  };

  for (const vi of active) {
    visited.fill(0);
    if (!tryAugment(vi)) {
      return { unmatched: vi, pinToVar, pinIndex };
    }
  }
  return { unmatched: -1, pinToVar, pinIndex };
}

/**
 * Whether every entry of `pinLists` can be given a distinct pin — i.e. the
 * bipartite graph has a perfect matching on the variable side. Used by the
 * GPIO availability check for pin-restricted IN/OUT channels.
 */
export function hasPerfectMatching(pinLists: string[][]): boolean {
  const active = pinLists.map((_, i) => i);
  return maximumMatching(active, pinLists).unmatched === -1;
}

