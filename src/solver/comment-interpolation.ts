// ============================================================
// Comment String Interpolation
// Evaluates ${expr} inside comments using solution data
// ============================================================

import { parseExpressionString } from '../parser/constraint-parser';
import type { VariableAssignment, EvalMcuInfo } from './solver';
import { evaluateExpr } from './solver';
import type { Assignment, DmaData } from '../types';

/**
 * Interpolate ${...} expressions in a comment string using solver-internal data.
 * Replaces each ${expr} with its evaluated value from the solution.
 * If evaluation fails, replaces with "?".
 */
export function interpolateComment(
  comment: string,
  portName: string,
  channelInfo: Map<string, Map<string, VariableAssignment[]>>,
  dmaData?: DmaData,
  mcuInfo?: EvalMcuInfo
): string {
  return comment.replace(/\$\{([^}]+)\}/g, (_match, exprStr: string) => {
    const expr = parseExpressionString(exprStr.trim());
    if (!expr) return '?';
    const result = evaluateExpr(expr, portName, channelInfo, dmaData, mcuInfo);
    if (result === false || result === '') return '?';
    return String(result);
  });
}

/**
 * Lightweight comment interpolation using export-level Assignment data.
 * Supports common functions: instance(CH), gpio_pin(CH), type(CH).
 */
export function interpolateCommentFromAssignments(
  comment: string,
  portName: string,
  assignments: Assignment[]
): string {
  // Build channel lookup: channelName -> Assignment
  const byChannel = new Map<string, Assignment>();
  for (const a of assignments) {
    if (a.portName === portName) {
      byChannel.set(a.channelName, a);
    }
  }

  return comment.replace(/\$\{([^}]+)\}/g, (_match, exprStr: string) => {
    const trimmed = exprStr.trim();

    // instance(CH) -> peripheral instance (e.g., "USART1" from "USART1_TX")
    const instanceMatch = trimmed.match(/^instance\((\w+)\)$/);
    if (instanceMatch) {
      const a = byChannel.get(instanceMatch[1]);
      if (!a) return '?';
      const idx = a.signalName.lastIndexOf('_');
      return idx > 0 ? a.signalName.substring(0, idx) : a.signalName;
    }

    // gpio_pin(CH) -> pin name (e.g., "PA9")
    const gpioMatch = trimmed.match(/^gpio_pin\((\w+)\)$/);
    if (gpioMatch) {
      const a = byChannel.get(gpioMatch[1]);
      return a ? a.pinName : '?';
    }

    // type(CH) -> peripheral type
    const typeMatch = trimmed.match(/^type\((\w+)\)$/);
    if (typeMatch) {
      const a = byChannel.get(typeMatch[1]);
      if (!a) return '?';
      // Extract type: "USART1" -> "USART", "SPI2" -> "SPI"
      const m = a.signalName.match(/^([A-Z]+)\d/);
      return m ? m[1] : '?';
    }

    // Plain channel reference -> signal name
    if (/^\w+$/.test(trimmed)) {
      const a = byChannel.get(trimmed);
      return a ? a.signalName : '?';
    }

    return '?';
  });
}

/**
 * Interpolate all comments in a map using assignment data.
 */
export function interpolateAllComments(
  comments: Map<string, string>,
  assignments: Assignment[]
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, comment] of comments) {
    if (!comment.includes('${')) {
      result.set(key, comment);
      continue;
    }
    // Key format: "portName" or "portName.channelName" or "pin:pinName"
    const dotIdx = key.indexOf('.');
    const portName = dotIdx >= 0 ? key.substring(0, dotIdx) : key;
    result.set(key, interpolateCommentFromAssignments(comment, portName, assignments));
  }
  return result;
}
