// ============================================================
// CEGAR Instance-Refinement Solver (CIR)
//
// Two-phase solving as a closed abstraction-refinement loop:
//
//   discover instance groups  (Phase 1, nogood- and blocking-aware)
//     → triage with the matching oracle (F1): provably unroutable
//       groups die in microseconds and their Hall violator becomes
//       a *certified* instance nogood constraining all future
//       discovery
//     → probe survivors with a growing backtrack budget (Luby-style
//       doubling); producers get permuted (Phase 1.5) and re-mined
//       for pin-level diversity
//
// There is no fixed Phase 1 / Phase 2 time split: discovery runs
// only while the probe queue is low, probes fail fast on small
// budgets and re-queue with bigger ones — compute flows to
// whichever phase is currently productive (time-to-first-solution
// stays low, diversity accumulates for the rest of the budget).
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, SolverStats } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { resolveTemplates } from '../parser/template-resolver';
import { getStdlibTemplates } from '../parser/stdlib-macros';
import {
  extractPorts, resolveReservePatterns, extractPinnedAssignments,
  extractSharedPatterns, resolveAllVariables,
  generateConfigCombinations,
  emptyResult, pushSolverWarnings, finalizeSolutions,
  partitionGpioVariables, isGpioVariable,
  configsHaveDma, pinnedOccupiedPins } from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  buildInstanceVariables, solvePhase1, solvePhase2ForGroup,
  groupFingerprint, varKey, sortInstanceDomainsByCost,
  type InstanceGroup, type InstanceTracker, type InstanceAssignment,
} from './two-phase-solver';
import { checkGroupPinFeasibility, type HallViolator } from './matching-oracle';
import { computePortPriority, sortByPortPriority } from './port-priority';
import { generatePermutedGroups } from './group-permutation';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';
import { mulberry32, diversifyDomain } from './solver-utils';

const MAX_DISCOVERY_ROUNDS = 20;
const STALE_ROUNDS_LIMIT = 3;
const PROBE_STEPS_INITIAL = 2000;   // backtracks for the first probe of a group
const PROBE_GROWTH = 4;             // budget multiplier per re-queue
const PROBE_MAX_ATTEMPTS = 3;
const PROBE_SOLUTION_CAP = 5;       // existence + a few; mining happens later
const MAX_NOGOODS = 500;
const LOW_WATER_QUEUE = 8;          // discover more groups when queue drops below
const MAX_PERMS_PER_GROUP = 50;

interface Probe {
  group: InstanceGroup;
  steps: number;
  attempt: number;
}

/** A certified instance nogood: this (varKey → instance) subset can never pin-route. */
interface InstanceNogood {
  entries: Array<{ key: string; instance: string }>;
}

export function solveCegar(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig,
  seedGroups?: InstanceGroup[]
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];
  const deadline = () => performance.now() - startTime > config.timeoutMs;

  // ---------- Setup (mirrors the other two-phase solvers) ----------
  const { ast: expandedAst, errors: macroErrors } = resolveTemplates(ast, getStdlibTemplates());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) for (const p of pinnedOccupiedPins(pa)) reservedPinSet.add(p);
  const reservedPeripheralSet = new Set(reserved.peripherals);

  const configCombinations = generateConfigCombinations(ports);
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);

  if (allVariables.length === 0) {
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }
  const emptyVar = allVariables.find(v => v.domain.length === 0 && !v.optional);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }

  const nonEmptyVars = allVariables.filter(v => v.domain.length > 0 || !v.optional);
  const { solveVars, gpioVars, gpioVarsPerConfig } = partitionGpioVariables(nonEmptyVars, !!config.skipGpioMapping);
  if (solveVars.length === 0 && gpioVars.length === 0) {
    return emptyResult(mcu.refName, errors, configCombinations.length, startTime);
  }
  if (gpioVars.length > 0) {
    errors.push({ type: 'warning', message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only` });
  }

  const portPriority = computePortPriority(solveVars);
  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0) configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
    }
  }

  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  // ---------- CEGAR state ----------
  const nogoods: InstanceNogood[] = [];
  const nogoodKeys = new Set<string>();
  // varKey\0instance -> nogoods containing that entry (fast partial check)
  const nogoodIndex = new Map<string, InstanceNogood[]>();
  const groupFingerprints = new Set<string>();
  const probeQueue: Probe[] = [];
  const producers: InstanceGroup[] = [];
  const producerFingerprints = new Set<string>();
  const solutions: Solution[] = [];
  const domainCache = new Map<string, number[]>();
  const rng = mulberry32(0xC1CADA);
  let oracleRejects = 0;
  let probeFails = 0;

  const canonicalNogood = (entries: Array<{ key: string; instance: string }>): string =>
    entries.map(e => `${e.key}=${e.instance}`).sort().join('&');

  const addNogood = (entries: Array<{ key: string; instance: string }>): void => {
    if (entries.length === 0 || nogoods.length >= MAX_NOGOODS) return;
    const canon = canonicalNogood(entries);
    if (nogoodKeys.has(canon)) return;
    nogoodKeys.add(canon);
    const ng: InstanceNogood = { entries };
    nogoods.push(ng);
    for (const e of entries) {
      const k = `${e.key}\0${e.instance}`;
      if (!nogoodIndex.has(k)) nogoodIndex.set(k, []);
      nogoodIndex.get(k)!.push(ng);
    }
  };

  const groupHitsNogood = (assignments: Map<string, string>): boolean => {
    for (const ng of nogoods) {
      let all = true;
      for (const e of ng.entries) {
        if (assignments.get(e.key) !== e.instance) { all = false; break; }
      }
      if (all) return true;
    }
    return false;
  };

  // Phase 1 pruning hook: after the latest assignment, check nogoods that
  // contain it — prune as soon as a full nogood is present in the partial.
  const isBlocked = (current: InstanceAssignment[]): boolean => {
    const last = current[current.length - 1];
    const lastKey = `${varKey(last.variable)}\0${last.instance}`;
    const candidates = nogoodIndex.get(lastKey);
    if (!candidates || candidates.length === 0) return false;
    const assigned = new Map<string, string>();
    for (const ia of current) assigned.set(varKey(ia.variable), ia.instance);
    for (const ng of candidates) {
      let all = true;
      for (const e of ng.entries) {
        if (assigned.get(e.key) !== e.instance) { all = false; break; }
      }
      if (all) return true;
    }
    return false;
  };

  // ---------- Oracle triage + nogood learning ----------

  /** Certify + minimize an instance nogood from a Hall violator. */
  const learnFromViolator = (violator: HallViolator, group: InstanceGroup): void => {
    let entries: Array<{ key: string; instance: string }> = [];
    for (const vi of violator.varIdxs) {
      const key = varKey(solveVars[vi]);
      const inst = group.assignments.get(key);
      if (inst) entries.push({ key, instance: inst });
    }
    if (entries.length === 0) return;

    // The violator alone must already be infeasible (certification), since
    // the oracle proof only involved these variables' restricted pools.
    const test = (subset: Array<{ key: string; instance: string }>): boolean =>
      !checkGroupPinFeasibility(solveVars, configCombinations, {
        assignments: new Map(subset.map(e => [e.key, e.instance])),
      }).feasible;

    if (!test(entries)) return; // relaxation artifact — don't learn

    // Greedy minimization: drop entries that aren't needed for infeasibility
    if (entries.length > 1) {
      for (let i = entries.length - 1; i >= 0 && entries.length > 1; i--) {
        const without = entries.filter((_, j) => j !== i);
        if (test(without)) entries = without;
      }
    }
    addNogood(entries);
  };

  /** Triage a freshly discovered group. Returns true when queued for probing. */
  const triage = (group: InstanceGroup): boolean => {
    if (groupHitsNogood(group.assignments)) return false;
    const res = checkGroupPinFeasibility(solveVars, configCombinations, group, {
      deadline: startTime + config.timeoutMs,
    });
    if (!res.feasible) {
      oracleRejects++;
      if (res.violator) learnFromViolator(res.violator, group);
      return false;
    }
    probeQueue.push({ group, steps: PROBE_STEPS_INITIAL, attempt: 0 });
    return true;
  };

  // ---------- Probing ----------

  const solveGroup = (group: InstanceGroup, maxSol: number, seed: number,
    pinUsage?: Map<string, number>, budget?: { steps: number }): Solution[] =>
    solvePhase2ForGroup(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      undefined, dmaData, domainCache, mcu, config.costWeights, seed, pinUsage, budget
    );

  /** Probe one group with its step budget. */
  const runProbe = (probe: Probe): void => {
    const budget = { steps: probe.steps };
    const sols = solveGroup(probe.group, PROBE_SOLUTION_CAP, 0, undefined, budget);
    if (sols.length > 0) {
      solutions.push(...sols);
      const fp = groupFingerprint(probe.group.assignments);
      if (!producerFingerprints.has(fp) && producers.length < config.maxGroups) {
        producerFingerprints.add(fp);
        producers.push(probe.group);
        // Phase 1.5: permutations of a *proven-routable* group are prime
        // candidates — triage them like discovered groups.
        const perms = generatePermutedGroups(
          probe.group, allInstanceVars, groupFingerprints, MAX_PERMS_PER_GROUP, rng
        );
        for (const pg of perms) {
          if (probeQueue.length >= config.maxGroups * 2) break;
          triage(pg);
        }
      }
      return;
    }
    probeFails++;
    if (budget.steps <= 0 && probe.attempt + 1 < PROBE_MAX_ATTEMPTS) {
      // Budget exhausted mid-tree: the group may still be routable — retry bigger
      probeQueue.push({
        group: probe.group,
        steps: probe.steps * PROBE_GROWTH,
        attempt: probe.attempt + 1,
      });
    }
    // Tree exhausted with zero solutions: pin-infeasible for reasons beyond
    // matching (requires/DMA). No oracle certificate — just don't reprocess.
  };

  // ---------- Discovery (one round across config combos) ----------

  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));
  const groupsPerCombo = new Map<number, number>();
  let discoveryRound = 0;
  let staleRounds = 0;
  let discoveryDone = false;

  const discoverRound = (): number => {
    const before = groupFingerprints.size;
    const comboIndices = [...configCombinations.keys()];
    if (discoveryRound > 0) {
      comboIndices.sort((a, b) => (groupsPerCombo.get(a) ?? 0) - (groupsPerCombo.get(b) ?? 0));
    }

    for (const comboIdx of comboIndices) {
      if (deadline()) break;
      if (groupFingerprints.size >= config.maxGroups * 2) break;
      const combo = configCombinations[comboIdx];

      let activeVars = allInstanceVars.filter(iv => combo.get(iv.portName) === iv.configName);
      if (activeVars.length === 0) continue;

      if (discoveryRound === 0) {
        sortByPortPriority(activeVars, portPriority);
      } else {
        activeVars = activeVars.map(iv => ({
          ...iv,
          domain: diversifyDomain(iv.domain, discoveryRound, discoveryRound * 77777 + comboIdx * 13),
        }));
        activeVars.sort((a, b) => a.domain.length - b.domain.length);
      }

      const lastVarOfConfig = new Map<string, number>();
      for (let i = 0; i < activeVars.length; i++) {
        lastVarOfConfig.set(`${activeVars[i].portName}\0${activeVars[i].configName}`, i);
      }
      const tracker: InstanceTracker = {
        instanceOwner: new Map(), instanceRefCount: new Map(), sharedPatterns,
      };
      const comboGroups: InstanceGroup[] = [];
      solvePhase1(
        activeVars, 0, tracker, [], ports, comboGroups, maxGroupsPerCombo,
        startTime, config.timeoutMs, lastVarOfConfig, configRequiresMap,
        dmaData, isBlocked
      );

      for (const g of comboGroups) {
        const fp = groupFingerprint(g.assignments);
        if (groupFingerprints.has(fp)) continue;
        groupFingerprints.add(fp);
        groupsPerCombo.set(comboIdx, (groupsPerCombo.get(comboIdx) ?? 0) + 1);
        triage(g);
      }
    }

    discoveryRound++;
    return groupFingerprints.size - before;
  };

  // Seed groups from other solvers (adaptive pipeline: the hybrid trick —
  // groups reverse-mapped from known-good pin solutions probe first)
  if (seedGroups) {
    for (const g of seedGroups) {
      const fp = groupFingerprint(g.assignments);
      if (groupFingerprints.has(fp)) continue;
      groupFingerprints.add(fp);
      triage(g);
    }
  }

  // ---------- Main refinement loop ----------
  // Alternate: keep the probe queue fed, drain it, grow budgets on retry.
  while (!deadline()) {
    if (!discoveryDone && probeQueue.length < LOW_WATER_QUEUE) {
      const found = discoverRound();
      staleRounds = found === 0 ? staleRounds + 1 : 0;
      if (discoveryRound >= MAX_DISCOVERY_ROUNDS || staleRounds >= STALE_ROUNDS_LIMIT) {
        discoveryDone = true;
      }
      continue;
    }
    if (probeQueue.length > 0) {
      runProbe(probeQueue.shift()!);
      continue;
    }
    if (discoveryDone) break;
  }

  // ---------- Diversity mining on proven producers with the remaining time ----------
  if (producers.length > 0 && !deadline()) {
    const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
    const mineGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
      solveGroup(group, maxSol, seed, pinUsage);
    solutions.push(...runPhase2Diverse(producers, mineGroup, {
      maxSolutionsPerGroup: config.maxSolutionsPerGroup,
      solutionsPerRound,
      timeoutMs: config.timeoutMs,
      startTime,
    }));
  }

  if (solutions.length === 0) {
    errors.push({
      type: 'error',
      message: `CEGAR: no routable instance group found (${groupFingerprints.size} discovered, ${oracleRejects} oracle-rejected, ${nogoods.length} nogoods learned, ${probeFails} probe failures)`,
    });
  } else if (nogoods.length > 0 || oracleRejects > 0) {
    errors.push({
      type: 'warning',
      message: `CEGAR: ${producers.length} routable groups (${oracleRejects} groups oracle-rejected, ${nogoods.length} instance nogoods learned)`,
    });
  }

  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);
  return finalizeSolutions(
    solutions, mcu, config.costWeights, errors, stats, startTime,
    gpioVarsPerConfig, reserved.pins, pinnedAssignments,
  );
}
