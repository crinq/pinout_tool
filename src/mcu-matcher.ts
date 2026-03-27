// ============================================================
// MCU Matching & Filtering
//
// Matches MCU names, packages, and memory specs from constraint
// declarations against stored MCU metadata in localStorage.
// ============================================================

import type { ProgramNode } from './parser/constraint-ast';
import { escapeRegex } from './utils';

export interface McuMetadata {
  refName: string;
  package: string;
  ram: number;      // KB
  flash: number;    // KB
  frequency: number; // MHz
  tags: string[];
}

/**
 * Convert a glob pattern to a case-insensitive RegExp.
 * Supports: * (any chars), ? (single char), [a,b,c] (alternatives).
 * Implicit * appended at end if not already present.
 */
export function globToRegex(pattern: string): RegExp {
  let p = pattern.trim();
  if (!p) return /^.*$/i;

  // Implicit trailing * if pattern doesn't already end with *
  if (!p.endsWith('*')) {
    p += '*';
  }

  // Expand bracket alternatives: [405,407] → (405|407)
  let re = '';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '[') {
      const close = p.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
        i++;
      } else {
        const inner = p.substring(i + 1, close);
        const alts = inner.split(',').map(s => escapeRegex(s.trim()));
        re += '(' + alts.join('|') + ')';
        i = close + 1;
      }
    } else if (ch === '*') {
      re += '.*';
      i++;
    } else if (ch === '?') {
      re += '.';
      i++;
    } else {
      re += escapeRegex(ch);
      i++;
    }
  }

  return new RegExp('^' + re + '$', 'i');
}


/**
 * Test if a value matches any of the given glob patterns (OR logic).
 */
export function matchesPatterns(value: string, patterns: string[]): boolean {
  return patterns.some(p => globToRegex(p).test(value));
}

/**
 * List all stored MCU metadata from localStorage.
 * Uses mcu-meta: entries. If metadata is missing ram/flash/package fields
 * (legacy entries), extracts them from the raw MCU XML and updates the metadata.
 */
export function listStoredMcuMetadata(): McuMetadata[] {
  const results: McuMetadata[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('mcu-xml:')) continue;

    const refName = key.substring('mcu-xml:'.length);
    let pkg = '';
    let ram = 0;
    let flash = 0;
    let frequency = 0;
    let tags: string[] = [];

    try {
      const metaStr = localStorage.getItem(`mcu-meta:${refName}`);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        tags = meta.tags ?? [];
        pkg = meta.package ?? '';
        ram = meta.ram ?? 0;
        flash = meta.flash ?? 0;
        frequency = meta.frequency ?? 0;
      }

      // Backfill missing fields from the XML root element attributes
      if (!pkg || !ram || !flash || !frequency) {
        const xml = localStorage.getItem(key);
        if (xml) {
          const extracted = extractMetaFromXml(xml);
          if (extracted) {
            pkg = pkg || extracted.package;
            ram = ram || extracted.ram;
            flash = flash || extracted.flash;
            frequency = frequency || extracted.frequency;
            // Update stored metadata so we don't parse XML again
            try {
              localStorage.setItem(`mcu-meta:${refName}`, JSON.stringify({
                tags, package: pkg, ram, flash, frequency,
              }));
            } catch { /* storage full */ }
          }
        }
      }
    } catch { /* ignore corrupt metadata */ }

    results.push({ refName, package: pkg, ram, flash, frequency, tags });
  }
  return results;
}

/**
 * Lightweight extraction of package/ram/flash from MCU XML without full DOM parse.
 * Looks for attributes on the root <Mcu> element.
 */
function extractMetaFromXml(xml: string): { package: string; ram: number; flash: number; frequency: number } | null {
  // Match Package attribute
  const pkgMatch = xml.match(/Package="([^"]+)"/);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  // Match Ram, Flash, Frequency from elements
  let ram = 0;
  let flash = 0;
  let frequency = 0;

  const ramMatch = xml.match(/<Ram>(\d+)<\/Ram>/);
  if (ramMatch) ram = parseInt(ramMatch[1], 10);

  const flashMatch = xml.match(/<Flash>(\d+)<\/Flash>/);
  if (flashMatch) flash = parseInt(flashMatch[1], 10);

  const freqMatch = xml.match(/<Frequency>(\d+)<\/Frequency>/);
  if (freqMatch) frequency = parseInt(freqMatch[1], 10);

  if (!pkg && !ram && !flash && !frequency) return null;
  return { package: pkg, ram, flash, frequency };
}

/**
 * Extract MCU filter criteria from a parsed AST.
 * Returns null if no mcu: declaration is present (use current MCU only).
 */
export function extractMcuFilters(ast: ProgramNode): {
  mcuPatterns: string[];
  packagePatterns: string[];
  minRamBytes: number;
  minRomBytes: number;
  minFreqMHz: number;
} | null {
  let mcuPatterns: string[] = [];
  let packagePatterns: string[] = [];
  let minRamBytes = 0;
  let minRomBytes = 0;
  let minFreqMHz = 0;
  let hasMcuDecl = false;

  for (const stmt of ast.statements) {
    switch (stmt.type) {
      case 'mcu_decl':
        hasMcuDecl = true;
        mcuPatterns = mcuPatterns.concat(stmt.patterns);
        break;
      case 'package_decl':
        packagePatterns = packagePatterns.concat(stmt.patterns);
        break;
      case 'ram_decl':
        minRamBytes = Math.max(minRamBytes, stmt.minBytes);
        break;
      case 'rom_decl':
        minRomBytes = Math.max(minRomBytes, stmt.minBytes);
        break;
      case 'freq_decl':
        minFreqMHz = Math.max(minFreqMHz, stmt.minMHz);
        break;
    }
  }

  if (!hasMcuDecl && packagePatterns.length === 0 && minRamBytes === 0 && minRomBytes === 0 && minFreqMHz === 0) {
    return null; // No multi-MCU filtering
  }

  return { mcuPatterns, packagePatterns, minRamBytes, minRomBytes, minFreqMHz };
}

/**
 * Filter stored MCUs by constraint criteria.
 * Returns matching MCU refNames.
 */
export function filterStoredMcus(ast: ProgramNode): string[] {
  const filters = extractMcuFilters(ast);
  if (!filters) return [];

  const allMcus = listStoredMcuMetadata();

  return allMcus
    .filter(m => {
      // MCU name filter
      if (filters.mcuPatterns.length > 0 && !matchesPatterns(m.refName, filters.mcuPatterns)) {
        return false;
      }

      // Package filter
      if (filters.packagePatterns.length > 0 && !matchesPatterns(m.package, filters.packagePatterns)) {
        return false;
      }

      // RAM filter (metadata stores KB, filter is in bytes)
      if (filters.minRamBytes > 0 && m.ram * 1024 < filters.minRamBytes) {
        return false;
      }

      // ROM/Flash filter (metadata stores KB, filter is in bytes)
      if (filters.minRomBytes > 0 && m.flash * 1024 < filters.minRomBytes) {
        return false;
      }

      // Frequency filter (both in MHz)
      if (filters.minFreqMHz > 0 && m.frequency < filters.minFreqMHz) {
        return false;
      }

      return true;
    })
    .map(m => m.refName);
}
