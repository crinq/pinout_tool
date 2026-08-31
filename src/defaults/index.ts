// ============================================================
// Bundled default libraries and export functions
//
// The defaults live in plain files next to this module and are inlined at
// build time (`?raw`), so they ship with the app and work offline.
//
// "Version" is a hash of the file's content, not its mtime: the browser cannot
// stat files, and a redeploy rewrites every mtime, which would report all
// libraries as updated on every release. A content hash only changes when the
// content actually does.
// ============================================================

import type { CustomExportFunction } from '../types';
// Imported straight from the files rather than re-exported from the parser
// modules: those pull in storage, which imports this module back.
import MACRO_LIBRARY_RAW from './macro-library.txt?raw';
import COMMON_ERRORS_RAW from './common-errors.txt?raw';
import PERIPHERAL_LIBRARY_RAW from './peripheral-library.txt?raw';

/** FNV-1a — short, stable, and good enough to tell two revisions apart. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface DefaultLibrary {
  id: string;
  /** Shown in the Data manager. */
  label: string;
  /** Current bundled text. */
  text: string;
}

export const DEFAULT_LIBRARIES: DefaultLibrary[] = [
  { id: 'macro-library', label: 'Macro Library', text: MACRO_LIBRARY_RAW.trim() },
  { id: 'common-errors-library', label: 'Common-Error Lint Library', text: COMMON_ERRORS_RAW.trim() },
  { id: 'peripheral-library', label: 'Peripheral Library', text: PERIPHERAL_LIBRARY_RAW.trim() },
];

/**
 * Built-in export functions, one file each under `defaults/exports/`. Dropping
 * a new file in adds an export; ids are taken from the file's header so a new
 * built-in can never collide with a user's own function.
 */
const EXPORT_FILES = import.meta.glob('./exports/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Parse `// key: value` header lines off the top of a default export file. */
export function parseExportFile(source: string, fallbackId: string): CustomExportFunction {
  const meta: Record<string, string> = {};
  const lines = source.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\/\/\s*(id|name|description)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    meta[m[1]] = m[2].trim();
  }
  return {
    id: meta.id || fallbackId,
    name: meta.name || fallbackId,
    description: meta.description || '',
    code: lines.slice(i).join('\n').trim(),
  };
}

export const DEFAULT_EXPORTS: CustomExportFunction[] = Object.entries(EXPORT_FILES)
  .map(([path, src]) => parseExportFile(src, path.replace(/^.*\/|\.js$/g, '')))
  .sort((a, b) => a.id.localeCompare(b.id));
