// ============================================================
// Application settings: shape, factory defaults, named presets, and the
// `settings:` constraint-block overrides.
// ============================================================

import type { ProgramNode, SettingsDeclNode, SettingValue } from './parser/constraint-ast';

export interface AppSettings {
  maxSolutions: number;
  solverTimeoutMs: number;
  solverTypes: string[];
  maxGroups: number;
  maxSolutionsPerGroup: number;
  numRestarts: number;
  costWeights: Record<string, number>;
  minZoom: number;
  maxZoom: number;
  mouseZoomGain: number;
  skipGpioMapping: boolean;
  postOptimize: boolean;
  squaredCosts: boolean;
  dataInspector: boolean;
  dynamicTimeoutMultiplier: number;
  solverDebugOverlay: boolean;
  urlEncoding: 'none' | 'constraints' | 'constraints-mcu' | 'full';
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxSolutions: 2600,
  solverTimeoutMs: 2500,
  dynamicTimeoutMultiplier: 3,
  solverTypes: ['two-phase', 'cost-guided', 'priority-backtracking', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'dynamic-mrv', 'adaptive'],
  maxGroups: 250,
  maxSolutionsPerGroup: 100,
  numRestarts: 150,
  costWeights: {
    pin_count: 1,
    port_spread: 0.2,
    peripheral_count: 0.5,
    debug_pin_penalty: 0.0,
    pin_clustering: 0.0,
    pin_proximity: 1,
    pin_anchor: 1,
    optional_fulfillment: 5,
  },
  minZoom: 0.5,
  maxZoom: 2,
  mouseZoomGain: 0.025,
  skipGpioMapping: true,
  postOptimize: false,
  squaredCosts: false,
  dataInspector: false,
  solverDebugOverlay: false,
  urlEncoding: 'none',
};

// ============================================================
// Named presets — `settings from "<name>":`
//
// "default" is the factory configuration above. Tune "complex" freely; it is
// meant for hard problems where the default budget gives up too early.
// ============================================================

export const SETTINGS_PRESETS: Record<string, Partial<AppSettings>> = {
  default: {},
  complex: {
    solverTimeoutMs: 5000,
    dynamicTimeoutMultiplier: 3,
    solverTypes: ['two-phase', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'conflict-directed', 'cegar', 'lns-repair', 'adaptive'],
    numRestarts: 400,
  },
};

// ============================================================
// `settings:` block → effective settings for one solve
// ============================================================

/**
 * Keys accepted inside a `settings:` block, mapped to the AppSettings field
 * they drive. Cost-function weights are handled separately (any key matching a
 * registered cost function id sets that weight).
 */
const SETTING_KEYS: Record<string, keyof AppSettings> = {
  timeout: 'solverTimeoutMs',
  solver_timeout: 'solverTimeoutMs',
  dynamic_timeout: 'dynamicTimeoutMultiplier',
  solvers: 'solverTypes',
  max_solutions: 'maxSolutions',
  max_groups: 'maxGroups',
  max_solutions_per_group: 'maxSolutionsPerGroup',
  num_restarts: 'numRestarts',
  skip_gpio_mapping: 'skipGpioMapping',
  post_optimize: 'postOptimize',
  squared_costs: 'squaredCosts',
};

export interface SettingsOverrideResult {
  settings: AppSettings;
  /** Human-readable problems (unknown key, wrong value type) — surfaced as warnings. */
  errors: string[];
  /** True when the constraints actually contained a `settings:` block. */
  applied: boolean;
}

const asBool = (v: SettingValue): boolean | null =>
  typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : null;

/**
 * Fold every `settings:` block in the program over `current`, returning the
 * settings this run should use. A block with `from "<preset>"` restarts from
 * that preset instead of the current settings.
 */
export function applySettingsOverrides(
  ast: ProgramNode,
  current: AppSettings,
  costFunctionIds: Set<string>,
): SettingsOverrideResult {
  const blocks = ast.statements.filter((s): s is SettingsDeclNode => s.type === 'settings_decl');
  // Always hand back a copy: the caller treats the result as scratch for one
  // run (the dynamic-timeout retry writes to it) and must not touch the
  // user's saved settings.
  const copy = (): AppSettings => ({ ...current, costWeights: { ...current.costWeights } });
  if (blocks.length === 0) return { settings: copy(), errors: [], applied: false };

  const errors: string[] = [];
  let out: AppSettings = copy();

  for (const block of blocks) {
    if (block.preset !== undefined) {
      const preset = SETTINGS_PRESETS[block.preset];
      if (!preset) {
        errors.push(`Line ${block.loc.line}: unknown settings preset "${block.preset}" (have: ${Object.keys(SETTINGS_PRESETS).join(', ')})`);
      } else {
        out = {
          ...DEFAULT_SETTINGS, ...preset,
          costWeights: { ...DEFAULT_SETTINGS.costWeights, ...preset.costWeights },
        };
      }
    }

    for (const entry of block.entries) {
      const { key, value, loc } = entry;

      // Cost-function weight, e.g. `pin_proximity: 5`
      if (costFunctionIds.has(key)) {
        if (typeof value !== 'number') {
          errors.push(`Line ${loc.line}: ${key} expects a number`);
          continue;
        }
        out.costWeights = { ...out.costWeights, [key]: value };
        continue;
      }

      const field = SETTING_KEYS[key];
      if (!field) {
        errors.push(`Line ${loc.line}: unknown setting "${key}"`);
        continue;
      }

      if (field === 'solverTypes') {
        if (!Array.isArray(value)) {
          errors.push(`Line ${loc.line}: solvers expects quoted names, e.g. solvers: "mrv-group", "hybrid"`);
          continue;
        }
        out.solverTypes = value;
        continue;
      }

      if (typeof out[field] === 'boolean') {
        const b = asBool(value);
        if (b === null) {
          errors.push(`Line ${loc.line}: ${key} expects 0/1 or true/false`);
          continue;
        }
        (out as unknown as Record<string, unknown>)[field] = b;
        continue;
      }

      if (typeof value !== 'number') {
        errors.push(`Line ${loc.line}: ${key} expects a number`);
        continue;
      }
      (out as unknown as Record<string, unknown>)[field] = value;
    }
  }

  return { settings: out, errors, applied: true };
}

// ============================================================
// Export: settings → a `settings:` block for the constraints file
// ============================================================

/**
 * Render the solver-relevant settings as a `settings:` block that
 * `applySettingsOverrides` reads back verbatim (round-trips).
 */
export function formatSettingsBlock(s: AppSettings): string {
  const bool = (b: boolean) => (b ? '1' : '0');
  const num = (n: number) => String(Number(n.toFixed(4)));
  const lines = [
    'settings:',
    `  timeout: ${num(s.solverTimeoutMs)}ms`,
    `  dynamic_timeout: ${num(s.dynamicTimeoutMultiplier)}`,
    `  solvers: ${s.solverTypes.map(t => `"${t}"`).join(', ')}`,
    `  max_solutions: ${num(s.maxSolutions)}`,
    `  max_groups: ${num(s.maxGroups)}`,
    `  max_solutions_per_group: ${num(s.maxSolutionsPerGroup)}`,
    `  num_restarts: ${num(s.numRestarts)}`,
    `  skip_gpio_mapping: ${bool(s.skipGpioMapping)}`,
    `  post_optimize: ${bool(s.postOptimize)}`,
    `  squared_costs: ${bool(s.squaredCosts)}`,
  ];
  for (const [id, w] of Object.entries(s.costWeights)) {
    lines.push(`  ${id}: ${num(w)}`);
  }
  return lines.join('\n');
}

/**
 * Put `block` into `text`, replacing an existing top-level `settings:` block
 * (with or without `from "…"`) or prepending it when there is none.
 */
export function upsertSettingsBlock(text: string, block: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^settings\b/.test(l));
  if (start === -1) {
    const sep = text.trim() === '' ? '' : '\n';
    return `${block}\n${sep}${text}`;
  }
  // The block runs until the next column-0 statement.
  let end = start + 1;
  while (end < lines.length && !(/^\S/.test(lines[end]) && lines[end].trim() !== '')) end++;
  // Keep one blank line after the block if the original had one.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(start, end - start, ...block.split('\n'));
  return lines.join('\n');
}
