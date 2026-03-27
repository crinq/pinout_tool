// ============================================================
// Signal Pattern Matching
// ============================================================

import type { SignalPatternNode, PatternPart } from '../parser/constraint-ast';
import type { Mcu, Pin, Signal } from '../types';
import { TYPE_ALIASES } from '../parser/mcu-xml-parser';

export interface SignalCandidate {
  pin: Pin;
  signal: Signal;
  signalName: string;
  peripheralInstance: string;
  peripheralType: string;
}

// Build a reverse map from normalized type to all original types
const REVERSE_ALIASES: Map<string, Set<string>> = new Map();
for (const [original, normalized] of Object.entries(TYPE_ALIASES)) {
  if (!REVERSE_ALIASES.has(normalized)) {
    REVERSE_ALIASES.set(normalized, new Set());
  }
  REVERSE_ALIASES.get(normalized)!.add(original);
}

/** Get all equivalent type names (original + aliases) for a given prefix */
function getEquivalentTypes(prefix: string): string[] {
  // If prefix is a normalized type, include all originals
  const reverseSet = REVERSE_ALIASES.get(prefix);
  if (reverseSet) return [prefix, ...reverseSet];
  // If prefix is an alias/original, include the normalized form and its siblings
  const normalized = TYPE_ALIASES[prefix];
  if (normalized) {
    const siblings = REVERSE_ALIASES.get(normalized);
    return [normalized, ...(siblings ?? [])];
  }
  return [prefix];
}

/** Get equivalent search terms for a substring search query (e.g. "UART" → ["UART", "USART", "LPUART"]) */
export function getEquivalentSearchTerms(term: string): string[] {
  const upper = term.toUpperCase();
  // Check if the term matches any alias key or value
  for (const [original, normalized] of Object.entries(TYPE_ALIASES)) {
    if (upper === original.toUpperCase() || upper === normalized.toUpperCase()) {
      const siblings = REVERSE_ALIASES.get(normalized);
      return [normalized, ...(siblings ?? [])];
    }
  }
  return [term];
}

/**
 * Check if a signal name matches a signal pattern.
 * Uses normalized peripheral types for matching.
 */
export function matchSignalPattern(pattern: SignalPatternNode, signal: Signal): boolean {
  if (!signal.peripheralInstance || !signal.signalFunction) return false;

  const instance = signal.peripheralInstance;   // e.g., "USART1"
  const func = signal.signalFunction;           // e.g., "TX"
  const type = signal.peripheralType || '';      // e.g., "USART" (normalized)
  const num = signal.instanceNumber;            // e.g., 1

  return matchPart(pattern.instancePart, instance, type, num) &&
         matchPart(pattern.functionPart, func, func, undefined);
}

/**
 * Check if a pattern matches a peripheral instance name (e.g., "ADC1", "SPI3").
 * Parses the instance name to extract type and number for matching.
 */
export function matchPatternToInstance(pattern: PatternPart, instanceName: string): boolean {
  const match = instanceName.match(/^([A-Za-z_]+?)(\d+)$/);
  const type = match ? match[1] : instanceName;
  const num = match ? parseInt(match[2], 10) : undefined;
  return matchPart(pattern, instanceName, type, num);
}

function matchPart(
  part: PatternPart,
  fullValue: string,      // e.g., "USART1" or "TX"
  typeOrFunc: string,      // e.g., "USART" (for instance) or "TX" (for function)
  num: number | undefined  // e.g., 1 (for instance) or undefined
): boolean {
  switch (part.type) {
    case 'literal':
      return fullValue === part.value;

    case 'any':
      return true;

    case 'wildcard': {
      // prefix* - match if the value starts with the prefix (after type normalization)
      // For instance part: USART* should match USART1, UART4 (via normalization), etc.
      // For function part: CH* should match CH1, CH2, etc.
      // Also: UART* should match USART1 (forward alias lookup).
      const equivTypes = getEquivalentTypes(part.prefix);
      for (const t of equivTypes) {
        if (fullValue.startsWith(t)) return true;
      }
      // Also check if the normalized type matches the prefix
      if (typeOrFunc.startsWith(part.prefix)) return true;
      return false;
    }

    case 'range': {
      // prefix[values] - match if the type matches and number is in values
      // Must be an exact match: CH[1,2] matches CH1 but NOT CH1N
      // Check all equivalent types (USART↔UART, TIM↔TIM1_8, etc.)
      const equivTypes = getEquivalentTypes(part.prefix);
      for (const t of equivTypes) {
        if (typeOrFunc === t && num !== undefined && part.values.includes(num)) {
          if (fullValue === t + num) return true;
        }
        if (fullValue.startsWith(t)) {
          const numStr = fullValue.substring(t.length);
          if (/^\d+$/.test(numStr)) {
            const n = parseInt(numStr, 10);
            if (part.values.includes(n)) return true;
          }
        }
      }
      return false;
    }
  }
}

/**
 * Find all (pin, signal) candidates that match a signal pattern in a given MCU.
 * Optionally restrict to a set of allowed pins.
 */
export function expandPatternToCandidates(
  pattern: SignalPatternNode,
  mcu: Mcu,
  allowedPins?: Set<string>
): SignalCandidate[] {
  const candidates: SignalCandidate[] = [];

  for (const pin of mcu.pins) {
    if (!pin.isAssignable) continue;
    if (allowedPins && !allowedPins.has(pin.name) && !allowedPins.has(gpioName(pin))) continue;

    for (const signal of pin.signals) {
      if (matchSignalPattern(pattern, signal)) {
        candidates.push({
          pin,
          signal,
          signalName: signal.name,
          peripheralInstance: signal.peripheralInstance || signal.name,
          peripheralType: signal.peripheralType || '',
        });
      }
    }
  }

  return candidates;
}

function gpioName(pin: Pin): string {
  if (pin.gpioPort && pin.gpioNumber !== undefined) {
    return `P${pin.gpioPort}${pin.gpioNumber}`;
  }
  return pin.name;
}
