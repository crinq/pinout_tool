import type { Solution, SolverResult, Assignment, ConfigCombinationAssignment, CustomExportFunction } from './types';
import { getKv } from './kv';

// ============================================================
// Serialized Types (JSON-safe, no Map/Set)
// ============================================================

export interface SerializedSolution {
  id: number;
  name?: string;
  mcuRef: string;
  // Compact format: flat list of unique (port, config, channel, pin, signal) entries
  assignments: Assignment[];
  // Legacy format (read-only, not written by new code)
  configAssignments?: {
    activeConfigs: Record<string, string>;
    assignments: Assignment[];
  }[];
  portPeripherals: Record<string, string[]>;
  costs: Record<string, number>;
  totalCost: number;
  gpioCount?: number;
  optionalTotal?: number;
  optionalFulfilled?: number;
}

export interface ProjectVersion {
  id: number;
  timestamp: number;
  constraintText: string;
  mcuRef: string;
  solutions: SerializedSolution[];
}

export interface ProjectData {
  name: string;
  versions: ProjectVersion[];
}

// ============================================================
// Serialization
// ============================================================

export function serializeSolution(sol: Solution): SerializedSolution {
  // Extract unique assignments across all config combinations
  const seen = new Set<string>();
  const assignments: Assignment[] = [];
  for (const ca of sol.configAssignments) {
    for (const a of ca.assignments) {
      const key = `${a.portName}\0${a.channelName}\0${a.pinName}\0${a.signalName}\0${a.configurationName}`;
      if (!seen.has(key)) {
        seen.add(key);
        assignments.push(a);
      }
    }
  }

  return {
    id: sol.id,
    name: sol.name,
    mcuRef: sol.mcuRef,
    assignments,
    portPeripherals: Object.fromEntries(
      [...sol.portPeripherals].map(([k, v]) => [k, [...v]])
    ),
    costs: Object.fromEntries(sol.costs),
    totalCost: sol.totalCost,
  };
}

export function deserializeSolution(data: SerializedSolution): Solution {
  let configAssignments: ConfigCombinationAssignment[];

  if (data.assignments) {
    // New compact format: reconstruct configAssignments from flat list
    configAssignments = rebuildConfigAssignments(data.assignments);
  } else if (data.configAssignments) {
    // Legacy format: convert directly
    configAssignments = data.configAssignments.map(ca => ({
      activeConfigs: new Map(Object.entries(ca.activeConfigs)),
      assignments: ca.assignments,
    }));
  } else {
    configAssignments = [];
  }

  return {
    id: data.id,
    name: data.name,
    mcuRef: data.mcuRef,
    configAssignments,
    portPeripherals: new Map(
      Object.entries(data.portPeripherals).map(([k, v]) => [k, new Set(v)])
    ),
    costs: new Map(Object.entries(data.costs)),
    totalCost: data.totalCost,
    gpioCount: data.gpioCount ?? 0,
    optionalTotal: data.optionalTotal ?? 0,
    optionalFulfilled: data.optionalFulfilled ?? 0,
  };
}

/**
 * Rebuild configAssignments from a flat assignment list.
 * Groups assignments by (portName, configurationName), then computes the
 * cross-product of configs across ports. Pinned assignments (portName '<pinned>')
 * are included in every combination.
 */
function rebuildConfigAssignments(assignments: Assignment[]): ConfigCombinationAssignment[] {
  // Group by port -> config -> assignments
  const portConfigs = new Map<string, Map<string, Assignment[]>>();
  const pinnedAssignments: Assignment[] = [];

  for (const a of assignments) {
    if (a.portName === '<pinned>') {
      pinnedAssignments.push(a);
      continue;
    }
    let configs = portConfigs.get(a.portName);
    if (!configs) { configs = new Map(); portConfigs.set(a.portName, configs); }
    let list = configs.get(a.configurationName);
    if (!list) { list = []; configs.set(a.configurationName, list); }
    list.push(a);
  }

  const ports = [...portConfigs.keys()];
  if (ports.length === 0) {
    // Only pinned assignments
    if (pinnedAssignments.length === 0) return [];
    return [{ activeConfigs: new Map(), assignments: pinnedAssignments }];
  }

  // Cross-product of configurations across ports
  const results: ConfigCombinationAssignment[] = [];

  function crossProduct(idx: number, activeConfigs: Map<string, string>, collected: Assignment[]): void {
    if (idx === ports.length) {
      results.push({
        activeConfigs: new Map(activeConfigs),
        assignments: [...pinnedAssignments, ...collected],
      });
      return;
    }
    const port = ports[idx];
    const configs = portConfigs.get(port)!;
    for (const [configName, configAssigns] of configs) {
      activeConfigs.set(port, configName);
      crossProduct(idx + 1, activeConfigs, [...collected, ...configAssigns]);
    }
  }

  crossProduct(0, new Map(), []);
  return results;
}

export function serializeSolverResult(result: SolverResult): SerializedSolution[] {
  return result.solutions.map(serializeSolution);
}

// ============================================================
// Project Migration (old format → versioned)
// ============================================================

// ============================================================
// Custom Export Functions
// ============================================================

const CUSTOM_EXPORT_PREFIX = 'custom-export:';

export async function loadCustomExports(): Promise<CustomExportFunction[]> {
  const results: CustomExportFunction[] = [];
  const kv = getKv();
  const keys = await kv.keysWithPrefix(CUSTOM_EXPORT_PREFIX);
  for (const k of keys) {
    const v = await kv.get(k);
    if (v == null) continue;
    try {
      results.push(JSON.parse(v));
    } catch { /* skip corrupt entries */ }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveCustomExport(fn: CustomExportFunction): Promise<void> {
  await getKv().set(CUSTOM_EXPORT_PREFIX + fn.id, JSON.stringify(fn));
}

export async function deleteCustomExport(id: string): Promise<void> {
  await getKv().delete(CUSTOM_EXPORT_PREFIX + id);
}

export const DEFAULT_EXPORT_EXAMPLE: CustomExportFunction = {
  id: 'example-pin-list',
  name: 'Pin List',
  description: 'List of used pins with port/signal mapping',
  code: `const lines = [mcuName + '  ' + mcuPackage, ''];

// Group signals per pin
const pinMap = new Map();
for (const a of assignments) {
  const key = a.pinName + '\\0' + a.portName + '.' + a.channelName;
  if (!pinMap.has(key)) pinMap.set(key, { pin: a.pinName, port: a.portName + '.' + a.channelName, signals: new Set() });
  pinMap.get(key).signals.add(a.signalName);
}

const rows = [...pinMap.values()].sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));

// Find column widths
const hdr = ['Pin', 'Port.Channel', 'Signal'];
const w = hdr.map((h, i) => Math.max(h.length, ...rows.map(r => [r.pin, r.port, [...r.signals].join(', ')][i].length)));

lines.push(hdr.map((h, i) => h.padEnd(w[i])).join('  '));
lines.push(w.map(n => '-'.repeat(n)).join('  '));
for (const r of rows) {
  lines.push([r.pin.padEnd(w[0]), r.port.padEnd(w[1]), [...r.signals].join(', ')].join('  '));
}

return lines.join('\\n');`,
};

export async function seedDefaultExports(): Promise<void> {
  // `custom-export-seeded` stays on localStorage (sync-friendly) so we
  // can short-circuit cheaply on every boot. The actual export blob
  // moved to the async kv.
  if (localStorage.getItem('custom-export-seeded')) return;
  const existing = await getKv().get(CUSTOM_EXPORT_PREFIX + DEFAULT_EXPORT_EXAMPLE.id);
  if (existing == null) await saveCustomExport(DEFAULT_EXPORT_EXAMPLE);
  localStorage.setItem('custom-export-seeded', '1');
}

// ============================================================
// Macro Library
// ============================================================

const MACRO_LIB_KEY = 'macro-library';

export async function loadMacroLibrary(): Promise<string | null> {
  try { return await getKv().get(MACRO_LIB_KEY); } catch { return null; }
}

export async function saveMacroLibrary(source: string): Promise<void> {
  try { await getKv().set(MACRO_LIB_KEY, source); } catch { /* storage unavailable */ }
}

// ============================================================
// Common-error lint library
// ============================================================

const LINT_LIB_KEY = 'common-errors-library';

export async function loadCommonErrorsLibrary(): Promise<string | null> {
  try { return await getKv().get(LINT_LIB_KEY); } catch { return null; }
}

export async function saveCommonErrorsLibrary(source: string): Promise<void> {
  try { await getKv().set(LINT_LIB_KEY, source); } catch { /* storage unavailable */ }
}

// ============================================================
// Peripheral snippet library (double-click helper in the editor)
// ============================================================

const PERIPHERAL_LIB_KEY = 'peripheral-library';

export async function loadPeripheralLibrary(): Promise<string | null> {
  try { return await getKv().get(PERIPHERAL_LIB_KEY); } catch { return null; }
}

export async function savePeripheralLibrary(source: string): Promise<void> {
  try { await getKv().set(PERIPHERAL_LIB_KEY, source); } catch { /* storage unavailable */ }
}

// ============================================================
// Project Data Migration
// ============================================================

/**
 * Whether a parsed JSON blob looks like a project exported from the Data
 * Manager. Checked before `migrateProjectData`, which happily fabricates a
 * version for any object (so an MCU JSON would otherwise import as a project).
 */
export function isExportedProject(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return Array.isArray(obj.versions) || typeof obj.constraintText === 'string';
}

/**
 * Append `imported`'s versions to `target` and renumber every id, so importing
 * over an existing project adds versions instead of replacing it (same
 * behaviour as "Save As" under an existing name). Mutates and returns `target`.
 */
export function mergeImportedVersions(target: ProjectData, imported: ProjectData): ProjectData {
  target.versions.push(...imported.versions.map(v => ({ ...v })));
  target.versions.forEach((v, i) => { v.id = i; });
  return target;
}

export function migrateProjectData(raw: unknown): ProjectData {
  const obj = raw as Record<string, unknown>;

  // Already in versioned format
  if (Array.isArray(obj.versions)) {
    return obj as unknown as ProjectData;
  }

  // Old format: { name, constraintText }
  const name = (obj.name as string) || '';
  const constraintText = (obj.constraintText as string) || '';

  return {
    name,
    versions: [{
      id: 0,
      timestamp: 0,
      constraintText,
      mcuRef: '',
      solutions: [],
    }],
  };
}
