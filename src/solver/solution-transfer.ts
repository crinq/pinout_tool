/**
 * Lightweight serialization for transferring SolverResult across the worker
 * boundary. Maps/Sets become plain arrays to avoid structured-clone overhead.
 *
 * Memory matters here: a roomy package can yield thousands of solutions per
 * solver, several solvers run at once, and every one of those payloads has to
 * live in the renderer at the same time — enough to get the tab OOM-killed.
 * Two observations keep it small:
 *
 *   - Solutions overlap heavily. A 986-solution result on a 64-pin part
 *     contained 228752 assignment entries but only 336 distinct ones, so the
 *     pool is shared across the whole result rather than per solution.
 *   - Every solution enumerates the same config combinations, so those are
 *     tabulated once and referenced by index.
 *
 * A combination's assignments are exactly the solution's assignments whose
 * (port, config) that combination activates, so no per-combination index list
 * is transferred either — `fromWire` re-selects them.
 */
import type { SolverResult, Solution, Assignment } from '../types';

/** Wire format for a Solution — everything shared lives on the result. */
interface WireSolution {
  id: number;
  name?: string;
  solverOrigin?: string;
  mcuRef: string;
  /** Indices into WireSolverResult.assignmentPool (this solution's assignments). */
  assignmentIdx: number[];
  /** One entry per config combination: comboTable index + DMA map (interned). */
  combos: { c: number; dma?: [number, number][] }[];
  portPeripherals: [string, string[]][];  // Map<string, Set<string>> → entries
  costs: [string, number][];              // Map<string, number> → entries
  totalCost: number;
  gpioCount: number;
  clusterSize?: number;
  optionalTotal: number;
  optionalFulfilled: number;
}

export interface WireSolverResult {
  mcuRef: string;
  /** Every distinct assignment across all solutions. */
  assignmentPool: Assignment[];
  /** Every distinct set of active configs, as Map entries. */
  comboTable: [string, string][][];
  /** Interned trigger/stream names; DMA maps reference these by index. */
  dmaStrings: string[];
  solutions: WireSolution[];
  errors: SolverResult['errors'];
  statistics: SolverResult['statistics'];
  _wire: true;  // discriminator
}

const assignmentKey = (a: Assignment): string =>
  `${a.pinName}\0${a.signalName}\0${a.portName}\0${a.channelName}\0${a.configurationName}`;

/** Convert SolverResult to wire format (call in worker before postMessage). */
export function toWire(result: SolverResult): WireSolverResult {
  const assignmentPool: Assignment[] = [];
  const assignmentIndex = new Map<string, number>();
  const refIndex = new Map<Assignment, number>();   // fast path: same object

  const poolIndex = (a: Assignment): number => {
    let idx = refIndex.get(a);
    if (idx !== undefined) return idx;
    const key = assignmentKey(a);
    idx = assignmentIndex.get(key);
    if (idx === undefined) {
      idx = assignmentPool.length;
      assignmentPool.push(a);
      assignmentIndex.set(key, idx);
    }
    refIndex.set(a, idx);
    return idx;
  };

  const comboTable: [string, string][][] = [];
  const comboIndex = new Map<string, number>();

  // DMA maps are almost all distinct, but the trigger/stream names they are
  // built from are a tiny set — intern those instead of the maps.
  const dmaStrings: string[] = [];
  const dmaStringIndex = new Map<string, number>();
  const intern = (v: string): number => {
    let i = dmaStringIndex.get(v);
    if (i === undefined) { i = dmaStrings.length; dmaStrings.push(v); dmaStringIndex.set(v, i); }
    return i;
  };

  const tableIndex = (activeConfigs: Map<string, string>): number => {
    const entries = [...activeConfigs].sort((x, y) => x[0].localeCompare(y[0]));
    const key = entries.map(([p, c]) => `${p}=${c}`).join(',');
    let idx = comboIndex.get(key);
    if (idx === undefined) {
      idx = comboTable.length;
      comboTable.push(entries);
      comboIndex.set(key, idx);
    }
    return idx;
  };

  const solutions: WireSolution[] = result.solutions.map(sol => {
    const seen = new Set<number>();
    const assignmentIdx: number[] = [];
    const combos = sol.configAssignments.map(ca => {
      for (const a of ca.assignments) {
        const i = poolIndex(a);
        if (!seen.has(i)) { seen.add(i); assignmentIdx.push(i); }
      }
      return {
        c: tableIndex(ca.activeConfigs),
        dma: ca.dmaStreamAssignment
          ? [...ca.dmaStreamAssignment].map(([t, st]) => [intern(t), intern(st)] as [number, number])
          : undefined,
      };
    });

    return {
      id: sol.id,
      name: sol.name,
      solverOrigin: sol.solverOrigin,
      mcuRef: sol.mcuRef,
      assignmentIdx,
      combos,
      portPeripherals: [...sol.portPeripherals].map(([k, v]) => [k, [...v]] as [string, string[]]),
      costs: [...sol.costs],
      totalCost: sol.totalCost,
      gpioCount: sol.gpioCount,
      clusterSize: sol.clusterSize,
      optionalTotal: sol.optionalTotal,
      optionalFulfilled: sol.optionalFulfilled,
    };
  });

  return {
    mcuRef: result.mcuRef,
    assignmentPool,
    comboTable,
    dmaStrings,
    solutions,
    errors: result.errors,
    statistics: result.statistics,
    _wire: true,
  };
}

/** Restore SolverResult from wire format (call on main thread after receiving). */
export function fromWire(wire: WireSolverResult): SolverResult {
  return {
    mcuRef: wire.mcuRef,
    solutions: wire.solutions.map(ws => {
      const own = ws.assignmentIdx.map(i => wire.assignmentPool[i]);
      return {
        id: ws.id,
        name: ws.name,
        solverOrigin: ws.solverOrigin,
        mcuRef: ws.mcuRef,
        configAssignments: ws.combos.map(cb => {
          const activeConfigs = new Map(wire.comboTable[cb.c]);
          return {
            activeConfigs,
            // Pinned assignments belong to every combination; the rest belong to
            // the config their port has active here.
            assignments: own.filter(a =>
              a.portName === '<pinned>' || activeConfigs.get(a.portName) === a.configurationName),
            dmaStreamAssignment: cb.dma
              ? new Map(cb.dma.map(([t, st]) => [wire.dmaStrings[t], wire.dmaStrings[st]]))
              : undefined,
          };
        }),
        portPeripherals: new Map(ws.portPeripherals.map(([k, v]) => [k, new Set(v)])),
        costs: new Map(ws.costs),
        totalCost: ws.totalCost,
        gpioCount: ws.gpioCount,
        clusterSize: ws.clusterSize,
        optionalTotal: ws.optionalTotal,
        optionalFulfilled: ws.optionalFulfilled,
        // _dedupKey is deliberately not transferred: it is a memo of a ~6 kB
        // string per solution (5.8 MB per 1000 solutions) that
        // solutionDedupKey() rebuilds on demand.
      };
    }) as Solution[],
    errors: wire.errors,
    statistics: wire.statistics,
  };
}
