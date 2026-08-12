// ============================================================
// F1: Bipartite Matching Feasibility Oracle
//
// For a fixed instance group, pin assignment minus require-
// constraints is a bipartite matching problem: within one config
// combination every active variable needs a distinct logical pin
// (cross-port pins are exclusive; within a (port, config) each pin
// is used at most once — see canAssignPin).
//
// If any combo has no perfect matching over the active variables,
// the group is PROVABLY pin-infeasible — no DFS needed. The failing
// Hall set (variables + their united pin pool) names the reason and
// feeds instance-level nogood learning (CEGAR solver).
//
// Sound relaxations (may pass an infeasible group, never reject a
// feasible one): optional variables and very-large-domain variables
// (GPIO-style) are excluded from the matching; physical-position
// and signal-exclusivity conflicts are ignored.
// ============================================================

import { isGpioVariable, type SolverVariable } from './solver';
import { maximumMatching } from './bipartite';
import { varKey, type InstanceGroup } from './two-phase-solver';

export interface HallViolator {
  comboIdx: number;
  /** Indices (into the variables array) of the unmatched Hall set */
  varIdxs: number[];
  /** United candidate pin pool of the Hall set (|pool| < |varIdxs|) */
  pinPool: string[];
}

export interface FeasibilityResult {
  feasible: boolean;
  violator?: HallViolator;
}

export interface OracleOptions {
  /** Variables with more distinct candidate pins than this are skipped (sound relaxation). */
  maxDomain?: number;
  /** performance.now() deadline; when exceeded remaining combos pass unchecked (sound). */
  deadline?: number;
  /** Check at most this many config combos (sound relaxation). */
  maxCombos?: number;
}

const DEFAULT_MAX_DOMAIN = 24;

/**
 * Check whether a group's instance assignment can possibly be pin-routed.
 * Pass `group = null` to check the unrestricted problem (probe phase).
 */
export function checkGroupPinFeasibility(
  variables: SolverVariable[],
  configCombinations: Map<string, string>[],
  group: InstanceGroup | null,
  opts: OracleOptions = {}
): FeasibilityResult {
  const maxDomain = opts.maxDomain ?? DEFAULT_MAX_DOMAIN;
  const maxCombos = opts.maxCombos ?? configCombinations.length;

  // Precompute per-variable pin lists (instance-filtered, deduped)
  const pinLists: string[][] = variables.map(v => {
    const required = group?.assignments.get(varKey(v));
    const pins = new Set<string>();
    for (const ci of v.domain) {
      const c = v.candidates[ci];
      if (required && c.peripheralInstance !== required) continue;
      pins.add(c.pin.name);
    }
    return [...pins];
  });

  const comboCount = Math.min(configCombinations.length, maxCombos);
  for (let comboIdx = 0; comboIdx < comboCount; comboIdx++) {
    if (opts.deadline !== undefined && performance.now() > opts.deadline) {
      return { feasible: true }; // out of time — pass unchecked (sound)
    }
    const combo = configCombinations[comboIdx];

    // Active, matchable variables for this combo
    const active: number[] = [];
    for (let vi = 0; vi < variables.length; vi++) {
      const v = variables[vi];
      if (combo.get(v.portName) !== v.configName) continue;
      if (v.optional) continue; // may stay unassigned — exclude (sound)
      if (isGpioVariable(v)) continue; // huge domains — exclude (sound)
      // Variable constrained by the group but with zero matching candidates:
      // instant infeasibility regardless of domain size.
      if (pinLists[vi].length === 0) {
        return {
          feasible: false,
          violator: { comboIdx, varIdxs: [vi], pinPool: [] },
        };
      }
      if (pinLists[vi].length > maxDomain) continue; // ponytail: skip wide domains, they never bind
      active.push(vi);
    }
    if (active.length === 0) continue;

    const result = maximumMatching(active, pinLists);
    if (result.unmatched !== -1) {
      const hall = extractHallSet(result.unmatched, pinLists, result.pinToVar, result.pinIndex);
      return {
        feasible: false,
        violator: {
          comboIdx,
          varIdxs: hall.vars,
          pinPool: hall.pins,
        },
      };
    }
  }

  return { feasible: true };
}

/**
 * From an unmatchable variable, walk alternating paths to collect the Hall
 * violator: a variable set W with |N(W)| < |W|.
 */
function extractHallSet(
  unmatchedVar: number,
  pinLists: string[][],
  pinToVar: Int32Array,
  pinIndex: Map<string, number>
): { vars: number[]; pins: string[] } {
  const varSet = new Set<number>([unmatchedVar]);
  const pinSet = new Set<string>();
  const queue = [unmatchedVar];

  while (queue.length > 0) {
    const vi = queue.pop()!;
    for (const p of pinLists[vi]) {
      if (pinSet.has(p)) continue;
      pinSet.add(p);
      const owner = pinToVar[pinIndex.get(p)!];
      if (owner !== -1 && !varSet.has(owner)) {
        varSet.add(owner);
        queue.push(owner);
      }
    }
  }

  return { vars: [...varSet], pins: [...pinSet] };
}
