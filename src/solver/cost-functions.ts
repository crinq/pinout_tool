// ============================================================
// Cost Functions for Solution Ranking
// ============================================================

import type { CostFunction, Solution, Mcu, LogicalPin } from '../types';
import type { SignalCandidate } from './pattern-matcher';

const registry = new Map<string, CostFunction>();

export function registerCostFunction(fn: CostFunction): void {
  registry.set(fn.id, fn);
}

// ============================================================
// Placement anchors (`@ ~...` soft hints). Built once per solve from the AST
// + package geometry (see pin-anchors.ts) and stashed here so the pin_anchor
// cost function and the hard-anchor filter can read them without threading an
// extra argument through every solver's finalize path.
// ponytail: module global, safe because a worker (or the editor's main thread)
// runs one solve at a time and prepareSolverContext re-sets it before costing.
// ============================================================

export interface AnchorGeom {
  /** Package position ("A1" / "42") → normalized (x,y) in [0,1], y=0 north, x=0 west. */
  norm(position: string): { x: number; y: number } | null;
  /** Multiply a normalized distance to get ~pin-spacing units (comparable to pin_proximity). */
  scale: number;
}

export interface SolutionAnchors {
  /** `portName\0channelName` → soft target points (normalized), applied as distance cost. */
  byChannel: Map<string, { x: number; y: number }[]>;
  geom: AnchorGeom;
  /** Hard: some channel of the port must land on each listed pin. */
  hardPortPins: { portName: string; pins: string[] }[];
  /** Hard: some channel mapped in the config must land on each listed pin. */
  hardConfigPins: { portName: string; configName: string; pins: string[] }[];
  /** `portName\0channelName` → the `group` block the channel was declared in. */
  groupOfChannel: Map<string, string>;
  /** Hard: some channel of the group must land on each listed pin. */
  hardGroupPins: { portName: string; channels: string[]; pins: string[] }[];
}

let activeAnchors: SolutionAnchors | null = null;
export function setActiveAnchors(a: SolutionAnchors | null): void { activeAnchors = a; }
export function getActiveAnchors(): SolutionAnchors | null { return activeAnchors; }

/**
 * When set, the distance-based cost functions (pin_clustering, pin_proximity,
 * pin_anchor) accumulate squared distances instead of raw ones, so a single
 * far-away pin is punished much harder than several slightly-spread ones.
 * Set once per solve alongside the anchors (see setActiveAnchors).
 */
let squaredCosts = false;
export function setSquaredCosts(v: boolean): void { squaredCosts = v; }
export function getSquaredCosts(): boolean { return squaredCosts; }
/** Apply the squared-distance option to a single distance term. */
const dist = (d: number): number => (squaredCosts ? d * d : d);

export function getCostFunction(id: string): CostFunction | undefined {
  return registry.get(id);
}

export function getAllCostFunctions(): CostFunction[] {
  return [...registry.values()];
}

export function computeTotalCost(
  solution: Solution,
  mcu: Mcu,
  weights: Map<string, number>
): number {
  let total = 0;
  solution.costs.clear();

  for (const fn of registry.values()) {
    const weight = weights.get(fn.id) ?? 1.0;
    if (weight === 0) continue;
    const cost = fn.compute(solution, mcu);
    solution.costs.set(fn.id, cost);
    total += cost * weight;
  }

  solution.totalCost = total;
  return total;
}

// ============================================================
// Built-in Cost Functions
// ============================================================

registerCostFunction({
  id: 'pin_count',
  name: 'Pin Count',
  description: 'Number of unique pins used (lower is better)',
  compute(solution: Solution): number {
    const pins = new Set<string>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        pins.add(a.pinName);
      }
    }
    return pins.size;
  },
});

registerCostFunction({
  id: 'port_spread',
  name: 'Port Spread',
  description: 'Number of different GPIO ports used (lower is better for PCB routing)',
  compute(solution: Solution): number {
    const ports = new Set<string>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        // Extract port letter from pin name (e.g., PA4 -> A)
        const match = a.pinName.match(/^P([A-Z])/);
        if (match) {
          ports.add(match[1]);
        }
      }
    }
    return ports.size;
  },
});

registerCostFunction({
  id: 'peripheral_count',
  name: 'Peripheral Count',
  description: 'Number of distinct peripheral instances used (lower preserves more for other uses)',
  compute(solution: Solution): number {
    const instances = new Set<string>();
    for (const [, peripherals] of solution.portPeripherals) {
      for (const p of peripherals) {
        instances.add(p);
      }
    }
    return instances.size;
  },
});

registerCostFunction({
  id: 'optional_fulfillment',
  name: 'Optional Fulfillment',
  description: 'Ratio of unfulfilled optional mappings and requires (lower = more optionals satisfied)',
  compute(solution: Solution): number {
    if (solution.optionalTotal === 0) return 0;
    // Cost = fraction of optionals NOT fulfilled (0 = all fulfilled, 1 = none fulfilled)
    return 1 - solution.optionalFulfilled / solution.optionalTotal;
  },
});

const DEBUG_SIGNAL_PATTERN = /^SYS_(?:JTCK|JTDI|JTDO|JTMS|JTRST|SWCLK|SWDIO|SWO)\b/i;

export function isDebugPin(pin: LogicalPin): boolean {
  return pin.signals.some(s => DEBUG_SIGNAL_PATTERN.test(s.name));
}

registerCostFunction({
  id: 'debug_pin_penalty',
  name: 'Debug Pin Penalty',
  description: 'Penalty for using debug-capable pins (SWD/JTAG)',
  compute(solution: Solution, mcu: Mcu): number {
    let penalty = 0;
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        const pin = mcu.logicalPinByName.get(a.pinName) ?? mcu.logicalPinByGpioName.get(a.pinName);
        if (pin && isDebugPin(pin)) {
          penalty += 10;
        }
      }
    }
    return penalty;
  },
});

// ============================================================
// Static Candidate Cost Estimation (for variable ordering)
// ============================================================

/**
 * Estimate the intrinsic cost of a candidate without current assignment context.
 * Used for cost-guided variable ordering in Phase 2.
 */
export function estimateCandidateCost(
  candidate: SignalCandidate,
  costWeights: Map<string, number>
): number {
  let cost = 0;

  // Debug pin penalty
  const wDebug = costWeights.get('debug_pin_penalty') ?? 0;
  if (wDebug > 0 && isDebugPin(candidate.pin)) {
    cost += wDebug * 10;
  }

  return cost;
}

// ============================================================
// Incremental Cost Tracking (C2)
// ============================================================

export interface IncrementalCostTracker {
  partialCost: number;
  pinRefCount: Map<string, number>;
  gpioPortRefCount: Map<string, number>;
  peripheralRefCount: Map<string, number>;
  wPinCount: number;
  wPortSpread: number;
  wDebug: number;
  wPeripheral: number;
  mcu: Mcu;
  costWeights: Map<string, number>;
  solutionCosts: number[];
  maxK: number;
  topKThreshold: number;
}

export function createIncrementalCostTracker(
  mcu: Mcu,
  costWeights: Map<string, number>,
  maxK: number
): IncrementalCostTracker {
  return {
    partialCost: 0,
    pinRefCount: new Map(),
    gpioPortRefCount: new Map(),
    peripheralRefCount: new Map(),
    wPinCount: costWeights.get('pin_count') ?? 0,
    wPortSpread: costWeights.get('port_spread') ?? 0,
    wDebug: costWeights.get('debug_pin_penalty') ?? 0,
    wPeripheral: costWeights.get('peripheral_count') ?? 0,
    mcu,
    costWeights,
    solutionCosts: [],
    maxK,
    topKThreshold: Infinity,
  };
}

export function incrementCost(tracker: IncrementalCostTracker, candidate: SignalCandidate): void {
  const pinName = candidate.pin.name;

  if (tracker.wPinCount > 0) {
    const rc = (tracker.pinRefCount.get(pinName) ?? 0) + 1;
    tracker.pinRefCount.set(pinName, rc);
    if (rc === 1) tracker.partialCost += tracker.wPinCount;
  }

  if (tracker.wPortSpread > 0) {
    const match = pinName.match(/^P([A-Z])/);
    if (match) {
      const rc = (tracker.gpioPortRefCount.get(match[1]) ?? 0) + 1;
      tracker.gpioPortRefCount.set(match[1], rc);
      if (rc === 1) tracker.partialCost += tracker.wPortSpread;
    }
  }

  if (tracker.wDebug > 0 && isDebugPin(candidate.pin)) {
    tracker.partialCost += tracker.wDebug * 10;
  }

  if (tracker.wPeripheral > 0) {
    const inst = candidate.peripheralInstance;
    const rc = (tracker.peripheralRefCount.get(inst) ?? 0) + 1;
    tracker.peripheralRefCount.set(inst, rc);
    if (rc === 1) tracker.partialCost += tracker.wPeripheral;
  }
}

export function decrementCost(tracker: IncrementalCostTracker, candidate: SignalCandidate): void {
  const pinName = candidate.pin.name;

  if (tracker.wPinCount > 0) {
    const rc = tracker.pinRefCount.get(pinName)! - 1;
    if (rc === 0) { tracker.pinRefCount.delete(pinName); tracker.partialCost -= tracker.wPinCount; }
    else tracker.pinRefCount.set(pinName, rc);
  }

  if (tracker.wPortSpread > 0) {
    const match = pinName.match(/^P([A-Z])/);
    if (match) {
      const rc = tracker.gpioPortRefCount.get(match[1])! - 1;
      if (rc === 0) { tracker.gpioPortRefCount.delete(match[1]); tracker.partialCost -= tracker.wPortSpread; }
      else tracker.gpioPortRefCount.set(match[1], rc);
    }
  }

  if (tracker.wDebug > 0 && isDebugPin(candidate.pin)) {
    tracker.partialCost -= tracker.wDebug * 10;
  }

  if (tracker.wPeripheral > 0) {
    const inst = candidate.peripheralInstance;
    const rc = tracker.peripheralRefCount.get(inst)! - 1;
    if (rc === 0) { tracker.peripheralRefCount.delete(inst); tracker.partialCost -= tracker.wPeripheral; }
    else tracker.peripheralRefCount.set(inst, rc);
  }
}

export function updateCostThreshold(tracker: IncrementalCostTracker, solutionCost: number): void {
  const idx = tracker.solutionCosts.findIndex(c => c > solutionCost);
  if (idx === -1) tracker.solutionCosts.push(solutionCost);
  else tracker.solutionCosts.splice(idx, 0, solutionCost);

  if (tracker.solutionCosts.length > tracker.maxK) {
    tracker.solutionCosts.length = tracker.maxK;
  }
  if (tracker.solutionCosts.length >= tracker.maxK) {
    tracker.topKThreshold = tracker.solutionCosts[tracker.solutionCosts.length - 1];
  }
}

// ============================================================
// Pin Proximity Helpers
// ============================================================

// JEDEC BGA row labels skip I, O, Q, S, X, Z (avoids confusion with 1/0/2/5/×/2).
// Raw ASCII (letter - 'A') therefore over-counts the row index by one per skipped
// letter below it, stretching vertical distances and adding a phantom row every
// time a pin swap crosses a skip boundary (e.g. H↔J, N↔P, P↔R read as 2 not 1).
const BGA_SKIP_ROWS = new Set(['I', 'O', 'Q', 'S', 'X', 'Z']);

/** Physical row index for a single-letter BGA row label, honoring JEDEC skips. */
function bgaRowIndex(letter: string): number {
  const code = letter.charCodeAt(0);
  let skipped = 0;
  for (const s of BGA_SKIP_ROWS) if (s.charCodeAt(0) < code) skipped++;
  return code - 'A'.charCodeAt(0) - skipped;
}

export function parseBgaPosition(pos: string): { row: number; col: number } | null {
  const match = pos.match(/^([A-Z])(\d+)$/);
  if (!match) return null;
  return {
    row: bgaRowIndex(match[1]),
    col: parseInt(match[2], 10),
  };
}

export function parsePackagePinCount(pkg: string): number {
  const match = pkg.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

registerCostFunction({
  id: 'pin_clustering',
  name: 'Pin Clustering',
  description: 'Physical spread of pins within each logical port (lower = tighter clustering)',
  compute(solution: Solution, mcu: Mcu): number {
    const isBGA = /BGA|WLCSP/i.test(mcu.package);
    const totalPins = parsePackagePinCount(mcu.package);

    // Group pins by logical port → positions across ALL of its configs. Every
    // config is routed on the PCB (only one is active at runtime, CPU-selected),
    // so proximity legitimately spans a port's full pin footprint.
    const portPositions = new Map<string, string[]>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const pin = mcu.logicalPinByName.get(a.pinName);
        if (!pin) continue;
        if (!portPositions.has(a.portName)) portPositions.set(a.portName, []);
        const pos = portPositions.get(a.portName)!;
        if (!pos.includes(pin.physical.position)) pos.push(pin.physical.position);
      }
    }

    let cost = 0;
    for (const positions of portPositions.values()) {
      if (positions.length < 2) continue;
      // Compute max pairwise distance (diameter) within this logical port
      let maxDist = 0;
      if (isBGA) {
        const parsed = positions.map(parseBgaPosition).filter((p): p is { row: number; col: number } => p !== null);
        for (let i = 0; i < parsed.length; i++)
          for (let j = i + 1; j < parsed.length; j++) {
            const dr = parsed[i].row - parsed[j].row;
            const dc = parsed[i].col - parsed[j].col;
            maxDist = Math.max(maxDist, Math.sqrt(dr * dr + dc * dc));
          }
      } else if (totalPins > 0) {
        const nums = positions.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
        for (let i = 0; i < nums.length; i++)
          for (let j = i + 1; j < nums.length; j++) {
            const diff = Math.abs(nums[i] - nums[j]);
            maxDist = Math.max(maxDist, Math.min(diff, totalPins - diff));
          }
      }
      cost += dist(maxDist);
    }
    return cost;
  },
});

registerCostFunction({
  id: 'pin_proximity',
  name: 'Pin Proximity',
  description: 'Physical distance between pins in the same port (lower means pins are closer together)',
  compute(solution: Solution, mcu: Mcu): number {
    const isBGA = /BGA|WLCSP/i.test(mcu.package);
    const totalPins = parsePackagePinCount(mcu.package);

    // Group unique pin positions by logical port, spanning ALL of its configs.
    // Every config is physically routed (runtime-multiplexed by the CPU), so a
    // port's routing proximity is measured over its complete pin footprint.
    const portPins = new Map<string, string[]>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const pin = mcu.logicalPinByName.get(a.pinName);
        if (!pin) continue;
        let positions = portPins.get(a.portName);
        if (!positions) {
          positions = [];
          portPins.set(a.portName, positions);
        }
        if (!positions.includes(pin.physical.position)) {
          positions.push(pin.physical.position);
        }
      }
    }

    let cost = 0;

    for (const positions of portPins.values()) {
      if (positions.length < 2) continue;

      if (isBGA) {
        const parsed = positions.map(parseBgaPosition).filter((p): p is { row: number; col: number } => p !== null);
        for (let i = 0; i < parsed.length; i++) {
          for (let j = i + 1; j < parsed.length; j++) {
            const dr = parsed[i].row - parsed[j].row;
            const dc = parsed[i].col - parsed[j].col;
            cost += dist(Math.sqrt(dr * dr + dc * dc));
          }
        }
      } else {
        // LQFP-style: circular distance
        const nums = positions.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
        if (totalPins > 0) {
          for (let i = 0; i < nums.length; i++) {
            for (let j = i + 1; j < nums.length; j++) {
              const diff = Math.abs(nums[i] - nums[j]);
              cost += dist(Math.min(diff, totalPins - diff));
            }
          }
        }
      }
    }

    return cost;
  },
});

registerCostFunction({
  id: 'pin_anchor',
  name: 'Pin Anchor',
  description: 'Distance of each pin from its `@ ~...` placement hint (lower means closer to the requested pin/position/region)',
  compute(solution: Solution, mcu: Mcu): number {
    const anchors = getActiveAnchors();
    if (!anchors || anchors.byChannel.size === 0) return 0;
    const { byChannel, geom } = anchors;

    let cost = 0;
    const seen = new Set<string>(); // dedup a channel's pin across configs
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const targets = byChannel.get(`${a.portName}\0${a.channelName}`);
        if (!targets || targets.length === 0) continue;
        const key = `${a.portName}\0${a.channelName}\0${a.pinName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pin = mcu.logicalPinByName.get(a.pinName);
        if (!pin) continue;
        const p = geom.norm(pin.physical.position);
        if (!p) continue;
        for (const t of targets) {
          const dx = p.x - t.x, dy = p.y - t.y;
          cost += dist(Math.sqrt(dx * dx + dy * dy) * geom.scale);
        }
      }
    }
    return cost;
  },
});

registerCostFunction({
  id: 'pin_group_clustering',
  name: 'Pin Group Clustering',
  description: 'Physical spread of the pins within each `group` block of a port (lower = tighter grouping)',
  compute(solution: Solution, mcu: Mcu): number {
    const anchors = getActiveAnchors();
    if (!anchors || anchors.groupOfChannel.size === 0) return 0;
    const { groupOfChannel } = anchors;

    const isBGA = /BGA|WLCSP/i.test(mcu.package);
    const totalPins = parsePackagePinCount(mcu.package);

    // Positions per `port\0group`, across every config — like pin_clustering,
    // but scoped to a declared group instead of the whole port. Channels with
    // no group contribute nothing, so an ungrouped port costs zero here.
    const groupPositions = new Map<string, string[]>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const group = groupOfChannel.get(`${a.portName}\0${a.channelName}`);
        if (!group) continue;
        const pin = mcu.logicalPinByName.get(a.pinName);
        if (!pin) continue;
        const key = `${a.portName}\0${group}`;
        let positions = groupPositions.get(key);
        if (!positions) {
          positions = [];
          groupPositions.set(key, positions);
        }
        if (!positions.includes(pin.physical.position)) positions.push(pin.physical.position);
      }
    }

    let cost = 0;
    for (const positions of groupPositions.values()) {
      if (positions.length < 2) continue;
      let maxDist = 0;
      if (isBGA) {
        const parsed = positions.map(parseBgaPosition).filter((b): b is { row: number; col: number } => b !== null);
        for (let i = 0; i < parsed.length; i++)
          for (let j = i + 1; j < parsed.length; j++) {
            const dr = parsed[i].row - parsed[j].row;
            const dc = parsed[i].col - parsed[j].col;
            maxDist = Math.max(maxDist, Math.sqrt(dr * dr + dc * dc));
          }
      } else if (totalPins > 0) {
        const nums = positions.map(pos => parseInt(pos, 10)).filter(n => !isNaN(n));
        for (let i = 0; i < nums.length; i++)
          for (let j = i + 1; j < nums.length; j++) {
            const diff = Math.abs(nums[i] - nums[j]);
            maxDist = Math.max(maxDist, Math.min(diff, totalPins - diff));
          }
      }
      cost += dist(maxDist);
    }
    return cost;
  },
});
