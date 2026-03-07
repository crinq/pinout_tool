// Shared solver utilities

/**
 * Mulberry32 - deterministic seeded PRNG.
 * Returns a function that produces uniform random numbers in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle using a provided PRNG. Returns a new array.
 */
export function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Deterministic domain diversification for Phase 1 instance exploration.
 * - Round 0: cost-sorted as-is (best-first)
 * - Round 1: reversed (worst-first, guarantees different instance at front)
 * - Rounds 2..n: rotate by (round-1), each instance gets a turn at front
 * - Beyond n: random shuffle with seed
 */
export function diversifyDomain(domain: readonly number[], round: number, seed: number): number[] {
  const n = domain.length;
  if (n <= 1 || round === 0) return [...domain];
  if (round === 1) return [...domain].reverse();
  const rotateRounds = n - 1; // rounds 2..n cover rotations 1..n-1
  if (round - 1 <= rotateRounds) {
    const r = (round - 1) % n;
    return [...domain.slice(r), ...domain.slice(0, r)];
  }
  return shuffleArray([...domain], mulberry32(seed));
}
