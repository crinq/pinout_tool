// ============================================================
// Signal Pattern Matching
// ============================================================

import type { SignalPatternNode, PatternPart } from '../parser/constraint-ast';
import type { Mcu, Pin, Signal } from '../types';
import { TYPE_ALIASES } from '../types';

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
      // prefix* — match if the value starts with the prefix (after type normalization)
      // For instance part: USART* should match USART1, UART4 (via normalization), etc.
      // For function part: CH* should match CH1, CH2, etc.
      const prefix = part.prefix;
      if (fullValue.startsWith(prefix)) return true;
      // Check via type normalization: if prefix is a normalized type,
      // also match aliases. E.g., pattern "USART*" should match "UART4"
      // because UART normalizes to USART.
      const aliasTypes = REVERSE_ALIASES.get(prefix);
      if (aliasTypes) {
        for (const alias of aliasTypes) {
          if (fullValue.startsWith(alias)) return true;
        }
      }
      // Also check if the normalized type matches the prefix
      if (typeOrFunc.startsWith(prefix)) return true;
      return false;
    }

    case 'range': {
      // prefix[values] — match if the type matches and number is in values
      // Must be an exact match: CH[1,2] matches CH1 but NOT CH1N
      const prefix = part.prefix;
      // Direct match: type matches prefix and number is in range
      if (typeOrFunc === prefix && num !== undefined && part.values.includes(num)) {
        // Verify the full value is exactly prefix+number (no trailing chars like "N")
        if (fullValue === prefix + num) return true;
      }
      // Also try extracting number from fullValue (must be purely numeric suffix)
      if (fullValue.startsWith(prefix)) {
        const numStr = fullValue.substring(prefix.length);
        if (/^\d+$/.test(numStr)) {
          const n = parseInt(numStr, 10);
          if (part.values.includes(n)) return true;
        }
      }
      // Check aliases
      const aliasTypes = REVERSE_ALIASES.get(prefix);
      if (aliasTypes) {
        for (const alias of aliasTypes) {
          if (typeOrFunc === alias && num !== undefined && part.values.includes(num)) {
            if (fullValue === alias + num) return true;
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
