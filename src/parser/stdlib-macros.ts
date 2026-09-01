import DEFAULT_MACRO_LIBRARY_RAW from '../defaults/macro-library.txt?raw';
// ============================================================
// Standard Library Macros
// Pre-defined macros for common peripheral configurations.
// These are parsed at startup and available in all projects.
// Users can edit the library via the Data Manager.
// ============================================================

import { parseConstraints } from './constraint-parser';
import { collectMacros, setMacroLibrary, getMacroLibrary } from './preprocessor';
import type { PortDeclNode } from './constraint-ast';
import { loadMacroLibrary, saveMacroLibrary } from '../storage';

export const DEFAULT_MACRO_LIBRARY = DEFAULT_MACRO_LIBRARY_RAW;

let cachedTemplates: Map<string, PortDeclNode> | null = null;

/**
 * Seed the macro library in storage if not present.
 */
export async function seedMacroLibrary(): Promise<void> {
  if ((await loadMacroLibrary()) === null) {
    await saveMacroLibrary(DEFAULT_MACRO_LIBRARY.trim());
  }
  // Publish the source synchronously so the preprocessor — which runs inside
  // parseConstraints, on hot paths that cannot await storage — sees it.
  await primeStdlibSource();
}

/**
 * Pull the macro library from storage and publish it to the preprocessor.
 * Called at boot (via seedMacroLibrary) and after the user saves an edited
 * library, so the next parse expands macros from the edited source.
 */
export async function primeStdlibSource(): Promise<void> {
  setMacroLibrary((await loadMacroLibrary()) ?? DEFAULT_MACRO_LIBRARY.trim());
  cachedTemplates = null;
}

/**
 * The macro library the preprocessor is currently expanding from — the user's
 * edited one once primed, the bundled default before that.
 */
export function getStdlibSource(): string {
  return getMacroLibrary();
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
  // The library supplies its own macros: a port template declared in it may
  // call one, and those calls have to expand before the template is merged
  // into a user's port.
  const result = parseConstraints(source, { macroLibrary: source });
  cachedTemplates = new Map();
  for (const stmt of result.ast?.statements ?? []) {
    if (stmt.type === 'port_decl') cachedTemplates.set(stmt.name, stmt);
  }
}

/**
 * Get the names of all macros in the current library (without arity suffix).
 */
export function getStdlibMacroNames(): Set<string> {
  return new Set(collectMacros(getStdlibSource()).map(m => m.name));
}
