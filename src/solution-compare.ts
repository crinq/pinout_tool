// ============================================================
// Solution compare: diff N solutions' pin assignments.
//
// Two solutions "agree" on a pin when they map it to the same signal,
// port, and channel. When any pair disagrees (or one leaves the pin
// unassigned while another uses it), the pin is *divergent*. The
// package viewer renders divergent pins with a per-solution pulse.
// ============================================================

import type { Assignment, Solution } from './types';

/** One solution's contribution to a divergent pin, or null if unassigned. */
export interface DivergentSlice {
  solutionIndex: number;   // position in the selected list (drives color)
  solutionId: number;
  solutionName: string;
  assignment: Assignment | null;
}

export interface DivergentPin {
  pinName: string;
  slices: DivergentSlice[];
}

export interface CompareResult {
  /** Assignments common to every selected solution — safe to render normally. */
  common: Assignment[];
  /** Pins that differ (including "assigned in one, missing in another"). */
  divergent: Map<string, DivergentPin>;
}

/** Flatten a Solution to unique (pin, signal, port, channel) tuples. */
export function flattenAssignments(solution: Solution): Assignment[] {
  const seen = new Set<string>();
  const out: Assignment[] = [];
  for (const ca of solution.configAssignments) {
    for (const a of ca.assignments) {
      const key = `${a.pinName}:${a.signalName}:${a.portName}:${a.channelName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

function assignmentKey(a: Assignment): string {
  return `${a.signalName}|${a.portName}|${a.channelName}`;
}

/**
 * Compare N solutions. A pin is "common" when every solution assigns it
 * to the same signal/port/channel — or every solution leaves it out. If
 * any solution disagrees, it becomes divergent (with one slice per input,
 * carrying null when that solution didn't touch the pin).
 */
export function compareSolutions(solutions: Solution[]): CompareResult {
  if (solutions.length === 0) {
    return { common: [], divergent: new Map() };
  }
  if (solutions.length === 1) {
    return { common: flattenAssignments(solutions[0]), divergent: new Map() };
  }

  // Per-solution pin → assignment lookup
  const perSolution: Map<string, Assignment>[] = solutions.map(sol => {
    const m = new Map<string, Assignment>();
    for (const a of flattenAssignments(sol)) {
      // First-wins if a pin somehow gets two rows (shouldn't happen post-flatten).
      if (!m.has(a.pinName)) m.set(a.pinName, a);
    }
    return m;
  });

  // Union of all pin names touched by any solution
  const allPins = new Set<string>();
  for (const m of perSolution) for (const pin of m.keys()) allPins.add(pin);

  const common: Assignment[] = [];
  const divergent = new Map<string, DivergentPin>();

  for (const pin of allPins) {
    const slices: DivergentSlice[] = solutions.map((sol, idx) => ({
      solutionIndex: idx,
      solutionId: sol.id,
      solutionName: sol.name || `Solution ${sol.id}`,
      assignment: perSolution[idx].get(pin) ?? null,
    }));

    // Every solution agreed (same key, or all null — but "all null" means
    // no one touched the pin, so it wouldn't be in allPins).
    const firstKey = slices[0].assignment ? assignmentKey(slices[0].assignment) : null;
    const allAgree = slices.every(s =>
      (s.assignment === null && firstKey === null) ||
      (s.assignment !== null && firstKey !== null && assignmentKey(s.assignment) === firstKey)
    );

    if (allAgree && slices[0].assignment) {
      common.push(slices[0].assignment);
    } else {
      divergent.set(pin, { pinName: pin, slices });
    }
  }

  return { common, divergent };
}

/**
 * Palette for per-selected-solution colors. Chosen to be visually distinct
 * from the default port colors used by peripheral highlights.
 */
export const SOLUTION_COMPARE_COLORS = [
  '#ec4899', // pink
  '#22d3ee', // cyan
  '#f97316', // orange
  '#a855f7', // purple
  '#84cc16', // lime
  '#eab308', // amber
  '#0ea5e9', // sky
  '#ef4444', // red
];

export function solutionCompareColor(index: number): string {
  return SOLUTION_COMPARE_COLORS[index % SOLUTION_COMPARE_COLORS.length];
}
