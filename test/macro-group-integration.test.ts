import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseConstraints } from '../src/parser/constraint-parser';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { solveConstraints } from '../src/solver/solver';
import { getActiveAnchors, computeTotalCost } from '../src/solver/cost-functions';
import type { Solution } from '../src/types';

const mcu = parseMcuXml(readFileSync(join(__dirname, 'g474/STM32G474R(B-C-E)Tx.xml'), 'utf-8'));

/**
 * The two features together, end to end: a macro that declares its own
 * channels with pasted names, called once per power rail inside a `group`
 * that steers where those pins land.
 */
const SRC = `macro efused(NAME):
  channel \${NAME}_EN    = OUT
  channel \${NAME}_PGOOD = IN
  channel \${NAME}_SNS
  adc(\${NAME}_SNS)

port PWR:
  group "rail_3v3": @ ~NW
    efused(VBUS)
  group "rail_1v8": @ ~SE
    efused(VDDA)

port CMD:
  channel TX
  channel RX
  config "uart":
    uart_port(TX, RX)
`;

const CHANNELS = [
  'PWR.VBUS_EN', 'PWR.VBUS_PGOOD', 'PWR.VBUS_SNS',
  'PWR.VDDA_EN', 'PWR.VDDA_PGOOD', 'PWR.VDDA_SNS',
  'CMD.TX', 'CMD.RX',
];

/** A solution placing rail_3v3 on `a` and rail_1v8 on `b`. */
function handBuilt(a: string[], b: string[]): Solution {
  const pins: Array<[string, string]> = [
    ['VBUS_EN', a[0]], ['VBUS_PGOOD', a[1]], ['VBUS_SNS', a[2]],
    ['VDDA_EN', b[0]], ['VDDA_PGOOD', b[1]], ['VDDA_SNS', b[2]],
  ];
  return {
    id: 0,
    mcuRef: mcu.refName,
    configAssignments: [{
      configCombination: new Map([['PWR', 'PWR']]),
      assignments: pins.map(([channelName, pinName]) => ({
        pinName, signalName: 'GPIO', portName: 'PWR', channelName, configurationName: 'PWR',
      })),
    }],
    portPeripherals: new Map(),
    costs: new Map(),
    totalCost: 0,
    gpioCount: pins.length,
    optionalTotal: 0,
    optionalFulfilled: 0,
  } as Solution;
}

function pinsByChannel(sol: Solution): Map<string, string> {
  return new Map(
    sol.configAssignments
      .flatMap(ca => ca.assignments)
      .map(a => [`${a.portName}.${a.channelName}`, a.pinName]),
  );
}

describe('macros and groups, end to end', () => {
  it('expands macro-declared channels and solves them on a real MCU', () => {
    const parsed = parseConstraints(SRC);
    expect(parsed.errors.map(e => `L${e.line}: ${e.message}`)).toEqual([]);

    const result = solveConstraints(parsed.ast!, mcu, {
      maxSolutions: 50, timeoutMs: 10000, skipGpioMapping: false,
    });
    expect(result.errors.filter(e => e.type === 'error').map(e => e.message)).toEqual([]);
    expect(result.solutions.length).toBeGreaterThan(0);

    const pins = pinsByChannel(result.solutions[0]);
    for (const ch of CHANNELS) expect(pins.has(ch), ch).toBe(true);
    // Every channel got a distinct pin.
    expect(new Set(pins.values()).size).toBe(pins.size);
  });

  it('routes the _SNS channels through the stdlib adc() macro', () => {
    const parsed = parseConstraints(SRC);
    const result = solveConstraints(parsed.ast!, mcu, {
      maxSolutions: 50, timeoutMs: 10000, skipGpioMapping: false,
    });
    const signals = new Map(
      result.solutions[0].configAssignments
        .flatMap(ca => ca.assignments)
        .map(a => [`${a.portName}.${a.channelName}`, a.signalName]),
    );
    expect(signals.get('PWR.VBUS_SNS')).toMatch(/ADC\d+_IN/);
    expect(signals.get('PWR.VDDA_SNS')).toMatch(/ADC\d+_IN/);
    expect(signals.get('CMD.TX')).toMatch(/USART|UART/);
  });

  it('ranks a solution that honours the group anchors above one that inverts them', () => {
    // Search order alone does not prove the anchors work — the backtracker
    // enumerates its last variables first and can exhaust maxSolutions before
    // it ever varies the earlier ones. What the feature actually promises is a
    // ranking, so compare two placements directly under the same weights.
    const parsed = parseConstraints(SRC);
    solveConstraints(parsed.ast!, mcu, { maxSolutions: 1, timeoutMs: 5000, skipGpioMapping: false });
    const anchors = getActiveAnchors()!;
    expect(anchors.groupOfChannel.get('PWR\0VBUS_EN')).toBe('rail_3v3');
    expect(anchors.groupOfChannel.get('PWR\0VDDA_EN')).toBe('rail_1v8');

    // PC13/PC14/PC15 sit at the north-west of this LQFP64; PB4/PB5/PB6 at the
    // south-east. `rail_3v3` is anchored NW and `rail_1v8` SE.
    const NW = ['PC13', 'PC14', 'PC15'];
    const SE = ['PB4', 'PB5', 'PB6'];
    const weights = new Map([['pin_anchor', 4], ['pin_group_clustering', 2]]);

    const honoured = handBuilt(NW, SE);
    const inverted = handBuilt(SE, NW);
    computeTotalCost(honoured, mcu, weights);
    computeTotalCost(inverted, mcu, weights);

    expect(honoured.totalCost).toBeLessThan(inverted.totalCost);
  });

  it('sorts the solutions it returns by total cost', () => {
    const parsed = parseConstraints(SRC);
    const result = solveConstraints(parsed.ast!, mcu, {
      maxSolutions: 100, timeoutMs: 10000, skipGpioMapping: false,
      costWeights: new Map([['pin_count', 1], ['pin_anchor', 4], ['pin_group_clustering', 2]]),
    });
    const costs = result.solutions.map(s => s.totalCost);
    expect(costs.length).toBeGreaterThan(1);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });
});
