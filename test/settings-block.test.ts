import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import type { ProgramNode, SettingsDeclNode } from '../src/parser/constraint-ast';
import { applySettingsOverrides, DEFAULT_SETTINGS, SETTINGS_PRESETS, formatSettingsBlock, upsertSettingsBlock } from '../src/settings';
import { getAllCostFunctions } from '../src/solver/cost-functions';

const COST_IDS = new Set(getAllCostFunctions().map(f => f.id));

function parseOk(src: string): ProgramNode {
  const r = parseConstraints(src);
  expect(r.errors, r.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  return r.ast!;
}
const settingsOf = (src: string) => parseOk(src).statements.find(s => s.type === 'settings_decl') as SettingsDeclNode;
const apply = (src: string, base = DEFAULT_SETTINGS) =>
  applySettingsOverrides(parseOk(src), base, COST_IDS);

describe('settings block — parsing', () => {
  it('parses numbers, time units, booleans and solver lists', () => {
    const s = settingsOf(`settings:
  skip_gpio_mapping: 1
  solvers: "mrv-group", "hybrid"
  timeout: 3000ms
  pin_proximity: 5`);
    expect(s.preset).toBeUndefined();
    expect(s.entries.map(e => [e.key, e.value])).toEqual([
      ['skip_gpio_mapping', 1],
      ['solvers', ['mrv-group', 'hybrid']],
      ['timeout', 3000],
      ['pin_proximity', 5],
    ]);
  });

  it('normalises `s` to milliseconds and accepts decimals / true / false', () => {
    const s = settingsOf(`settings:
  timeout: 3s
  post_optimize: true
  squared_costs: false
  pin_anchor: 0.5`);
    expect(s.entries.map(e => e.value)).toEqual([3000, true, false, 0.5]);
  });

  it('parses `from "preset"` with and without a body', () => {
    expect(settingsOf('settings from "default":\n  timeout: 5s').preset).toBe('default');
    const bare = settingsOf('settings from "complex":');
    expect(bare.preset).toBe('complex');
    expect(bare.entries).toEqual([]);
  });

  it('rejects a bodyless block with no preset', () => {
    expect(parseConstraints('settings:').errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-value', () => {
    expect(parseConstraints('settings:\n  timeout: ?').errors.length).toBeGreaterThan(0);
  });
});

describe('settings block — applying', () => {
  it('is a no-op (but a copy) with no block', () => {
    const r = apply('port P:\n  channel A = OUT');
    expect(r.applied).toBe(false);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
    expect(r.settings).not.toBe(DEFAULT_SETTINGS);          // never aliases the caller's object
    expect(r.settings.costWeights).not.toBe(DEFAULT_SETTINGS.costWeights);
  });

  it('overrides plain fields, booleans, timeouts and solver lists', () => {
    const r = apply(`settings:
  skip_gpio_mapping: 0
  solvers: "mrv-group", "hybrid"
  timeout: 3s
  max_solutions: 40`);
    expect(r.errors).toEqual([]);
    expect(r.settings.skipGpioMapping).toBe(false);
    expect(r.settings.solverTypes).toEqual(['mrv-group', 'hybrid']);
    expect(r.settings.solverTimeoutMs).toBe(3000);
    expect(r.settings.maxSolutions).toBe(40);
    // untouched fields keep their value
    expect(r.settings.numRestarts).toBe(DEFAULT_SETTINGS.numRestarts);
  });

  it('sets cost-function weights by their id', () => {
    const r = apply('settings:\n  pin_proximity: 5\n  pin_anchor: 0');
    expect(r.errors).toEqual([]);
    expect(r.settings.costWeights.pin_proximity).toBe(5);
    expect(r.settings.costWeights.pin_anchor).toBe(0);
    expect(r.settings.costWeights.pin_count).toBe(DEFAULT_SETTINGS.costWeights.pin_count);
  });

  it('`from "default"` restarts from factory settings, then overrides', () => {
    const current = { ...DEFAULT_SETTINGS, maxSolutions: 7, solverTimeoutMs: 99 };
    const r = apply('settings from "default":\n  timeout: 5s', current);
    expect(r.settings.maxSolutions).toBe(DEFAULT_SETTINGS.maxSolutions); // reset, not 7
    expect(r.settings.solverTimeoutMs).toBe(5000);                       // then overridden
  });

  it('`from "complex"` loads the complex preset', () => {
    const r = apply('settings from "complex":');
    expect(r.applied).toBe(true);
    expect(r.settings.solverTimeoutMs).toBe(SETTINGS_PRESETS.complex.solverTimeoutMs);
    expect(r.settings.solverTypes).toEqual(SETTINGS_PRESETS.complex.solverTypes);
  });

  it('reports unknown settings, unknown presets and wrong value types', () => {
    expect(apply('settings:\n  nonsense: 1').errors[0]).toMatch(/unknown setting "nonsense"/);
    expect(apply('settings from "nope":').errors[0]).toMatch(/unknown settings preset "nope"/);
    expect(apply('settings:\n  solvers: 3').errors[0]).toMatch(/solvers expects quoted names/);
    expect(apply('settings:\n  timeout: "fast"').errors[0]).toMatch(/timeout expects a number/);
  });

  it('leaves the caller\'s settings object untouched', () => {
    const current = { ...DEFAULT_SETTINGS, costWeights: { ...DEFAULT_SETTINGS.costWeights } };
    apply('settings:\n  timeout: 9s\n  pin_proximity: 42', current);
    expect(current.solverTimeoutMs).toBe(DEFAULT_SETTINGS.solverTimeoutMs);
    expect(current.costWeights.pin_proximity).toBe(DEFAULT_SETTINGS.costWeights.pin_proximity);
  });

  it('later blocks fold onto earlier ones', () => {
    const r = apply('settings:\n  timeout: 1s\n\nsettings:\n  max_groups: 5');
    expect(r.settings.solverTimeoutMs).toBe(1000);
    expect(r.settings.maxGroups).toBe(5);
  });
});

describe('settings export', () => {
  it('round-trips: the exported block parses back to the same settings', () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      solverTimeoutMs: 7500,
      solverTypes: ['mrv-group', 'hybrid'],
      maxSolutions: 42,
      skipGpioMapping: false,
      postOptimize: true,
      squaredCosts: true,
      costWeights: { ...DEFAULT_SETTINGS.costWeights, pin_proximity: 5, pin_anchor: 0.25 },
    };
    const block = formatSettingsBlock(custom);
    const r = apply(block, DEFAULT_SETTINGS);
    expect(r.errors).toEqual([]);
    for (const k of ['solverTimeoutMs', 'maxSolutions', 'maxGroups', 'maxSolutionsPerGroup',
                     'numRestarts', 'dynamicTimeoutMultiplier', 'skipGpioMapping',
                     'postOptimize', 'squaredCosts'] as const) {
      expect(r.settings[k], k).toEqual(custom[k]);
    }
    expect(r.settings.solverTypes).toEqual(custom.solverTypes);
    expect(r.settings.costWeights).toEqual(custom.costWeights);
  });

  it('writes the timeout with a unit and booleans as 0/1', () => {
    const block = formatSettingsBlock({ ...DEFAULT_SETTINGS, solverTimeoutMs: 2500, skipGpioMapping: true, postOptimize: false });
    expect(block).toContain('  timeout: 2500ms');
    expect(block).toContain('  skip_gpio_mapping: 1');
    expect(block).toContain('  post_optimize: 0');
    expect(block.startsWith('settings:\n')).toBe(true);
  });
});

describe('upsertSettingsBlock', () => {
  const BLOCK = 'settings:\n  timeout: 1000ms';

  it('prepends when the file has no block', () => {
    expect(upsertSettingsBlock('port P:\n  channel A = OUT', BLOCK))
      .toBe('settings:\n  timeout: 1000ms\n\nport P:\n  channel A = OUT');
  });

  it('handles an empty file', () => {
    expect(upsertSettingsBlock('', BLOCK)).toBe('settings:\n  timeout: 1000ms\n');
  });

  it('replaces an existing block, keeping the rest intact', () => {
    const before = `settings:
  timeout: 9s
  max_groups: 3

port P:
  channel A = OUT`;
    const after = upsertSettingsBlock(before, BLOCK);
    expect(after).toBe(`settings:
  timeout: 1000ms

port P:
  channel A = OUT`);
    // and it still parses
    expect(parseConstraints(after).errors).toHaveLength(0);
  });

  it('replaces a `from "preset"` block too', () => {
    const before = 'settings from "complex":\n  timeout: 9s\n\nport P:\n  channel A = OUT';
    const after = upsertSettingsBlock(before, BLOCK);
    expect(after).not.toContain('complex');
    expect(after).toContain('port P:');
  });
});

describe('presets must not clobber app/UI settings', () => {
  it('settings from "complex" keeps debug overlay, zoom and URL encoding', () => {
    const base = {
      ...DEFAULT_SETTINGS,
      costWeights: { ...DEFAULT_SETTINGS.costWeights },
      solverDebugOverlay: true,
      minZoom: 0.25,
      maxZoom: 4,
      mouseZoomGain: 0.05,
      touchGestures: false,
      dataInspector: true,
      urlEncoding: 'full' as const,
    };
    const r = applySettingsOverrides(parseOk('settings from "complex":\n'), base, COST_IDS);
    expect(r.errors).toEqual([]);
    // solver settings come from the preset / factory defaults…
    expect(r.settings.solverTimeoutMs).toBe(SETTINGS_PRESETS.complex.solverTimeoutMs);
    expect(r.settings.numRestarts).toBe(SETTINGS_PRESETS.complex.numRestarts);
    // …but app/UI settings survive untouched.
    expect(r.settings.solverDebugOverlay).toBe(true);
    expect(r.settings.minZoom).toBe(0.25);
    expect(r.settings.maxZoom).toBe(4);
    expect(r.settings.mouseZoomGain).toBe(0.05);
    expect(r.settings.touchGestures).toBe(false);
    expect(r.settings.dataInspector).toBe(true);
    expect(r.settings.urlEncoding).toBe('full');
  });
});
