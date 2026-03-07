// ============================================================
// Shared Group Permutation Utilities
//
// Extracted from priority-group-solver.ts — generates permuted
// instance groups by swapping peripheral instances of the same
// type across ports.
// ============================================================

import type { InstanceVariable, InstanceGroup } from './two-phase-solver';
import { varKey, groupFingerprint } from './two-phase-solver';
import { shuffleArray } from './solver-utils';

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

/** Cartesian product of arrays, with sampling if too large. */
function cartesianProduct<T>(arrays: T[][], maxResults: number, rng: () => number): T[][] {
  const totalSize = arrays.reduce((acc, arr) => acc * arr.length, 1);

  if (totalSize <= maxResults) {
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

/**
 * Generate permuted groups from a source group by swapping peripheral
 * instances of the same type across ports.
 */
export function generatePermutedGroups(
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
      // No valid swaps - include identity so Cartesian product still works
      clusterPerms.push([cluster.instances]);
    } else {
      // Include identity + valid permutations
      clusterPerms.push([cluster.instances, ...validNonIdentity]);
    }
  }

  const newGroups: InstanceGroup[] = [];

  const tryAddCombo = (combo: string[][]) => {
    let allIdentity = true;
    for (let c = 0; c < clusters.length; c++) {
      if (combo[c] !== clusterPerms[c][0]) {
        allIdentity = false;
        break;
      }
    }
    if (allIdentity) return;

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
  };

  // Phase A: Stratified single-cluster permutations
  const perCluster = Math.max(1, Math.floor(maxPerGroup / (clusters.length + 1)));
  for (let c = 0; c < clusters.length; c++) {
    const nonIdentity = clusterPerms[c].slice(1);
    const selected = nonIdentity.slice(0, perCluster);
    for (const perm of selected) {
      if (newGroups.length >= maxPerGroup) break;
      const combo = clusterPerms.map((cp, i) => i === c ? perm : cp[0]);
      tryAddCombo(combo);
    }
  }

  // Phase B: Multi-cluster combos with remaining budget
  const remaining = maxPerGroup - newGroups.length;
  if (remaining > 0 && clusters.length > 1) {
    const combos = cartesianProduct(clusterPerms, remaining, rng);
    for (const combo of combos) {
      if (newGroups.length >= maxPerGroup) break;
      tryAddCombo(combo);
    }
  }

  return newGroups;
}
