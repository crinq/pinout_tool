// ============================================================
// Two-Phase Solver
//
// Phase 1: For each config combination, assign peripheral instances
//          to ports (lightweight CSP, no pin checking — only instance
//          exclusivity and require constraints).
// Phase 2: For each instance group, filter variable domains to
//          matching instances and run pin-level backtracking.
// ============================================================

import type {
  Mcu, Solution, SolverResult, SolverError, SolverStats,
} from '../types';
import { normalizePeripheralType } from '../types';
import type {
  ProgramNode, RequireNode, PatternPart, ConstraintExprNode,
} from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros } from '../parser/stdlib-macros';
import { computeTotalCost } from './cost-functions';
import type { SignalCandidate } from './pattern-matcher';
import type {
  SolverVariable, VariableAssignment, PortSpec, PinnedAssignment,
} from './solver';
import {
  extractPorts, extractReservedPins, extractPinnedAssignments,
  extractSharedPatterns, isSharedInstance, resolveAllVariables,
  generateConfigCombinations, validateConstraints,
  solveBacktrack, deduplicateSolutions, createPinTracker,
} from './solver';

// ============================================================
// Two-Phase Config
// ============================================================

export interface TwoPhaseConfig {
  maxGroups: number;
  maxSolutionsPerGroup: number;
  timeoutMs: number;
  costWeights: Map<string, number>;
}

// ============================================================
// Phase 1 Types
// ============================================================

export interface InstanceVariable {
  portName: string;
  channelName: string;
  configName: string;
  exprIndex: number;
  instanceCandidates: string[];        // unique peripheral instances
  candidateTypes: Map<string, string>; // instance -> peripheralType
  domain: number[];                    // indices into instanceCandidates
  originalVariable: SolverVariable;
}

export interface InstanceAssignment {
  variable: InstanceVariable;
  instance: string;
}

export interface InstanceTracker {
  instanceOwner: Map<string, string>;
  instanceRefCount: Map<string, number>;
  sharedPatterns: PatternPart[];
}

export interface InstanceGroup {
  // Maps variable key -> peripheral instance (for ALL configs, not just active ones)
  assignments: Map<string, string>;
}

// ============================================================
// Main Entry Point
// ============================================================

export function solveTwoPhase(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SolverResult {
  const startTime = performance.now();
  const errors: SolverError[] = [];
  const solutions: Solution[] = [];

  // Expand macros
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
  const allVariables = resolveAllVariables(ports, mcu, reservedSet);

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

  // Build instance variables from all solver variables
  const allInstanceVars = buildInstanceVariables(allVariables);

  // Build requires map
  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0) {
        configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
      }
    }
  }

  // ========== Phase 1: Instance Assignment per Config Combination ==========
  // For each config combination, backtrack only over the active variables
  const groupFingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];
  const maxGroupsPerCombo = Math.max(1, Math.ceil(config.maxGroups / configCombinations.length));

  for (const combo of configCombinations) {
    if (performance.now() - startTime > config.timeoutMs) break;
    if (groups.length >= config.maxGroups) break;

    // Filter to only variables active in this config combination
    const activeVars = allInstanceVars.filter(iv =>
      combo.get(iv.portName) === iv.configName
    );

    if (activeVars.length === 0) continue;

    // Sort by MRV
    activeVars.sort((a, b) => a.domain.length - b.domain.length);

    // Build eager-check structures for active variables
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
      lastVarOfConfig, configRequiresMap
    );

    // Add unique groups
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
    errors.push({
      type: 'error',
      message: 'Phase 1: No valid peripheral instance assignments found',
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

  // ========== Phase 2: Pin Assignment per Group ==========
  const stats: SolverStats = {
    totalCombinations: configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: configCombinations.length,
  };

  for (const group of groups) {
    if (performance.now() - startTime > config.timeoutMs) break;

    const groupSolutions = solvePhase2ForGroup(
      group, allVariables, ports, reservedPins, pinnedAssignments,
      sharedPatterns, configCombinations,
      config.maxSolutionsPerGroup, startTime, config.timeoutMs, stats
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

  // Compute costs and sort
  for (const sol of solutions) {
    sol.mcuRef = mcu.refName;
    computeTotalCost(sol, mcu, config.costWeights);
  }

  solutions.sort((a, b) => a.totalCost - b.totalCost);
  solutions.forEach((s, i) => s.id = i);
  stats.solveTimeMs = performance.now() - startTime;

  const deduped = deduplicateSolutions(solutions);

  return { mcuRef: mcu.refName, solutions: deduped, errors, statistics: stats };
}

// ============================================================
// Phase 1: Instance-Level Backtracking (per config combination)
// ============================================================

export function buildInstanceVariables(solverVars: SolverVariable[]): InstanceVariable[] {
  return solverVars.map(sv => {
    const instanceSet = new Map<string, string>(); // instance -> peripheralType
    for (const idx of sv.domain) {
      const c = sv.candidates[idx];
      if (!instanceSet.has(c.peripheralInstance)) {
        instanceSet.set(c.peripheralInstance, c.peripheralType);
      }
    }
    const instanceCandidates = [...instanceSet.keys()];
    return {
      portName: sv.portName,
      channelName: sv.channelName,
      configName: sv.configName,
      exprIndex: sv.exprIndex,
      instanceCandidates,
      candidateTypes: instanceSet,
      domain: instanceCandidates.map((_, i) => i),
      originalVariable: sv,
    };
  });
}

export function canAssignInstance(
  tracker: InstanceTracker, instance: string, portName: string
): boolean {
  if (isSharedInstance(instance, tracker.sharedPatterns)) return true;
  const owner = tracker.instanceOwner.get(instance);
  return owner === undefined || owner === portName;
}

export function assignInstance(
  tracker: InstanceTracker, instance: string, portName: string
): void {
  tracker.instanceOwner.set(instance, portName);
  const key = `${portName}\0${instance}`;
  tracker.instanceRefCount.set(key, (tracker.instanceRefCount.get(key) || 0) + 1);
}

export function unassignInstance(
  tracker: InstanceTracker, instance: string, portName: string
): void {
  const key = `${portName}\0${instance}`;
  const count = tracker.instanceRefCount.get(key)! - 1;
  if (count === 0) {
    tracker.instanceRefCount.delete(key);
    tracker.instanceOwner.delete(instance);
  } else {
    tracker.instanceRefCount.set(key, count);
  }
}

export function solvePhase1(
  variables: InstanceVariable[],
  varIndex: number,
  tracker: InstanceTracker,
  current: InstanceAssignment[],
  ports: Map<string, PortSpec>,
  groups: InstanceGroup[],
  maxGroups: number,
  startTime: number,
  timeoutMs: number,
  lastVarOfConfig: Map<string, number>,
  configRequiresMap: Map<string, RequireNode[]>
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (groups.length >= maxGroups) return;

  if (varIndex === variables.length) {
    // All instance variables assigned — build group
    const assignments = new Map<string, string>();
    for (const ia of current) {
      assignments.set(varKey(ia.variable), ia.instance);
    }
    groups.push({ assignments });
    return;
  }

  const v = variables[varIndex];

  for (const candidateIdx of v.domain) {
    if (groups.length >= maxGroups) return;
    if (performance.now() - startTime > timeoutMs) return;

    const instance = v.instanceCandidates[candidateIdx];

    if (!canAssignInstance(tracker, instance, v.portName)) continue;

    assignInstance(tracker, instance, v.portName);
    current.push({ variable: v, instance });

    // Eager constraint check at (port, config) boundary
    let pruned = false;
    const configKey = `${v.portName}\0${v.configName}`;
    if (lastVarOfConfig.get(configKey) === varIndex) {
      const requires = configRequiresMap.get(configKey);
      if (requires) {
        const portChannels = new Map<string, VariableAssignment[]>();
        for (const ia of current) {
          if (ia.variable.portName === v.portName && ia.variable.configName === v.configName) {
            if (!portChannels.has(ia.variable.channelName)) {
              portChannels.set(ia.variable.channelName, []);
            }
            portChannels.get(ia.variable.channelName)!.push(
              syntheticVariableAssignment(ia)
            );
          }
        }
        const channelInfo = new Map<string, Map<string, VariableAssignment[]>>();
        channelInfo.set(v.portName, portChannels);

        for (const req of requires) {
          const result = evaluateExprPhase1(req.expression, v.portName, channelInfo);
          if (result === false) {
            pruned = true;
            break;
          }
        }
      }
    }

    if (!pruned) {
      solvePhase1(
        variables, varIndex + 1, tracker, current,
        ports, groups, maxGroups,
        startTime, timeoutMs, lastVarOfConfig, configRequiresMap
      );
    }

    current.pop();
    unassignInstance(tracker, instance, v.portName);
  }
}

// ============================================================
// Phase 1 Constraint Evaluation
// ============================================================

function syntheticVariableAssignment(ia: InstanceAssignment): VariableAssignment {
  const periType = ia.variable.candidateTypes.get(ia.instance) || '';
  return {
    variable: ia.variable.originalVariable,
    candidate: {
      pin: { name: '', position: '', type: 'I/O', signals: [], isAssignable: false },
      signal: { name: ia.instance },
      signalName: ia.instance,
      peripheralInstance: ia.instance,
      peripheralType: periType,
    } as SignalCandidate,
  };
}

function evaluateExprPhase1(
  expr: ConstraintExprNode,
  currentPort: string,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>
): boolean | string {
  switch (expr.type) {
    case 'function_call':
      return evaluateFunctionCallPhase1(expr.name, expr.args, currentPort, channelInfo);

    case 'binary_expr': {
      const left = evaluateExprPhase1(expr.left, currentPort, channelInfo);
      const right = evaluateExprPhase1(expr.right, currentPort, channelInfo);
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
      return !evaluateExprPhase1(expr.operand, currentPort, channelInfo);

    case 'ident':
      return expr.name;

    case 'string_literal':
      return expr.value;

    case 'dot_access':
      return `${expr.object}.${expr.property}`;
  }
}

function evaluateFunctionCallPhase1(
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
      const { channelArgs, typeFilter } = extractTypeFilter(args);
      const instances = new Set<string>();
      for (const arg of channelArgs) {
        const vas = resolveChannel(arg);
        for (const va of vas) {
          if (!matchesFilter(va, typeFilter)) continue;
          instances.add(va.candidate.peripheralInstance);
        }
      }
      return instances.size <= 1;
    }

    case 'diff_instance': {
      const { channelArgs, typeFilter } = extractTypeFilter(args);
      const instances: string[] = [];
      for (const arg of channelArgs) {
        const vas = resolveChannel(arg);
        for (const va of vas) {
          if (!matchesFilter(va, typeFilter)) continue;
          instances.push(va.candidate.peripheralInstance);
        }
      }
      return new Set(instances).size === instances.length;
    }

    case 'instance': {
      const { channelArgs, typeFilter } = extractTypeFilter(args);
      if (channelArgs.length === 1) {
        const vas = resolveChannel(channelArgs[0]);
        for (const va of vas) {
          if (matchesFilter(va, typeFilter)) return va.candidate.peripheralInstance;
        }
      }
      return '';
    }

    case 'type': {
      const { channelArgs, typeFilter } = extractTypeFilter(args);
      if (channelArgs.length === 1) {
        const vas = resolveChannel(channelArgs[0]);
        for (const va of vas) {
          if (matchesFilter(va, typeFilter)) return va.candidate.peripheralType;
        }
      }
      return '';
    }

    case 'gpio_pin':
    case 'gpio_port':
      return '';

    default:
      return false;
  }
}

// ============================================================
// Phase 2: Pin-Level Solving per Group
// ============================================================

export function solvePhase2ForGroup(
  group: InstanceGroup,
  allVariables: SolverVariable[],
  ports: Map<string, PortSpec>,
  reservedPins: string[],
  pinnedAssignments: PinnedAssignment[],
  sharedPatterns: PatternPart[],
  configCombinations: Map<string, string>[],
  maxSolutions: number,
  startTime: number,
  timeoutMs: number,
  stats: SolverStats
): Solution[] {
  // Filter each variable's domain to only candidates matching the group's instance
  const filteredVars: SolverVariable[] = allVariables.map(sv => {
    const key = `${sv.portName}\0${sv.configName}\0${sv.channelName}\0${sv.exprIndex}`;
    const requiredInstance = group.assignments.get(key);

    if (!requiredInstance) {
      // Variable not in instance assignments (from a different config combo) — keep full domain
      return { ...sv, domain: [...sv.domain] };
    }

    const filteredDomain = sv.domain.filter(idx => {
      return sv.candidates[idx].peripheralInstance === requiredInstance;
    });

    return { ...sv, domain: filteredDomain };
  });

  // Skip groups where filtering eliminated all candidates for some variable
  const emptyVar = filteredVars.find(v => v.domain.length === 0);
  if (emptyVar) return [];

  // Sort by MRV
  filteredVars.sort((a, b) => a.domain.length - b.domain.length);

  // Build eager-check structures
  const lastVarOfConfig = new Map<string, number>();
  const configRequiresMap = new Map<string, RequireNode[]>();
  for (let i = 0; i < filteredVars.length; i++) {
    const key = `${filteredVars[i].portName}\0${filteredVars[i].configName}`;
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
  const solutions: Solution[] = [];
  const deepest = { depth: -1, assignments: [] as VariableAssignment[] };

  solveBacktrack(
    filteredVars, 0, tracker, [],
    configCombinations, ports, pinnedAssignments,
    solutions, maxSolutions, startTime, timeoutMs, stats, deepest,
    lastVarOfConfig, configRequiresMap
  );

  return solutions;
}

// ============================================================
// Helpers
// ============================================================

export function varKey(v: { portName: string; configName: string; channelName: string; exprIndex: number }): string {
  return `${v.portName}\0${v.configName}\0${v.channelName}\0${v.exprIndex}`;
}

export function groupFingerprint(assignments: Map<string, string>): string {
  const entries = [...assignments.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${v}`).join('|');
}
