import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { runSingleSolver } from '../src/solver/solver-worker-impl';
import { classifyProjectSolutions } from '../src/solver/solution-status';

// Regression: `shared:` lets ports share an instance, but each signal still
// serves one port. With TIM8 shared, Motor_PWM.CN (TIM8_CH3N on PH15) and
// Safety.brake_pwm (TIM8_CH3N on PB1) got the same signal on two pins.
// F103C8: TIM1_CH1N is on PA7 and PB13.
const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F103C(8-B)Tx.xml'), 'utf-8'));

const SOLVERS = [
  'backtracking', 'cost-guided', 'ac3', 'dynamic-mrv', 'priority-backtracking', 'randomized-restarts',
  'two-phase', 'diverse-instances', 'priority-two-phase', 'priority-diverse',
  'priority-group', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'conflict-directed', 'cegar', 'lns-repair', 'adaptive',
];
const run = (id: string, src: string) => runSingleSolver(id, parseConstraints(src).ast!, mcu,
  { maxSolutions: 10, timeoutMs: 1000, costWeights: new Map() },
  { maxGroups: 20, maxSolutionsPerGroup: 5 }, { numRestarts: 3 }, 'easy');

const PORTS = (brake: string) => `
port PWM:
  channel AN @ PB13 = TIM1_CH1N

port SAFE:
  channel BRK = ${brake}
`;

describe.each(['shared: TIM1', 'shared: TIM* for PWM, SAFE'])('%s', (share) => {
  it.each(SOLVERS)('%s never gives the same signal to two ports', (id) => {
    const r = run(id, `${share}\n${PORTS('TIM1_CH1N | TIM1_CH2N')}`);
    expect(r.solutions.length, r.errors.map(e => e.message).join('; ')).toBeGreaterThan(0);
    for (const s of r.solutions) {
      const brk = s.configAssignments[0].assignments.find(a => a.portName === 'SAFE')!;
      expect(brk.signalName).toBe('TIM1_CH2N');
    }
  });

  it('only that signal: no solution', () => {
    expect(run('backtracking', `${share}\n${PORTS('TIM1_CH1N')}`).solutions).toEqual([]);
  });
});

it('the validity check flags a solution that reuses a signal across ports', () => {
  const ast = parseConstraints(`shared: TIM1\n${PORTS('TIM1_CH1N')}`).ast!;
  const sol = {
    id: 0, mcuRef: mcu.refName, portPeripherals: new Map(), costs: new Map(), totalCost: 0, gpioCount: 0,
    optionalTotal: 0, optionalFulfilled: 0,
    configAssignments: [{
      activeConfigs: new Map([['PWM', 'PWM'], ['SAFE', 'SAFE']]),
      assignments: [
        { pinName: 'PB13', signalName: 'TIM1_CH1N', portName: 'PWM', channelName: 'AN', configurationName: 'PWM' },
        { pinName: 'PA7', signalName: 'TIM1_CH1N', portName: 'SAFE', channelName: 'BRK', configurationName: 'SAFE' },
      ],
    }],
  };
  expect(classifyProjectSolutions([sol], ast, mcu, true).get(sol)?.status).toBe('invalid');
});
