import type { Solution, Assignment, ConfigCombinationAssignment, CustomExportFunction } from './types';
import { DEFAULT_LIBRARIES, DEFAULT_EXPORTS, contentHash } from './defaults';
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


/**
 * Hash of the bundled default a stored item was last synced with. Lets us tell
 * "the user edited this" from "we shipped a new revision" — see syncDefaults.
 */
const BASE_HASH_PREFIX = 'default-base:';
const baseHashKey = (id: string): string => BASE_HASH_PREFIX + id;

export interface PendingUpdate {
  kind: 'library' | 'export';
  id: string;
  label: string;
}

/**
 * Bring stored libraries and built-in export functions up to date with the
 * bundled defaults, and report what still needs the user to decide.
 *
 * - never stored yet        → seed it
 * - stored, never edited    → update in place (nothing to lose)
 * - stored and edited       → leave it, return it as a pending update
 *
 * "Edited" means the stored text differs from the default it was seeded with,
 * which is why the seed hash is recorded alongside it.
 */
export async function syncDefaults(): Promise<PendingUpdate[]> {
  const kv = getKv();
  const pending: PendingUpdate[] = [];

  /**
   * @param current  stored text to compare against, or null if nothing stored
   * @param write    persists the default; only called when it is safe to do so
   */
  const sync = async (
    kind: 'library' | 'export', id: string, label: string,
    defaultText: string, current: string | null, write: () => Promise<void>,
  ): Promise<void> => {
    const wanted = contentHash(defaultText);
    if (current == null) {                       // new install / new built-in
      await write();
      await kv.set(baseHashKey(id), wanted);
      return;
    }
    const base = await kv.get(baseHashKey(id));
    if (base === wanted) return;                 // already on this revision
    if (base != null && contentHash(current) !== base) {
      pending.push({ kind, id, label });         // customised — the user decides
      return;
    }
    // Untouched, or a pre-existing install adopting the scheme: move forward.
    await write();
    await kv.set(baseHashKey(id), wanted);
  };

  for (const lib of DEFAULT_LIBRARIES) {
    await sync('library', lib.id, lib.label, lib.text, await kv.get(lib.id),
      () => kv.set(lib.id, lib.text));
  }

  for (const fn of DEFAULT_EXPORTS) {
    const raw = await kv.get(CUSTOM_EXPORT_PREFIX + fn.id);
    let currentCode: string | null = null;
    if (raw != null) {
      try { currentCode = (JSON.parse(raw) as CustomExportFunction).code; } catch { currentCode = null; }
    }
    await sync('export', fn.id, fn.name, fn.code, currentCode, () => saveCustomExport(fn));
  }

  return pending;
}

/** Apply a pending update, discarding the user's edits to that item. */
export async function applyDefaultUpdate(update: PendingUpdate): Promise<void> {
  const kv = getKv();
  if (update.kind === 'library') {
    const lib = DEFAULT_LIBRARIES.find(l => l.id === update.id);
    if (!lib) return;
    await kv.set(lib.id, lib.text);
    await kv.set(baseHashKey(lib.id), contentHash(lib.text));
    return;
  }
  const fn = DEFAULT_EXPORTS.find(f => f.id === update.id);
  if (!fn) return;
  await saveCustomExport(fn);
  await kv.set(baseHashKey(fn.id), contentHash(fn.code));
}

/** Record a default as the current baseline (used after an explicit Reset). */
export async function markSyncedWithDefault(id: string, defaultText: string): Promise<void> {
  try { await getKv().set(baseHashKey(id), contentHash(defaultText)); } catch { /* storage unavailable */ }
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
