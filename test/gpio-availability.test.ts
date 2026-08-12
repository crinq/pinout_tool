import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { solveConstraints } from '../src/solver/solver';
import type { Mcu } from '../src/types';
import { isGeneralPurposePin } from '../src/utils';

// With `skipGpioMapping` on, IN/OUT channels are not placed individually — the
// solver only verifies that enough free pins remain. The budget must count pins
// that can actually host a GPIO: an assignable pin with no GPIO signal (an H7
// `_C` analog-only pad) can never satisfy an IN/OUT channel, and two logical
// pins bonded to one physical pad are only one usable GPIO.

function load(folder: string): Mcu {
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const CFG = { maxSolutions: 2, timeoutMs: 5000, costWeights: new Map<string, number>(), skipGpioMapping: true };

function solveCount(mcu: Mcu, src: string): number {
  const { ast, errors } = parseConstraints(src);
  expect(errors, errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return solveConstraints(ast!, mcu, CFG).solutions.length;
}

const gpios = (n: number) => Array.from({ length: n }, (_, i) => `  channel G${i} = OUT`).join('\n');
const gpioPort = (n: number) => `port P:\n${gpios(n)}`;

/** Unique physical pads that can host a GPIO — the true budget. */
function gpioCapacity(mcu: Mcu): number {
  const pads = new Set<string>();
  for (const p of mcu.logicalPins) {
    if (!p.isAssignable) continue;
    if (!p.signals.some(s => s.peripheralType === 'GPIO')) continue;
    pads.add(p.physical.position);
  }
  return pads.size;
}

describe('GPIO availability check (skipGpioMapping)', () => {
  // h755i is the interesting one: 133 assignable pins but only 128 GPIO-capable
  // pads — the 5 `_C` analog pads used to be counted as free GPIOs.
  for (const folder of ['g474', 'f405v', 'h755i']) {
    describe(folder, () => {
      const mcu = load(folder);
      const cap = gpioCapacity(mcu);

      it('accepts exactly the capacity and rejects one more', () => {
        expect(cap).toBeGreaterThan(0);
        expect(solveCount(mcu, gpioPort(cap)), `${cap} GPIOs should fit`).toBeGreaterThan(0);
        expect(solveCount(mcu, gpioPort(cap + 1)), `${cap + 1} GPIOs must not fit`).toBe(0);
      });

      it('subtracts pins taken by peripherals', () => {
        const uart = `port U:
  channel TX = USART*_TX $u
  channel RX = USART*_RX $u

`;
        // The UART eats 2 pads, so cap-2 still fits but cap-1 does not.
        expect(solveCount(mcu, uart + gpioPort(cap - 2))).toBeGreaterThan(0);
        expect(solveCount(mcu, uart + gpioPort(cap - 1))).toBe(0);
      });

      it('subtracts reserved pins', () => {
        expect(solveCount(mcu, `reserve: PA0, PA1, PA2\n\n${gpioPort(cap - 2)}`)).toBe(0);
      });
    });
  }

  it('counts only GPIO-capable pads, not every assignable pin', () => {
    const mcu = load('h755i');
    const assignable = mcu.logicalPins.filter(p => p.isAssignable).length;
    const cap = gpioCapacity(mcu);
    expect(cap).toBeLessThan(assignable); // the `_C` pads make these differ
    // Regression: a request between the two used to slip through.
    expect(solveCount(mcu, gpioPort(cap + 1))).toBe(0);
    expect(solveCount(mcu, gpioPort(assignable))).toBe(0);
  });

  // VREF+ is `Type="MonoIO"` in CubeMX: assignable (it can carry VREFBUF_OUT)
  // but it is NOT a GPIO, so it must not count toward the IN/OUT budget.
  it('excludes MonoIO pins like VREF+ from the GPIO budget', () => {
    for (const folder of ['g474', 'h755i']) {
      const mcu = load(folder);
      const vref = mcu.logicalPins.find(p => p.name.startsWith('VREF+'));
      expect(vref, `${folder} has a VREF+ pin`).toBeDefined();
      expect(vref!.type).toBe('MonoIO');
      expect(vref!.isAssignable).toBe(true); // usable for VREFBUF_OUT
      expect(vref!.signals.some(s => s.peripheralType === 'GPIO'),
        `${folder} VREF+ must not be GPIO-capable`).toBe(false);
      // …and therefore not part of the budget.
      const pads = new Set(mcu.logicalPins
        .filter(p => p.isAssignable && p.signals.some(s => s.peripheralType === 'GPIO'))
        .map(p => p.physical.position));
      expect(pads.has(vref!.physical.position)).toBe(false);
    }
  });
});

// A skipped GPIO channel can still be pin-restricted (`@ PA0, PA1`, `@ !PB1`).
// A bare count is then not enough: the restricted channels also need a system
// of distinct representatives (Hall's condition).
describe('pin-restricted GPIO channels (skipGpioMapping)', () => {
  const mcu = load('g474');
  const both = (src: string) => [true, false].map(skipGpioMapping =>
    solveConstraints(parseConstraints(src).ast!, mcu, {
      maxSolutions: 3, timeoutMs: 5000, costWeights: new Map(), skipGpioMapping,
    }).solutions.length);

  it('rejects more restricted channels than their shared pins (pigeonhole)', () => {
    const three = `port P:
  channel A @ PA0, PA1 = OUT
  channel B @ PA0, PA1 = OUT
  channel C @ PA0, PA1 = OUT`;
    expect(both(three)).toEqual([0, 0]); // infeasible whether skipped or solved
  });

  it('accepts exactly as many restricted channels as pins', () => {
    const two = `port P:
  channel A @ PA0, PA1 = OUT
  channel B @ PA0, PA1 = OUT`;
    for (const n of both(two)) expect(n).toBeGreaterThan(0);
  });

  it('rejects a restricted channel whose only pad is already taken', () => {
    const taken = `pin PA0 = USART2_TX

port P:
  channel A @ PA0 = OUT`;
    expect(both(taken)).toEqual([0, 0]);
  });

  it('honours `@ !pin` exclusions when counting the domain', () => {
    // B is pushed off PA1, so A/B/C compete for PA0+PA1 with one seat gone.
    const excl = `port P:
  channel A @ PA0, PA1 = OUT
  channel B @ PA0, PA1, !PA1 = OUT
  channel C @ PA0, PA1 = OUT`;
    expect(both(excl)).toEqual([0, 0]);
  });

  it('does not charge solved GPIO channels against the leftover-pad budget', () => {
    // Regression: with skipGpioMapping off these pins are already in the
    // solution and must not be counted a second time.
    const src = `port P:
  channel A @ PA0 = OUT
  channel B @ PB0 = OUT`;
    for (const n of both(src)) expect(n).toBeGreaterThan(0);
  });
});

// The "N/M pins (X free)" summary and the package viewer must treat CubeMX
// MonoIO pads (VREF+, DNU, PDR_ON, NJTRST, MP1 DDR bus) as power-like: they
// are fixed-function, not part of the spendable I/O budget.
describe('general-purpose pin count (MonoIO excluded)', () => {
  it('STM32G474CCUx UFQFPN48 has 42 usable pins, not 43', () => {
    const mcu = parseMcuXml(
      readFileSync(join(__dirname, 'all/mcu/STM32G474C(B-C-E)Ux.xml'), 'utf-8'),
    );
    expect(mcu.package).toBe('UFQFPN48');
    const assignable = mcu.logicalPins.filter(p => p.isAssignable).length;
    const usable = mcu.logicalPins.filter(isGeneralPurposePin).length;
    expect(assignable).toBe(43);  // includes VREF+
    expect(usable).toBe(42);      // 48 pins − VBAT, VREF+, VDDA, 3×VDD
    // …and it agrees with the solver's GPIO budget.
    expect(gpioCapacity(mcu)).toBe(42);
  });

  it('a MonoIO pin is excluded but keeps its dedicated signal mappable', () => {
    const mcu = parseMcuXml(
      readFileSync(join(__dirname, 'all/mcu/STM32G474C(B-C-E)Ux.xml'), 'utf-8'),
    );
    const vref = mcu.logicalPins.find(p => p.name.startsWith('VREF+'))!;
    expect(isGeneralPurposePin(vref)).toBe(false); // not spendable I/O
    expect(vref.isAssignable).toBe(true);          // VREFBUF_OUT still mappable
    expect(vref.signals.map(s => s.name)).toContain('VREFBUF_OUT');
  });
});

// A real-world constraint set that does not fit a 48-pin package. Guards
// against the whole pipeline (search + GPIO budget) silently accepting it.
describe('pin_count_fail fixture must not yield solutions', () => {
  const mcu = parseMcuXml(
    readFileSync(join(__dirname, 'all/mcu/STM32G474C(B-C-E)Ux.xml'), 'utf-8'),
  );
  const src = readFileSync(join(__dirname, 'fixtures/pin_count_fail.txt'), 'utf-8');

  it('is rejected with skipGpioMapping on and off', () => {
    expect(mcu.package).toBe('UFQFPN48');
    const { ast, errors } = parseConstraints(src);
    expect(errors.filter(e => e.message)).toHaveLength(0);
    for (const skipGpioMapping of [true, false]) {
      const r = solveConstraints(ast!, mcu, {
        maxSolutions: 3, timeoutMs: 8000, costWeights: new Map(), skipGpioMapping,
      });
      expect(r.solutions.length, `skipGpioMapping=${skipGpioMapping}`).toBe(0);
    }
  });
});
