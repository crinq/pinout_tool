// ============================================================
// AC-3 Forward Checking Solver
//
// After each variable assignment, propagates constraints to shrink
// remaining variables' domains. Detects failures earlier and prunes
// more branches than the basic backtracking solver.
//
// Propagation rules:
// 1. Pin exclusivity: assigned pin removed from other ports' domains
// 2. Instance exclusivity: non-shared instance removed from other ports
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { computeTotalCost } from './cost-functions';
import {
  prepareSolverContext,
  evaluateAllConstraints, buildSolution, deduplicateSolutions,
  canAssignPin, assignPin, unassignPin, isSharedInstance, evaluateExpr,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker,
} from './solver';
import type { PatternPart } from '../parser/constraint-ast';

const DEFAULT_CONFIG: SolverConfig = {
  maxSolutions: 100,
  timeoutMs: 5000,
  costWeights: new Map(),
};

export function solveAC3(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (config.costWeights) {
    cfg.costWeights = new Map([...DEFAULT_CONFIG.costWeights, ...config.costWeights]);
  }

  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors);
  if (!ctx) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: errors.length > 0 ? errors : [{ type: 'warning', message: 'No variables to solve' }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
    };
  }

  const solutions: Solution[] = [];

  // Build mutable domains
  const domains: number[][] = ctx.variables.map(v => [...v.domain]);

  // Precompute pin->candidate index mapping for propagation
  // Map pin name -> list of (varIndex, candidateIdx) that use that pin
  const pinToVarCandidates = new Map<string, Array<{ varIdx: number; candIdx: number }>>();
  // Map instance -> list of (varIndex, candidateIdx) that use that instance
  const instanceToVarCandidates = new Map<string, Array<{ varIdx: number; candIdx: number }>>();

  for (let vi = 0; vi < ctx.variables.length; vi++) {
    const v = ctx.variables[vi];
    for (const ci of v.domain) {
      const c = v.candidates[ci];
      const pinKey = c.pin.name;
      if (!pinToVarCandidates.has(pinKey)) pinToVarCandidates.set(pinKey, []);
      pinToVarCandidates.get(pinKey)!.push({ varIdx: vi, candIdx: ci });

      if (c.peripheralInstance) {
        if (!instanceToVarCandidates.has(c.peripheralInstance)) instanceToVarCandidates.set(c.peripheralInstance, []);
        instanceToVarCandidates.get(c.peripheralInstance)!.push({ varIdx: vi, candIdx: ci });
      }
    }
  }

  solveBacktrackAC3(
    ctx.variables, 0, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats, ctx.deepest,
    ctx.lastVarOfConfig, ctx.configRequiresMap,
    domains, pinToVarCandidates, instanceToVarCandidates, ctx.sharedPatterns
  );

  if (solutions.length >= cfg.maxSolutions) {
    errors.push({ type: 'warning', message: `Maximum solutions (${cfg.maxSolutions}) reached.` });
  }
  if (performance.now() - startTime > cfg.timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${solutions.length} solutions.` });
  }

  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, cfg.costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  ctx.stats.solveTimeMs = performance.now() - startTime;

  const deduped = deduplicateSolutions(solutions);
  return { mcuRef: mcu.refName, solutions: deduped, errors, statistics: ctx.stats };
}

/**
 * Check if any port has ALL its configs blocked (every config has at least
 * one unassigned variable with an empty domain). If so, no valid config
 * combination exists for that port — a true dead end.
 *
 * A config is viable if:
 * - All its variables are already assigned (fully resolved), OR
 * - All its unassigned variables have non-empty domains
 */
function hasPortWipeout(
  variables: SolverVariable[],
  domains: number[][],
  assigned: Set<number>
): boolean {
  // Collect ports that have at least one empty-domain unassigned variable
  const emptyVarPorts = new Set<string>();
  for (let i = 0; i < variables.length; i++) {
    if (!assigned.has(i) && domains[i].length === 0) {
      emptyVarPorts.add(variables[i].portName);
    }
  }
  if (emptyVarPorts.size === 0) return false;

  // For each affected port, check if at least one config is still viable
  for (const port of emptyVarPorts) {
    // Track per-config: has unassigned vars? any unassigned var with empty domain?
    const configHasUnassigned = new Map<string, boolean>();
    const configHasEmpty = new Map<string, boolean>();
    for (let i = 0; i < variables.length; i++) {
      if (variables[i].portName !== port) continue;
      const cfg = variables[i].configName;
      if (!configHasUnassigned.has(cfg)) {
        configHasUnassigned.set(cfg, false);
        configHasEmpty.set(cfg, false);
      }
      if (!assigned.has(i)) {
        configHasUnassigned.set(cfg, true);
        if (domains[i].length === 0) configHasEmpty.set(cfg, true);
      }
    }
    // A config is viable if fully assigned OR has no empty unassigned vars
    let anyViable = false;
    for (const [cfg, hasUnassigned] of configHasUnassigned) {
      if (!hasUnassigned || !configHasEmpty.get(cfg)) {
        anyViable = true;
        break;
      }
    }
    if (!anyViable) return true;
  }
  return false;
}

/**
 * Forward-check propagation: after assigning variable varIdx to candidate,
 * remove conflicting candidates from other variables' domains.
 * Returns the list of removed entries (for undo) or null if a port has no viable config.
 */
function propagate(
  candidate: import('./pattern-matcher').SignalCandidate,
  portName: string,
  variables: SolverVariable[],
  domains: number[][],
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[],
  assigned: Set<number>
): Array<{ varIdx: number; candIdx: number }> | null {
  const removed: Array<{ varIdx: number; candIdx: number }> = [];

  // 1. Pin exclusivity: remove this pin from variables in different ports
  const pinEntries = pinToVarCandidates.get(candidate.pin.name);
  if (pinEntries) {
    for (const entry of pinEntries) {
      if (assigned.has(entry.varIdx)) continue;
      if (variables[entry.varIdx].portName === portName) continue;
      const domIdx = domains[entry.varIdx].indexOf(entry.candIdx);
      if (domIdx !== -1) {
        domains[entry.varIdx].splice(domIdx, 1);
        removed.push(entry);
      }
    }
  }

  // 2. Instance exclusivity: if non-shared, remove from other ports
  if (candidate.peripheralInstance && !isSharedInstance(candidate.peripheralInstance, sharedPatterns)) {
    const instEntries = instanceToVarCandidates.get(candidate.peripheralInstance);
    if (instEntries) {
      for (const entry of instEntries) {
        if (assigned.has(entry.varIdx)) continue;
        if (variables[entry.varIdx].portName === portName) continue;
        const domIdx = domains[entry.varIdx].indexOf(entry.candIdx);
        if (domIdx !== -1) {
          domains[entry.varIdx].splice(domIdx, 1);
          removed.push(entry);
        }
      }
    }
  }

  // Check for real wipeout: a port with no viable config remaining
  if (hasPortWipeout(variables, domains, assigned)) {
    // Undo domain changes before reporting wipeout
    undoPropagate(removed, domains);
    return null;
  }

  return removed;
}

/** Undo propagation by restoring removed candidates to domains */
function undoPropagate(
  removed: Array<{ varIdx: number; candIdx: number }>,
  domains: number[][]
): void {
  for (const entry of removed) {
    domains[entry.varIdx].push(entry.candIdx);
  }
}

function solveBacktrackAC3(
  variables: SolverVariable[],
  varIndex: number,
  tracker: PinTracker,
  current: VariableAssignment[],
  configCombinations: Map<string, string>[],
  ports: Map<string, PortSpec>,
  pinnedAssignments: PinnedAssignment[],
  solutions: Solution[],
  maxSolutions: number,
  startTime: number,
  timeoutMs: number,
  stats: SolverStats,
  deepest: { depth: number; assignments: VariableAssignment[] },
  lastVarOfConfig: Map<string, number>,
  configRequiresMap: Map<string, RequireNode[]>,
  domains: number[][],
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[]
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;

  if (varIndex > deepest.depth) {
    deepest.depth = varIndex;
    deepest.assignments = [...current];
  }

  if (varIndex === variables.length) {
    stats.evaluatedCombinations++;
    if (evaluateAllConstraints(current, configCombinations, ports)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length
      );
      solutions.push(solution);
      stats.validSolutions++;
    }
    return;
  }

  const v = variables[varIndex];
  const assigned = new Set<number>();
  for (let i = 0; i < varIndex; i++) assigned.add(i);

  // Iterate over current domain (may have been pruned by propagation)
  const domainCopy = [...domains[varIndex]];
  for (const candidateIdx of domainCopy) {
    if (solutions.length >= maxSolutions) return;
    if (performance.now() - startTime > timeoutMs) return;

    const candidate = v.candidates[candidateIdx];

    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance);
    current.push({ variable: v, candidate });

    // Eager constraint check
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    if (lastVarOfConfig.get(configKey) === varIndex) {
      const requires = configRequiresMap.get(configKey);
      if (requires) {
        const portChannels = new Map<string, VariableAssignment[]>();
        for (const va of current) {
          if (va.variable.portName === v.portName && va.variable.configName === v.configName) {
            if (!portChannels.has(va.variable.channelName)) {
              portChannels.set(va.variable.channelName, []);
            }
            portChannels.get(va.variable.channelName)!.push(va);
          }
        }
        const channelInfo = new Map<string, Map<string, VariableAssignment[]>>();
        channelInfo.set(v.portName, portChannels);

        for (const req of requires) {
          if (!evaluateExpr(req.expression, v.portName, channelInfo)) {
            pruned = true;
            break;
          }
        }
      }
    }

    if (!pruned) {
      // Forward-check propagation
      assigned.add(varIndex);
      const removed = propagate(
        candidate, v.portName,
        variables, domains, pinToVarCandidates, instanceToVarCandidates,
        sharedPatterns, assigned
      );

      if (removed !== null) {
        // No domain wipeout — recurse
        solveBacktrackAC3(
          variables, varIndex + 1, tracker, current,
          configCombinations, ports, pinnedAssignments,
          solutions, maxSolutions, startTime, timeoutMs, stats, deepest,
          lastVarOfConfig, configRequiresMap,
          domains, pinToVarCandidates, instanceToVarCandidates, sharedPatterns
        );
        undoPropagate(removed, domains);
      }
      assigned.delete(varIndex);
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance);
  }
}
