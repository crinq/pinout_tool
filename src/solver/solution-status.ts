// ============================================================
// Solution validity classification
//
// Answers, for a stored solution against the CURRENT constraints + MCU:
//   'valid'   — every required channel is assigned and all constraints hold
//   'extra'   — valid, but the solution also carries assignments for channels
//               no longer present in the constraints (harmless leftovers)
//   'invalid' — a required channel is unassigned or a constraint is violated
//
// Lets the project list flag which saved solutions still fit after edits.
// Reuses the solver context + the editor's assignment reconstruction so the
// verdict matches what the solver/editor would accept.
// ============================================================

import type { Mcu, Solution, SolverError } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import {
  prepareSolverContext, resolveReservePatterns,
  createPinTracker, canAssignPin, assignPin, evaluateAllConstraints,
  collectConstraintFailures,
  type SolverContext, type VariableAssignment,
} from './solver';
import { formatConstraintExpr } from '../parser/expr-format';
import { buildVarsByChannel, reconstructAssignments } from './post-optimize';

export type SolutionStatus = 'valid' | 'extra' | 'invalid';

/** How many failures to spell out before summarising the rest. */
export const MAX_REASONS = 3;

export interface SolutionVerdict {
  status: SolutionStatus;
  /**
   * Why the solution is not valid, most specific first, capped at MAX_REASONS
   * (a trailing "…and N more" entry is added when there were more). Empty for
   * a valid solution.
   */
  reasons: string[];
}

/**
 * Classify each solution against the current constraints. Solutions for a
 * different MCU than `mcu` are omitted (no verdict). Returns an empty map when
 * the constraints can't be prepared (errors / no MCU).
 */
export function classifyProjectSolutions(
  solutions: Solution[],
  ast: ProgramNode,
  mcu: Mcu,
  skipGpioMapping?: boolean,
): Map<Solution, SolutionVerdict> {
  const out = new Map<Solution, SolutionVerdict>();
  if (solutions.length === 0) return out;

  const errors: SolverError[] = [];
  const ctx = prepareSolverContext(ast, mcu, errors, skipGpioMapping);
  if (!ctx) return out; // constraints unsolvable/errored → no verdict

  const reservedPositions = resolveReservePatterns(ctx.expandedAst, mcu).positions;
  const varsByChannel = buildVarsByChannel(ctx.variables);
  const requiredVars = ctx.variables.filter(v => !v.optional);

  // Every (port, config, channel) the constraints declare — for "extra" detection.
  const declaredChannels = new Set<string>();
  for (const [portName, port] of ctx.ports) {
    for (const config of port.configs) {
      for (const m of config.mappings) {
        declaredChannels.add(`${portName}\0${config.name}\0${m.channelName}`);
      }
    }
  }

  for (const sol of solutions) {
    if (sol.mcuRef && sol.mcuRef !== mcu.refName) continue; // different MCU → skip
    out.set(sol, classifyOne(sol, ctx, varsByChannel, requiredVars, declaredChannels, reservedPositions));
  }
  return out;
}

/** `line 9: ` when the source line is known, otherwise ''. */
function at(line?: number): string {
  return line === undefined ? '' : `line ${line}: `;
}

/** Source line of the mapping a variable came from, if the spec carries one. */
function mappingLine(ctx: SolverContext, v: SolverContext['variables'][number]): number | undefined {
  const config = ctx.ports.get(v.portName)?.configs.find(c => c.name === v.configName);
  return config?.mappings.find(m => m.channelName === v.channelName)?.line;
}

function classifyOne(
  sol: Solution,
  ctx: SolverContext,
  varsByChannel: ReturnType<typeof buildVarsByChannel>,
  requiredVars: SolverContext['variables'],
  declaredChannels: Set<string>,
  reservedPositions: string[],
): SolutionVerdict {
  const assigned = reconstructAssignments(sol, varsByChannel);
  const reasons: string[] = [];
  let dropped = 0;
  const note = (text: string): void => {
    if (reasons.length < MAX_REASONS) reasons.push(text); else dropped++;
  };
  const verdict = (status: SolutionStatus): SolutionVerdict => ({
    status,
    reasons: dropped > 0 ? [...reasons, `…and ${dropped} more`] : reasons,
  });

  // Coverage: every required channel must have a valid assignment in the
  // solution. This is the common case after an edit — a channel gained a
  // pattern the stored pins no longer match, or is new.
  for (const v of requiredVars) {
    if (assigned.has(v)) continue;
    note(`${at(mappingLine(ctx, v))}channel ${v.channelName} = ${v.patternRaw} not satisfied`);
  }

  // Validity: pin/instance exclusivity + require constraints + DMA.
  const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns, reservedPositions);
  const va: VariableAssignment[] = [];
  for (const [v, c] of assigned) {
    if (!canAssignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position)) {
      note(`${at(mappingLine(ctx, v))}channel ${v.channelName} cannot use ${c.pin.name} (${c.signalName}) — already taken or reserved`);
      continue;
    }
    assignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position);
    va.push({ variable: v, candidate: c });
  }

  if (!evaluateAllConstraints(va, ctx.configCombinations, ctx.ports, ctx.dmaData, undefined, ctx.mcuInfo, ctx.sharedPatterns)) {
    const failures = collectConstraintFailures(
      va, ctx.configCombinations, ctx.ports, ctx.dmaData, ctx.mcuInfo, MAX_REASONS);
    for (const f of failures) {
      note(`${at(f.require.loc?.line)}require ${formatConstraintExpr(f.require.expression)} not satisfied`);
    }
    // A DMA shortage fails evaluateAllConstraints without any single require
    // being false, so say something rather than nothing.
    if (failures.length === 0) note('constraints not satisfied (no valid DMA assignment)');
  }

  if (reasons.length > 0) return verdict('invalid');

  // Extra: any assignment for a channel the constraints no longer declare.
  for (const ca of sol.configAssignments) {
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      if (!declaredChannels.has(`${a.portName}\0${a.configurationName}\0${a.channelName}`)) {
        note(`${a.portName}.${a.channelName} on ${a.pinName} is not in the current constraints`);
      }
    }
  }
  if (reasons.length > 0) return verdict('extra');

  return { status: 'valid', reasons: [] };
}
