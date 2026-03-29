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
  tempMin: number;   // °C
  tempMax: number;   // °C
  voltageMin: number; // V
  voltageMax: number; // V
  cores: string[];    // e.g., ["Arm Cortex-M4"] or ["ARM Cortex-M7", "ARM Cortex-M4"]
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
    let tempMin = 0;
    let tempMax = 0;
    let voltageMin = 0;
    let voltageMax = 0;
    let cores: string[] = [];
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
        tempMin = meta.tempMin ?? 0;
        tempMax = meta.tempMax ?? 0;
        voltageMin = meta.voltageMin ?? 0;
        voltageMax = meta.voltageMax ?? 0;
        cores = meta.cores ?? [];
      }

      // Backfill missing fields from the XML root element attributes
      if (!pkg || !ram || !flash || !frequency || (!tempMin && !tempMax) || cores.length === 0) {
        const xml = localStorage.getItem(key);
        if (xml) {
          const extracted = extractMetaFromXml(xml);
          if (extracted) {
            pkg = pkg || extracted.package;
            ram = ram || extracted.ram;
            flash = flash || extracted.flash;
            frequency = frequency || extracted.frequency;
            tempMin = tempMin || extracted.tempMin;
            tempMax = tempMax || extracted.tempMax;
            voltageMin = voltageMin || extracted.voltageMin;
            voltageMax = voltageMax || extracted.voltageMax;
            if (cores.length === 0) cores = extracted.cores;
            // Update stored metadata so we don't parse XML again
            try {
              localStorage.setItem(`mcu-meta:${refName}`, JSON.stringify({
                tags, package: pkg, ram, flash, frequency,
                tempMin, tempMax, voltageMin, voltageMax, cores,
              }));
            } catch { /* storage full */ }
          }
        }
      }
    } catch { /* ignore corrupt metadata */ }

    results.push({ refName, package: pkg, ram, flash, frequency, tempMin, tempMax, voltageMin, voltageMax, cores, tags });
  }
  return results;
}

/**
 * Lightweight extraction of package/ram/flash from MCU XML without full DOM parse.
 * Looks for attributes on the root <Mcu> element.
 */
function extractMetaFromXml(xml: string): {
  package: string; ram: number; flash: number; frequency: number;
  tempMin: number; tempMax: number; voltageMin: number; voltageMax: number;
  cores: string[];
} | null {
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

  // Match Temperature and Voltage from attributes: <Temperature Min="-40" Max="105"/>
  let tempMin = 0;
  let tempMax = 0;
  let voltageMin = 0;
  let voltageMax = 0;

  const tempMatch = xml.match(/<Temperature\s+Max="([^"]+)"\s+Min="([^"]+)"/);
  if (tempMatch) {
    tempMax = parseFloat(tempMatch[1]);
    tempMin = parseFloat(tempMatch[2]);
  }

  const voltMatch = xml.match(/<Voltage\s+Max="([^"]+)"\s+Min="([^"]+)"/);
  if (voltMatch) {
    voltageMax = parseFloat(voltMatch[1]);
    voltageMin = parseFloat(voltMatch[2]);
  }

  // Extract Core elements: <Core>Arm Cortex-M4</Core>
  const cores: string[] = [];
  const coreRegex = /<Core>([^<]+)<\/Core>/g;
  let coreMatch;
  while ((coreMatch = coreRegex.exec(xml)) !== null) {
    cores.push(coreMatch[1].trim());
  }

  if (!pkg && !ram && !flash && !frequency) return null;
  return { package: pkg, ram, flash, frequency, tempMin, tempMax, voltageMin, voltageMax, cores };
}

/**
 * Extract MCU filter criteria from a parsed AST.
 * Returns null if no mcu: declaration is present (use current MCU only).
 */
export function extractMcuFilters(ast: ProgramNode): {
  mcuPatterns: string[];
  packagePatterns: string[];
  minRamBytes: number;
  maxRamBytes: number;
  minRomBytes: number;
  maxRomBytes: number;
  minFreqMHz: number;
  maxFreqMHz: number;
  reqTempMin?: number;
  reqTempMax?: number;
  reqVoltageMin?: number;
  reqVoltageMax?: number;
  coreRequired: string[][];
} | null {
  let mcuPatterns: string[] = [];
  let packagePatterns: string[] = [];
  let minRamBytes = 0;
  let maxRamBytes = 0;
  let minRomBytes = 0;
  let maxRomBytes = 0;
  let minFreqMHz = 0;
  let maxFreqMHz = 0;
  let reqTempMin: number | undefined;
  let reqTempMax: number | undefined;
  let reqVoltageMin: number | undefined;
  let reqVoltageMax: number | undefined;
  let coreRequired: string[][] = [];
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
        if (stmt.maxBytes !== undefined) {
          maxRamBytes = maxRamBytes > 0 ? Math.min(maxRamBytes, stmt.maxBytes) : stmt.maxBytes;
        }
        break;
      case 'rom_decl':
        minRomBytes = Math.max(minRomBytes, stmt.minBytes);
        if (stmt.maxBytes !== undefined) {
          maxRomBytes = maxRomBytes > 0 ? Math.min(maxRomBytes, stmt.maxBytes) : stmt.maxBytes;
        }
        break;
      case 'freq_decl':
        minFreqMHz = Math.max(minFreqMHz, stmt.minMHz);
        if (stmt.maxMHz !== undefined) {
          maxFreqMHz = maxFreqMHz > 0 ? Math.min(maxFreqMHz, stmt.maxMHz) : stmt.maxMHz;
        }
        break;
      case 'temp_decl':
        if (stmt.minTemp !== undefined) {
          reqTempMin = reqTempMin !== undefined ? Math.min(reqTempMin, stmt.minTemp) : stmt.minTemp;
        }
        if (stmt.maxTemp !== undefined) {
          reqTempMax = reqTempMax !== undefined ? Math.max(reqTempMax, stmt.maxTemp) : stmt.maxTemp;
        }
        break;
      case 'voltage_decl':
        if (stmt.minVoltage !== undefined) {
          reqVoltageMin = reqVoltageMin !== undefined ? Math.min(reqVoltageMin, stmt.minVoltage) : stmt.minVoltage;
        }
        if (stmt.maxVoltage !== undefined) {
          reqVoltageMax = reqVoltageMax !== undefined ? Math.max(reqVoltageMax, stmt.maxVoltage) : stmt.maxVoltage;
        }
        break;
      case 'core_decl':
        coreRequired = coreRequired.concat(stmt.required);
        break;
    }
  }

  const hasFilters = hasMcuDecl || packagePatterns.length > 0 ||
    minRamBytes > 0 || maxRamBytes > 0 ||
    minRomBytes > 0 || maxRomBytes > 0 ||
    minFreqMHz > 0 || maxFreqMHz > 0 ||
    reqTempMin !== undefined || reqTempMax !== undefined ||
    reqVoltageMin !== undefined || reqVoltageMax !== undefined ||
    coreRequired.length > 0;

  if (!hasFilters) {
    return null; // No multi-MCU filtering
  }

  return {
    mcuPatterns, packagePatterns,
    minRamBytes, maxRamBytes, minRomBytes, maxRomBytes,
    minFreqMHz, maxFreqMHz,
    reqTempMin, reqTempMax, reqVoltageMin, reqVoltageMax,
    coreRequired,
  };
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
      if (filters.maxRamBytes > 0 && m.ram * 1024 > filters.maxRamBytes) {
        return false;
      }

      // ROM/Flash filter (metadata stores KB, filter is in bytes)
      if (filters.minRomBytes > 0 && m.flash * 1024 < filters.minRomBytes) {
        return false;
      }
      if (filters.maxRomBytes > 0 && m.flash * 1024 > filters.maxRomBytes) {
        return false;
      }

      // Frequency filter (both in MHz)
      if (filters.minFreqMHz > 0 && m.frequency < filters.minFreqMHz) {
        return false;
      }
      if (filters.maxFreqMHz > 0 && m.frequency > filters.maxFreqMHz) {
        return false;
      }

      // Temperature filter: MCU range must cover the required operating point(s)
      // temp: -40 → MCU must support -40°C (mcu.tempMin ≤ -40)
      // temp: < 85 → MCU must support up to 85°C (mcu.tempMax ≥ 85)
      // temp: -40 < 85 → MCU must cover [-40, 85] range
      if (filters.reqTempMin !== undefined && m.tempMin > filters.reqTempMin) {
        return false;
      }
      if (filters.reqTempMax !== undefined && m.tempMax < filters.reqTempMax) {
        return false;
      }

      // Voltage filter: MCU range must cover the required operating voltage(s)
      if (filters.reqVoltageMin !== undefined && m.voltageMin > filters.reqVoltageMin) {
        return false;
      }
      if (filters.reqVoltageMax !== undefined && m.voltageMax < filters.reqVoltageMax) {
        return false;
      }

      // Core filter: each AND group must match at least one MCU core
      // Pattern like "M4" matches "Arm Cortex-M4" or "ARM Cortex-M4" (case-insensitive contains)
      for (const andGroup of filters.coreRequired) {
        const matched = andGroup.some(alt =>
          m.cores.some(c => c.toUpperCase().includes(alt.toUpperCase()))
        );
        if (!matched) return false;
      }

      return true;
    })
    .map(m => m.refName);
}
