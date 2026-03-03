// ============================================================
// Port Priority Utilities
//
// Computes a priority score for each (port, config) based on
// total pin availability across all channels. Ports with fewer
// available pins are more constrained and should be assigned first.
// ============================================================

import type { SolverVariable } from './solver';

export type PriorityFn = (variables: SolverVariable[]) => Map<string, number>;

/**
 * Compute port priority: for each (portName, configName) pair,
 * sum the unique pin counts across all channels.
 * Lower value = more constrained = should be assigned first.
 */
export function computePortPriority(variables: SolverVariable[]): Map<string, number> {
  const priority = new Map<string, number>();
  for (const v of variables) {
    const key = `${v.portName}\0${v.configName}`;
    const uniquePins = new Set<string>();
    for (const c of v.candidates) {
      uniquePins.add(c.pin.name);
    }
    priority.set(key, (priority.get(key) ?? 0) + uniquePins.size);
  }
  return priority;
}

/**
 * Compute normalized port priority: for each (portName, configName) pair,
 * divide the total unique pin count by the number of channels (variables).
 * This gives the average candidates per required signal.
 * Lower ratio = more constrained = should be assigned first.
 */
export function computeNormalizedPortPriority(variables: SolverVariable[]): Map<string, number> {
  const pinSum = new Map<string, number>();
  const channelCount = new Map<string, number>();
  for (const v of variables) {
    const key = `${v.portName}\0${v.configName}`;
    const uniquePins = new Set<string>();
    for (const c of v.candidates) {
      uniquePins.add(c.pin.name);
    }
    pinSum.set(key, (pinSum.get(key) ?? 0) + uniquePins.size);
    channelCount.set(key, (channelCount.get(key) ?? 0) + 1);
  }
  const priority = new Map<string, number>();
  for (const [key, pins] of pinSum) {
    priority.set(key, pins / channelCount.get(key)!);
  }
  return priority;
}

/**
 * In-place sort: primary by port priority ASC (most constrained first),
 * secondary by domain size ASC (MRV tiebreaker within port).
 */
export function sortByPortPriority<T extends { portName: string; configName: string; domain: number[] }>(
  variables: T[],
  priority: Map<string, number>
): void {
  variables.sort((a, b) => {
    const pa = priority.get(`${a.portName}\0${a.configName}`) ?? Infinity;
    const pb = priority.get(`${b.portName}\0${b.configName}`) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return a.domain.length - b.domain.length;
  });
}
