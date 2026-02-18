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
  Assignment,
} from '../types';
import { normalizePeripheralType } from '../types';
import type {
  ProgramNode,
  RequireNode, SignalPatternNode,
  ConstraintExprNode, PatternPart,
} from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import { expandPatternToCandidates, type SignalCandidate } from './pattern-matcher';
import { computeTotalCost } from './cost-functions';

// ============================================================
// Solver Configuration
// ============================================================

export interface SolverConfig {
  maxSolutions: number;
  timeoutMs: number;
  costWeights: Map<string, number>;
}

const DEFAULT_CONFIG: SolverConfig = {
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
  };
}

export function canAssignPin(
  tracker: PinTracker, pin: string, portName: string, configName: string, channelName: string,
  peripheralInstance?: string
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
  return true;
}

export function assignPin(
  tracker: PinTracker, pin: string, portName: string, configName: string, channelName: string,
  peripheralInstance?: string
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
}

export function unassignPin(
  tracker: PinTracker, pin: string, portName: string, configName: string,
  peripheralInstance?: string
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

export function extractReservedPins(ast: ProgramNode): string[] {
  const pins: string[] = [];
  for (const stmt of ast.statements) {
    if (stmt.type === 'reserve_decl') {
      pins.push(...stmt.pins);
    }
  }
  return pins;
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
  reservedPins: Set<string>
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

          allCandidates = allCandidates.filter(c => !reservedPins.has(c.pin.name));

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
// Pre-solve Validation
// ============================================================

const KNOWN_FUNCTIONS = new Set([
  'same_instance', 'diff_instance', 'instance', 'type',
  'gpio_pin', 'gpio_port',
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
      // Cross-port reference — we'd need the other port's channels to validate
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
}

/**
 * Prepare common solver state: expand macros, extract ports/pins,
 * resolve variables, build eager-check structures.
 * Returns null if there are fatal errors (empty domains, macro errors with type 'error').
 */
export function prepareSolverContext(
  ast: ProgramNode, mcu: Mcu, errors: SolverError[]
): SolverContext | null {
  const { ast: expandedAst, errors: macroErrors } = expandAllMacros(ast, getStdlibMacros());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reservedPins = extractReservedPins(expandedAst);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedSet = new Set(reservedPins);
  for (const pa of pinnedAssignments) {
    reservedSet.add(pa.pinName);
  }

  validateConstraints(ports, errors);

  const configCombinations = generateConfigCombinations(ports);
  const variables = resolveAllVariables(ports, mcu, reservedSet);

  if (variables.length === 0) return null;

  const emptyVar = variables.find(v => v.domain.length === 0);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return null;
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

  const tracker = createPinTracker(reservedPins, sharedPatterns);

  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

  return {
    expandedAst, ports, reservedPins, pinnedAssignments, sharedPatterns,
    configCombinations, variables, lastVarOfConfig, configRequiresMap,
    tracker, stats, deepest,
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
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (config.costWeights) {
    cfg.costWeights = new Map([...DEFAULT_CONFIG.costWeights, ...config.costWeights]);
  }

  const startTime = performance.now();
  const errors: SolverError[] = [];
  const solutions: Solution[] = [];


  // Expand macros (including stdlib) before extracting ports
  const { ast: expandedAst, errors: macroErrors } = expandAllMacros(ast, getStdlibMacros());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }
  const ports = extractPorts(expandedAst);
  const reservedPins = extractReservedPins(expandedAst);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedSet = new Set(reservedPins);
  for (const pa of pinnedAssignments) {
    reservedSet.add(pa.pinName);
  }

  // Validate constraints before solving
  validateConstraints(ports, errors);

  const configCombinations = generateConfigCombinations(ports);

  // Create variables for ALL configs of ALL ports
  const variables = resolveAllVariables(ports, mcu, reservedSet);

  if (variables.length === 0) {
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
  const emptyVar = variables.find(v => v.domain.length === 0);
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

  const tracker = createPinTracker(reservedPins, sharedPatterns);

  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  // Track deepest partial solution for conflict reporting
  const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

  // Backtracking search over ALL variables simultaneously
  solveBacktrack(
    variables, 0, tracker, [],
    configCombinations, ports, pinnedAssignments,
    solutions, cfg.maxSolutions, startTime, cfg.timeoutMs, stats, deepest,
    lastVarOfConfig, configRequiresMap
  );

  if (solutions.length >= cfg.maxSolutions) {
    errors.push({ type: 'warning', message: `Maximum solutions (${cfg.maxSolutions}) reached.` });
  }
  if (performance.now() - startTime > cfg.timeoutMs) {
    errors.push({ type: 'warning', message: `Solver timeout after ${solutions.length} solutions.` });
  }

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
        message: `Could not assign ${failingVar.portName}.${failingVar.channelName} (config "${failingVar.configName}") — ${failingVar.candidates.length} candidates all conflict`,
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

  // Set mcuRef and compute costs for all solutions
  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, cfg.costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  stats.solveTimeMs = performance.now() - startTime;

  // Deduplicate solutions with identical pin assignments
  const deduped = deduplicateSolutions(solutions);

  return { mcuRef: mcu.refName, solutions: deduped, errors, statistics: stats };
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
  configRequiresMap: Map<string, RequireNode[]>
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (solutions.length >= maxSolutions) return;

  // Track deepest partial solution for conflict reporting
  if (varIndex > deepest.depth) {
    deepest.depth = varIndex;
    deepest.assignments = [...current];
  }

  if (varIndex === variables.length) {
    // All variables assigned — check require constraints for ALL config combinations
    stats.evaluatedCombinations++;
    if (evaluateAllConstraints(current, configCombinations, ports)) {
      const solution = buildSolution(
        current, configCombinations, ports, pinnedAssignments, solutions.length
      );
      solutions.push(solution);
      stats.validSolutions++;
    }
    return;
  }

  const v = variables[varIndex];

  for (const candidateIdx of v.domain) {
    if (solutions.length >= maxSolutions) return;
    if (performance.now() - startTime > timeoutMs) return;

    const candidate = v.candidates[candidateIdx];

    // Port-aware pin uniqueness check (includes channel and peripheral instance exclusivity)
    if (!canAssignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance)) continue;

    assignPin(tracker, candidate.pin.name, v.portName, v.configName, v.channelName, candidate.peripheralInstance);
    current.push({ variable: v, candidate });

    // Eager constraint check: when all variables of a (port, config) are assigned,
    // immediately check that config's requires to prune early
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    if (lastVarOfConfig.get(configKey) === varIndex) {
      const requires = configRequiresMap.get(configKey);
      if (requires) {
        // Build channelInfo for just this (port, config)
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
          if (!evaluateExpr(req.expression, v.portName, channelInfo)) {
            pruned = true;
            break;
          }
        }
      }
    }

    if (!pruned) {
      solveBacktrack(
        variables, varIndex + 1, tracker, current,
        configCombinations, ports, pinnedAssignments,
        solutions, maxSolutions, startTime, timeoutMs, stats, deepest,
        lastVarOfConfig, configRequiresMap
      );
    }

    current.pop();
    unassignPin(tracker, candidate.pin.name, v.portName, v.configName, candidate.peripheralInstance);
  }
}

// ============================================================
// Constraint Evaluation (checks ALL config combinations)
// ============================================================

export function evaluateAllConstraints(
  assignments: VariableAssignment[],
  configCombinations: Map<string, string>[],
  ports: Map<string, PortSpec>
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
        if (!evaluateExpr(req.expression, portName, channelInfo)) {
          return false;
        }
      }
    }
  }

  return true;
}

export function evaluateExpr(
  expr: ConstraintExprNode,
  currentPort: string,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>
): boolean | string {
  switch (expr.type) {
    case 'function_call':
      return evaluateFunctionCall(expr.name, expr.args, currentPort, channelInfo);

    case 'binary_expr': {
      const left = evaluateExpr(expr.left, currentPort, channelInfo);
      const right = evaluateExpr(expr.right, currentPort, channelInfo);
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
      return !evaluateExpr(expr.operand, currentPort, channelInfo);

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
  channelInfo: Map<string, Map<string, VariableAssignment[]>>
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

    default:
      return false;
  }
}

// ============================================================
// Solution Building
// ============================================================

export function buildSolution(
  varAssignments: VariableAssignment[],
  configCombinations: Map<string, string>[],
  _ports: Map<string, PortSpec>,
  pinnedAssignments: PinnedAssignment[],
  id: number
): Solution {
  const pinnedEntries: Assignment[] = pinnedAssignments.map(pa => ({
    pinName: pa.pinName,
    signalName: pa.signalName,
    portName: '<pinned>',
    channelName: '<pinned>',
    configurationName: '<pinned>',
  }));

  // Build one ConfigCombinationAssignment per config combination
  const configAssignments = configCombinations.map(combo => {
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
    return { activeConfigs: combo, assignments: comboAssignments };
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
