// ============================================================
// Priority Group Solver
//
// Three-phase approach combining diverse instance discovery,
// instance permutation for group diversity, and priority-ordered
// pin assignment:
// - Phase 1: Multi-round instance group discovery (priority round 0,
//   shuffled MRV rounds 1+)
// - Phase 1.5: Generate additional groups by permuting peripheral
//   instances of the same type across ports
// - Phase 2: Priority-ordered backtracking for pin assignment
// ============================================================

import type { Mcu, Solution, SolverResult, SolverError, SolverStats } from '../types';
import type { ProgramNode, RequireNode } from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import { computeTotalCost } from './cost-functions';
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
  groupFingerprint, varKey,
  type InstanceGroup, type InstanceTracker, type InstanceVariable,
} from './two-phase-solver';
import { computePortPriority, sortByPortPriority } from './port-priority';

// ============================================================
// Config
// ============================================================

const DIVERSITY_ROUNDS = 10;
const MAX_PERMUTED_GROUPS = 200;
const MAX_PERMS_PER_GROUP = 50;

// ============================================================
// PRNG utilities
// ============================================================

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

// ============================================================
// Permutation generation
// ============================================================

interface SubGroup {
  varKeys: string[];
  originalInstance: string;
}

interface Cluster {
  peripheralType: string;
  subGroups: SubGroup[];
  instances: string[];  // parallel to subGroups
}

/** Generate all permutations of an array (Heap's algorithm). */
function allPermutations<T>(items: T[]): T[][] {
  const result: T[][] = [];
  const arr = [...items];
  const n = arr.length;
  const c = new Array(n).fill(0);
  result.push([...arr]);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      if (i % 2 === 0) [arr[0], arr[i]] = [arr[i], arr[0]];
      else [arr[c[i]], arr[i]] = [arr[i], arr[c[i]]];
      result.push([...arr]);
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return result;
}

/** Sample random permutations using Fisher-Yates with dedup. */
function samplePermutations<T>(items: T[], count: number, rng: () => number): T[][] {
  const results: T[][] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < count * 5 && results.length < count; attempt++) {
    const perm = shuffleArray(items, rng);
    const key = perm.map(String).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      results.push(perm);
    }
  }
  return results;
}

/** Factorial with overflow guard. */
function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) {
    r *= i;
    if (r > 1e8) return Infinity;
  }
  return r;
}

/**
 * Generate permuted groups from a source group by swapping peripheral
 * instances of the same type across ports.
 */
function generatePermutedGroups(
  sourceGroup: InstanceGroup,
  allInstanceVars: InstanceVariable[],
  fingerprints: Set<string>,
  maxPerGroup: number,
  rng: () => number,
): InstanceGroup[] {
  // Build varKey -> InstanceVariable lookup
  const varLookup = new Map<string, InstanceVariable>();
  for (const iv of allInstanceVars) {
    varLookup.set(varKey(iv), iv);
  }

  // Build instance -> peripheral type mapping
  const instanceType = new Map<string, string>();
  for (const [vk, inst] of sourceGroup.assignments) {
    const iv = varLookup.get(vk);
    if (iv) {
      const type = iv.candidateTypes.get(inst);
      if (type) instanceType.set(inst, type);
    }
  }

  // Group varKeys by their assigned instance → sub-groups
  const instanceVarKeys = new Map<string, string[]>();
  for (const [vk, inst] of sourceGroup.assignments) {
    if (!instanceVarKeys.has(inst)) instanceVarKeys.set(inst, []);
    instanceVarKeys.get(inst)!.push(vk);
  }

  // Group instances by peripheral type → clusters
  const typeInstances = new Map<string, string[]>();
  for (const [inst, type] of instanceType) {
    if (!typeInstances.has(type)) typeInstances.set(type, []);
    typeInstances.get(type)!.push(inst);
  }

  // Only clusters with 2+ distinct instances can be permuted
  const clusters: Cluster[] = [];
  for (const [type, instances] of typeInstances) {
    if (instances.length < 2) continue;
    const subGroups = instances.map(inst => ({
      varKeys: instanceVarKeys.get(inst) || [],
      originalInstance: inst,
    }));
    clusters.push({ peripheralType: type, subGroups, instances });
  }

  if (clusters.length === 0) return [];

  // For each cluster, generate valid non-identity permutations
  const clusterPerms: string[][][] = [];

  for (const cluster of clusters) {
    const n = cluster.instances.length;
    const perms = factorial(n) <= maxPerGroup
      ? allPermutations(cluster.instances)
      : samplePermutations(cluster.instances, maxPerGroup, rng);

    // Filter to valid permutations (each sub-group's vars must support new instance)
    const validNonIdentity = perms.filter(perm => {
      let isIdentity = true;
      for (let i = 0; i < perm.length; i++) {
        if (perm[i] !== cluster.instances[i]) {
          isIdentity = false;
          // Check all varKeys in this sub-group support the new instance
          for (const vk of cluster.subGroups[i].varKeys) {
            const iv = varLookup.get(vk);
            if (!iv || !iv.instanceCandidates.includes(perm[i])) return false;
          }
        }
      }
      return !isIdentity;
    });

    if (validNonIdentity.length === 0) {
      // No valid swaps — include identity so Cartesian product still works
      clusterPerms.push([cluster.instances]);
    } else {
      // Include identity + valid permutations
      clusterPerms.push([cluster.instances, ...validNonIdentity]);
    }
  }

  // Cartesian product across clusters, excluding all-identity
  const combos = cartesianProduct(clusterPerms, maxPerGroup, rng);

  const newGroups: InstanceGroup[] = [];
  for (const combo of combos) {
    // Check if all-identity (skip it)
    let allIdentity = true;
    for (let c = 0; c < clusters.length; c++) {
      if (combo[c] !== clusterPerms[c][0]) {
        allIdentity = false;
        break;
      }
    }
    if (allIdentity) continue;

    // Build new assignment map
    const newAssignments = new Map(sourceGroup.assignments);
    for (let c = 0; c < clusters.length; c++) {
      const perm = combo[c];
      for (let i = 0; i < clusters[c].subGroups.length; i++) {
        for (const vk of clusters[c].subGroups[i].varKeys) {
          newAssignments.set(vk, perm[i]);
        }
      }
    }

    const fp = groupFingerprint(newAssignments);
    if (!fingerprints.has(fp)) {
      fingerprints.add(fp);
      newGroups.push({ assignments: newAssignments });
    }
  }

  return newGroups;
}

/** Cartesian product of arrays, with sampling if too large. */
function cartesianProduct<T>(arrays: T[][], maxResults: number, rng: () => number): T[][] {
  const totalSize = arrays.reduce((acc, arr) => acc * arr.length, 1);

  if (totalSize <= maxResults) {
    // Full Cartesian product
    let result: T[][] = [[]];
    for (const arr of arrays) {
      const next: T[][] = [];
      for (const prev of result) {
        for (const item of arr) {
          next.push([...prev, item]);
        }
      }
      result = next;
    }
    return result;
  }

  // Random sampling
  const results: T[][] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < maxResults * 5 && results.length < maxResults; attempt++) {
    const combo = arrays.map(arr => arr[Math.floor(rng() * arr.length)]);
    const key = combo.map((_, i) => arrays[i].indexOf(combo[i])).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      results.push(combo);
    }
  }
  return results;
}

// ============================================================
// Main solver
// ============================================================

export function solvePriorityGroup(
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
    errors.push({ type: 'warning', message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) — verified pin availability only` });
  }

  const portPriority = computePortPriority(solveVars);
  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);

  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
      }
    }
  }

  // ========== Phase 1: Diverse Instance Group Discovery ==========
  const groupFingerprints = new Set<string>();
  const discoveredGroups: InstanceGroup[] = [];
  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));

  for (let round = 0; round < DIVERSITY_ROUNDS; round++) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (discoveredGroups.length >= config.maxGroups) break;

    for (const combo of configCombinations) {
      if (performance.now() - startTime > config.timeoutMs) break;
      if (discoveredGroups.length >= config.maxGroups) break;

      let activeVars = allInstanceVars.filter(iv =>
        combo.get(iv.portName) === iv.configName
      );

      if (activeVars.length === 0) continue;

      if (round === 0) {
        // Priority ordering: most constrained peripherals first
        sortByPortPriority(activeVars, portPriority);
      } else {
        // Shuffled domains + MRV sort for diversity
        const rng = mulberry32(round * 54321 + configCombinations.indexOf(combo) * 11);
        activeVars = activeVars.map(iv => ({
          ...iv,
          domain: shuffleArray([...iv.domain], rng),
        }));
        activeVars.sort((a, b) => a.domain.length - b.domain.length);
      }

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

      const remaining = config.maxGroups - discoveredGroups.length;
      const limit = Math.min(maxGroupsPerCombo, remaining);

      const comboGroups: InstanceGroup[] = [];
      solvePhase1(
        activeVars, 0, tracker, [],
        ports, comboGroups, limit,
        startTime, config.timeoutMs,
        lastVarOfConfig, configRequiresMap,
        dmaData
      );

      for (const g of comboGroups) {
        if (discoveredGroups.length >= config.maxGroups) break;
        const fp = groupFingerprint(g.assignments);
        if (!groupFingerprints.has(fp)) {
          groupFingerprints.add(fp);
          discoveredGroups.push(g);
        }
      }
    }

    if (round === 0 && discoveredGroups.length >= config.maxGroups) break;
  }

  // ========== Phase 1.5: Instance Permutation ==========
  const permutedGroups: InstanceGroup[] = [];
  const permRng = mulberry32(42);

  for (const group of discoveredGroups) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (permutedGroups.length >= MAX_PERMUTED_GROUPS) break;

    const newGroups = generatePermutedGroups(
      group, allInstanceVars, groupFingerprints,
      MAX_PERMS_PER_GROUP, permRng
    );

    for (const g of newGroups) {
      if (permutedGroups.length >= MAX_PERMUTED_GROUPS) break;
      permutedGroups.push(g);
    }
  }

  // Interleave permuted groups (diverse instance assignments) with
  // discovered groups so Phase 2 processes diverse groups early,
  // before the timeout expires on shallow Phase 1 variations.
  const allGroups: InstanceGroup[] = [];
  const dLen = discoveredGroups.length, pLen = permutedGroups.length;
  const maxIdx = Math.max(dLen, pLen);
  for (let i = 0; i < maxIdx; i++) {
    if (i < pLen) allGroups.push(permutedGroups[i]);
    if (i < dLen) allGroups.push(discoveredGroups[i]);
  }

  if (allGroups.length === 0) {
    errors.push({ type: 'error', message: 'Phase 1: No valid peripheral instance assignments found' });
    return {
      mcuRef: mcu.refName, solutions: [], errors,
      statistics: { totalCombinations: configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: configCombinations.length },
    };
  }

  // ========== Phase 2: Priority Pin Assignment ==========
  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  const solutions: Solution[] = [];

  const phase2Sort = (vars: typeof allVariables) => {
    const p2Priority = computePortPriority(vars);
    sortByPortPriority(vars, p2Priority);
  };

  for (const group of allGroups) {
    if (performance.now() - startTime > config.timeoutMs) break;

    const groupSolutions = solvePhase2ForGroup(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      config.maxSolutionsPerGroup, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData
    );
    solutions.push(...groupSolutions);
  }

  if (solutions.length === 0 && allGroups.length > 0) {
    errors.push({
      type: 'warning',
      message: `Phase 1 found ${discoveredGroups.length} groups (+${permutedGroups.length} permuted) but Phase 2 found no valid pin assignments`,
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
