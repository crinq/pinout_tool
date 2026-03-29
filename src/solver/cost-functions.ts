// ============================================================
// Cost Functions for Solution Ranking
// ============================================================

import type { CostFunction, Solution, Mcu, Pin } from '../types';
import type { SignalCandidate } from './pattern-matcher';

const registry = new Map<string, CostFunction>();

export function registerCostFunction(fn: CostFunction): void {
  registry.set(fn.id, fn);
}

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

export function isDebugPin(pin: Pin): boolean {
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
        const pin = mcu.pinByName.get(a.pinName) ?? mcu.pinByGpioName.get(a.pinName);
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

export function parseBgaPosition(pos: string): { row: number; col: number } | null {
  const match = pos.match(/^([A-Z])(\d+)$/);
  if (!match) return null;
  return {
    row: match[1].charCodeAt(0) - 'A'.charCodeAt(0),
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

    // Group pins by logical port → get positions
    const portPositions = new Map<string, string[]>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const pin = mcu.pinByName.get(a.pinName);
        if (!pin) continue;
        if (!portPositions.has(a.portName)) portPositions.set(a.portName, []);
        const pos = portPositions.get(a.portName)!;
        if (!pos.includes(pin.position)) pos.push(pin.position);
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
      cost += maxDist;
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

    // Group unique pin positions by port
    const portPins = new Map<string, string[]>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName === '<pinned>') continue;
        const pin = mcu.pinByName.get(a.pinName);
        if (!pin) continue;
        let positions = portPins.get(a.portName);
        if (!positions) {
          positions = [];
          portPins.set(a.portName, positions);
        }
        if (!positions.includes(pin.position)) {
          positions.push(pin.position);
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
            cost += Math.sqrt(dr * dr + dc * dc);
          }
        }
      } else {
        // LQFP-style: circular distance
        const nums = positions.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
        if (totalPins > 0) {
          for (let i = 0; i < nums.length; i++) {
            for (let j = i + 1; j < nums.length; j++) {
              const diff = Math.abs(nums[i] - nums[j]);
              cost += Math.min(diff, totalPins - diff);
            }
          }
        }
      }
    }

    return cost;
  },
});
