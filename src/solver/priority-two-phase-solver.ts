// ============================================================
// Priority Two-Phase Solver
//
// Two-phase solver with port-priority variable ordering:
// peripherals with fewer available pins are assigned first
// in both Phase 1 (instance assignment) and Phase 2 (pin assignment).
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, SolverStats } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import { computeTotalCost, estimateCandidateCost } from './cost-functions';
import {
  extractPorts, resolveReservePatterns, extractPinnedAssignments,
  extractSharedPatterns, resolveAllVariables,
  generateConfigCombinations, validateConstraints,
  deduplicateSolutions,
  partitionGpioVariables, validateGpioAvailability, isGpioVariable,
  configsHaveDma,
} from './solver';
import type { TwoPhaseConfig } from './two-phase-solver';
import {
  buildInstanceVariables, solvePhase1, solvePhase2ForGroup,
  groupFingerprint, sortInstanceDomainsByCost,
  type InstanceGroup, type InstanceTracker,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority } from './port-priority';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';

export function solvePriorityTwoPhase(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];

  const { ast: expandedAst, errors: macroErrors } = expandAllMacros(ast, getStdlibMacros());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) {
    reservedPinSet.add(pa.pinName);
  }
  const reservedPeripheralSet = new Set(reserved.peripherals);

  validateConstraints(ports, errors);

  const configCombinations = generateConfigCombinations(ports);
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);

  if (allVariables.length === 0) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: [{ type: 'warning', message: 'No variables to solve' }],
      statistics: { totalCombinations: configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: configCombinations.length },
    };
  }

  const emptyVar = allVariables.find(v => v.domain.length === 0);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return {
      mcuRef: mcu.refName, solutions: [], errors,
      statistics: { totalCombinations: configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: configCombinations.length },
    };
  }

  const { solveVars, gpioVars, gpioCountPerConfig } = partitionGpioVariables(allVariables, !!config.skipGpioMapping);

  if (solveVars.length === 0 && gpioVars.length === 0) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: [{ type: 'warning', message: 'No variables to solve' }],
      statistics: { totalCombinations: configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: configCombinations.length },
    };
  }

  if (gpioVars.length > 0) {
    errors.push({ type: 'warning', message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only` });
  }

  // Compute port priority from solver variables (pin counts per port)
  const portPriority = computePortPriority(solveVars);

  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);

  // C3: Sort instance domains by ascending average pin cost
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
      }
    }
  }

  // ========== Phase 1: Instance Assignment per Config Combination ==========
  const groupFingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];
  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));

  for (const combo of configCombinations) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (groups.length >= config.maxGroups) break;

    const activeVars = allInstanceVars.filter(iv =>
      combo.get(iv.portName) === iv.configName
    );

    if (activeVars.length === 0) continue;

    // Sort by port priority (most constrained first), then MRV tiebreaker
    sortByPortPriority(activeVars, portPriority);

    const lastVarOfConfig = new Map<string, number>();
    for (let i = 0; i < activeVars.length; i++) {
      const key = `${activeVars[i].portName}\0${activeVars[i].configName}`;
      lastVarOfConfig.set(key, i);
    }

    const tracker: InstanceTracker = {
      instanceOwner: new Map(),
      instanceRefCount: new Map(),
      sharedPatterns,
    };

    const comboGroups: InstanceGroup[] = [];
    solvePhase1(
      activeVars, 0, tracker, [],
      ports, comboGroups, maxGroupsPerCombo,
      startTime, config.timeoutMs,
      lastVarOfConfig, configRequiresMap,
      dmaData
    );

    for (const g of comboGroups) {
      if (groups.length >= config.maxGroups) break;
      const fp = groupFingerprint(g.assignments);
      if (!groupFingerprints.has(fp)) {
        groupFingerprints.add(fp);
        groups.push(g);
      }
    }
  }

  if (groups.length === 0) {
    errors.push({ type: 'error', message: 'Phase 1: No valid peripheral instance assignments found' });
    return {
      mcuRef: mcu.refName, solutions: [], errors,
      statistics: { totalCombinations: configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: configCombinations.length },
    };
  }

  // ========== Phase 2: Pin assignment per group ==========
  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  const solutions: Solution[] = [];

  // Custom sort for Phase 2: port priority with MRV + cost tiebreaker (C1)
  const costWeights = config.costWeights;
  const phase2Sort = (vars: typeof allVariables) => {
    const p2Priority = computePortPriority(vars);
    // Compute min candidate cost per variable
    const minCosts = new Map<typeof vars[0], number>();
    for (const v of vars) {
      let minCost = Infinity;
      for (const ci of v.domain) {
        const cost = estimateCandidateCost(v.candidates[ci], costWeights);
        if (cost < minCost) minCost = cost;
      }
      minCosts.set(v, minCost);
    }
    // Primary: port priority, Secondary: MRV, Tertiary: higher cost first
    vars.sort((a, b) => {
      const pa = p2Priority.get(a.portName) ?? 0;
      const pb = p2Priority.get(b.portName) ?? 0;
      if (pa !== pb) return pb - pa; // higher priority first
      const sizeA = a.domain.length, sizeB = b.domain.length;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return (minCosts.get(b) ?? 0) - (minCosts.get(a) ?? 0);
    });
  };

  const domainCache = new Map<string, number[]>();
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2ForGroup(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData, domainCache, mcu, config.costWeights, seed, pinUsage
    );
  solutions.push(...runPhase2Diverse(groups, solveGroup, {
    maxSolutionsPerGroup: config.maxSolutionsPerGroup,
    solutionsPerRound,
    timeoutMs: config.timeoutMs,
    startTime,
  }));

  if (solutions.length === 0 && groups.length > 0) {
    errors.push({
      type: 'warning',
      message: `Phase 1 found ${groups.length} instance groups but Phase 2 found no valid pin assignments`,
    });
  }

  if (performance.now() - startTime > config.timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${solutions.length} solutions.` });
  }

  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, config.costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  stats.solveTimeMs = performance.now() - startTime;

  const deduped = deduplicateSolutions(solutions);
  const filtered = validateGpioAvailability(deduped, gpioCountPerConfig, mcu, reserved.pins, pinnedAssignments);
  return { mcuRef: mcu.refName, solutions: filtered, errors, statistics: stats };
}
