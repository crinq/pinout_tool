// ============================================================
// Solver Diagnostics
//
// Static analysis of a (constraint AST × MCU) pair, independent of any
// solver run. Surfaces bottlenecks like:
//   - channels with zero candidate (pin, signal) pairs
//   - peripheral types where total demand exceeds available instances
//   - reserves / pinned-assignments that prune more candidates than
//     expected
//   - cross-port contention on the same instance pool
//
// The report is the same regardless of which solver runs (it depends on
// constraints + MCU, not on the search algorithm), so the debug overlay
// shows it from any solver row. Per-solver runtime numbers (time, valid,
// evaluated) come from `SolverStats` on the result.
// ============================================================

import type { Mcu } from '../types';
import type { ProgramNode } from '../parser/constraint-ast';
import { expandAllMacros } from '../parser/macro-expander';
import { getStdlibMacros, getStdlibTemplates } from '../parser/stdlib-macros';
import {
  extractPorts, extractSharedPatterns, isSharedInstance, extractPinnedAssignments,
  resolveAllVariables, resolveReservePatterns, type PortSpec, type SolverVariable, pinnedOccupiedPins } from './solver';
import type { PinnedAssignment as ExportedPinnedAssignment } from './solver';

// ============================================================
// Report shape
// ============================================================

export interface ChannelDiagnostics {
  portName: string;
  channelName: string;
  configName: string;
  /** Joined raw signal pattern text (e.g. "USART*_TX | UART*_TX"). */
  patternRaw: string;
  /** True if the mapping is `?=` (optional). */
  optional: boolean;
  /**
   * True when every alternative of this channel is the pure-GPIO shorthand
   * (IN / OUT). The ranking in {@link aggregateSolverRuns} skips these so
   * they don't crowd out real peripheral-signal bottlenecks — every free
   * GPIO is a candidate, so they're noisy but rarely the cause of failure.
   */
  isGpio: boolean;
  /** All (pin, signal) candidates produced by pattern expansion. */
  candidatesTotal: number;
  /** Candidates after subtracting reserved pins / peripherals. */
  candidatesFree: number;
  /** Distinct logical pins among free candidates. */
  uniquePinsFree: number;
  /** Distinct peripheral instances among free candidates. */
  uniqueInstancesFree: number;
  /** Distinct peripheral types among free candidates. */
  uniqueTypesFree: number;
  /** Set of distinct pin names (for cross-port contention queries). */
  pinSet: Set<string>;
  /** Set of distinct peripheral instances. */
  instanceSet: Set<string>;
  /** Peripheral type names this channel could match (after normalization). */
  typeSet: Set<string>;
  /** Pruning attribution. Each counter is candidates dropped by that cause. */
  prunedByReserve: number;
  prunedByPinned: number;
  /** Human-readable bottleneck hints, empty when nothing notable. */
  hints: string[];
}

export interface PortDiagnostics {
  portName: string;
  channels: ChannelDiagnostics[];
  /** Required peripheral count by type, e.g. { USART: 1, SPI: 2 }. */
  peripheralDemand: Map<string, number>;
  /** Hints scoped to this port (zero-candidate channels, single-instance lock-ins). */
  hints: string[];
}

export interface TypeDemand {
  /** Normalized type name (e.g. "USART"). */
  type: string;
  /** Ports requiring at least one instance of this type. */
  portsRequesting: string[];
  /** Sum across ports treating each port's worst-case configuration. */
  totalRequired: number;
  /** Distinct instances available on this MCU. */
  totalAvailable: number;
  /** Available minus those already reserved or pinned away. */
  totalFree: number;
  /** Whether this type is in the `shared:` patterns (free-for-all sharing). */
  shared: boolean;
  /** Available instances by name. */
  available: string[];
  /** Reserved instances by name. */
  reserved: string[];
  /** True when totalRequired > totalFree (and not shared). */
  shortfall: boolean;
  /** max(0, required - free) — how many additional instances we'd need. */
  missingInstances: number;
}

export interface PinDemand {
  /** Stable identifier: portName + channelName so multi-config channels don't double-count. */
  channelKey: string;
  portName: string;
  channelName: string;
  /** Total free pins this channel could land on. */
  freePinCount: number;
  /** Channels (in other ports) competing for the same pins. */
  competingChannels: string[];
  /** True when freePinCount === 0. */
  shortfall: boolean;
}

export interface SolverDiagnosticsReport {
  /** RefName of the MCU under analysis. */
  mcuRef: string;
  /** When true, no constraint produced a candidate set — likely no MCU loaded or empty constraints. */
  emptyConstraints: boolean;
  /** Per-port breakdown. */
  ports: PortDiagnostics[];
  /** Aggregated per-peripheral-type demand vs supply. */
  typeDemand: TypeDemand[];
  /** Per-channel pin shortfalls. */
  pinDemand: PinDemand[];
  /** Top-level human-readable summary lines (good fit for console). */
  summary: string[];
  /** Reserves that hit no candidates — likely typos. */
  unmatchedReserves: string[];
  /** Reserve declaration counts: pins, peripherals, positions. */
  reserved: { pins: string[]; peripherals: string[]; positions: string[] };
  /** Pinned (`pin X = signal`) assignments. */
  pinned: ExportedPinnedAssignment[];
}

// ============================================================
// Public API
// ============================================================

export function analyzeSolverInputs(
  ast: ProgramNode,
  mcu: Mcu,
  pinnedAssignmentsArg?: ExportedPinnedAssignment[],
): SolverDiagnosticsReport {
  const expanded = expandAllMacros(ast, getStdlibMacros(), getStdlibTemplates()).ast;
  const ports = extractPorts(expanded);
  const reserved = resolveReservePatterns(expanded, mcu);
  const sharedPatterns = extractSharedPatterns(expanded);
  const pinnedAssignments = pinnedAssignmentsArg ?? extractPinnedAssignments(expanded);

  const reservedPinSet = new Set<string>(reserved.pins);
  for (const pa of pinnedAssignments) for (const p of pinnedOccupiedPins(pa)) reservedPinSet.add(p);
  const reservedPeripheralSet = new Set<string>(reserved.peripherals);

  // Re-resolve variables with reserves applied so candidate counts are
  // honest about what the solver actually sees.
  const variables = resolveAllVariables(ports, mcu, reservedPinSet, reservedPeripheralSet);
  // And without reserves, so we can attribute pruning to specific causes.
  const variablesNoReserve = resolveAllVariables(ports, mcu, new Set(), new Set());

  const portReports = buildPortReports(
    ports, mcu, variables, variablesNoReserve, reservedPinSet, reservedPeripheralSet, pinnedAssignments,
  );
  const typeDemand = buildTypeDemand(portReports, mcu, reservedPeripheralSet, sharedPatterns);
  const pinDemand = buildPinDemand(portReports);
  const unmatchedReserves = collectUnmatchedReserves(expanded, mcu);
  const summary = buildSummary(mcu, portReports, typeDemand, pinDemand);

  return {
    mcuRef: mcu.refName,
    emptyConstraints: variables.length === 0,
    ports: portReports,
    typeDemand,
    pinDemand,
    summary,
    unmatchedReserves,
    reserved,
    pinned: pinnedAssignments,
  };
}

// ============================================================
// Per-port channel analysis
// ============================================================

function buildPortReports(
  ports: Map<string, PortSpec>,
  _mcu: Mcu,
  variables: SolverVariable[],
  variablesNoReserve: SolverVariable[],
  reservedPinSet: Set<string>,
  reservedPeripheralSet: Set<string>,
  pinnedAssignments: ExportedPinnedAssignment[],
): PortDiagnostics[] {
  // Index variables by (port, config, channel, exprIdx) for cross-table lookup.
  const keyOf = (v: SolverVariable) => `${v.portName}\0${v.configName}\0${v.channelName}\0${v.exprIndex}`;
  const byKeyFree = new Map<string, SolverVariable>();
  for (const v of variables) byKeyFree.set(keyOf(v), v);

  const pinnedSet = new Set(pinnedAssignments.map(p => p.pinName));

  const reports: PortDiagnostics[] = [];
  for (const [portName, port] of ports) {
    const channels: ChannelDiagnostics[] = [];

    for (const v of variablesNoReserve) {
      if (v.portName !== portName) continue;
      const free = byKeyFree.get(keyOf(v));
      const candidatesTotal = v.candidates.length;
      const candidatesFree = free?.candidates.length ?? 0;
      const prunedByReserve = countPrunedByReserve(v, reservedPinSet, reservedPeripheralSet);
      const prunedByPinned = countPrunedByPinned(v, pinnedSet, reservedPinSet);

      const pinSet = new Set(free?.candidates.map(c => c.pin.name) ?? []);
      const instanceSet = new Set(free?.candidates.map(c => c.peripheralInstance) ?? []);
      const typeSet = new Set(free?.candidates.map(c => c.peripheralType).filter(Boolean) as string[]);

      const hints: string[] = [];
      if (candidatesTotal === 0) {
        hints.push(`No pin on ${_mcu.refName} carries ${v.patternRaw} — pattern may be misspelled or this MCU lacks that peripheral.`);
      } else if (candidatesFree === 0) {
        hints.push(`All candidates pruned: ${prunedByReserve} by reserve, ${prunedByPinned} by pin assignments.`);
      } else if (instanceSet.size === 1 && [...instanceSet][0]) {
        hints.push(`Only 1 free instance (${[...instanceSet][0]}) — port pinned to it.`);
      }

      // A channel is "pure GPIO" only when every alternative is the IN /
       // OUT shorthand. Anything that names a peripheral signal (USART_TX,
       // ADC_INp, …) requires a peripheral pin and stays in the ranking.
       const isGpio = v.patternRaw.split('|')
         .map(s => s.trim())
         .every(s => s === 'IN' || s === 'OUT');

      channels.push({
        portName,
        channelName: v.channelName,
        configName: v.configName,
        patternRaw: v.patternRaw,
        optional: v.optional ?? false,
        isGpio,
        candidatesTotal,
        candidatesFree,
        uniquePinsFree: pinSet.size,
        uniqueInstancesFree: instanceSet.size,
        uniqueTypesFree: typeSet.size,
        pinSet,
        instanceSet,
        typeSet,
        prunedByReserve,
        prunedByPinned,
        hints,
      });
    }

    // Aggregate peripheral type demand. For each port we union the types
    // its (non-optional) channels need; the count is "1 instance per type
    // per port" since the solver enforces same-port instance reuse.
    const peripheralDemand = new Map<string, number>();
    const seenTypes = new Set<string>();
    for (const ch of channels) {
      if (ch.optional) continue;
      for (const t of ch.typeSet) {
        if (!seenTypes.has(`${portName}\0${t}`)) {
          seenTypes.add(`${portName}\0${t}`);
          peripheralDemand.set(t, (peripheralDemand.get(t) ?? 0) + 1);
        }
      }
    }

    const portHints: string[] = [];
    const zeroChans = channels.filter(c => !c.optional && c.candidatesFree === 0);
    if (zeroChans.length > 0) {
      portHints.push(`${zeroChans.length} channel${zeroChans.length === 1 ? '' : 's'} with no free candidate: ${zeroChans.map(c => c.channelName).join(', ')}`);
    }

    // Sort channels for stable display: zero-candidate first, then by name.
    channels.sort((a, b) => {
      const az = a.candidatesFree === 0 ? 0 : 1;
      const bz = b.candidatesFree === 0 ? 0 : 1;
      if (az !== bz) return az - bz;
      const cmp = a.configName.localeCompare(b.configName);
      if (cmp !== 0) return cmp;
      return a.channelName.localeCompare(b.channelName);
    });

    reports.push({ portName, channels, peripheralDemand, hints: portHints });
    void port; // marker — port already iterated
  }

  reports.sort((a, b) => a.portName.localeCompare(b.portName));
  return reports;
}

// ============================================================
// Type demand
// ============================================================

import type { PatternPart } from '../parser/constraint-ast';

function buildTypeDemand(
  ports: PortDiagnostics[],
  mcu: Mcu,
  reservedPeripheralSet: Set<string>,
  sharedPatterns: PatternPart[],
): TypeDemand[] {
  // Aggregate demand across ports.
  const demand = new Map<string, { ports: Set<string>; required: number }>();
  for (const port of ports) {
    for (const [type, count] of port.peripheralDemand) {
      const entry = demand.get(type) ?? { ports: new Set(), required: 0 };
      entry.ports.add(port.portName);
      entry.required += count;
      demand.set(type, entry);
    }
  }

  const out: TypeDemand[] = [];
  for (const [type, { ports: portSet, required }] of demand) {
    const instances = mcu.typeToInstances.get(type) ?? [];
    const reservedHits = instances.filter(i => reservedPeripheralSet.has(i));
    const free = instances.filter(i => !reservedPeripheralSet.has(i));
    // A `shared:` pattern lifts the "1 port per instance" rule, so demand
    // is effectively unbounded relative to the pool — we still surface the
    // numbers but mark `shared: true` so the UI doesn't flag it red.
    const shared = instances.some(i => isSharedInstance(i, sharedPatterns));
    const totalFree = free.length;
    const shortfall = !shared && required > totalFree;
    const missingInstances = shared ? 0 : Math.max(0, required - totalFree);

    out.push({
      type,
      portsRequesting: [...portSet].sort(),
      totalRequired: required,
      totalAvailable: instances.length,
      totalFree,
      shared,
      available: free,
      reserved: reservedHits,
      shortfall,
      missingInstances,
    });
  }

  out.sort((a, b) => {
    if (a.shortfall !== b.shortfall) return a.shortfall ? -1 : 1;
    return a.type.localeCompare(b.type);
  });
  return out;
}

// ============================================================
// Pin demand (cross-port pin contention)
// ============================================================

function buildPinDemand(ports: PortDiagnostics[]): PinDemand[] {
  const result: PinDemand[] = [];

  for (const port of ports) {
    // Within one port, the solver allows pin reuse across configs/channels
    // (with channel exclusivity) — so we only flag a shortfall when the
    // SET of candidate pins fails to grow with channels. The most useful
    // metric is per-channel, considering competition from other ports.
    for (const ch of port.channels) {
      if (ch.optional) continue;
      const competingChannels: string[] = [];
      for (const otherPort of ports) {
        if (otherPort.portName === port.portName) continue;
        for (const otherCh of otherPort.channels) {
          if (otherCh.optional) continue;
          // Overlap = at least one shared pin.
          if (intersects(ch.pinSet, otherCh.pinSet)) {
            competingChannels.push(`${otherPort.portName}.${otherCh.channelName}`);
          }
        }
      }
      const dedup = [...new Set(competingChannels)].sort();
      result.push({
        channelKey: `${port.portName}\0${ch.channelName}`,
        portName: port.portName,
        channelName: ch.channelName,
        freePinCount: ch.uniquePinsFree,
        competingChannels: dedup,
        shortfall: ch.uniquePinsFree === 0,
      });
    }
  }

  return result;
}

// ============================================================
// Reserve diagnostics
// ============================================================

function collectUnmatchedReserves(ast: ProgramNode, mcu: Mcu): string[] {
  // A reserve pattern that hit nothing on this MCU is almost always a
  // typo. Walk the AST, re-run the (lightweight) match logic and report
  // patterns whose intersection with the MCU is empty.
  const unmatched: string[] = [];
  for (const stmt of ast.statements) {
    if (stmt.type !== 'reserve_decl') continue;
    for (const pattern of stmt.patterns) {
      if (pattern.type !== 'literal') continue;
      const v = pattern.value;
      if (mcu.logicalPinByName.has(v)) continue;
      if (mcu.peripheralByInstance.has(v)) continue;
      if (mcu.physicalPinByPosition.has(v)) continue;
      // Wildcards/ranges are caught by the resolver — we only tag literals
      // here so noise stays low.
      unmatched.push(v);
    }
  }
  return unmatched;
}

// ============================================================
// Summary lines
// ============================================================

function buildSummary(
  mcu: Mcu,
  ports: PortDiagnostics[],
  typeDemand: TypeDemand[],
  pinDemand: PinDemand[],
): string[] {
  const lines: string[] = [];
  const portCount = ports.length;
  const channelCount = ports.reduce((s, p) => s + p.channels.length, 0);
  const zeroChannels = ports.flatMap(p => p.channels.filter(c => !c.optional && c.candidatesFree === 0));
  const shortfalls = typeDemand.filter(t => t.shortfall);

  lines.push(`MCU ${mcu.refName}: ${portCount} port${portCount === 1 ? '' : 's'}, ${channelCount} channel${channelCount === 1 ? '' : 's'}.`);

  if (zeroChannels.length > 0) {
    const sample = zeroChannels.slice(0, 3).map(c => `${c.portName}.${c.channelName}`).join(', ');
    lines.push(`Zero-candidate channels: ${zeroChannels.length} (${sample}${zeroChannels.length > 3 ? '…' : ''}).`);
  }

  for (const t of shortfalls) {
    lines.push(`${t.type}: need ${t.totalRequired}, have ${t.totalFree} free (${t.totalAvailable} on MCU). Missing ${t.missingInstances} instance${t.missingInstances === 1 ? '' : 's'} for ports ${t.portsRequesting.join(', ')}.`);
  }

  const pinShorts = pinDemand.filter(p => p.shortfall);
  if (pinShorts.length > 0) {
    const sample = pinShorts.slice(0, 3).map(p => `${p.portName}.${p.channelName}`).join(', ');
    lines.push(`No free pin: ${pinShorts.length} channel${pinShorts.length === 1 ? '' : 's'} (${sample}${pinShorts.length > 3 ? '…' : ''}).`);
  }

  return lines;
}

// ============================================================
// Helpers
// ============================================================

function countPrunedByReserve(
  v: SolverVariable,
  reservedPinSet: Set<string>,
  reservedPeripheralSet: Set<string>,
): number {
  let n = 0;
  for (const c of v.candidates) {
    if (reservedPinSet.has(c.pin.name) || reservedPeripheralSet.has(c.peripheralInstance)) n++;
  }
  return n;
}

function countPrunedByPinned(
  v: SolverVariable,
  pinnedSet: Set<string>,
  reservedPinSet: Set<string>,
): number {
  let n = 0;
  for (const c of v.candidates) {
    // A pin counts as "pinned" only when not also reserved (avoid double-count).
    if (pinnedSet.has(c.pin.name) && !reservedPinSet.has(c.pin.name)) n++;
  }
  return n;
}

function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) return true;
  return false;
}

// ============================================================
// Console-friendly one-liner per solver
// ============================================================

export function formatSolverSummary(
  solverId: string,
  validSolutions: number,
  evaluatedCombinations: number,
  solveTimeMs: number,
  report: SolverDiagnosticsReport,
): string {
  const failed = Math.max(0, evaluatedCombinations - validSolutions);
  const headline = `[${solverId}] ${validSolutions} valid / ${failed} failed in ${solveTimeMs.toFixed(0)}ms`;
  const bottlenecks = report.summary.slice(1).join(' ');
  return bottlenecks ? `${headline} — ${bottlenecks}` : headline;
}

// ============================================================
// Cross-solver aggregate view
//
// Same static report (constraint × MCU) feeds every solver, so the
// "where's the bottleneck?" question doesn't change by algorithm. What
// the aggregate adds is:
//   1. Top-N rankings (so the user sees the worst offenders without
//      scanning a long table).
//   2. Cross-solver runtime totals (any solver succeed at all? best
//      result count?  total time spent searching).
//   3. A digest of every error message, deduped, with which solvers
//      reported it.
// The aggregate is computed on demand in the UI when the user opens
// the Overview modal.
// ============================================================

import type { SolverResult } from '../types';

export interface AggregateBottleneck {
  /** "USART", "PA9", "CMD.TX" — what the user sees in the row. */
  label: string;
  /** Numeric severity used for ranking. Higher = worse. */
  severity: number;
  /** One-line explanation of why this is a bottleneck. */
  detail: string;
}

export interface AggregateRunStats {
  solverCount: number;
  finishedCount: number;
  timeoutCount: number;
  errorCount: number;
  abortedCount: number;
  /** Max validSolutions any solver produced (post-dedup happens elsewhere). */
  bestValidCount: number;
  totalEvaluated: number;
  totalSolveTimeMs: number;
  fastestFirstSolutionMs: number | null;
}

/**
 * Floor numbers for "what does this design demand from the MCU?". These
 * are minimum, not maximum: the solver may pack channels onto fewer
 * pins/peripherals through reuse, but it cannot use less than the floor.
 */
export interface MinimumRequirements {
  /** Non-optional channels that need a peripheral-signal pin (excludes pure GPIO). */
  peripheralSignalPins: number;
  /** Non-optional pure-GPIO channels (IN / OUT mappings). */
  gpioPins: number;
  /** Total non-optional channels = peripheralSignalPins + gpioPins. */
  totalPins: number;
  /** Sum of distinct (port, peripheral-type) pairs from non-optional channels. */
  peripheralInstances: number;
  /** Per-type minimum demand; same numbers as TypeDemand.totalRequired but skipping GPIO. */
  byType: Map<string, number>;
}

export interface AggregateReport {
  mcuRef: string;
  topPeripheralShortfalls: AggregateBottleneck[];
  /** Channels ranked by hardness (zero-candidate first, then smallest free). */
  topHardChannels: AggregateBottleneck[];
  /** Pins / channels with the most cross-port competition. */
  topContention: AggregateBottleneck[];
  /** Distinct error messages with counts and the solvers that reported them. */
  errorDigest: Array<{ message: string; type: 'error' | 'warning'; count: number; solvers: string[] }>;
  /** Aggregate runtime statistics across every solver in the run. */
  runStats: AggregateRunStats;
  /** Source-of-truth for the top-level summary on the overview modal. */
  headlines: string[];
  /** Minimum pin / peripheral demand the constraints place on the MCU. */
  minRequirements: MinimumRequirements;
}

export interface SolverRunRecord {
  solverId: string;
  state: 'finished' | 'timeout' | 'error' | 'aborted' | 'running';
  result: SolverResult | null;
}

export interface AggregateOptions {
  /** Cap for each top-N ranking (peripheral, hard channels, contention). Default 10. */
  topN?: number;
  /**
   * Drop channels with exactly one free pin from the hardest-channels
   * ranking. They're "forced bindings" — the constraint is locked, but
   * forcing isn't necessarily a bottleneck (often it's deliberate, e.g.
   * USB_DM/USB_DP with a single legal pad). Toggle from the Overview
   * modal so users can see them on demand.
   */
  excludeForcedBinding?: boolean;
}

export function aggregateSolverRuns(
  report: SolverDiagnosticsReport,
  runs: SolverRunRecord[],
  options: AggregateOptions = {},
): AggregateReport {
  const topN = options.topN ?? 10;
  const excludeForcedBinding = options.excludeForcedBinding ?? false;
  const topPeripheralShortfalls: AggregateBottleneck[] = report.typeDemand
    .filter(t => t.shortfall && !t.shared && t.type !== 'GPIO')
    .sort((a, b) => b.missingInstances - a.missingInstances)
    .slice(0, topN)
    .map(t => ({
      label: t.type,
      severity: t.missingInstances,
      detail: `Need ${t.totalRequired} instance${t.totalRequired === 1 ? '' : 's'}, only ${t.totalFree} free (${t.totalAvailable} on MCU). Missing ${t.missingInstances}. Ports: ${t.portsRequesting.join(', ')}.`,
    }));

  // Hardest channels: zero-free first (severity = 1000 + total candidate
  // count, so missing-pattern beats "0/0" pins), then low-free count.
  // Pure-GPIO channels (IN/OUT) are skipped — they trivially have huge
  // candidate sets and their hardness is not the failure cause.
  const allChannels = report.ports.flatMap(p =>
    p.channels
      .filter(c => !c.optional && !c.isGpio)
      // Forced-binding rows have candidates but only 1 free pin. They get
      // suppressed when the user toggles "exclude forced bindings" so the
      // ranking surfaces real shortages instead of locked-in choices.
      .filter(c => !excludeForcedBinding || c.candidatesFree === 0 || c.uniquePinsFree !== 1)
      .map(c => ({ port: p.portName, channel: c })),
  );
  const channelRanked = allChannels
    .map(({ port, channel: c }) => {
      let severity: number;
      let detail: string;
      if (c.candidatesTotal === 0) {
        severity = 1000;
        detail = `No pin on ${report.mcuRef} carries pattern ${c.patternRaw}.`;
      } else if (c.candidatesFree === 0) {
        severity = 500 + c.prunedByReserve + c.prunedByPinned;
        detail = `${c.candidatesTotal} candidate${c.candidatesTotal === 1 ? '' : 's'} all pruned (${c.prunedByReserve} reserve / ${c.prunedByPinned} pinned).`;
      } else if (c.uniquePinsFree === 1) {
        severity = 100;
        detail = `Only 1 free pin (forced binding). Pattern: ${c.patternRaw}.`;
      } else if (c.candidatesFree <= 2) {
        severity = 50 + (3 - c.candidatesFree);
        detail = `Just ${c.candidatesFree} free candidate${c.candidatesFree === 1 ? '' : 's'} after pruning.`;
      } else {
        severity = -c.candidatesFree;
        detail = `${c.candidatesFree} free candidates on ${c.uniquePinsFree} pin${c.uniquePinsFree === 1 ? '' : 's'}.`;
      }
      return {
        label: `${port}.${c.channelName}${c.configName !== port ? ` [${c.configName}]` : ''}`,
        severity,
        detail,
      };
    })
    .sort((a, b) => b.severity - a.severity)
    .slice(0, topN);

  // Map channelKey → isGpio so we can drop pure-GPIO contention entries.
  // GPIO channels have huge candidate sets (≈ every assignable pin), so
  // they trivially overlap with everything and would dominate the list.
  const gpioChannelKeys = new Set(
    report.ports.flatMap(p => p.channels)
      .filter(c => c.isGpio)
      .map(c => `${c.portName}\0${c.channelName}`),
  );

  const topContention = report.pinDemand
    .filter(p => p.competingChannels.length > 0 && !gpioChannelKeys.has(p.channelKey))
    .sort((a, b) => b.competingChannels.length - a.competingChannels.length)
    .slice(0, topN)
    .map(p => ({
      label: `${p.portName}.${p.channelName}`,
      severity: p.competingChannels.length,
      detail: `Free pins: ${p.freePinCount}. Competes with ${p.competingChannels.length} other channel${p.competingChannels.length === 1 ? '' : 's'}: ${p.competingChannels.slice(0, 5).join(', ')}${p.competingChannels.length > 5 ? '…' : ''}.`,
    }));

  const minRequirements = computeMinimumRequirements(report);

  // Aggregate run stats and dedupe errors across all solvers.
  const runStats: AggregateRunStats = {
    solverCount: runs.length,
    finishedCount: runs.filter(r => r.state === 'finished').length,
    timeoutCount: runs.filter(r => r.state === 'timeout').length,
    errorCount: runs.filter(r => r.state === 'error').length,
    abortedCount: runs.filter(r => r.state === 'aborted').length,
    bestValidCount: 0,
    totalEvaluated: 0,
    totalSolveTimeMs: 0,
    fastestFirstSolutionMs: null,
  };

  const errorMap = new Map<string, { type: 'error' | 'warning'; count: number; solvers: Set<string> }>();
  for (const r of runs) {
    if (!r.result) continue;
    runStats.bestValidCount = Math.max(runStats.bestValidCount, r.result.solutions.length);
    runStats.totalEvaluated += r.result.statistics.evaluatedCombinations;
    runStats.totalSolveTimeMs += r.result.statistics.solveTimeMs;
    const ttfs = r.result.statistics.firstSolutionMs;
    if (ttfs !== undefined) {
      runStats.fastestFirstSolutionMs = runStats.fastestFirstSolutionMs === null
        ? ttfs : Math.min(runStats.fastestFirstSolutionMs, ttfs);
    }
    for (const e of r.result.errors) {
      // Strip a trailing solver name prefix if present so identical
      // messages from different solvers fold into one row.
      const key = e.message.replace(/^\[[^\]]+\]\s*/, '').trim();
      const slot = errorMap.get(key) ?? { type: e.type, count: 0, solvers: new Set<string>() };
      slot.count++;
      slot.solvers.add(r.solverId);
      errorMap.set(key, slot);
    }
  }

  const errorDigest = [...errorMap.entries()]
    .map(([message, v]) => ({ message, type: v.type, count: v.count, solvers: [...v.solvers].sort() }))
    .sort((a, b) => {
      // Errors first, then by frequency.
      if ((a.type === 'error') !== (b.type === 'error')) return a.type === 'error' ? -1 : 1;
      return b.count - a.count;
    });

  const headlines: string[] = [];
  headlines.push(
    `${runStats.finishedCount}/${runStats.solverCount} solver${runStats.solverCount === 1 ? '' : 's'} finished`
    + (runStats.timeoutCount ? ` (${runStats.timeoutCount} timeout)` : '')
    + (runStats.errorCount ? ` (${runStats.errorCount} error)` : '')
    + (runStats.abortedCount ? ` (${runStats.abortedCount} aborted)` : '')
    + ` · best ${runStats.bestValidCount} valid solution${runStats.bestValidCount === 1 ? '' : 's'}`,
  );
  if (topPeripheralShortfalls.length > 0) {
    headlines.push(`Top shortfall: ${topPeripheralShortfalls[0].label} (missing ${topPeripheralShortfalls[0].severity}).`);
  }
  const zeroChans = channelRanked.filter(c => c.severity >= 500);
  if (zeroChans.length > 0) {
    headlines.push(`${zeroChans.length} channel${zeroChans.length === 1 ? '' : 's'} with no free candidates.`);
  }
  if (runStats.bestValidCount === 0 && runStats.solverCount > 0) {
    headlines.push('No solver produced a valid solution — likely structurally infeasible.');
  }

  return {
    mcuRef: report.mcuRef,
    topPeripheralShortfalls,
    topHardChannels: channelRanked,
    topContention,
    errorDigest,
    runStats,
    headlines,
    minRequirements,
  };
}

/**
 * Floor numbers for what the constraints demand: total non-optional
 * channels split into peripheral-signal pins vs pure-GPIO pins, plus
 * peripheral-instance demand keyed by type. The solver may pack better
 * (channel reuse across configs reduces actual usage) but never lower.
 */
function computeMinimumRequirements(report: SolverDiagnosticsReport): MinimumRequirements {
  let peripheralSignalPins = 0;
  let gpioPins = 0;
  for (const p of report.ports) {
    for (const ch of p.channels) {
      if (ch.optional) continue;
      if (ch.isGpio) gpioPins++;
      else peripheralSignalPins++;
    }
  }

  const byType = new Map<string, number>();
  let peripheralInstances = 0;
  for (const t of report.typeDemand) {
    if (t.type === 'GPIO') continue;     // tracked under gpioPins above
    byType.set(t.type, t.totalRequired);
    peripheralInstances += t.totalRequired;
  }

  return {
    peripheralSignalPins,
    gpioPins,
    totalPins: peripheralSignalPins + gpioPins,
    peripheralInstances,
    byType,
  };
}
