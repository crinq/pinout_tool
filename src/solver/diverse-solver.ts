// ============================================================
// Diverse Instances Solver
//
// Enhances the two-phase solver's Phase 1 to find more diverse
// peripheral instance groups by running multiple rounds with
// shuffled instance candidate orderings.
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

const MAX_DIVERSITY_ROUNDS = 25;

// Mulberry32 seeded PRNG
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function solveDiverseInstances(
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

  // Build instance variables from non-GPIO solver variables only.
  // GPIO variables don't have meaningful peripheral instances for Phase 1.
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

  // ========== Phase 1: Multi-round diverse instance assignment ==========
  const groupFingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];
  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));

  for (let round = 0; round < MAX_DIVERSITY_ROUNDS; round++) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (groups.length >= config.maxGroups) break;

    for (const combo of configCombinations) {
      if (performance.now() - startTime > config.timeoutMs) break;
      if (groups.length >= config.maxGroups) break;

      // Filter to active variables
      let activeVars = allInstanceVars.filter(iv =>
        combo.get(iv.portName) === iv.configName
      );

      if (activeVars.length === 0) continue;

      // For round > 0, shuffle each variable's instance domain
      if (round > 0) {
        const rng = mulberry32(round * 54321 + configCombinations.indexOf(combo) * 11);
        activeVars = activeVars.map(iv => ({
          ...iv,
          domain: shuffleArray([...iv.domain], rng),
        }));
      }

      // Sort by MRV
      activeVars.sort((a, b) => a.domain.length - b.domain.length);

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

      const remaining = config.maxGroups - groups.length;
      const limit = Math.min(maxGroupsPerCombo, remaining);

      const comboGroups: InstanceGroup[] = [];
      solvePhase1(
        activeVars, 0, tracker, [],
        ports, comboGroups, limit,
        startTime, config.timeoutMs,
        lastVarOfConfig, configRequiresMap
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

    // If round 0 already found enough groups, stop
    if (round === 0 && groups.length >= config.maxGroups) break;
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

  // C1: Cost-guided variable ordering for Phase 2
  const costWeights = config.costWeights;
  const phase2Sort = (vars: typeof solveVars) => {
    const minCosts = new Map<typeof vars[0], number>();
    for (const v of vars) {
      let minCost = Infinity;
      for (const ci of v.domain) {
        const cost = estimateCandidateCost(v.candidates[ci], costWeights);
        if (cost < minCost) minCost = cost;
      }
      minCosts.set(v, minCost);
    }
    vars.sort((a, b) => {
      const sizeA = a.domain.length, sizeB = b.domain.length;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return (minCosts.get(b) ?? 0) - (minCosts.get(a) ?? 0);
    });
  };

  const domainCache = new Map<string, number[]>();
  for (const group of groups) {
    if (performance.now() - startTime > config.timeoutMs) break;

    const groupSolutions = solvePhase2ForGroup(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      config.maxSolutionsPerGroup, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData, domainCache, mcu, costWeights
    );
    solutions.push(...groupSolutions);
  }

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
