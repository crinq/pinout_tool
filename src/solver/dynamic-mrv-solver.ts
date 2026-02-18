// ============================================================
// Dynamic MRV Solver
//
// Instead of a fixed variable order, dynamically picks the
// unassigned variable with the smallest remaining domain at
// each step. Combined with forward checking for effectiveness.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats } from '../types';
import type { ProgramNode, RequireNode, PatternPart } from '../parser/constraint-ast';
import { computeTotalCost } from './cost-functions';
import {
  prepareSolverContext,
  evaluateAllConstraints, buildSolution, deduplicateSolutions,
  canAssignPin, assignPin, unassignPin, isSharedInstance, evaluateExpr,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker,
} from './solver';

const DEFAULT_CONFIG: SolverConfig = {
  maxSolutions: 100,
  timeoutMs: 5000,
  costWeights: new Map(),
};

export function solveDynamicMRV(
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
  const n = ctx.variables.length;

  // Build mutable domains
  const domains: number[][] = ctx.variables.map(v => [...v.domain]);
  const assigned = new Array<boolean>(n).fill(false);

  // Build last-var-of-config check: we need to know when ALL variables of a (port, config) are assigned
  const configVarIndices = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${ctx.variables[i].portName}\0${ctx.variables[i].configName}`;
    if (!configVarIndices.has(key)) configVarIndices.set(key, []);
    configVarIndices.get(key)!.push(i);
  }

  // Precompute pin -> (varIdx, candIdx)
  const pinToVarCandidates = new Map<string, Array<{ varIdx: number; candIdx: number }>>();
  const instanceToVarCandidates = new Map<string, Array<{ varIdx: number; candIdx: number }>>();

  for (let vi = 0; vi < n; vi++) {
    const v = ctx.variables[vi];
    for (const ci of v.domain) {
      const c = v.candidates[ci];
      if (!pinToVarCandidates.has(c.pin.name)) pinToVarCandidates.set(c.pin.name, []);
      pinToVarCandidates.get(c.pin.name)!.push({ varIdx: vi, candIdx: ci });

      if (c.peripheralInstance) {
        if (!instanceToVarCandidates.has(c.peripheralInstance)) instanceToVarCandidates.set(c.peripheralInstance, []);
        instanceToVarCandidates.get(c.peripheralInstance)!.push({ varIdx: vi, candIdx: ci });
      }
    }
  }

  solveBacktrackDynamic(
    ctx.variables, assigned, domains, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats,
    ctx.configRequiresMap, configVarIndices, 0, n,
    pinToVarCandidates, instanceToVarCandidates, ctx.sharedPatterns
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
 * one unassigned variable with an empty domain).
 *
 * A config is viable if:
 * - All its variables are already assigned (fully resolved), OR
 * - All its unassigned variables have non-empty domains
 */
function hasPortWipeout(
  variables: SolverVariable[],
  domains: number[][],
  assigned: boolean[]
): boolean {
  const emptyVarPorts = new Set<string>();
  for (let i = 0; i < variables.length; i++) {
    if (!assigned[i] && domains[i].length === 0) {
      emptyVarPorts.add(variables[i].portName);
    }
  }
  if (emptyVarPorts.size === 0) return false;

  for (const port of emptyVarPorts) {
    const configHasUnassigned = new Map<string, boolean>();
    const configHasEmpty = new Map<string, boolean>();
    for (let i = 0; i < variables.length; i++) {
      if (variables[i].portName !== port) continue;
      const cfg = variables[i].configName;
      if (!configHasUnassigned.has(cfg)) {
        configHasUnassigned.set(cfg, false);
        configHasEmpty.set(cfg, false);
      }
      if (!assigned[i]) {
        configHasUnassigned.set(cfg, true);
        if (domains[i].length === 0) configHasEmpty.set(cfg, true);
      }
    }
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

/** Forward-check: remove conflicting candidates, return removed list or null on real wipeout */
function propagate(
  candidate: import('./pattern-matcher').SignalCandidate,
  portName: string,
  variables: SolverVariable[],
  domains: number[][],
  assigned: boolean[],
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[]
): Array<{ varIdx: number; candIdx: number }> | null {
  const removed: Array<{ varIdx: number; candIdx: number }> = [];

  // Pin exclusivity across ports
  const pinEntries = pinToVarCandidates.get(candidate.pin.name);
  if (pinEntries) {
    for (const entry of pinEntries) {
      if (assigned[entry.varIdx]) continue;
      if (variables[entry.varIdx].portName === portName) continue;
      const domIdx = domains[entry.varIdx].indexOf(entry.candIdx);
      if (domIdx !== -1) {
        domains[entry.varIdx].splice(domIdx, 1);
        removed.push(entry);
      }
    }
  }

  // Instance exclusivity across ports
  if (candidate.peripheralInstance && !isSharedInstance(candidate.peripheralInstance, sharedPatterns)) {
    const instEntries = instanceToVarCandidates.get(candidate.peripheralInstance);
    if (instEntries) {
      for (const entry of instEntries) {
        if (assigned[entry.varIdx]) continue;
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

function undoPropagate(
  removed: Array<{ varIdx: number; candIdx: number }>,
  domains: number[][]
): void {
  for (const entry of removed) {
    domains[entry.varIdx].push(entry.candIdx);
  }
}

function solveBacktrackDynamic(
  variables: SolverVariable[],
  assigned: boolean[],
  domains: number[][],
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
  configRequiresMap: Map<string, RequireNode[]>,
  configVarIndices: Map<string, number[]>,
  depth: number,
  totalVars: number,
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[]
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;

  if (depth === totalVars) {
    // All variables assigned — check all config combinations
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

  // Dynamic MRV: pick unassigned variable with smallest non-empty domain
  // Variables with empty domains are for inactive configs — skip them
  let bestVar = -1;
  let bestSize = Infinity;
  let unassignedCount = 0;
  for (let i = 0; i < totalVars; i++) {
    if (assigned[i]) continue;
    unassignedCount++;
    if (domains[i].length > 0 && domains[i].length < bestSize) {
      bestSize = domains[i].length;
      bestVar = i;
    }
  }

  if (bestVar === -1) {
    if (unassignedCount === 0) {
      // All assigned — this shouldn't happen (depth check above catches it)
      return;
    }
    // All unassigned variables have empty domains — check if it's a real wipeout
    // or if they're all for inactive configs. Either way, we can't proceed with
    // normal assignment. Try to complete the solution with remaining vars "skipped".
    // Mark all empty-domain vars as assigned and try to evaluate.
    const skipped: number[] = [];
    for (let i = 0; i < totalVars; i++) {
      if (!assigned[i]) { assigned[i] = true; skipped.push(i); }
    }
    stats.evaluatedCombinations++;
    if (evaluateAllConstraints(current, configCombinations, ports)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length
      );
      solutions.push(solution);
      stats.validSolutions++;
    }
    for (const i of skipped) assigned[i] = false;
    return;
  }

  const vi = bestVar;
  const v = variables[vi];
  assigned[vi] = true;

  const domainCopy = [...domains[vi]];
  for (const candidateIdx of domainCopy) {
    if (solutions.length >= maxSolutions) return;
    if (performance.now() - startTime > timeoutMs) return;

    const candidate = v.candidates[candidateIdx];

    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance);
    current.push({ variable: v, candidate });

    // Eager constraint check: if all variables of this (port, config) are now assigned
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    const configVars = configVarIndices.get(configKey);
    if (configVars && configVars.every(idx => assigned[idx])) {
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
      // Forward checking propagation
      const removed = propagate(
        candidate, v.portName,
        variables, domains, assigned,
        pinToVarCandidates, instanceToVarCandidates, sharedPatterns
      );

      if (removed !== null) {
        solveBacktrackDynamic(
          variables, assigned, domains, tracker, current,
          configCombinations, ports, pinnedAssignments,
          solutions, maxSolutions, startTime, timeoutMs, stats,
          configRequiresMap, configVarIndices, depth + 1, totalVars,
          pinToVarCandidates, instanceToVarCandidates, sharedPatterns
        );
        undoPropagate(removed, domains);
      }
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance);
  }

  assigned[vi] = false;
}
