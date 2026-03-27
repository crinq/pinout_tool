// ============================================================
// Constraint Solver
// CSP Backtracking with forward checking
//
// Solves ALL configs per port simultaneously. A valid solution
// must satisfy every config combination (configs are mutually
// exclusive within a port, but all ports are active at once).
// Pins may be reused across configs of the same port, but
// must be unique across different ports and within a single
// (port, config) pair.
// ============================================================

import type {
  Mcu, Solution, SolverResult, SolverError, SolverStats,
  Assignment, DmaData, DmaStreamInfo,
} from '../types';
import { normalizePeripheralType } from '../parser/mcu-xml-parser';
import { findDmaStreamsForSignal } from '../parser/dma-xml-parser';
import type {
  ProgramNode,
  RequireNode, SignalPatternNode,
  ConstraintExprNode, PatternPart,
} from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import { expandPatternToCandidates, matchPatternToInstance, type SignalCandidate } from './pattern-matcher';
import {
  computeTotalCost, type IncrementalCostTracker,
  incrementCost, decrementCost, updateCostThreshold,
} from './cost-functions';

// ============================================================
// Solver Configuration
// ============================================================

export interface SolverConfig {
  maxSolutions: number;
  timeoutMs: number;
  costWeights: Map<string, number>;
  skipGpioMapping?: boolean;
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  maxSolutions: 100,
  timeoutMs: 5000,
  costWeights: new Map([
    ['pin_count', 1],
    ['port_spread', 0.5],
    ['peripheral_count', 0.5],
    ['debug_pin_penalty', 2],
    ['pin_clustering', 0.3],
  ]),
};

/** Merge user config with defaults, properly merging costWeights Maps. */
export function mergeSolverConfig(config: Partial<SolverConfig>): SolverConfig {
  const cfg = { ...DEFAULT_SOLVER_CONFIG, ...config };
  if (config.costWeights) {
    cfg.costWeights = new Map([...DEFAULT_SOLVER_CONFIG.costWeights, ...config.costWeights]);
  }
  return cfg;
}

/** Create an empty solver result for early returns. */
export function emptyResult(
  mcuRef: string,
  errors: SolverError[],
  configCombinations?: number,
  startTime?: number,
): SolverResult {
  const cc = configCombinations ?? 0;
  return {
    mcuRef,
    solutions: [],
    errors: errors.length > 0 ? errors : [{ type: 'warning', message: 'No variables to solve' }],
    statistics: {
      totalCombinations: cc,
      evaluatedCombinations: 0,
      validSolutions: 0,
      solveTimeMs: startTime != null ? performance.now() - startTime : 0,
      configCombinations: cc,
    },
  };
}

/** Push max-solutions/timeout warnings if applicable. */
export function pushSolverWarnings(
  errors: SolverError[],
  solutions: Solution[],
  maxSolutions: number,
  startTime: number,
  timeoutMs: number,
): void {
  if (solutions.length >= maxSolutions) {
    errors.push({ type: 'warning', message: `Maximum solutions (${maxSolutions}) reached.` });
  }
  if (performance.now() - startTime > timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${solutions.length} solutions.` });
  }
}

/** Post-process solutions: set mcuRef, compute costs, sort, dedup, validate GPIO, return result. */
export function finalizeSolutions(
  solutions: Solution[],
  mcu: Mcu,
  costWeights: Map<string, number>,
  errors: SolverError[],
  stats: SolverStats,
  startTime: number,
  gpioCountPerConfig: Map<string, number>,
  reservedPins: string[],
  pinnedAssignments: PinnedAssignment[],
): SolverResult {
  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  stats.solveTimeMs = performance.now() - startTime;

  const deduped = deduplicateSolutions(solutions);
  const filtered = validateGpioAvailability(deduped, gpioCountPerConfig, mcu, reservedPins, pinnedAssignments);
  return { mcuRef: mcu.refName, solutions: filtered, errors, statistics: stats };
}

/** Build lastVarOfConfig map from solver variables. */
export function buildLastVarOfConfig(variables: SolverVariable[]): Map<string, number> {
  const lastVarOfConfig = new Map<string, number>();
  for (let i = 0; i < variables.length; i++) {
    const key = `${variables[i].portName}\0${variables[i].configName}`;
    lastVarOfConfig.set(key, i);
  }
  return lastVarOfConfig;
}

// ============================================================
// Internal Types
// ============================================================

export interface PortSpec {
  name: string;
  channels: Map<string, ChannelSpec>;
  configs: ConfigSpec[];
}

export interface ChannelSpec {
  name: string;
  allowedPins?: Set<string>;
}

export interface ConfigSpec {
  name: string;
  mappings: MappingSpec[];
  requires: RequireNode[];
}

export interface MappingSpec {
  channelName: string;
  signalExprs: SignalExprSpec[];
}

export interface SignalExprSpec {
  alternatives: SignalPatternNode[];
  candidates: SignalCandidate[]; // resolved against MCU
}

export interface SolverVariable {
  portName: string;
  channelName: string;
  configName: string;
  exprIndex: number; // index within mapping's signalExprs
  patternRaw: string; // original pattern text for error messages
  candidates: SignalCandidate[];
  domain: number[]; // indices into candidates
}

export interface VariableAssignment {
  variable: SolverVariable;
  candidate: SignalCandidate;
}

// ============================================================
// Forward Checking / Propagation Context (shared by all solvers)
// ============================================================

export interface PropagationContext {
  domains: number[][];
  assigned: boolean[];
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>;
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>;
  sharedPatterns: PatternPart[];
  removedStack: Array<Array<{ varIdx: number; candIdx: number }>>;
}

export type PinLookups = {
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>;
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>;
};

/** Build pin→candidates and instance→candidates lookup maps from solver variables. */
export function buildPinLookups(variables: SolverVariable[]): PinLookups {
  const pinToVarCandidates = new Map<string, Array<{ varIdx: number; candIdx: number }>>();
  const instanceToVarCandidates = new Map<string, Array<{ varIdx: number; candIdx: number }>>();

  for (let vi = 0; vi < variables.length; vi++) {
    const v = variables[vi];
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

  return { pinToVarCandidates, instanceToVarCandidates };
}

export function buildPropagationContext(
  variables: SolverVariable[],
  sharedPatterns: PatternPart[]
): PropagationContext {
  const domains = variables.map(v => [...v.domain]);
  const assigned = new Array(variables.length).fill(false);
  const { pinToVarCandidates, instanceToVarCandidates } = buildPinLookups(variables);

  return { domains, assigned, pinToVarCandidates, instanceToVarCandidates, sharedPatterns, removedStack: [] };
}

/** Check if any port has ALL its configs blocked (every config has at least one unassigned variable with empty domain) */
export function hasPortWipeout(
  variables: SolverVariable[],
  domains: number[][],
  isAssigned: (idx: number) => boolean
): boolean {
  const emptyVarPorts = new Set<string>();
  for (let i = 0; i < variables.length; i++) {
    if (!isAssigned(i) && domains[i].length === 0) {
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
      if (!isAssigned(i)) {
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
export function propagateShared(
  candidate: SignalCandidate,
  portName: string,
  variables: SolverVariable[],
  domains: number[][],
  isAssigned: (idx: number) => boolean,
  pinToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  instanceToVarCandidates: Map<string, Array<{ varIdx: number; candIdx: number }>>,
  sharedPatterns: PatternPart[]
): Array<{ varIdx: number; candIdx: number }> | null {
  const removed: Array<{ varIdx: number; candIdx: number }> = [];

  // Pin exclusivity across ports
  const pinEntries = pinToVarCandidates.get(candidate.pin.name);
  if (pinEntries) {
    for (const entry of pinEntries) {
      if (isAssigned(entry.varIdx)) continue;
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
        if (isAssigned(entry.varIdx)) continue;
        if (variables[entry.varIdx].portName === portName) continue;
        const domIdx = domains[entry.varIdx].indexOf(entry.candIdx);
        if (domIdx !== -1) {
          domains[entry.varIdx].splice(domIdx, 1);
          removed.push(entry);
        }
      }
    }
  }

  // Check for real wipeout
  if (hasPortWipeout(variables, domains, isAssigned)) {
    undoPropagateShared(removed, domains);
    return null;
  }

  return removed;
}

export function undoPropagateShared(
  removed: Array<{ varIdx: number; candIdx: number }>,
  domains: number[][]
): void {
  for (const entry of removed) {
    domains[entry.varIdx].push(entry.candIdx);
  }
}

// ============================================================
// Pin Tracking (port-aware uniqueness)
// ============================================================

export interface PinTracker {
  // pin -> port that owns it (pins can't be shared across ports)
  pinOwner: Map<string, string>;
  // "port\0pin" -> number of configs in that port using this pin
  portPinRefCount: Map<string, number>;
  // "port\0config" -> set of pins used by that specific config
  configPins: Map<string, Set<string>>;
  // "port\0pin" -> channel that owns this pin within the port
  // (a pin is exclusive to one channel across all configs)
  portPinChannel: Map<string, string>;
  // Peripheral instance -> port that owns it (exclusive by default)
  instanceOwner: Map<string, string>;
  // "port\0instance" -> ref count for backtracking
  instanceRefCount: Map<string, number>;
  // Patterns for instances that may be shared across ports
  sharedPatterns: PatternPart[];
  // "port\0config" -> set of peripheral signals used (within-config signal exclusivity)
  configSignals: Map<string, Set<string>>;
}

export function createPinTracker(reservedPins: string[], sharedPatterns: PatternPart[]): PinTracker {
  const pinOwner = new Map<string, string>();
  // Mark reserved pins as owned by a sentinel port
  for (const pin of reservedPins) {
    pinOwner.set(pin, '\0reserved');
  }
  return {
    pinOwner,
    portPinRefCount: new Map(),
    configPins: new Map(),
    portPinChannel: new Map(),
    instanceOwner: new Map(),
    instanceRefCount: new Map(),
    sharedPatterns,
    configSignals: new Map(),
  };
}

export function canAssignPin(
  tracker: PinTracker, pin: string, portName: string, configName: string, channelName: string,
  peripheralInstance?: string, signalName?: string
): boolean {
  // Cross-port exclusivity
  const owner = tracker.pinOwner.get(pin);
  if (owner !== undefined && owner !== portName) return false;
  // Within-config exclusivity (no duplicate pins in one config)
  const configKey = `${portName}\0${configName}`;
  if (tracker.configPins.get(configKey)?.has(pin)) return false;
  // Within-port channel exclusivity (pin belongs to one channel across all configs)
  const ppKey = `${portName}\0${pin}`;
  const existingChannel = tracker.portPinChannel.get(ppKey);
  if (existingChannel !== undefined && existingChannel !== channelName) return false;
  // Peripheral instance exclusivity (unless shared)
  if (peripheralInstance && !isSharedInstance(peripheralInstance, tracker.sharedPatterns)) {
    const instOwner = tracker.instanceOwner.get(peripheralInstance);
    if (instOwner !== undefined && instOwner !== portName) return false;
  }
  // Within-config signal exclusivity (a peripheral signal can only be assigned once per config)
  if (signalName && signalName.includes('_')) {
    if (tracker.configSignals.get(configKey)?.has(signalName)) return false;
  }
  return true;
}

export function assignPin(
  tracker: PinTracker, pin: string, portName: string, configName: string, channelName: string,
  peripheralInstance?: string, signalName?: string
): void {
  tracker.pinOwner.set(pin, portName);
  const ppKey = `${portName}\0${pin}`;
  tracker.portPinRefCount.set(ppKey, (tracker.portPinRefCount.get(ppKey) || 0) + 1);
  tracker.portPinChannel.set(ppKey, channelName);
  const configKey = `${portName}\0${configName}`;
  if (!tracker.configPins.has(configKey)) tracker.configPins.set(configKey, new Set());
  tracker.configPins.get(configKey)!.add(pin);
  // Track peripheral instance ownership
  if (peripheralInstance) {
    tracker.instanceOwner.set(peripheralInstance, portName);
    const ipKey = `${portName}\0${peripheralInstance}`;
    tracker.instanceRefCount.set(ipKey, (tracker.instanceRefCount.get(ipKey) || 0) + 1);
  }
  // Track peripheral signal usage within config
  if (signalName && signalName.includes('_')) {
    if (!tracker.configSignals.has(configKey)) tracker.configSignals.set(configKey, new Set());
    tracker.configSignals.get(configKey)!.add(signalName);
  }
}

export function unassignPin(
  tracker: PinTracker, pin: string, portName: string, configName: string,
  peripheralInstance?: string, signalName?: string
): void {
  const configKey = `${portName}\0${configName}`;
  tracker.configPins.get(configKey)!.delete(pin);
  const ppKey = `${portName}\0${pin}`;
  const count = tracker.portPinRefCount.get(ppKey)! - 1;
  if (count === 0) {
    tracker.portPinRefCount.delete(ppKey);
    tracker.pinOwner.delete(pin);
    tracker.portPinChannel.delete(ppKey);
  } else {
    tracker.portPinRefCount.set(ppKey, count);
  }
  // Untrack peripheral instance
  if (peripheralInstance) {
    const ipKey = `${portName}\0${peripheralInstance}`;
    const iCount = tracker.instanceRefCount.get(ipKey)! - 1;
    if (iCount === 0) {
      tracker.instanceRefCount.delete(ipKey);
      tracker.instanceOwner.delete(peripheralInstance);
    } else {
      tracker.instanceRefCount.set(ipKey, iCount);
    }
  }
  // Untrack peripheral signal
  if (signalName && signalName.includes('_')) {
    tracker.configSignals.get(configKey)?.delete(signalName);
  }
}

// ============================================================
// AST Extraction
// ============================================================

export function extractPorts(ast: ProgramNode): Map<string, PortSpec> {
  const ports = new Map<string, PortSpec>();

  for (const stmt of ast.statements) {
    if (stmt.type !== 'port_decl') continue;

    const channels = new Map<string, ChannelSpec>();
    for (const ch of stmt.channels) {
      channels.set(ch.name, {
        name: ch.name,
        allowedPins: ch.allowedPins ? new Set(ch.allowedPins) : undefined,
      });
    }

    const configs: ConfigSpec[] = [];
    for (const cfg of stmt.configs) {
      const mappings: MappingSpec[] = [];
      const requires: RequireNode[] = [];

      for (const item of cfg.body) {
        if (item.type === 'mapping') {
          mappings.push({
            channelName: item.channelName,
            signalExprs: item.signalExprs.map(expr => ({
              alternatives: expr.alternatives,
              candidates: [], // resolved later
            })),
          });
        } else if (item.type === 'require') {
          requires.push(item);
        }
      }

      configs.push({ name: cfg.name, mappings, requires });
    }

    ports.set(stmt.name, { name: stmt.name, channels, configs });
  }

  return ports;
}

export interface ReserveResult {
  pins: string[];
  peripherals: string[];
}

/** Resolve reserve patterns against MCU pin names and peripheral instances */
export function resolveReservePatterns(ast: ProgramNode, mcu: Mcu): ReserveResult {
  const pins: string[] = [];
  const peripherals: string[] = [];

  for (const stmt of ast.statements) {
    if (stmt.type !== 'reserve_decl') continue;

    for (const pattern of stmt.patterns) {
      // Try matching against pin names
      let matchedPin = false;
      for (const pin of mcu.pins) {
        if (matchPatternToInstance(pattern, pin.name)) {
          pins.push(pin.name);
          matchedPin = true;
        }
      }

      // Try matching against peripheral instances
      for (const periph of mcu.peripherals) {
        if (matchPatternToInstance(pattern, periph.instanceName)) {
          peripherals.push(periph.instanceName);
        }
      }

      // If pattern is a literal that didn't match any MCU pin or peripheral,
      // still add it as a pin name (backwards compat for unknown pins)
      if (!matchedPin && pattern.type === 'literal' && peripherals.length === 0) {
        pins.push(pattern.value);
      }
    }
  }

  return { pins, peripherals };
}

export interface PinnedAssignment {
  pinName: string;
  signalName: string;
}

export function extractPinnedAssignments(ast: ProgramNode): PinnedAssignment[] {
  const result: PinnedAssignment[] = [];
  for (const stmt of ast.statements) {
    if (stmt.type === 'pin_decl') {
      result.push({ pinName: stmt.pinName, signalName: stmt.signalName });
    }
  }
  return result;
}

export function extractSharedPatterns(ast: ProgramNode): PatternPart[] {
  const patterns: PatternPart[] = [];
  for (const stmt of ast.statements) {
    if (stmt.type === 'shared_decl') {
      patterns.push(...stmt.patterns);
    }
  }
  return patterns;
}

/** Check if a peripheral instance name matches any shared pattern */
export function isSharedInstance(instance: string, patterns: PatternPart[]): boolean {
  for (const p of patterns) {
    if (matchInstancePattern(instance, p)) return true;
  }
  return false;
}

function matchInstancePattern(instance: string, pattern: PatternPart): boolean {
  switch (pattern.type) {
    case 'literal':
      return instance === pattern.value;
    case 'any':
      return true;
    case 'wildcard':
      return instance.startsWith(pattern.prefix);
    case 'range': {
      if (!instance.startsWith(pattern.prefix)) return false;
      const suffix = instance.substring(pattern.prefix.length);
      const num = parseInt(suffix, 10);
      return !isNaN(num) && String(num) === suffix && pattern.values.includes(num);
    }
  }
}

// ============================================================
// Config Combinations
// ============================================================

export function generateConfigCombinations(ports: Map<string, PortSpec>): Map<string, string>[] {
  const portNames: string[] = [];
  const configNames: string[][] = [];

  for (const [name, port] of ports) {
    if (port.configs.length === 0) continue;
    portNames.push(name);
    configNames.push(port.configs.map(c => c.name));
  }

  if (portNames.length === 0) return [new Map()];

  // Cartesian product
  const combos: Map<string, string>[] = [];
  const indices = new Array(portNames.length).fill(0);

  while (true) {
    const combo = new Map<string, string>();
    for (let i = 0; i < portNames.length; i++) {
      combo.set(portNames[i], configNames[i][indices[i]]);
    }
    combos.push(combo);

    // Increment
    let carry = true;
    for (let i = indices.length - 1; i >= 0 && carry; i--) {
      indices[i]++;
      if (indices[i] < configNames[i].length) {
        carry = false;
      } else {
        indices[i] = 0;
      }
    }
    if (carry) break;
  }

  return combos;
}

// ============================================================
// Variable Resolution (all configs at once)
// ============================================================

export function resolveAllVariables(
  ports: Map<string, PortSpec>,
  mcu: Mcu,
  reservedPins: Set<string>,
  reservedPeripherals: Set<string> = new Set()
): SolverVariable[] {
  const variables: SolverVariable[] = [];

  for (const [portName, port] of ports) {
    for (const config of port.configs) {
      for (const mapping of config.mappings) {
        const channel = port.channels.get(mapping.channelName);

        // Each &-separated signal expr creates a separate solver variable (multi-pin)
        for (let exprIdx = 0; exprIdx < mapping.signalExprs.length; exprIdx++) {
          const expr = mapping.signalExprs[exprIdx];

          let allCandidates: SignalCandidate[] = [];
          for (const pattern of expr.alternatives) {
            const candidates = expandPatternToCandidates(pattern, mcu, channel?.allowedPins);
            allCandidates.push(...candidates);
          }

          allCandidates = allCandidates.filter(c =>
            !reservedPins.has(c.pin.name) &&
            !reservedPeripherals.has(c.peripheralInstance)
          );

          // Deduplicate by pin+signal
          const seen = new Set<string>();
          allCandidates = allCandidates.filter(c => {
            const key = `${c.pin.name}:${c.signalName}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          const patternRaw = expr.alternatives.map(a => a.raw).join(' | ');
          variables.push({
            portName,
            channelName: mapping.channelName,
            configName: config.name,
            exprIndex: exprIdx,
            patternRaw,
            candidates: allCandidates,
            domain: allCandidates.map((_, i) => i),
          });
        }
      }
    }
  }

  return variables;
}

// ============================================================
// GPIO Variable Partitioning
// ============================================================

/** Check if a solver variable represents a pure GPIO (IN/OUT) pattern. */
export function isGpioVariable(v: SolverVariable): boolean {
  const parts = v.patternRaw.split(' | ').map(p => p.trim());
  return parts.length > 0 && parts.every(p => p === 'IN' || p === 'OUT');
}

export interface GpioPartitionResult {
  solveVars: SolverVariable[];
  gpioVars: SolverVariable[];
  gpioCountPerConfig: Map<string, number>;
}

// ============================================================
// Problem Complexity Estimation (A1)
// ============================================================

export function estimateComplexity(ast: ProgramNode, mcu: Mcu): 'easy' | 'medium' | 'hard' | 'very-hard' {
  const { ast: expandedAst } = expandAllMacros(ast, getStdlibMacros());
  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const reservedPinSet = new Set(reserved.pins);
  const reservedPeripheralSet = new Set(reserved.peripherals);
  const allVars = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);
  const configCombos = generateConfigCombinations(ports);

  const varCount = allVars.length;
  const comboCount = configCombos.length;

  if (varCount < 10 && comboCount < 5) return 'easy';
  if (varCount < 30 && comboCount < 20) return 'medium';
  if (varCount < 80) return 'hard';
  return 'very-hard';
}

/** Partition variables into solvable and GPIO-only (availability check). */
export function partitionGpioVariables(
  variables: SolverVariable[],
  skipGpioMapping: boolean
): GpioPartitionResult {
  const solveVars: SolverVariable[] = [];
  const gpioVars: SolverVariable[] = [];
  const gpioCountPerConfig = new Map<string, number>();

  for (const v of variables) {
    if (isGpioVariable(v)) {
      const key = `${v.portName}\0${v.configName}`;
      gpioCountPerConfig.set(key, (gpioCountPerConfig.get(key) ?? 0) + 1);
      if (skipGpioMapping) {
        gpioVars.push(v);
      } else {
        solveVars.push(v);
      }
    } else {
      solveVars.push(v);
    }
  }

  return { solveVars, gpioVars, gpioCountPerConfig };
}

/** Annotate solutions with gpioCount and filter those without enough free pins. */
export function validateGpioAvailability(
  solutions: Solution[],
  gpioCountPerConfig: Map<string, number>,
  mcu: Mcu,
  reservedPins: string[],
  pinnedAssignments: PinnedAssignment[]
): Solution[] {
  if (gpioCountPerConfig.size === 0) {
    for (const s of solutions) s.gpioCount = 0;
    return solutions;
  }

  const totalAssignable = mcu.pins.filter(p => p.isAssignable).length;
  const alwaysUnavailable = new Set<string>(reservedPins);
  for (const pa of pinnedAssignments) {
    alwaysUnavailable.add(pa.pinName);
  }

  return solutions.filter(solution => {
    let totalGpio = 0;
    for (const configAssignment of solution.configAssignments) {
      const unavailable = new Set(alwaysUnavailable);
      for (const a of configAssignment.assignments) {
        if (a.portName !== '<pinned>') unavailable.add(a.pinName);
      }

      let gpioNeeded = 0;
      for (const [portName, configName] of configAssignment.activeConfigs) {
        gpioNeeded += gpioCountPerConfig.get(`${portName}\0${configName}`) ?? 0;
      }
      totalGpio = Math.max(totalGpio, gpioNeeded);

      if (gpioNeeded > 0 && totalAssignable - unavailable.size < gpioNeeded) {
        return false;
      }
    }
    solution.gpioCount = totalGpio;
    return true;
  });
}

// ============================================================
// Pre-solve Validation
// ============================================================

const KNOWN_FUNCTIONS = new Set([
  'same_instance', 'diff_instance', 'instance', 'type',
  'gpio_pin', 'gpio_port', 'dma',
]);

export function validateConstraints(ports: Map<string, PortSpec>, errors: SolverError[]): void {
  for (const [portName, port] of ports) {
    // Collect all channel names that have mappings in any config
    const mappedChannels = new Set<string>();
    for (const config of port.configs) {
      for (const mapping of config.mappings) {
        mappedChannels.add(mapping.channelName);
      }
    }

    for (const config of port.configs) {
      // Validate require constraints
      for (const req of config.requires) {
        validateExpr(req.expression, portName, mappedChannels, config.name, errors);
      }
    }
  }
}

function validateExpr(
  expr: ConstraintExprNode,
  portName: string,
  mappedChannels: Set<string>,
  configName: string,
  errors: SolverError[]
): void {
  switch (expr.type) {
    case 'function_call':
      if (!KNOWN_FUNCTIONS.has(expr.name)) {
        errors.push({
          type: 'error',
          message: `Unknown function "${expr.name}" in ${portName} config "${configName}"`,
          source: `${portName}`,
        });
      }
      for (const arg of expr.args) {
        validateExpr(arg, portName, mappedChannels, configName, errors);
      }
      break;

    case 'binary_expr':
      validateExpr(expr.left, portName, mappedChannels, configName, errors);
      validateExpr(expr.right, portName, mappedChannels, configName, errors);
      break;

    case 'unary_expr':
      validateExpr(expr.operand, portName, mappedChannels, configName, errors);
      break;

    case 'ident':
      // Check if this identifier refers to a known channel in this port
      if (!mappedChannels.has(expr.name)) {
        errors.push({
          type: 'warning',
          message: `Channel "${expr.name}" referenced in require but has no mapping in ${portName}`,
          source: `${portName}`,
        });
      }
      break;

    case 'dot_access':
      // Cross-port reference - we'd need the other port's channels to validate
      break;

    case 'string_literal':
      break;
  }
}

// ============================================================
// Shared Solver Context
// ============================================================

export interface SolverContext {
  expandedAst: ProgramNode;
  ports: Map<string, PortSpec>;
  reservedPins: string[];
  pinnedAssignments: PinnedAssignment[];
  sharedPatterns: PatternPart[];
  configCombinations: Map<string, string>[];
  variables: SolverVariable[];
  lastVarOfConfig: Map<string, number>;
  configRequiresMap: Map<string, RequireNode[]>;
  tracker: PinTracker;
  stats: SolverStats;
  deepest: { depth: number; assignments: VariableAssignment[] };
  gpioCountPerConfig: Map<string, number>;
  dmaData?: DmaData;
}

/**
 * Prepare common solver state: expand macros, extract ports/pins,
 * resolve variables, build eager-check structures.
 * Returns null if there are fatal errors (empty domains, macro errors with type 'error').
 */
export function prepareSolverContext(
  ast: ProgramNode, mcu: Mcu, errors: SolverError[],
  skipGpioMapping?: boolean
): SolverContext | null {
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
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);

  if (allVariables.length === 0) return null;

  const emptyVar = allVariables.find(v => v.domain.length === 0);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return null;
  }

  const { solveVars: variables, gpioVars, gpioCountPerConfig } = partitionGpioVariables(allVariables, !!skipGpioMapping);

  if (variables.length === 0 && gpioVars.length === 0) return null;

  if (gpioVars.length > 0) {
    errors.push({
      type: 'warning',
      message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only`,
    });
  }

  // Sort by MRV
  variables.sort((a, b) => a.domain.length - b.domain.length);

  // Pre-compute last variable index per (port, config)
  const lastVarOfConfig = new Map<string, number>();
  const configRequiresMap = new Map<string, RequireNode[]>();
  for (let i = 0; i < variables.length; i++) {
    const key = `${variables[i].portName}\0${variables[i].configName}`;
    lastVarOfConfig.set(key, i);
  }
  for (const [portName, port] of ports) {
    for (const config of port.configs) {
      if (config.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${config.name}`, config.requires);
      }
    }
  }

  const tracker = createPinTracker(reserved.pins, sharedPatterns);

  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

  // Only pass DMA data when configs actually use dma() constraints
  const hasDmaConstraints = mcu.dma && configsHaveDma(ports);

  return {
    expandedAst, ports, reservedPins: reserved.pins, pinnedAssignments, sharedPatterns,
    configCombinations, variables, lastVarOfConfig, configRequiresMap,
    tracker, stats, deepest, gpioCountPerConfig,
    dmaData: hasDmaConstraints ? mcu.dma : undefined,
  };
}

// ============================================================
// Backtracking Search
// ============================================================

export function solveConstraints(
  ast: ProgramNode,
  mcu: Mcu,
  config: Partial<SolverConfig> = {}
): SolverResult {
  const cfg = mergeSolverConfig(config);

  const startTime = performance.now();
  const errors: SolverError[] = [];
  const solutions: Solution[] = [];


  // Expand macros (including stdlib) before extracting ports
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

  // Validate constraints before solving
  validateConstraints(ports, errors);

  const configCombinations = generateConfigCombinations(ports);

  // Create variables for ALL configs of ALL ports
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);

  if (allVariables.length === 0) {
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors: [{ type: 'warning', message: 'No variables to solve (no port configs defined)' }],
      statistics: {
        totalCombinations: configCombinations.length,
        evaluatedCombinations: 0,
        validSolutions: 0,
        solveTimeMs: performance.now() - startTime,
        configCombinations: configCombinations.length,
      },
    };
  }

  // Check for empty domains
  const emptyVar = allVariables.find(v => v.domain.length === 0);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return {
      mcuRef: mcu.refName,
      solutions: [],
      errors,
      statistics: {
        totalCombinations: configCombinations.length,
        evaluatedCombinations: 0,
        validSolutions: 0,
        solveTimeMs: performance.now() - startTime,
        configCombinations: configCombinations.length,
      },
    };
  }

  const { solveVars: variables, gpioVars, gpioCountPerConfig } = partitionGpioVariables(allVariables, !!cfg.skipGpioMapping);

  if (gpioVars.length > 0) {
    errors.push({
      type: 'warning',
      message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only`,
    });
  }

  // Sort by MRV (minimum remaining values)
  variables.sort((a, b) => a.domain.length - b.domain.length);

  // Pre-compute: last variable index per (port, config) in MRV order
  // When we reach this index, all variables for that config are assigned
  // and we can eagerly check its require constraints.
  const lastVarOfConfig = new Map<string, number>();
  const configRequiresMap = new Map<string, RequireNode[]>();
  for (let i = 0; i < variables.length; i++) {
    const key = `${variables[i].portName}\0${variables[i].configName}`;
    lastVarOfConfig.set(key, i); // last one wins
  }
  for (const [portName, port] of ports) {
    for (const config of port.configs) {
      if (config.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${config.name}`, config.requires);
      }
    }
  }

  const tracker = createPinTracker(reserved.pins, sharedPatterns);

  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  // Track deepest partial solution for conflict reporting
  const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

  // Only pass DMA data when configs actually use dma() constraints
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;

  // Backtracking search over ALL variables simultaneously
  solveBacktrack(
    variables, 0, tracker, [],
    configCombinations, ports, pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, stats, deepest,
    lastVarOfConfig, configRequiresMap, dmaData
  );

  pushSolverWarnings(errors, solutions, cfg.maxSolutions, startTime, cfg.timeoutMs);

  // If no solutions found, report deepest partial as conflict info
  if (solutions.length === 0 && deepest.depth >= 0) {
    const failingVar = deepest.depth + 1 < variables.length ? variables[deepest.depth + 1] : null;
    const partialAssignments: Assignment[] = deepest.assignments.map(va => ({
      pinName: va.candidate.pin.name,
      signalName: va.candidate.signalName,
      portName: va.variable.portName,
      channelName: va.variable.channelName,
      configurationName: va.variable.configName,
    }));

    if (failingVar) {
      errors.push({
        type: 'error',
        message: `Could not assign ${failingVar.portName}.${failingVar.channelName} (config "${failingVar.configName}") - ${failingVar.candidates.length} candidates all conflict`,
        source: `${failingVar.portName}.${failingVar.channelName}`,
        partialSolution: partialAssignments,
      });
    } else {
      errors.push({
        type: 'error',
        message: 'All pin assignments found but require constraints failed for all config combinations',
        partialSolution: partialAssignments,
      });
    }
  }

  return finalizeSolutions(solutions, mcu, cfg.costWeights, errors, stats, startTime, gpioCountPerConfig, reserved.pins, pinnedAssignments);
}

export function solveBacktrack(
  variables: SolverVariable[],
  varIndex: number,
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
  deepest: { depth: number; assignments: VariableAssignment[] },
  lastVarOfConfig: Map<string, number>,
  configRequiresMap: Map<string, RequireNode[]>,
  dmaData?: DmaData,
  propagationCtx?: PropagationContext,
  costTracker?: IncrementalCostTracker
): void {
  // Iterative backtracking with explicit stack (avoids stack overflow on large problems)
  const totalVars = variables.length;

  // Stack frames: [varIdx, domainPosition, assignedCandidate (or -1 if entering)]
  // We use parallel arrays for performance
  const stackVarIdx: number[] = [];
  const stackDomPos: number[] = [];
  // Track which candidate was assigned at each level for undo
  const stackAssigned: number[] = []; // index into candidates, -1 = not yet assigned

  stackVarIdx.push(varIndex);
  stackDomPos.push(0);
  stackAssigned.push(-1);

  while (stackVarIdx.length > 0) {
    if (performance.now() - startTime > timeoutMs) return;
    if (solutions.length >= maxSolutions) return;

    const sp = stackVarIdx.length - 1;
    const vi = stackVarIdx[sp];

    // Track deepest for conflict reporting
    if (vi > deepest.depth) {
      deepest.depth = vi;
      deepest.assignments = [...current];
    }

    // All variables assigned - evaluate constraints
    if (vi === totalVars) {
      stats.evaluatedCombinations++;
      const dmaAssignmentsOut: Map<string, string>[] = [];
      if (evaluateAllConstraints(current, configCombinations, ports, dmaData, dmaAssignmentsOut)) {
        const solution = buildSolution(
          current, configCombinations, ports, pinnedAssignments, solutions.length, dmaAssignmentsOut
        );
        // C2: compute cost immediately and update pruning threshold
        if (costTracker) {
          computeTotalCost(solution, costTracker.mcu, costTracker.costWeights);
          updateCostThreshold(costTracker, solution.totalCost);
        }
        solutions.push(solution);
        stats.validSolutions++;
        const elapsed = performance.now() - startTime;
        if (stats.firstSolutionMs === undefined) stats.firstSolutionMs = elapsed;
        stats.lastSolutionMs = elapsed;
      }
      // Pop this leaf frame and backtrack
      stackVarIdx.length = sp;
      stackDomPos.length = sp;
      stackAssigned.length = sp;
      // Undo the assignment from the parent frame
      if (sp > 0) {
        const parentSp = sp - 1;
        const parentVi = stackVarIdx[parentSp];
        const parentCandIdx = stackAssigned[parentSp];
        if (parentCandIdx >= 0) {
          const pv = variables[parentVi];
          const pc = pv.candidates[parentCandIdx];
          current.pop();
          if (costTracker) decrementCost(costTracker, pc);
          if (propagationCtx) {
            undoPropagateShared(propagationCtx.removedStack[propagationCtx.removedStack.length - 1], propagationCtx.domains);
            propagationCtx.removedStack.length--;
            propagationCtx.assigned[parentVi] = false;
          }
          unassignPin(tracker, pc.pin.name, pv.portName, pv.configName, pc.peripheralInstance, pc.signalName);
          stackAssigned[parentSp] = -1;
        }
      }
      continue;
    }

    const v = variables[vi];
    const domain = propagationCtx ? propagationCtx.domains[vi] : v.domain;

    // If we had a previous assignment, undo it before trying next candidate
    if (stackAssigned[sp] >= 0) {
      const prevCandIdx = stackAssigned[sp];
      const prevCand = v.candidates[prevCandIdx];
      current.pop();
      if (costTracker) decrementCost(costTracker, prevCand);
      if (propagationCtx) {
        undoPropagateShared(propagationCtx.removedStack[propagationCtx.removedStack.length - 1], propagationCtx.domains);
        propagationCtx.removedStack.length--;
        propagationCtx.assigned[vi] = false;
      }
      unassignPin(tracker, prevCand.pin.name, v.portName, v.configName, prevCand.peripheralInstance, prevCand.signalName);
      stackAssigned[sp] = -1;
    }

    // Try candidates from current domain position
    let found = false;
    const domLen = domain.length;
    for (let dpos = stackDomPos[sp]; dpos < domLen; dpos++) {
      if (solutions.length >= maxSolutions) return;
      if (performance.now() - startTime > timeoutMs) return;

      const candidateIdx = domain[dpos];
      const candidate = v.candidates[candidateIdx];

      if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName)) continue;

      assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance, candidate.signalName);
      current.push({ variable: v, candidate });

      // C2: Incremental cost tracking and pruning
      let pruned = false;
      if (costTracker) {
        incrementCost(costTracker, candidate);
        if (costTracker.partialCost > costTracker.topKThreshold) {
          pruned = true;
        }
      }

      // Eager constraint check
      if (!pruned) {
        const configKey = `${v.portName}\0${v.configName}`;
        if (lastVarOfConfig.get(configKey) === vi) {
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
              if (!evaluateExpr(req.expression, v.portName, channelInfo, dmaData)) {
                pruned = true;
                break;
              }
            }
          }
        }
      }

      // Forward checking propagation (if enabled)
      if (!pruned && propagationCtx) {
        propagationCtx.assigned[vi] = true;
        const removed = propagateShared(
          candidate, v.portName,
          variables, propagationCtx.domains, i => propagationCtx.assigned[i],
          propagationCtx.pinToVarCandidates, propagationCtx.instanceToVarCandidates,
          propagationCtx.sharedPatterns
        );
        if (removed === null) {
          pruned = true;
          propagationCtx.assigned[vi] = false;
        } else {
          propagationCtx.removedStack.push(removed);
        }
      }

      if (!pruned) {
        // Record this assignment and advance
        stackAssigned[sp] = candidateIdx;
        stackDomPos[sp] = dpos + 1; // resume here on backtrack
        // Push next variable frame
        stackVarIdx.push(vi + 1);
        stackDomPos.push(0);
        stackAssigned.push(-1);
        found = true;
        break;
      }

      // Pruned - undo and try next candidate
      current.pop();
      if (costTracker) decrementCost(costTracker, candidate);
      unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance, candidate.signalName);
    }

    if (!found) {
      // No more candidates - backtrack: pop this frame
      stackVarIdx.length = sp;
      stackDomPos.length = sp;
      stackAssigned.length = sp;
    }
  }
}

// ============================================================
// Constraint Evaluation (checks ALL config combinations)
// ============================================================

export function evaluateAllConstraints(
  assignments: VariableAssignment[],
  configCombinations: Map<string, string>[],
  ports: Map<string, PortSpec>,
  dmaData?: DmaData,
  dmaAssignmentsOut?: Map<string, string>[]
): boolean {
  // Build per-config assignment lookup:
  // port -> config -> channel -> VariableAssignment[]
  const byPortConfig = new Map<string, Map<string, Map<string, VariableAssignment[]>>>();
  for (const va of assignments) {
    const port = va.variable.portName;
    const config = va.variable.configName;
    const channel = va.variable.channelName;
    if (!byPortConfig.has(port)) byPortConfig.set(port, new Map());
    const portMap = byPortConfig.get(port)!;
    if (!portMap.has(config)) portMap.set(config, new Map());
    const configMap = portMap.get(config)!;
    if (!configMap.has(channel)) configMap.set(channel, []);
    configMap.get(channel)!.push(va);
  }

  // For EACH config combination, check all active configs' constraints
  for (const combo of configCombinations) {
    // Build flat channelInfo for this combo (port -> channel -> assignments)
    const channelInfo = new Map<string, Map<string, VariableAssignment[]>>();
    for (const [portName, configName] of combo) {
      const configChannels = byPortConfig.get(portName)?.get(configName);
      if (configChannels) {
        channelInfo.set(portName, configChannels);
      }
    }

    // Evaluate each active config's require constraints
    for (const [portName, configName] of combo) {
      const port = ports.get(portName);
      if (!port) continue;
      const config = port.configs.find(c => c.name === configName);
      if (!config) continue;

      for (const req of config.requires) {
        if (!evaluateExpr(req.expression, portName, channelInfo, dmaData)) {
          return false;
        }
      }
    }

    // After require checks pass, compute DMA stream assignment for this combo
    if (dmaData) {
      const dmaAssignment = computeDmaAssignmentForCombo(combo, ports, channelInfo, dmaData);
      if (dmaAssignment === null) {
        return false;
      }
      if (dmaAssignmentsOut) {
        dmaAssignmentsOut.push(dmaAssignment);
      }
    }
  }

  return true;
}

export function evaluateExpr(
  expr: ConstraintExprNode,
  currentPort: string,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>,
  dmaData?: DmaData
): boolean | string {
  switch (expr.type) {
    case 'function_call':
      return evaluateFunctionCall(expr.name, expr.args, currentPort, channelInfo, dmaData);

    case 'binary_expr': {
      const left = evaluateExpr(expr.left, currentPort, channelInfo, dmaData);
      const right = evaluateExpr(expr.right, currentPort, channelInfo, dmaData);
      switch (expr.operator) {
        case '==': return left === right;
        case '!=': return left !== right;
        case '&': return !!left && !!right;
        case '|': return !!left || !!right;
        case '^': return !!left !== !!right;
      }
      return false;
    }

    case 'unary_expr':
      return !evaluateExpr(expr.operand, currentPort, channelInfo, dmaData);

    case 'ident':
      return expr.name;

    case 'string_literal':
      return expr.value;

    case 'dot_access': {
      // Cross-port reference
      return `${expr.object}.${expr.property}`;
    }
  }
}

function evaluateFunctionCall(
  name: string,
  args: ConstraintExprNode[],
  currentPort: string,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>,
  dmaData?: DmaData
): boolean | string {
  const resolveChannel = (arg: ConstraintExprNode): VariableAssignment[] => {
    if (arg.type === 'ident') {
      return channelInfo.get(currentPort)?.get(arg.name) || [];
    }
    if (arg.type === 'dot_access') {
      return channelInfo.get(arg.object)?.get(arg.property) || [];
    }
    return [];
  };

  const getInstance = (va: VariableAssignment): string => {
    return va.candidate.peripheralInstance;
  };

  // Extract optional type filter: last arg may be a string literal like "TIM"
  const extractTypeFilter = (fnArgs: ConstraintExprNode[]): {
    channelArgs: ConstraintExprNode[];
    typeFilter: string | null;
  } => {
    if (fnArgs.length > 0 && fnArgs[fnArgs.length - 1].type === 'string_literal') {
      const raw = (fnArgs[fnArgs.length - 1] as { value: string }).value;
      return {
        channelArgs: fnArgs.slice(0, -1),
        typeFilter: normalizePeripheralType(raw),
      };
    }
    return { channelArgs: fnArgs, typeFilter: null };
  };

  const matchesFilter = (va: VariableAssignment, typeFilter: string | null): boolean => {
    if (!typeFilter) return true;
    return va.candidate.peripheralType === typeFilter;
  };

  switch (name) {
    case 'same_instance': {
      // All channels must use the same peripheral instance
      // Optional last arg: type filter string, e.g. same_instance(A, B, "TIM")
      const { channelArgs, typeFilter } = extractTypeFilter(args);
      const instances = new Set<string>();
      for (const arg of channelArgs) {
        const vas = resolveChannel(arg);
        for (const va of vas) {
          if (!matchesFilter(va, typeFilter)) continue;
          instances.add(getInstance(va));
        }
      }
      return instances.size <= 1;
    }

    case 'diff_instance': {
      // All channels must use different peripheral instances
      // Optional last arg: type filter string
      const { channelArgs, typeFilter } = extractTypeFilter(args);
      const instances: string[] = [];
      for (const arg of channelArgs) {
        const vas = resolveChannel(arg);
        for (const va of vas) {
          if (!matchesFilter(va, typeFilter)) continue;
          instances.push(getInstance(va));
        }
      }
      return new Set(instances).size === instances.length;
    }

    case 'instance': {
      // Returns the peripheral instance name for a channel
      // Optional second arg: type filter, e.g. instance(A, "TIM")
      const { channelArgs: iArgs, typeFilter: iFilter } = extractTypeFilter(args);
      if (iArgs.length === 1) {
        const vas = resolveChannel(iArgs[0]);
        for (const va of vas) {
          if (matchesFilter(va, iFilter)) return getInstance(va);
        }
      }
      return '';
    }

    case 'type': {
      // Returns the normalized peripheral type for a channel
      // Optional second arg: type filter, e.g. type(A, "TIM")
      const { channelArgs: tArgs, typeFilter: tFilter } = extractTypeFilter(args);
      if (tArgs.length === 1) {
        const vas = resolveChannel(tArgs[0]);
        for (const va of vas) {
          if (matchesFilter(va, tFilter)) return va.candidate.peripheralType;
        }
      }
      return '';
    }

    case 'gpio_pin': {
      // Returns the pin name (e.g., "PA4")
      // Optional second arg: type filter, e.g. gpio_pin(MOSI, "SPI")
      const { channelArgs: gpArgs, typeFilter: gpFilter } = extractTypeFilter(args);
      if (gpArgs.length === 1) {
        const vas = resolveChannel(gpArgs[0]);
        for (const va of vas) {
          if (matchesFilter(va, gpFilter)) return va.candidate.pin.name;
        }
      }
      return '';
    }

    case 'gpio_port': {
      // Returns the GPIO port instance name (e.g., "GPIO1" for port A, "GPIO2" for port B)
      // Optional second arg: type filter, e.g. gpio_port(MOSI, "SPI")
      const { channelArgs: gpoArgs, typeFilter: gpoFilter } = extractTypeFilter(args);
      if (gpoArgs.length === 1) {
        const vas = resolveChannel(gpoArgs[0]);
        for (const va of vas) {
          if (!matchesFilter(va, gpoFilter)) continue;
          const pin = va.candidate.pin;
          if (pin.gpioPort) {
            const portNum = pin.gpioPort.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
            return `GPIO${portNum}`;
          }
        }
      }
      return '';
    }

    case 'dma': {
      // Check if the channel's assigned signal has DMA stream support.
      // dma(channel) or dma(channel, "TYPE_TRIGGER") with optional filter.
      // The filter specifies the peripheral type for candidate filtering and
      // optionally the DMA trigger function (e.g. "SPI_TX" → look up SPI1_TX).
      if (!dmaData) return true;
      // Extract channel arg and optional filter
      let dmaChannelArg: ConstraintExprNode | null = null;
      let dmaFilt: { peripheralType: string | null; triggerFunction: string | null } =
        { peripheralType: null, triggerFunction: null };
      if (args.length >= 1) {
        dmaChannelArg = args[0];
        if (args.length >= 2 && args[args.length - 1].type === 'string_literal') {
          dmaFilt = parseDmaFilter((args[args.length - 1] as { value: string }).value);
        }
      }
      if (!dmaChannelArg) return true;
      const vas = resolveChannel(dmaChannelArg);
      let hasMatchingVa = false;
      for (const va of vas) {
        if (dmaFilt.peripheralType && va.candidate.peripheralType !== dmaFilt.peripheralType) continue;
        hasMatchingVa = true;
        const triggerName = getDmaTriggerName(
          va.candidate.peripheralInstance, dmaFilt.triggerFunction, va.candidate.signalName
        );
        const streams = findDmaStreamsForSignal(
          dmaData, triggerName, va.candidate.peripheralInstance
        );
        if (streams.length > 0) return true;
      }
      // If channel not yet assigned or no VAs match the filter, vacuously true
      return !hasMatchingVa;
    }

    default:
      return false;
  }
}

// ============================================================
// DMA Stream Feasibility Validation
// ============================================================

interface DmaReq {
  portName: string;
  channelName: string;
  signalName: string;
  availableStreams: DmaStreamInfo[];
}

/**
 * Parse a dma() filter string into peripheral type and trigger function.
 * e.g. "SPI_TX" → { peripheralType: "SPI", triggerFunction: "TX" }
 *      "TIM"    → { peripheralType: "TIM", triggerFunction: null }
 *      "USART_RX" → { peripheralType: "USART", triggerFunction: "RX" }
 */
function parseDmaFilter(raw: string): { peripheralType: string; triggerFunction: string | null } {
  const idx = raw.indexOf('_');
  if (idx !== -1) {
    return {
      peripheralType: normalizePeripheralType(raw.substring(0, idx)),
      triggerFunction: raw.substring(idx + 1),
    };
  }
  return { peripheralType: normalizePeripheralType(raw), triggerFunction: null };
}

/**
 * Construct the DMA trigger name to look up in the DMA data.
 * If the dma() filter specifies a trigger function (e.g. "SPI_TX"),
 * the trigger is instance + "_" + function (e.g. "SPI1_TX").
 * Otherwise, use the MCU signal name from the channel mapping (e.g. "TIM2_CH3").
 */
function getDmaTriggerName(
  instance: string,
  triggerFunction: string | null,
  signalName: string
): string {
  if (triggerFunction) return instance + '_' + triggerFunction;
  return signalName;
}

interface DmaFilter {
  peripheralType: string | null;
  triggerFunction: string | null;
}

/**
 * Compute a concrete DMA stream assignment for a config combination.
 *
 * Rules:
 * - A DMA stream is exclusive to one port (cross-port exclusivity)
 * - A DMA stream serves at most one channel within a config (within-config exclusivity)
 * - Different configs of the same port may reuse the same stream
 *
 * Returns the assignment map (signalName → stream name) if feasible, or null if not.
 * Only channels with dma() constraints are included.
 */
function computeDmaAssignmentForCombo(
  combo: Map<string, string>,
  ports: Map<string, PortSpec>,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>,
  dmaData: DmaData
): Map<string, string> | null {
  const requirements: DmaReq[] = [];

  for (const [portName, configName] of combo) {
    const port = ports.get(portName);
    if (!port) continue;
    const config = port.configs.find(c => c.name === configName);
    if (!config) continue;

    // Check if this config has any dma() constraints
    const dmaChannels = collectDmaChannels(config.requires);
    if (dmaChannels.size === 0) continue;

    const portChannels = channelInfo.get(portName);
    if (!portChannels) continue;

    for (const [channelName, filter] of dmaChannels) {
      const vas = portChannels.get(channelName) ?? [];
      for (const va of vas) {
        if (filter.peripheralType && va.candidate.peripheralType !== filter.peripheralType) continue;
        const triggerName = getDmaTriggerName(
          va.candidate.peripheralInstance, filter.triggerFunction, va.candidate.signalName
        );
        const streams = findDmaStreamsForSignal(
          dmaData, triggerName, va.candidate.peripheralInstance
        );
        if (streams.length > 0) {
          requirements.push({
            portName, channelName,
            signalName: va.candidate.signalName,
            availableStreams: streams,
          });
        }
      }
    }
  }

  if (requirements.length === 0) return new Map();

  // Try to find a consistent assignment via backtracking
  const assigned = new Array<DmaStreamInfo | null>(requirements.length).fill(null);
  if (!assignDmaStreams(requirements, 0, new Map(), assigned)) return null;

  // Build the result map: signalName → stream name
  const result = new Map<string, string>();
  for (let i = 0; i < requirements.length; i++) {
    if (assigned[i]) {
      result.set(requirements[i].signalName, assigned[i]!.name);
    }
  }
  return result;
}

/**
 * Quick check: do any configs in any port have a dma() constraint?
 */
export function configsHaveDma(ports: Map<string, PortSpec>): boolean {
  for (const port of ports.values()) {
    for (const config of port.configs) {
      for (const req of config.requires) {
        if (exprHasDma(req.expression)) return true;
      }
    }
  }
  return false;
}

function exprHasDma(expr: ConstraintExprNode): boolean {
  switch (expr.type) {
    case 'function_call':
      if (expr.name === 'dma') return true;
      return expr.args.some(exprHasDma);
    case 'binary_expr':
      return exprHasDma(expr.left) || exprHasDma(expr.right);
    case 'unary_expr':
      return exprHasDma(expr.operand);
    default:
      return false;
  }
}

/**
 * Walk require expressions to find dma() function calls and their channel arguments.
 * Returns a map of channel name -> DMA filter info.
 */
function collectDmaChannels(requires: RequireNode[]): Map<string, DmaFilter> {
  const result = new Map<string, DmaFilter>();
  for (const req of requires) {
    walkExprForDma(req.expression, result);
  }
  return result;
}

function walkExprForDma(expr: ConstraintExprNode, result: Map<string, DmaFilter>): void {
  switch (expr.type) {
    case 'function_call':
      if (expr.name === 'dma') {
        const args = expr.args;
        if (args.length >= 1 && args[0].type === 'ident') {
          let filter: DmaFilter = { peripheralType: null, triggerFunction: null };
          if (args.length >= 2 && args[args.length - 1].type === 'string_literal') {
            const raw = (args[args.length - 1] as { value: string }).value;
            filter = parseDmaFilter(raw);
          }
          result.set(args[0].name, filter);
        }
      }
      for (const arg of expr.args) {
        walkExprForDma(arg, result);
      }
      break;
    case 'binary_expr':
      walkExprForDma(expr.left, result);
      walkExprForDma(expr.right, result);
      break;
    case 'unary_expr':
      walkExprForDma(expr.operand, result);
      break;
  }
}

/**
 * Backtracking assignment of DMA streams to requirements.
 * Each stream is used by at most one requirement in a config combination.
 * Cross-port: a stream can only belong to one port.
 * Within-config: each channel needs its own stream.
 *
 * Fills in the `assigned` array with the chosen stream for each requirement.
 */
function assignDmaStreams(
  requirements: DmaReq[],
  index: number,
  usedStreams: Map<string, string>,  // stream name -> "port\0channel" that claimed it
  assigned: Array<DmaStreamInfo | null>
): boolean {
  if (index === requirements.length) return true;

  const req = requirements[index];
  const reqKey = `${req.portName}\0${req.channelName}`;

  for (const stream of req.availableStreams) {
    const claimedBy = usedStreams.get(stream.name);
    if (claimedBy !== undefined) {
      // Stream already claimed - check if it's the same port but different channel
      const claimedPort = claimedBy.split('\0')[0];
      if (claimedPort !== req.portName) continue; // cross-port conflict
      // Same port, different channel in same config - conflict
      continue;
    }

    usedStreams.set(stream.name, reqKey);
    assigned[index] = stream;
    if (assignDmaStreams(requirements, index + 1, usedStreams, assigned)) return true;
    usedStreams.delete(stream.name);
    assigned[index] = null;
  }

  return false;
}

// ============================================================
// Solution Building
// ============================================================

export function buildSolution(
  varAssignments: VariableAssignment[],
  configCombinations: Map<string, string>[],
  _ports: Map<string, PortSpec>,
  pinnedAssignments: PinnedAssignment[],
  id: number,
  dmaAssignments?: Map<string, string>[]
): Solution {
  const pinnedEntries: Assignment[] = pinnedAssignments.map(pa => ({
    pinName: pa.pinName,
    signalName: pa.signalName,
    portName: '<pinned>',
    channelName: '<pinned>',
    configurationName: '<pinned>',
  }));

  // Build one ConfigCombinationAssignment per config combination
  const configAssignments = configCombinations.map((combo, comboIdx) => {
    const comboAssignments: Assignment[] = [];
    for (const va of varAssignments) {
      if (combo.get(va.variable.portName) === va.variable.configName) {
        comboAssignments.push({
          pinName: va.candidate.pin.name,
          signalName: va.candidate.signalName,
          portName: va.variable.portName,
          channelName: va.variable.channelName,
          configurationName: va.variable.configName,
        });
      }
    }
    comboAssignments.push(...pinnedEntries);
    const ca: import('../types').ConfigCombinationAssignment = {
      activeConfigs: combo,
      assignments: comboAssignments,
    };
    if (dmaAssignments && dmaAssignments[comboIdx] && dmaAssignments[comboIdx].size > 0) {
      ca.dmaStreamAssignment = dmaAssignments[comboIdx];
    }
    return ca;
  });

  // Collect all peripherals across all configs
  const allAssignments: Assignment[] = varAssignments.map(va => ({
    pinName: va.candidate.pin.name,
    signalName: va.candidate.signalName,
    portName: va.variable.portName,
    channelName: va.variable.channelName,
    configurationName: va.variable.configName,
  }));

  const solution: Solution = {
    id,
    mcuRef: '',  // set by solveConstraints after building
    configAssignments,
    portPeripherals: extractPeripherals(allAssignments),
    costs: new Map(),
    totalCost: 0,
    gpioCount: 0,  // set by validateGpioAvailability
  };

  return solution;
}

// ============================================================
// Deduplication
// ============================================================

export function deduplicateSolutions(solutions: Solution[]): Solution[] {
  const seen = new Set<string>();
  const result: Solution[] = [];

  for (const sol of solutions) {
    // Create a fingerprint from all config assignments
    const parts: string[] = [];
    for (const ca of sol.configAssignments) {
      const configParts: string[] = [];
      for (const [port, config] of ca.activeConfigs) {
        configParts.push(`${port}=${config}`);
      }
      const assignParts = ca.assignments
        .filter(a => a.portName !== '<pinned>')
        .map(a => `${a.portName}.${a.channelName}:${a.pinName}=${a.signalName}`)
        .sort();
      parts.push(`[${configParts.sort().join(',')}]{${assignParts.join(',')}}`);
    }
    const key = parts.sort().join('|');

    if (!seen.has(key)) {
      seen.add(key);
      result.push(sol);
    }
  }

  // Re-number
  result.forEach((s, i) => s.id = i);
  return result;
}

// ============================================================
// Solution Clustering (D5)
// ============================================================

/** Group solutions by peripheral fingerprint (port→peripherals, ignoring pin names).
 *  Sets clusterSize on each solution and returns one representative per cluster (lowest cost). */
export function clusterSolutions(solutions: Solution[]): Solution[] {
  if (solutions.length === 0) return solutions;

  const clusters = new Map<string, Solution[]>();
  for (const sol of solutions) {
    // Build fingerprint from portPeripherals (ignoring pin-level details)
    const parts: string[] = [];
    for (const [port, peripherals] of sol.portPeripherals) {
      parts.push(`${port}:[${[...peripherals].sort().join(',')}]`);
    }
    const fp = parts.sort().join('|');
    if (!clusters.has(fp)) clusters.set(fp, []);
    clusters.get(fp)!.push(sol);
  }

  const representatives: Solution[] = [];
  for (const group of clusters.values()) {
    group.sort((a, b) => a.totalCost - b.totalCost);
    const best = group[0];
    best.clusterSize = group.length;
    representatives.push(best);
  }

  representatives.sort((a, b) => a.totalCost - b.totalCost);
  representatives.forEach((s, i) => s.id = i);
  return representatives;
}

// ============================================================
// Helpers
// ============================================================

export function extractPeripherals(assignments: Assignment[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!result.has(a.portName)) {
      result.set(a.portName, new Set());
    }
    // Extract peripheral instance from signal name
    const match = a.signalName.match(/^([A-Z]+\d*)/);
    if (match) {
      result.get(a.portName)!.add(match[1]);
    }
  }
  return result;
}
