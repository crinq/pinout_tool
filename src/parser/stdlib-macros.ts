import DEFAULT_MACRO_LIBRARY_RAW from '../defaults/macro-library.txt?raw';
// ============================================================
// Standard Library Macros
// Pre-defined macros for common peripheral configurations.
// These are parsed at startup and available in all projects.
// Users can edit the library via the Data Manager.
// ============================================================

import { parseConstraints } from './constraint-parser';
import { extractMacros } from './macro-expander';
import type { MacroDeclNode, PortDeclNode } from './constraint-ast';
import { loadMacroLibrary, saveMacroLibrary } from '../storage';

export const DEFAULT_MACRO_LIBRARY = DEFAULT_MACRO_LIBRARY_RAW;

let cachedStdlib: Map<string, MacroDeclNode> | null = null;
let cachedTemplates: Map<string, PortDeclNode> | null = null;
let cachedSource: string | null = null;

/**
 * Seed the macro library in storage if not present.
 */
export async function seedMacroLibrary(): Promise<void> {
  if ((await loadMacroLibrary()) === null) {
    await saveMacroLibrary(DEFAULT_MACRO_LIBRARY.trim());
  }
  // Pre-populate the cached source so synchronous getStdlibSource() works
  // from solver hot paths without touching async storage.
  cachedSource = (await loadMacroLibrary()) ?? DEFAULT_MACRO_LIBRARY.trim();
}

/**
 * Invalidate the cached macros so they are re-parsed on next access.
 * Call this after the user edits the macro library — and then call
 * primeStdlibSource() to refresh `cachedSource` from storage.
 */
export function invalidateStdlibCache(): void {
  cachedStdlib = null;
  cachedTemplates = null;
  cachedSource = null;
}

/**
 * Pull the macro source from storage and cache it for sync access.
 * Called at boot (via seedMacroLibrary) and after the user saves an
 * edited library so subsequent getStdlibSource() calls see the change
 * without re-reading IDB.
 */
export async function primeStdlibSource(): Promise<void> {
  cachedSource = (await loadMacroLibrary()) ?? DEFAULT_MACRO_LIBRARY.trim();
  cachedStdlib = null;
  cachedTemplates = null;
}

/**
 * Get the current macro library source. Returns the cached value
 * populated at boot — callers in the solver hot path can stay sync.
 * Falls back to the default if priming was somehow skipped.
 */
export function getStdlibSource(): string {
  if (cachedSource !== null) return cachedSource;
  cachedSource = DEFAULT_MACRO_LIBRARY.trim();
  return cachedSource;
}

/**
 * Get the stdlib macro definitions (parsed once, cached).
 */
export function getStdlibMacros(): Map<string, MacroDeclNode> {
  if (cachedStdlib) return cachedStdlib;
  parseStdlib();
  return cachedStdlib!;
}

/**
 * Get port templates from the stdlib (parsed once, cached).
 */
export function getStdlibTemplates(): Map<string, PortDeclNode> {
  if (cachedTemplates) return cachedTemplates;
  parseStdlib();
  return cachedTemplates!;
}

function parseStdlib(): void {
  const source = getStdlibSource();
  const result = parseConstraints(source);
  if (result.ast) {
    cachedStdlib = extractMacros(result.ast);
    cachedTemplates = new Map();
    for (const stmt of result.ast.statements) {
      if (stmt.type === 'port_decl') {
        cachedTemplates.set(stmt.name, stmt);
      }
    }
  } else {
    cachedStdlib = new Map();
    cachedTemplates = new Map();
  }
}

/**
 * Get the names of all macros in the current library (without arity suffix).
 */
export function getStdlibMacroNames(): Set<string> {
  const names = new Set<string>();
  for (const key of getStdlibMacros().keys()) {
    names.add(key.split('/')[0]);
  }
  return names;
}
