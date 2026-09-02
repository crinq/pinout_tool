// Regression tests for the solver-layer bugs found in the 2026-09 audit
// (ai_docs/report.md #22–#33). One describe block per bug.
//
// Fixture facts (test/f405v, LQFP100): USART1_TX on PA9(pos 68) / PB6(92),
// USART2_TX on PA2(25) / PD5(86). Circular pin distances: 68↔25=43,
// 68↔86=18, 92↔25=33, 92↔86=6.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints, parseExpressionString } from '../src/parser/constraint-parser';
import {
  solveConstraints, hasPortWipeout, extractPeripherals, evaluateExpr,
} from '../src/solver/solver';
import { solveTwoPhase } from '../src/solver/two-phase-solver';
import { solveMrvGroup } from '../src/solver/mrv-group-solver';
import { solveHybrid } from '../src/solver/hybrid-solver';
import { solveDiverseInstances } from '../src/solver/diverse-solver';
import { solvePriorityTwoPhase } from '../src/solver/priority-two-phase-solver';
import { solvePriorityGroup } from '../src/solver/priority-group-solver';
import { solveCegar } from '../src/solver/cegar-solver';
import { solveAC3 } from '../src/solver/ac3-solver';
import { solveCostGuided } from '../src/solver/cost-guided-solver';
import { solveDynamicMRV } from '../src/solver/dynamic-mrv-solver';
import { solveConflictDirected } from '../src/solver/conflict-directed-solver';
import { solveLnsRepair } from '../src/solver/lns-solver';
import { buildVarsByChannel, reconstructAssignments } from '../src/solver/post-optimize';
import type { Mcu, SolverResult } from '../src/types';
import type { ProgramNode } from '../src/parser/constraint-ast';

function load(folder: string): Mcu {
  const dir = join(__dirname, folder);
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.endsWith('_Modes.xml'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

const f405 = load('f405v');
const h755 = load('h755x');

function ast(src: string): ProgramNode {
  const r = parseConstraints(src);
  expect(r.errors, r.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return r.ast!;
}

const SP = { maxSolutions: 50, timeoutMs: 5000, costWeights: new Map<string, number>(), skipGpioMapping: false };
const TP = { maxGroups: 50, maxSolutionsPerGroup: 20, timeoutMs: 5000, costWeights: new Map<string, number>(), skipGpioMapping: false };

const fatal = (r: SolverResult) => r.errors.filter(e => e.type === 'error').map(e => e.message).join('; ');

describe('#22 dynamic-mrv must not emit combos with wiped-out mandatory channels', () => {
  // OTHER consumes PA9+PB6, wiping UART's "alt" config (TX2 restricted to
  // those pins) while "main" stays solvable. The old empty-domain fallback
  // emitted alt combos with TX2 simply missing.
  const src = `port OTHER:
  channel X @ PA9
  channel Y @ PB6
  config "c":
    X = OUT
    Y = OUT

port UART:
  channel TX
  channel TX2 @ PA9, PB6
  config "main":
    TX = USART2_TX
  config "alt":
    TX2 = USART1_TX
`;
  it('emits only complete combos', () => {
    const r = solveDynamicMRV(ast(src), f405, SP);
    expect(r.solutions.length, fatal(r)).toBeGreaterThan(0);
    for (const sol of r.solutions) {
      for (const ca of sol.configAssignments) {
        if (ca.activeConfigs.get('UART') === 'alt') {
          expect(
            ca.assignments.some(a => a.portName === 'UART' && a.channelName === 'TX2'),
            'combo activates UART/alt but has no pin for TX2',
          ).toBe(true);
        }
      }
    }
  });
});

describe('#23 CDS optional-frame spin loop', () => {
  // Y's only candidate always conflicts with X (same pin and same instance),
  // so Y is skipped at every leaf. The old leaf-undo re-skipped the optional
  // frame forever, re-emitting one identical solution until maxSolutions.
  const src = `port A:
  channel X @ PA9, PB6
  config "c":
    X = USART1_TX

port B:
  channel Y @ PA9
  config "c":
    Y ?= USART1_TX
`;
  it('enumerates distinct solutions instead of spinning on one leaf', () => {
    const r = solveConflictDirected(ast(src), f405, SP);
    const pins = new Set(
      r.solutions.map(s => s.configAssignments[0].assignments.find(a => a.channelName === 'X')?.pinName),
    );
    expect([...pins].sort()).toEqual(['PA9', 'PB6']);
    // Old behavior: 50 duplicate emissions (maxSolutions) of the first leaf.
    expect(r.statistics.validSolutions).toBeLessThan(SP.maxSolutions);
  });
});

describe('#24 geometry requires need mcuInfo in every solver', () => {
  const solvers: Array<[string, (a: ProgramNode) => SolverResult]> = [
    ['two-phase', a => solveTwoPhase(a, f405, TP)],
    ['mrv-group', a => solveMrvGroup(a, f405, TP)],
    ['ac3', a => solveAC3(a, f405, SP)],
    ['cost-guided', a => solveCostGuided(a, f405, SP)],
    ['dynamic-mrv', a => solveDynamicMRV(a, f405, SP)],
  ];
  const src = (req: string) => `port P:
  channel A
  channel B
  config "c":
    A = USART1_TX
    B = USART2_TX
    require ${req}
`;
  // All candidate pairs have circular distance ≥ 6 (see header).
  for (const [name, solve] of solvers) {
    it(`${name}: satisfiable distance require finds solutions`, () => {
      const r = solve(ast(src('pin_distance(A, B) > 5')));
      expect(r.solutions.length, fatal(r)).toBeGreaterThan(0);
    });
    it(`${name}: unsatisfiable distance require finds none`, () => {
      // No pair is closer than 6 — the old undefined-mcuInfo evaluation made
      // pin_distance return 0, so "< 5" was vacuously true everywhere.
      const r = solve(ast(src('pin_distance(A, B) < 5')));
      expect(r.solutions.length).toBe(0);
    });
    it(`${name}: tight distance require selects the close pair`, () => {
      const r = solve(ast(src('pin_distance(A, B) < 10')));
      expect(r.solutions.length, fatal(r)).toBeGreaterThan(0);
      for (const sol of r.solutions) {
        const a = sol.configAssignments[0].assignments.find(x => x.channelName === 'A')!;
        const b = sol.configAssignments[0].assignments.find(x => x.channelName === 'B')!;
        expect(a.pinName).toBe('PB6');
        expect(b.pinName).toBe('PD5');
      }
    });
  }
});

describe('#25 hasPortWipeout must not count skippable optionals', () => {
  const mkVars = (opts: Array<{ optional?: boolean }>) => opts.map((o, i) => ({
    portName: 'A', configName: 'c', channelName: `ch${i}`, optional: o.optional,
  })) as never[];
  it('an emptied optional domain does not block the config', () => {
    const variables = mkVars([{}, { optional: true }]);
    const domains = [[0], []];
    expect(hasPortWipeout(variables, domains, () => false)).toBe(false);
  });
  it('an emptied mandatory domain still does', () => {
    const variables = mkVars([{}, {}]);
    const domains = [[0], []];
    expect(hasPortWipeout(variables, domains, () => false)).toBe(true);
  });
});

describe('#26/#30 _C analog-switch coupling end to end', () => {
  // PC2_C carrying a pinned non-ADC signal closes the switch and consumes
  // PC2 (h755x, TFBGA240). Both LNS and CDS must refuse to place anything
  // on PC2 then — and must still allow it when PC2_C carries its own ADC
  // channel (switch open).
  const blocked = `pin PC2_C = SPI2_MISO

port B:
  channel Y @ PC2
  config "c":
    Y = DFSDM1_CKIN1
`;
  const open = `port A:
  channel W @ PC2_C
  config "c":
    W = ADC3_INP0

port B:
  channel Y @ PC2
  config "c":
    Y = DFSDM1_CKIN1
`;
  // LNS is anytime (runs until its deadline) — keep its budget small here.
  const LNS_SP = { ...SP, maxSolutions: 3, timeoutMs: 1000 };
  for (const [name, solve] of [
    ['lns-repair', (a: ProgramNode) => solveLnsRepair(a, h755, LNS_SP)],
    ['conflict-directed', (a: ProgramNode) => solveConflictDirected(a, h755, SP)],
  ] as const) {
    it(`${name}: non-ADC on PC2_C blocks PC2`, () => {
      expect(solve(ast(blocked)).solutions.length).toBe(0);
    });
    it(`${name}: ADC on PC2_C leaves PC2 usable`, () => {
      const r = solve(ast(open));
      expect(r.solutions.length, fatal(r)).toBeGreaterThan(0);
    });
  }
});

describe('#27 optional channels matching nothing must not abort two-phase solvers', () => {
  const src = `port P:
  channel TX
  channel EXTRA
  config "c":
    TX = USART1_TX
    EXTRA ?= FOOBAR9_NOPE
`;
  const solvers: Array<[string, (a: ProgramNode) => SolverResult]> = [
    ['two-phase', a => solveTwoPhase(a, f405, TP)],
    ['mrv-group', a => solveMrvGroup(a, f405, TP)],
    ['hybrid', a => solveHybrid(a, f405, TP)],
    ['diverse-instances', a => solveDiverseInstances(a, f405, TP)],
    ['priority-two-phase', a => solvePriorityTwoPhase(a, f405, TP)],
    ['priority-group', a => solvePriorityGroup(a, f405, TP)],
    ['cegar', a => solveCegar(a, f405, TP)],
  ];
  for (const [name, solve] of solvers) {
    it(`${name}: solves with the optional left unassigned`, () => {
      const r = solve(ast(src));
      expect(fatal(r)).toBe('');
      expect(r.solutions.length).toBeGreaterThan(0);
    });
  }
});

describe('#28 optionals whose candidates all conflict must be skippable', () => {
  // Y's only candidate collides with X on pin and instance. Solvers without
  // a skip branch dead-ended and reported zero solutions.
  const src = `port A:
  channel X @ PA9
  config "c":
    X = USART1_TX

port B:
  channel Y @ PA9
  config "c":
    Y ?= USART1_TX
`;
  const solvers: Array<[string, (a: ProgramNode) => SolverResult]> = [
    ['ac3', a => solveAC3(a, f405, SP)],
    ['cost-guided', a => solveCostGuided(a, f405, SP)],
    ['dynamic-mrv', a => solveDynamicMRV(a, f405, SP)],
    ['backtracking', a => solveConstraints(a, f405, SP)],
  ];
  for (const [name, solve] of solvers) {
    it(`${name}: finds the solution that drops the optional`, () => {
      const r = solve(ast(src));
      expect(r.solutions.length, fatal(r)).toBeGreaterThan(0);
      const sol = r.solutions[0];
      const x = sol.configAssignments[0].assignments.find(a => a.portName === 'A');
      expect(x?.pinName).toBe('PA9');
    });
  }
});

describe('#29 extractPeripherals instance parsing', () => {
  it('keeps I2C1 and I2C2 distinct (prefix regex truncated both to "I2")', () => {
    const res = extractPeripherals([
      { pinName: 'PB7', signalName: 'I2C1_SDA', portName: 'P', channelName: 'a', configurationName: 'c' },
      { pinName: 'PB10', signalName: 'I2C2_SCL', portName: 'P', channelName: 'b', configurationName: 'c' },
      { pinName: 'PA9', signalName: 'USART1_TX', portName: 'P', channelName: 'd', configurationName: 'c' },
    ]);
    expect([...res.get('P')!].sort()).toEqual(['I2C1', 'I2C2', 'USART1']);
  });
});

describe('#31 optional GPIO channels must not count toward the pad budget', () => {
  const gpioCapacity = (mcu: Mcu): number => {
    const pads = new Set<string>();
    for (const p of mcu.logicalPins) {
      if (!p.isAssignable) continue;
      if (!p.signals.some(s => s.peripheralType === 'GPIO')) continue;
      pads.add(p.physical.position);
    }
    return pads.size;
  };
  it('capacity-filling GPIO set plus an optional extra still solves', () => {
    const cap = gpioCapacity(f405);
    const lines = Array.from({ length: cap }, (_, i) => `  channel G${i} = OUT`).join('\n');
    const src = `port P:\n${lines}\n  channel OPT ?= OUT\n`;
    const r = solveConstraints(ast(src), f405, { ...SP, maxSolutions: 2, skipGpioMapping: true });
    expect(r.solutions.length, fatal(r)).toBeGreaterThan(0);
  });
});

describe('#32 post-optimize assignment reconstruction', () => {
  it('matches assignments to variables with augmenting paths, not first-fit', () => {
    const pinA = { name: 'PA0', physical: { position: '1' } };
    const pinB = { name: 'PA1', physical: { position: '2' } };
    const candA = { pin: pinA, signalName: 'TIM1_CH1', peripheralInstance: 'TIM1' };
    const candB = { pin: pinB, signalName: 'TIM1_CH1', peripheralInstance: 'TIM1' };
    // v0 (A|B) listed first, v1 matches only A — first-fit bound A to v0 and
    // dropped the B assignment (v1 has no B candidate).
    const v0 = { portName: 'P', configName: 'c', channelName: 'ch', exprIndex: 0, candidates: [candA, candB] };
    const v1 = { portName: 'P', configName: 'c', channelName: 'ch', exprIndex: 1, candidates: [candA] };
    const varsByChannel = buildVarsByChannel([v0, v1] as never[]);
    const sol = {
      configAssignments: [{
        activeConfigs: new Map([['P', 'c']]),
        assignments: [
          { pinName: 'PA0', signalName: 'TIM1_CH1', portName: 'P', channelName: 'ch', configurationName: 'c' },
          { pinName: 'PA1', signalName: 'TIM1_CH1', portName: 'P', channelName: 'ch', configurationName: 'c' },
        ],
      }],
    };
    const assigned = reconstructAssignments(sol as never, varsByChannel);
    expect(assigned.size).toBe(2);
    expect((assigned.get(v0 as never) as typeof candB).pin.name).toBe('PA1');
    expect((assigned.get(v1 as never) as typeof candA).pin.name).toBe('PA0');
  });
});

describe('#33 QFP row/col orientation matches pin-anchors and real LQFP numbering', () => {
  // Pin 1 is the top-left corner (row 0, col 0); numbering runs down the
  // left edge, so pin 26 on an LQFP100 is the bottom-left corner.
  const evalOn = (expr: string, position: string): number => {
    const parsed = parseExpressionString(expr)!;
    const va = { variable: { channelName: 'A' }, candidate: { pin: { physical: { position } } } };
    const channelInfo = new Map([['P', new Map([['A', [va]]])]]);
    const mcuInfo = { package: 'LQFP100', pinByName: new Map() };
    return evaluateExpr(parsed, 'P', channelInfo as never, undefined, mcuInfo) as number;
  };
  it('pin 1 is at row 0 / col 0', () => {
    expect(evalOn('pin_row(A)', '1')).toBe(0);
    expect(evalOn('pin_col(A)', '1')).toBe(0);
  });
  it('pin 26 is bottom-left (row 25 / col 0)', () => {
    expect(evalOn('pin_row(A)', '26')).toBe(25);
    expect(evalOn('pin_col(A)', '26')).toBe(0);
  });
  it('pin 51 starts the right edge going up', () => {
    expect(evalOn('pin_col(A)', '51')).toBe(25);
    expect(evalOn('pin_row(A)', '51')).toBe(25);
  });
});
