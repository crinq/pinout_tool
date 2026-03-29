/**
 * Lightweight serialization for transferring SolverResult across worker boundary.
 * Converts Maps/Sets to plain arrays to avoid expensive structured clone overhead.
 */
import type { SolverResult, Solution, ConfigCombinationAssignment } from '../types';

/** Wire format for a Solution — Maps/Sets replaced with plain arrays. */
interface WireSolution {
  id: number;
  name?: string;
  solverOrigin?: string;
  mcuRef: string;
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
  assignments: ConfigCombinationAssignment['assignments'];
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
    solutions: result.solutions.map(sol => ({
      id: sol.id,
      name: sol.name,
      solverOrigin: sol.solverOrigin,
      mcuRef: sol.mcuRef,
      configAssignments: sol.configAssignments.map(ca => ({
        activeConfigs: [...ca.activeConfigs],
        assignments: ca.assignments,
        dmaStreamAssignment: ca.dmaStreamAssignment ? [...ca.dmaStreamAssignment] : undefined,
      })),
      portPeripherals: [...sol.portPeripherals].map(([k, v]) => [k, [...v]] as [string, string[]]),
      costs: [...sol.costs],
      totalCost: sol.totalCost,
      gpioCount: sol.gpioCount,
      clusterSize: sol.clusterSize,
      optionalTotal: sol.optionalTotal,
      optionalFulfilled: sol.optionalFulfilled,
      _dedupKey: sol._dedupKey,
    })),
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
        assignments: ca.assignments,
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
