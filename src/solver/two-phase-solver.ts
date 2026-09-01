// ============================================================
// Two-Phase Solver
//
// Phase 1: For each config combination, assign peripheral instances
//          to ports (lightweight CSP, no pin checking - only instance
//          exclusivity and require constraints).
// Phase 2: For each instance group, filter variable domains to
//          matching instances and run pin-level backtracking.
// ============================================================

import type {
  Mcu, Solution, SolverResult, SolverError, SolverStats, DmaData,
} from '../types';
import { normalizePeripheralType } from '../parser/mcu-xml-parser';
import type {
  ProgramNode, RequireNode, PatternPart, ConstraintExprNode,
} from '../parser/constraint-ast';
import { resolveTemplates } from '../parser/template-resolver';
import { checkGroupPinFeasibility } from './matching-oracle';
import { getStdlibTemplates } from '../parser/stdlib-macros';
import { estimateCandidateCost, createIncrementalCostTracker } from './cost-functions';
import type { SignalCandidate } from './pattern-matcher';
import type {
  SolverVariable, VariableAssignment, PortSpec, PinnedAssignment,
} from './solver';
import {
  extractPorts, resolveReservePatterns, extractPinnedAssignments,
  extractSharedPatterns, isSharedInstance, resolveAllVariables,
  generateConfigCombinations,
  solveBacktrack, createPinTracker,
  partitionGpioVariables, isGpioVariable,
  configsHaveDma, buildPropagationContext,
  pushSolverWarnings, finalizeSolutions,
  isOptionalRequireVacuous, pinnedOccupiedPins } from './solver';
import { mulberry32, shuffleArray } from './solver-utils';
import { runPhase2Diverse, type GroupSolverFn } from './phase2-diversity';

// ============================================================
// Two-Phase Config
// ============================================================

export interface TwoPhaseConfig {
  maxGroups: number;
  maxSolutionsPerGroup: number;
  timeoutMs: number;
  costWeights: Map<string, number>;
  skipGpioMapping?: boolean;
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
  const { ast: expandedAst, errors: macroErrors } = resolveTemplates(ast, getStdlibTemplates());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) {
    for (const p of pinnedOccupiedPins(pa)) reservedPinSet.add(p);
  }
  const reservedPeripheralSet = new Set(reserved.peripherals);

  const configCombinations = generateConfigCombinations(ports);
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;
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

  const { solveVars, gpioVars, gpioVarsPerConfig } = partitionGpioVariables(allVariables, !!config.skipGpioMapping);

  if (solveVars.length === 0 && gpioVars.length === 0) {
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

  if (gpioVars.length > 0) {
    errors.push({ type: 'warning', message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only` });
  }

  // Build instance variables from non-GPIO solver variables only.
  // GPIO variables (IN/OUT) don't have meaningful peripheral instances
  // and would explode Phase 1's search space.
  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);

  // C3: Sort instance domains by ascending average pin cost
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

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
  const collect = (cap: number): InstanceGroup[] => collectPhase1Groups(
    allInstanceVars, solveVars, configCombinations, ports, sharedPatterns, configRequiresMap,
    cap, startTime, config.timeoutMs, dmaData,
  );
  let groups = collect(config.maxGroups);

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

  // C1: Cost-guided variable ordering for Phase 2
  const costWeights = config.costWeights;
  const phase2Sort = (vars: SolverVariable[]) => {
    costGuidedPhase2Sort(vars, costWeights);
  };

  const domainCache = new Map<string, number[]>();
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2ForGroup(
      group, solveVars, ports, reserved.pins, pinnedAssignments,
      sharedPatterns, configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      phase2Sort, dmaData, domainCache, mcu, costWeights, seed, pinUsage
    );
  const runPhase2 = (gs: InstanceGroup[]): Solution[] => runPhase2Diverse(gs, solveGroup, {
    maxSolutionsPerGroup: config.maxSolutionsPerGroup,
    solutionsPerRound,
    timeoutMs: config.timeoutMs,
    startTime,
  });
  solutions.push(...runPhase2(groups));

  // Phase 2 can burn through a small group budget in milliseconds. Rather than
  // give up with most of the timeout unspent, widen Phase 1 and try again: the
  // first groups it emits are not necessarily routable.
  const MAX_GROUP_CAP = 20000;
  let cap = config.maxGroups;
  while (
    solutions.length === 0 &&
    groups.length >= cap &&
    cap < MAX_GROUP_CAP &&
    performance.now() - startTime < config.timeoutMs * 0.9
  ) {
    cap = Math.min(cap * 4, MAX_GROUP_CAP);
    groups = collect(cap);
    solutions.push(...runPhase2(groups));
  }

  if (solutions.length === 0 && groups.length > 0) {
    // Say which budget ran out. The escalation loop above can stop on the group
    // cap with time still on the clock, and without this the result is a bare
    // "no solutions" that looks like proven infeasibility rather than giving up.
    const hitCap = groups.length >= cap;
    errors.push({
      type: 'warning',
      message: hitCap
        ? `Phase 1 reached its group limit (${cap}) and Phase 2 found no valid pin assignments among those groups — raise max_groups or try another solver`
        : `Phase 1 found ${groups.length} instance groups but Phase 2 found no valid pin assignments`,
    });
  }

  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);

  return finalizeSolutions(solutions, mcu, config.costWeights, errors, stats, startTime, gpioVarsPerConfig, reserved.pins, pinnedAssignments);
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

/**
 * Collect Phase-1 instance groups across all config combinations.
 *
 * Combos are searched with a *fair time slice* each: a single pathological
 * combination (deep dead-end that DFS cannot escape) would otherwise consume
 * the whole budget and starve every later — possibly easy — combination,
 * reporting "no valid peripheral instance assignments" for a solvable problem.
 * If the sliced pass finds nothing, a second pass re-runs with the remaining
 * budget unsliced, so anything the old single-pass search could solve is still
 * solved.
 */
export function collectPhase1Groups(
  allInstanceVars: InstanceVariable[],
  solveVars: SolverVariable[],
  configCombinations: Map<string, string>[],
  ports: Map<string, PortSpec>,
  sharedPatterns: PatternPart[],
  configRequiresMap: Map<string, RequireNode[]>,
  maxGroups: number,
  startTime: number,
  timeoutMs: number,
  dmaData?: DmaData,
): InstanceGroup[] {
  const groupFingerprints = new Set<string>();
  const groups: InstanceGroup[] = [];
  // Dividing the quota evenly starves everyone when there are many combos and
  // few groups (20 groups / 12 combos = 1 each): productive combinations stop
  // early while barren ones still burn their slice. Let a combo contribute a
  // useful batch so the quota fills from whatever is productive, then stop.
  const MIN_GROUPS_PER_COMBO = 8;
  const maxGroupsPerCombo = Math.min(
    maxGroups,
    Math.max(MIN_GROUPS_PER_COMBO, Math.ceil(maxGroups / configCombinations.length)),
  );


  // Only keep instance groups that can actually be pin-routed. The oracle is a
  // sound relaxation (it never rejects a routable group), so this cannot lose
  // solutions — but it stops Phase 2 from burning the whole budget on groups
  // that provably have no perfect pin matching.
  const deadline = startTime + timeoutMs;
  const acceptGroup = (assignments: Map<string, string>): boolean =>
    checkGroupPinFeasibility(solveVars, configCombinations, { assignments }, { deadline }).feasible;
  /** Never slice below this: a slice too small to reach any leaf is wasted. */
  const MIN_SLICE_MS = 50;

  const runPass = (sliced: boolean): void => {
    for (let i = 0; i < configCombinations.length; i++) {
      const remaining = timeoutMs - (performance.now() - startTime);
      if (remaining <= 0) return;
      if (groups.length >= maxGroups) return;

      const activeVars = allInstanceVars.filter(iv => combosMatch(configCombinations[i], iv));
      if (activeVars.length === 0) continue;

      orderByConfigBlock(activeVars);

      const lastVarOfConfig = new Map<string, number>();
      for (let k = 0; k < activeVars.length; k++) {
        lastVarOfConfig.set(`${activeVars[k].portName}\0${activeVars[k].configName}`, k);
      }

      const tracker: InstanceTracker = {
        instanceOwner: new Map(),
        instanceRefCount: new Map(),
        sharedPatterns,
      };

      const budget = sliced
        ? Math.min(remaining, Math.max(MIN_SLICE_MS, remaining / (configCombinations.length - i)))
        : remaining;

      const comboGroups: InstanceGroup[] = [];
      solvePhase1(
        activeVars, 0, tracker, [],
        ports, comboGroups, maxGroupsPerCombo,
        performance.now(), budget,
        lastVarOfConfig, configRequiresMap, dmaData, undefined, acceptGroup
      );

      for (const g of comboGroups) {
        if (groups.length >= maxGroups) break;
        const fp = groupFingerprint(g.assignments);
        if (!groupFingerprints.has(fp)) {
          groupFingerprints.add(fp);
          groups.push(g);
        }
      }
    }
  };

  runPass(true);
  if (groups.length === 0) runPass(false); // fall back to the unsliced search
  return groups;
}

/**
 * Order instance variables as contiguous (port, config) blocks, most-constrained
 * block first and MRV within each block.
 *
 * A port's `require`s are only evaluated once its last variable is assigned
 * (see lastVarOfConfig). Under a global MRV sort a port's variables end up
 * scattered across the whole ordering, so those checks fire near the very
 * bottom of the tree and the search thrashes: it re-derives the same conflict
 * after re-assigning everything above it. Keeping each port together makes its
 * constraints prune as soon as that port is complete.
 */
export function orderByConfigBlock(vars: InstanceVariable[]): void {
  const blocks = new Map<string, InstanceVariable[]>();
  for (const v of vars) {
    const key = `${v.portName}\0${v.configName}`;
    const list = blocks.get(key);
    if (list) list.push(v); else blocks.set(key, [v]);
  }
  for (const list of blocks.values()) list.sort((a, b) => a.domain.length - b.domain.length);

  // Most-constrained block first: smallest domain, then fewest variables.
  const ordered = [...blocks.values()].sort((a, b) => {
    const da = Math.min(...a.map(v => v.domain.length));
    const db = Math.min(...b.map(v => v.domain.length));
    if (da !== db) return da - db;
    return a.length - b.length;
  });

  vars.length = 0;
  for (const list of ordered) vars.push(...list);
}

const combosMatch = (combo: Map<string, string>, iv: InstanceVariable): boolean =>
  combo.get(iv.portName) === iv.configName;

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
  configRequiresMap: Map<string, RequireNode[]>,
  dmaData?: DmaData,
  isBlocked?: (current: InstanceAssignment[]) => boolean,
  acceptGroup?: (assignments: Map<string, string>) => boolean
): void {
  if (performance.now() - startTime > timeoutMs) return;
  if (groups.length >= maxGroups) return;

  if (varIndex === variables.length) {
    // All instance variables assigned - build group
    const assignments = new Map<string, string>();
    for (const ia of current) {
      assignments.set(varKey(ia.variable), ia.instance);
    }
    // A rejected leaf must not consume the group budget — keep searching.
    if (!acceptGroup || acceptGroup(assignments)) groups.push({ assignments });
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
    // CEGAR: learned instance nogoods / blocking clauses
    if (isBlocked && isBlocked(current)) pruned = true;
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
          if (isOptionalRequireVacuous(req.expression, v.portName, channelInfo)) {
            continue;
          }
          const result = evaluateExprPhase1(req.expression, v.portName, channelInfo, dmaData);
          if (result === false) {
            if (req.optional) continue;
            pruned = true;
            break;
          }
        }
      }
    }

    // Pin-feasibility of the partial assignment, checked at the same (port,
    // config) boundary as the requires. The oracle treats unassigned variables
    // as unrestricted, so a partial map is sound — and rejecting here prunes a
    // whole subtree instead of one leaf.
    if (!pruned && acceptGroup && lastVarOfConfig.get(configKey) === varIndex) {
      const partial = new Map<string, string>();
      for (const ia of current) partial.set(varKey(ia.variable), ia.instance);
      if (!acceptGroup(partial)) pruned = true;
    }

    if (!pruned) {
      solvePhase1(
        variables, varIndex + 1, tracker, current,
        ports, groups, maxGroups,
        startTime, timeoutMs, lastVarOfConfig, configRequiresMap,
        dmaData, isBlocked, acceptGroup
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
  // Phase-1 evaluates instance-level constraints before pin assignment, so
  // the pin/signal structures only need to type-check; nothing reads them.
  const stubPhysical = { position: '', logicals: [] as never[] };
  const stubLogical = {
    name: '',
    type: 'I/O' as const,
    signals: [],
    isAssignable: false,
    isDefaultVariant: true,
    physical: stubPhysical as never,
  };
  return {
    variable: ia.variable.originalVariable,
    candidate: {
      pin: stubLogical as never,
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
  channelInfo: Map<string, Map<string, VariableAssignment[]>>,
  dmaData?: DmaData
): boolean | string | number {
  switch (expr.type) {
    case 'function_call':
      return evaluateFunctionCallPhase1(expr.name, expr.args, currentPort, channelInfo, dmaData);

    case 'binary_expr': {
      const left = evaluateExprPhase1(expr.left, currentPort, channelInfo, dmaData);
      const right = evaluateExprPhase1(expr.right, currentPort, channelInfo, dmaData);
      switch (expr.operator) {
        case '==': return left === right;
        case '!=': return left !== right;
        case '&': return !!left && !!right;
        case '|': return !!left || !!right;
        case '^': return !!left !== !!right;
        case '<': return typeof left === 'number' && typeof right === 'number' && left < right;
        case '>': return typeof left === 'number' && typeof right === 'number' && left > right;
        case '<=': return typeof left === 'number' && typeof right === 'number' && left <= right;
        case '>=': return typeof left === 'number' && typeof right === 'number' && left >= right;
        case '+': return typeof left === 'number' && typeof right === 'number' ? left + right : false;
        case '-': return typeof left === 'number' && typeof right === 'number' ? left - right : false;
      }
      return false;
    }

    case 'unary_expr':
      return !evaluateExprPhase1(expr.operand, currentPort, channelInfo, dmaData);

    case 'ident':
      return expr.name;

    case 'string_literal':
      return expr.value;

    case 'boolean_literal':
      return expr.value;

    case 'pattern_literal':
      return expr.text;

    case 'number_literal':
      return expr.value;

    case 'dot_access':
      return `${expr.object}.${expr.property}`;
  }
}

function evaluateFunctionCallPhase1(
  name: string,
  args: ConstraintExprNode[],
  currentPort: string,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>,
  dmaData?: DmaData
): boolean | string | number {
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

    case 'dma': {
      // Phase 1 only knows instance-level info (no pin/signal yet).
      // Be optimistic: Phase 2 does the full DMA stream feasibility check.
      // Only reject if the channel is assigned and uses an instance with
      // peripheral-level DMA entries that don't exist.
      if (!dmaData) return true;
      const dmaArgs = args.slice();
      if (dmaArgs.length >= 1) {
        const vas = resolveChannel(dmaArgs[0]);
        if (vas.length === 0) return true; // channel not yet assigned
        for (const va of vas) {
          const inst = va.candidate.peripheralInstance;
          if (inst) {
            // Check instance-level DMA (ADC, DAC, etc.)
            const instStreams = dmaData.instanceToDmaStreams.get(inst);
            if (instStreams && instStreams.length > 0) return true;
            // Check signal-level DMA (USART, SPI, etc.) - any signal from this instance
            for (const [sigName, streams] of dmaData.signalToDmaStreams) {
              if (sigName.startsWith(inst + '_') && streams.length > 0) return true;
            }
          }
        }
        return false;
      }
      return true;
    }

    case 'flag':
      // Per-pin flags are unknowable before pin assignment — stay optimistic
      // (Phase 2 evaluates it for real). Rejecting here would be unsound.
      return true;

    case 'pin_number':
      // Phase 1: no pin assigned yet, return 0 (vacuously pass)
      return 0;

    case 'channel_number': {
      if (args.length === 1) {
        const vas = resolveChannel(args[0]);
        for (const va of vas) {
          const func = va.candidate.signal.signalFunction || '';
          const numMatch = func.match(/(\d+)$/);
          if (numMatch) return parseInt(numMatch[1], 10);
        }
      }
      return 0;
    }

    case 'channel_signal': {
      if (args.length === 1) {
        const vas = resolveChannel(args[0]);
        for (const va of vas) {
          return va.candidate.signal.signalFunction || '';
        }
      }
      return '';
    }

    case 'instance_number': {
      if (args.length === 1) {
        const vas = resolveChannel(args[0]);
        for (const va of vas) {
          const num = va.candidate.signal.instanceNumber;
          if (num !== undefined) return num;
        }
      }
      return 0;
    }

    // Phase 1: no pin assigned yet, return 0 (vacuously pass)
    case 'pin_row':
    case 'pin_col':
    case 'pin_distance':
      return 0;

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
  stats: SolverStats,
  sortVariables?: (vars: SolverVariable[]) => void,
  dmaData?: DmaData,
  domainCache?: Map<string, number[]>,
  mcu?: Mcu,
  costWeights?: Map<string, number>,
  shuffleSeed?: number,
  pinUsageCount?: Map<string, number>,
  budget?: { steps: number }
): Solution[] {
  // Filter each variable's domain to only candidates matching the group's instance
  // S5: Use domain cache when available to avoid redundant filtering
  const filteredVars: SolverVariable[] = allVariables.map(sv => {
    const key = `${sv.portName}\0${sv.configName}\0${sv.channelName}\0${sv.exprIndex}`;
    const requiredInstance = group.assignments.get(key);

    if (!requiredInstance) {
      return { ...sv, domain: [...sv.domain] };
    }

    const cacheKey = `${key}\0${requiredInstance}`;
    let filteredDomain: number[];

    if (domainCache) {
      const cached = domainCache.get(cacheKey);
      if (cached) {
        filteredDomain = [...cached]; // clone since domains are mutated
      } else {
        filteredDomain = sv.domain.filter(idx => sv.candidates[idx].peripheralInstance === requiredInstance);
        domainCache.set(cacheKey, filteredDomain);
        filteredDomain = [...filteredDomain];
      }
    } else {
      filteredDomain = sv.domain.filter(idx => sv.candidates[idx].peripheralInstance === requiredInstance);
    }

    return { ...sv, domain: filteredDomain };
  });

  // Skip groups where filtering eliminated all candidates for some variable
  const emptyVar = filteredVars.find(v => v.domain.length === 0);
  if (emptyVar) return [];

  // Sort variables (custom sort or default MRV)
  if (sortVariables) {
    sortVariables(filteredVars);
  } else {
    filteredVars.sort((a, b) => a.domain.length - b.domain.length);
  }

  // D6: Randomized candidate ordering within each variable's domain
  if (shuffleSeed && shuffleSeed > 0) {
    const rng = mulberry32(shuffleSeed);
    for (const v of filteredVars) {
      v.domain = shuffleArray(v.domain, rng);
    }
  }

  // D9: Anti-correlated pin sampling — prefer less-used pins
  if (pinUsageCount && pinUsageCount.size > 0) {
    for (const v of filteredVars) {
      v.domain.sort((a, b) =>
        (pinUsageCount.get(v.candidates[a].pin.name) ?? 0) -
        (pinUsageCount.get(v.candidates[b].pin.name) ?? 0));
    }
  }

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

  // Build forward checking propagation context (F2: with same_instance propagation)
  const propagationCtx = buildPropagationContext(filteredVars, sharedPatterns, configRequiresMap);

  // C2: Create incremental cost tracker for pruning
  const costTracker = mcu && costWeights
    ? createIncrementalCostTracker(mcu, costWeights, maxSolutions)
    : undefined;

  solveBacktrack(
    filteredVars, 0, tracker, [],
    configCombinations, ports, pinnedAssignments,
    solutions, maxSolutions, startTime, timeoutMs, stats, deepest,
    lastVarOfConfig, configRequiresMap,
    dmaData, propagationCtx, costTracker, undefined, budget
  );

  return solutions;
}

// ============================================================
// Cost-Aware Instance Domain Ordering (C3)
// ============================================================

export function sortInstanceDomainsByCost(
  instanceVars: InstanceVariable[],
  costWeights: Map<string, number>
): void {
  for (const iv of instanceVars) {
    const instanceCosts = new Map<string, number>();
    for (const inst of iv.instanceCandidates) {
      const matching = iv.originalVariable.domain
        .map(ci => iv.originalVariable.candidates[ci])
        .filter(c => c.peripheralInstance === inst);
      if (matching.length === 0) continue;
      const avgCost = matching.reduce((sum, c) =>
        sum + estimateCandidateCost(c, costWeights), 0) / matching.length;
      instanceCosts.set(inst, avgCost);
    }
    iv.domain.sort((a, b) =>
      (instanceCosts.get(iv.instanceCandidates[a]) ?? 0) -
      (instanceCosts.get(iv.instanceCandidates[b]) ?? 0)
    );
  }
}

// ============================================================
// Cost-Guided Phase 2 Variable Ordering (C1)
// ============================================================

function costGuidedPhase2Sort(
  vars: SolverVariable[],
  costWeights: Map<string, number>
): void {
  // Compute min candidate cost per variable
  const minCosts = new Map<SolverVariable, number>();
  for (const v of vars) {
    let minCost = Infinity;
    for (const ci of v.domain) {
      const cost = estimateCandidateCost(v.candidates[ci], costWeights);
      if (cost < minCost) minCost = cost;
    }
    minCosts.set(v, minCost);
  }

  // Primary: MRV (domain size), Secondary: higher min-cost first
  // (assign expensive variables first to prune early)
  vars.sort((a, b) => {
    const sizeA = a.domain.length, sizeB = b.domain.length;
    if (sizeA !== sizeB) return sizeA - sizeB;
    return (minCosts.get(b) ?? 0) - (minCosts.get(a) ?? 0);
  });
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

// ============================================================
// Shared Phase 1 (A2)
// ============================================================

export interface SharedPhase1Result {
  groups: InstanceGroup[];
  solveVars: SolverVariable[];
  ports: Map<string, PortSpec>;
  reservedPins: string[];
  pinnedAssignments: PinnedAssignment[];
  sharedPatterns: PatternPart[];
  configCombinations: Map<string, string>[];
  gpioVarsPerConfig: Map<string, SolverVariable[]>;
  gpioVarCount: number;
  errors: SolverError[];
  dmaData?: DmaData;
}

/**
 * Run the common setup + Phase 1 instance assignment.
 * Returns null if there's nothing to solve.
 */
export function runSharedPhase1(
  ast: ProgramNode,
  mcu: Mcu,
  config: TwoPhaseConfig
): SharedPhase1Result | null {
  const startTime = performance.now();
  const errors: SolverError[] = [];

  const { ast: expandedAst, errors: macroErrors } = resolveTemplates(ast, getStdlibTemplates());
  for (const me of macroErrors) {
    errors.push({ type: 'error', message: me.message, source: me.macroName });
  }

  const ports = extractPorts(expandedAst);
  const reserved = resolveReservePatterns(expandedAst, mcu);
  const pinnedAssignments = extractPinnedAssignments(expandedAst);
  const sharedPatterns = extractSharedPatterns(expandedAst);

  const reservedPinSet = new Set(reserved.pins);
  for (const pa of pinnedAssignments) for (const p of pinnedOccupiedPins(pa)) reservedPinSet.add(p);
  const reservedPeripheralSet = new Set(reserved.peripherals);

  const configCombinations = generateConfigCombinations(ports);
  const dmaData = mcu.dma && configsHaveDma(ports) ? mcu.dma : undefined;
  const allVariables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);

  if (allVariables.length === 0) return null;

  const emptyVar = allVariables.find(v => v.domain.length === 0);
  if (emptyVar) {
    errors.push({
      type: 'error',
      message: `No matching signals for "${emptyVar.patternRaw}" (${emptyVar.portName}.${emptyVar.channelName} in config "${emptyVar.configName}")`,
      source: `${emptyVar.portName}.${emptyVar.channelName}`,
    });
    return { groups: [], solveVars: [], ports, reservedPins: reserved.pins, pinnedAssignments, sharedPatterns, configCombinations, gpioVarsPerConfig: new Map(), gpioVarCount: 0, errors, dmaData };
  }

  const { solveVars, gpioVars, gpioVarsPerConfig } = partitionGpioVariables(allVariables, !!config.skipGpioMapping);
  if (solveVars.length === 0 && gpioVars.length === 0) return null;

  if (gpioVars.length > 0) {
    errors.push({ type: 'warning', message: `Skipped GPIO mapping for ${gpioVars.length} IN/OUT variable(s) - verified pin availability only` });
  }

  const nonGpioVars = solveVars.filter(v => !isGpioVariable(v));
  const allInstanceVars = buildInstanceVariables(nonGpioVars);
  sortInstanceDomainsByCost(allInstanceVars, config.costWeights);

  const configRequiresMap = new Map<string, RequireNode[]>();
  for (const [portName, port] of ports) {
    for (const c of port.configs) {
      if (c.requires.length > 0) configRequiresMap.set(`${portName}\0${c.name}`, c.requires);
    }
  }

  // Phase 1: instance assignment across config combinations
  const groups = collectPhase1Groups(
    allInstanceVars, solveVars, configCombinations, ports, sharedPatterns, configRequiresMap,
    config.maxGroups, startTime, config.timeoutMs, dmaData,
  );

  return {
    groups, solveVars, ports, reservedPins: reserved.pins,
    pinnedAssignments, sharedPatterns, configCombinations,
    gpioVarsPerConfig, gpioVarCount: gpioVars.length, errors, dmaData,
  };
}

/**
 * Run Phase 2 on pre-computed groups from shared Phase 1.
 */
export function runPhase2Only(
  phase1: SharedPhase1Result,
  mcu: Mcu,
  config: TwoPhaseConfig,
  startTime: number,
  sortVariables?: (vars: SolverVariable[]) => void
): SolverResult {
  const errors = [...phase1.errors];

  if (phase1.groups.length === 0) {
    if (errors.every(e => e.type !== 'error')) {
      errors.push({ type: 'error', message: 'Phase 1: No valid peripheral instance assignments found' });
    }
    return {
      mcuRef: mcu.refName, solutions: [], errors,
      statistics: { totalCombinations: phase1.configCombinations.length, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: phase1.configCombinations.length },
    };
  }

  const stats: SolverStats = {
    totalCombinations: phase1.configCombinations.length,
    evaluatedCombinations: 0,
    validSolutions: 0,
    solveTimeMs: 0,
    configCombinations: phase1.configCombinations.length,
  };

  const domainCache = new Map<string, number[]>();
  const solutionsPerRound = Math.max(1, Math.ceil(config.maxSolutionsPerGroup / 5));
  const solveGroup: GroupSolverFn = (group, maxSol, seed, pinUsage) =>
    solvePhase2ForGroup(
      group, phase1.solveVars, phase1.ports, phase1.reservedPins,
      phase1.pinnedAssignments, phase1.sharedPatterns, phase1.configCombinations,
      maxSol, startTime, config.timeoutMs, stats,
      sortVariables, phase1.dmaData, domainCache, mcu, config.costWeights, seed, pinUsage
    );
  const solutions = runPhase2Diverse(phase1.groups, solveGroup, {
    maxSolutionsPerGroup: config.maxSolutionsPerGroup,
    solutionsPerRound,
    timeoutMs: config.timeoutMs,
    startTime,
  });

  if (solutions.length === 0 && phase1.groups.length > 0) {
    errors.push({ type: 'warning', message: `Phase 1 found ${phase1.groups.length} instance groups but Phase 2 found no valid pin assignments` });
  }
  pushSolverWarnings(errors, solutions, config.maxSolutionsPerGroup * config.maxGroups, startTime, config.timeoutMs);

  return finalizeSolutions(solutions, mcu, config.costWeights, errors, stats, startTime, phase1.gpioVarsPerConfig, phase1.reservedPins, phase1.pinnedAssignments);
}
