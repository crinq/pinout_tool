/**
 * Lightweight serialization for transferring SolverResult across worker boundary.
 * Converts Maps/Sets to plain arrays to avoid expensive structured clone overhead.
 * Uses assignment pooling to deduplicate repeated Assignment objects across CCAs.
 */
import type { SolverResult, Solution, Assignment } from '../types';

/** Wire format for a Solution — Maps/Sets replaced with plain arrays, assignments pooled. */
interface WireSolution {
  id: number;
  name?: string;
  solverOrigin?: string;
  mcuRef: string;
  /** Shared pool of unique assignments for this solution */
  assignmentPool: Assignment[];
  /** Each CCA references assignments by index into assignmentPool */
  configAssignments: WireConfigAssignment[];
  portPeripherals: [string, string[]][];  // Map<string, Set<string>> → entries
  costs: [string, number][];              // Map<string, number> → entries
  totalCost: number;
  gpioCount: number;
  clusterSize?: number;
  optionalTotal: number;
  optionalFulfilled: number;
  _dedupKey?: string;
}

interface WireConfigAssignment {
  activeConfigs: [string, string][];      // Map<string, string> → entries
  /** Indices into the parent WireSolution.assignmentPool */
  assignmentIndices: number[];
  dmaStreamAssignment?: [string, string][];
}

export interface WireSolverResult {
  mcuRef: string;
  solutions: WireSolution[];
  errors: SolverResult['errors'];
  statistics: SolverResult['statistics'];
  _wire: true;  // discriminator
}

/** Convert SolverResult to wire format (call in worker before postMessage). */
export function toWire(result: SolverResult): WireSolverResult {
  return {
    mcuRef: result.mcuRef,
    solutions: result.solutions.map(sol => {
      // Build assignment pool: deduplicate by identity (reference) then by content
      const pool: Assignment[] = [];
      const refToIdx = new Map<Assignment, number>();  // fast path: same object reference
      const keyToIdx = new Map<string, number>();      // slow path: same content

      function getPoolIndex(a: Assignment): number {
        let idx = refToIdx.get(a);
        if (idx !== undefined) return idx;
        const key = `${a.pinName}\0${a.signalName}\0${a.portName}\0${a.channelName}\0${a.configurationName}`;
        idx = keyToIdx.get(key);
        if (idx !== undefined) {
          refToIdx.set(a, idx);
          return idx;
        }
        idx = pool.length;
        pool.push(a);
        refToIdx.set(a, idx);
        keyToIdx.set(key, idx);
        return idx;
      }

      const configAssignments: WireConfigAssignment[] = sol.configAssignments.map(ca => ({
        activeConfigs: [...ca.activeConfigs],
        assignmentIndices: ca.assignments.map(a => getPoolIndex(a)),
        dmaStreamAssignment: ca.dmaStreamAssignment ? [...ca.dmaStreamAssignment] : undefined,
      }));

      return {
        id: sol.id,
        name: sol.name,
        solverOrigin: sol.solverOrigin,
        mcuRef: sol.mcuRef,
        assignmentPool: pool,
        configAssignments,
        portPeripherals: [...sol.portPeripherals].map(([k, v]) => [k, [...v]] as [string, string[]]),
        costs: [...sol.costs],
        totalCost: sol.totalCost,
        gpioCount: sol.gpioCount,
        clusterSize: sol.clusterSize,
        optionalTotal: sol.optionalTotal,
        optionalFulfilled: sol.optionalFulfilled,
        _dedupKey: sol._dedupKey,
      };
    }),
    errors: result.errors,
    statistics: result.statistics,
    _wire: true,
  };
}

/** Restore SolverResult from wire format (call on main thread after receiving). */
export function fromWire(wire: WireSolverResult): SolverResult {
  return {
    mcuRef: wire.mcuRef,
    solutions: wire.solutions.map(ws => ({
      id: ws.id,
      name: ws.name,
      solverOrigin: ws.solverOrigin,
      mcuRef: ws.mcuRef,
      configAssignments: ws.configAssignments.map(ca => ({
        activeConfigs: new Map(ca.activeConfigs),
        assignments: ca.assignmentIndices.map(i => ws.assignmentPool[i]),
        dmaStreamAssignment: ca.dmaStreamAssignment ? new Map(ca.dmaStreamAssignment) : undefined,
      })),
      portPeripherals: new Map(ws.portPeripherals.map(([k, v]) => [k, new Set(v)])),
      costs: new Map(ws.costs),
      totalCost: ws.totalCost,
      gpioCount: ws.gpioCount,
      clusterSize: ws.clusterSize,
      optionalTotal: ws.optionalTotal,
      optionalFulfilled: ws.optionalFulfilled,
      _dedupKey: ws._dedupKey,
    })) as Solution[],
    errors: wire.errors,
    statistics: wire.statistics,
  };
}
