// ============================================================
// Dynamic MRV Solver
//
// Instead of a fixed variable order, dynamically picks the
// unassigned variable with the smallest remaining domain at
// each step. Combined with forward checking for effectiveness.
// ============================================================

import type { Mcu, SolverResult, SolverError, Solution, SolverStats, DmaData } from '../types';
import type { ProgramNode, RequireNode, PatternPart } from '../parser/constraint-ast';
import {
  prepareSolverContext, tryEmitSolution,
  canAssignPin, assignPin, unassignPin, checkRequires,
  propagateShared, undoPropagateShared, buildPinLookups,
  buildSameInstancePropagator, propagateSameInstance,
  mergeSolverConfig, emptyResult, pushSolverWarnings, finalizeSolutions,
  type SolverConfig, type SolverVariable, type VariableAssignment,
  type PortSpec, type PinnedAssignment, type PinTracker, type EvalMcuInfo,
  type SameInstancePropagator,
} from './solver';

export function solveDynamicMRV(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = mergeSolverConfig(config);

  const startTime = performance.now();
  const errors: SolverError[] = [];

  const ctx = prepareSolverContext(ast, mcu, errors, cfg.skipGpioMapping);
  if (!ctx) {
    return emptyResult(mcu.refName, errors);
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

  const { pinToVarCandidates, instanceToVarCandidates } = buildPinLookups(ctx.variables);
  const sameInstance = buildSameInstancePropagator(ctx.variables, ctx.configRequiresMap);

  solveBacktrackDynamic(
    ctx.variables, assigned, domains, ctx.tracker, [],
    ctx.configCombinations, ctx.ports, ctx.pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, ctx.stats,
    ctx.configRequiresMap, configVarIndices, 0, n,
    pinToVarCandidates, instanceToVarCandidates, ctx.sharedPatterns,
    ctx.dmaData, sameInstance, ctx.mcuInfo
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);

  return finalizeSolutions(
    solutions, mcu, cfg.costWeights, errors, ctx.stats, startTime,
    ctx.gpioVarsPerConfig, ctx.reservedPins, ctx.pinnedAssignments,
  );
}

export function solveBacktrackDynamic(
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
  sharedPatterns: PatternPart[],
  dmaData?: DmaData,
  sameInstance?: SameInstancePropagator,
  mcuInfo?: EvalMcuInfo,
  budget?: { steps: number }
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;
  if (budget && --budget.steps < 0) return;

  if (depth === totalVars) {
    // All variables assigned - check all config combinations
    tryEmitSolution(
      current, configCombinations, ports, pinnedAssignments,
      solutions, stats, startTime, dmaData, mcuInfo, sharedPatterns,
    );
    return;
  }

  // Dynamic MRV: pick unassigned variable with smallest non-empty domain
  // Variables with empty domains are for inactive configs - skip them
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
      // All assigned - this shouldn't happen (depth check above catches it)
      return;
    }
    // All unassigned variables have empty domains. A mandatory one means its
    // (port, config) is wiped out — a combo activating that config would be
    // emitted with missing pins, so restrict evaluation to combos avoiding
    // every wiped config. Optional (`?=`) vars are legally skippable anywhere.
    const skipped: number[] = [];
    const wiped = new Set<string>();
    for (let i = 0; i < totalVars; i++) {
      if (!assigned[i]) {
        assigned[i] = true;
        skipped.push(i);
        if (!variables[i].optional) wiped.add(`${variables[i].portName}\0${variables[i].configName}`);
      }
    }
    const viableCombos = wiped.size === 0
      ? configCombinations
      : configCombinations.filter(combo => {
          for (const [port, cfg] of combo) {
            if (wiped.has(`${port}\0${cfg}`)) return false;
          }
          return true;
        });
    if (viableCombos.length > 0) {
      tryEmitSolution(
        current, viableCombos, ports, pinnedAssignments,
        solutions, stats, startTime, dmaData, mcuInfo, sharedPatterns,
      );
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

    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName, candidate.pin.physical.position)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName, candidate.pin.physical.position);
    current.push({ variable: v, candidate });

    // Eager constraint check: if all variables of this (port, config) are now assigned
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    const configVars = configVarIndices.get(configKey);
    if (configVars && configVars.every(idx => assigned[idx])) {
      const requires = configRequiresMap.get(configKey);
      if (requires && !checkRequires(requires, v.portName, v.configName, current, dmaData, mcuInfo)) {
        pruned = true;
      }
    }

    if (!pruned) {
      // Forward checking propagation (F2: same_instance first, shared wipeout check covers both)
      const siRemoved = sameInstance
        ? propagateSameInstance(vi, candidate, sameInstance, variables, domains, i => assigned[i])
        : null;
      const removed = propagateShared(
        candidate, v.portName,
        variables, domains, i => assigned[i],
        pinToVarCandidates, instanceToVarCandidates, sharedPatterns
      );

      if (removed !== null) {
        solveBacktrackDynamic(
          variables, assigned, domains, tracker, current,
          configCombinations, ports, pinnedAssignments,
          solutions, maxSolutions, startTime, timeoutMs, stats,
          configRequiresMap, configVarIndices, depth + 1, totalVars,
          pinToVarCandidates, instanceToVarCandidates, sharedPatterns,
          dmaData, sameInstance, mcuInfo, budget
        );
        undoPropagateShared(removed, domains);
      }
      if (siRemoved) undoPropagateShared(siRemoved, domains);
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance, candidate.signalName, candidate.pin.physical.position);
  }

  // Optional variable: also explore leaving it unassigned — a fully
  // conflicting `?=` channel must not kill branches valid without it.
  if (v.optional && solutions.length < maxSolutions) {
    solveBacktrackDynamic(
      variables, assigned, domains, tracker, current,
      configCombinations, ports, pinnedAssignments,
      solutions, maxSolutions, startTime, timeoutMs, stats,
      configRequiresMap, configVarIndices, depth + 1, totalVars,
      pinToVarCandidates, instanceToVarCandidates, sharedPatterns,
      dmaData, sameInstance, mcuInfo, budget
    );
  }

  assigned[vi] = false;
}
