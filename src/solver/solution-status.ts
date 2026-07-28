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
  type SolverContext, type VariableAssignment,
} from './solver';
import { buildVarsByChannel, reconstructAssignments } from './post-optimize';

export type SolutionStatus = 'valid' | 'extra' | 'invalid';

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
): Map<Solution, SolutionStatus> {
  const out = new Map<Solution, SolutionStatus>();
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

function classifyOne(
  sol: Solution,
  ctx: SolverContext,
  varsByChannel: ReturnType<typeof buildVarsByChannel>,
  requiredVars: SolverContext['variables'],
  declaredChannels: Set<string>,
  reservedPositions: string[],
): SolutionStatus {
  const assigned = reconstructAssignments(sol, varsByChannel);

  // Coverage: every required channel must have a valid assignment in the solution.
  for (const v of requiredVars) if (!assigned.has(v)) return 'invalid';

  // Validity: pin/instance exclusivity + require constraints + DMA.
  const tracker = createPinTracker(ctx.reservedPins, ctx.sharedPatterns, reservedPositions);
  const va: VariableAssignment[] = [];
  for (const [v, c] of assigned) {
    if (!canAssignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position)) {
      return 'invalid';
    }
    assignPin(tracker, c.pin.name, v.portName, v.configName, v.channelName, c.peripheralInstance, c.signalName, c.pin.physical.position);
    va.push({ variable: v, candidate: c });
  }
  if (!evaluateAllConstraints(va, ctx.configCombinations, ctx.ports, ctx.dmaData, undefined, ctx.mcuInfo, ctx.sharedPatterns)) {
    return 'invalid';
  }

  // Extra: any assignment for a channel the constraints no longer declare.
  for (const ca of sol.configAssignments) {
    for (const a of ca.assignments) {
      if (a.portName === '<pinned>') continue;
      if (!declaredChannels.has(`${a.portName}\0${a.configurationName}\0${a.channelName}`)) return 'extra';
    }
  }
  return 'valid';
}
