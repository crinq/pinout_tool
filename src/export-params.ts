// ============================================================
// User-definable parameters for export functions.
//
// A parameter is declared as a comment line inside the export function's
// code (built-in file or custom editor code — same syntax, and the code
// stays the single source of truth):
//
//   // param: <key> <type> = <default> | <Label> | <doc string>
//   // param: fmt enum(csv,tsv,md) = csv | Format | Output format of the table
//   // param: sep string = , | Separator | Column separator character
//   // param: header bool = true | Header row | Include a header row
//   // param: width int = 20 | Column width | Pad columns to this many chars
//
// At run time the values are passed to the function as the `params`
// argument ({ key: value }); the latest values are persisted per function
// id in localStorage so an export re-runs with the user's last choices.
// ============================================================

export type ExportParamType = 'bool' | 'string' | 'enum' | 'int' | 'float';

export interface ExportParam {
  key: string;
  type: ExportParamType;
  /** Allowed values, enum type only. */
  options?: string[];
  default: boolean | string | number;
  /** Display name shown next to the input. */
  label: string;
  /** Shown as the input's tooltip. */
  doc: string;
}

export type ExportParamValues = Record<string, boolean | string | number>;

const PARAM_RE = /^\/\/\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s+(bool|string|enum|int|float)\s*(?:\(([^)]*)\))?\s*=\s*([^|]*)\|([^|]*)\|(.*)$/;

/** Coerce a raw default/stored value to the parameter's type, or null if invalid. */
export function coerceParamValue(param: ExportParam, raw: unknown): boolean | string | number | null {
  switch (param.type) {
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return null;
    case 'int': {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      return Number.isInteger(n) ? n : null;
    }
    case 'float': {
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
      return Number.isFinite(n) ? n : null;
    }
    case 'enum':
      return typeof raw === 'string' && param.options?.includes(raw) ? raw : null;
    case 'string':
      return typeof raw === 'string' ? raw : null;
  }
}

/**
 * Parse every `// param:` line out of an export function's code.
 * Malformed lines are skipped (they are just comments to the executor);
 * a line with an invalid default falls back to a type-appropriate zero value.
 */
export function parseExportParams(code: string): ExportParam[] {
  const out: ExportParam[] = [];
  const seen = new Set<string>();
  for (const line of code.split('\n')) {
    const m = PARAM_RE.exec(line.trim());
    if (!m) continue;
    const [, key, type, optionsRaw, defRaw, labelRaw, docRaw] = m;
    if (seen.has(key)) continue;
    seen.add(key);
    const options = type === 'enum'
      ? (optionsRaw ?? '').split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    if (type === 'enum' && (!options || options.length === 0)) continue;
    const param: ExportParam = {
      key,
      type: type as ExportParamType,
      options,
      default: false,
      label: labelRaw.trim() || key,
      doc: docRaw.trim(),
    };
    const def = coerceParamValue(param, defRaw.trim());
    param.default = def ?? (type === 'bool' ? false : type === 'string' ? '' : type === 'enum' ? options![0] : 0);
    out.push(param);
  }
  return out;
}

/** Defaults of a parameter list as a values object. */
export function defaultParamValues(params: ExportParam[]): ExportParamValues {
  const out: ExportParamValues = {};
  for (const p of params) out[p.key] = p.default;
  return out;
}

const storageKey = (fnId: string): string => `export-params:${fnId}`;

/**
 * Last-used values for one export function, merged over the declared
 * defaults. Stored values that no longer fit the declaration (renamed key,
 * changed type, removed enum option) are dropped silently.
 */
export function loadParamValues(fnId: string, params: ExportParam[]): ExportParamValues {
  const values = defaultParamValues(params);
  try {
    const raw = localStorage.getItem(storageKey(fnId));
    if (!raw) return values;
    const stored = JSON.parse(raw) as Record<string, unknown>;
    for (const p of params) {
      const v = coerceParamValue(p, stored[p.key]);
      if (v !== null) values[p.key] = v;
    }
  } catch { /* corrupt / unavailable storage → defaults */ }
  return values;
}

export function saveParamValues(fnId: string, values: ExportParamValues): void {
  try {
    localStorage.setItem(storageKey(fnId), JSON.stringify(values));
  } catch { /* storage full — the run still works, just not remembered */ }
}
