// ============================================================
// Cost Functions for Solution Ranking
// ============================================================

import type { CostFunction, Solution, Mcu } from '../types';

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
  id: 'debug_pin_penalty',
  name: 'Debug Pin Penalty',
  description: 'Penalty for using debug-capable pins (SWD/JTAG)',
  compute(solution: Solution): number {
    const debugPins = new Set(['PA13', 'PA14', 'PA15', 'PB3', 'PB4']);
    let penalty = 0;
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        // Check both raw pin name and GPIO-style
        const match = a.pinName.match(/^P([A-Z])(\d+)/);
        const gpioName = match ? `P${match[1]}${match[2]}` : a.pinName;
        if (debugPins.has(gpioName)) {
          penalty += 10;
        }
      }
    }
    return penalty;
  },
});

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
  description: 'Bonus for pins on the same GPIO port per port (lower is better)',
  compute(solution: Solution): number {
    // Group pins by port name, then count distinct GPIO ports
    const portGpioPorts = new Map<string, Set<string>>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (!portGpioPorts.has(a.portName)) {
          portGpioPorts.set(a.portName, new Set());
        }
        const match = a.pinName.match(/^P([A-Z])/);
        if (match) {
          portGpioPorts.get(a.portName)!.add(match[1]);
        }
      }
    }
    let cost = 0;
    for (const gpioPorts of portGpioPorts.values()) {
      // Ideal: all pins on same port (cost = 0)
      // Each extra port adds 1
      cost += Math.max(0, gpioPorts.size - 1);
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
