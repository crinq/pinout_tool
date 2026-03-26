// ============================================================
// SVG Export
//
// Generates an SVG string from MCU package data and pin
// assignments, matching the canvas renderer's layout logic.
// ============================================================

import type { Mcu, Pin, Assignment } from '../types';

interface SvgExportOptions {
  mcu: Mcu;
  assignments: Assignment[];
  portColors: Map<string, string>;
  width: number;
  height: number;
  darkMode: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getColors(dark: boolean) {
  return {
    bg: dark ? '#1a1a2e' : '#ffffff',
    chipBg: dark ? '#2a2a3e' : '#f5f5f5',
    text: dark ? '#e0e0e0' : '#1a1a1a',
    assigned: dark ? '#3b82f6' : '#3b82f6',
    unassigned: dark ? '#6b7280' : '#9ca3af',
    reserved: dark ? '#4b5563' : '#374151',
  };
}

function pinColor(
  pin: Pin,
  assignmentsByPin: Map<string, Assignment[]>,
  portColors: Map<string, string>,
  colors: ReturnType<typeof getColors>,
): string {
  const pinAssignments = assignmentsByPin.get(pin.name);
  if (pinAssignments && pinAssignments.length > 0) {
    const portName = pinAssignments.find(a => a.portName !== '<pinned>')?.portName;
    const portColor = portName ? portColors.get(portName) : undefined;
    return portColor || colors.assigned;
  }
  if (!pin.isAssignable) return colors.reserved;
  return colors.unassigned;
}

function pinLabel(pin: Pin, assignmentsByPin: Map<string, Assignment[]>): string {
  const gpio = pin.gpioPort && pin.gpioNumber !== undefined
    ? `P${pin.gpioPort}${pin.gpioNumber}`
    : pin.name.substring(0, 6);
  const pinAssignments = assignmentsByPin.get(pin.name);
  if (pinAssignments && pinAssignments.length > 0) {
    const nonPinned = pinAssignments.filter(a => a.portName !== '<pinned>');
    if (nonPinned.length > 0) {
      const portChannel = `${nonPinned[0].portName}.${nonPinned[0].channelName}`;
      const signals = [...new Set(nonPinned.map(a => a.signalName))];
      return `${gpio} ${portChannel} ${signals.join(' ')}`;
    }
    const signals = [...new Set(pinAssignments.map(a => a.signalName))];
    return `${gpio} ${signals.join(' ')}`;
  }
  return gpio;
}

function buildAssignmentMap(assignments: Assignment[]): Map<string, Assignment[]> {
  const map = new Map<string, Assignment[]>();
  for (const a of assignments) {
    if (!map.has(a.pinName)) map.set(a.pinName, []);
    map.get(a.pinName)!.push(a);
  }
  return map;
}

// ============================================================
// LQFP SVG
// ============================================================

function renderLQFPSvg(opts: SvgExportOptions): string {
  const { mcu, assignments, portColors, width, height, darkMode } = opts;
  const colors = getColors(darkMode);
  const assignmentsByPin = buildAssignmentMap(assignments);

  const totalPins = mcu.pins.length;
  const packageMatch = mcu.package.match(/(\d+)/);
  const packagePinCount = packageMatch ? parseInt(packageMatch[1], 10) : totalPins;
  const pinsPerSide = Math.floor(packagePinCount / 4);

  // Fixed layout: pinSpacing drives chip size, margin fills the rest
  const pinSpacing = 14;
  const pinLength = 14;
  const pinWidth = Math.min(8, pinSpacing * 0.7);
  const chipSize = pinsPerSide * pinSpacing + 10;
  const chipX = (width - chipSize) / 2;
  const chipY = (height - chipSize) / 2;

  const parts: string[] = [];

  // Background
  parts.push(`<rect width="${width}" height="${height}" fill="${colors.bg}"/>`);

  // Chip body
  parts.push(`<rect x="${chipX}" y="${chipY}" width="${chipSize}" height="${chipSize}" fill="${colors.chipBg}" stroke="${colors.text}" stroke-width="2"/>`);

  // Pin 1 notch
  const ns = 12;
  parts.push(`<path d="M${chipX},${chipY} L${chipX + ns},${chipY} A${ns},${ns} 0 0,0 ${chipX},${chipY + ns} Z" fill="${colors.text}"/>`);

  // MCU name
  const cx = chipX + chipSize / 2;
  const cy = chipY + chipSize / 2;
  parts.push(`<text x="${cx}" y="${cy - 8}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-weight="bold" font-size="11" fill="${colors.text}">${esc(mcu.refName)}</text>`);
  parts.push(`<text x="${cx}" y="${cy + 8}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="10" fill="${colors.text}">${esc(mcu.package)}</text>`);

  // Pins
  const sortedPins = [...mcu.pins].sort((a, b) => parseInt(a.position, 10) - parseInt(b.position, 10));
  const fontSize = Math.min(9, pinSpacing * 0.65);

  for (let i = 0; i < sortedPins.length && i < packagePinCount; i++) {
    const pin = sortedPins[i];
    const sideIndex = Math.floor(i / pinsPerSide);
    const indexOnSide = i % pinsPerSide;
    const offset = 5 + indexOnSide * pinSpacing + pinSpacing / 2;

    let x = 0, y = 0, pw = 0, ph = 0;
    let labelX = 0, labelY = 0;
    let anchor: string;

    switch (sideIndex) {
      case 0: // Left
        x = chipX - pinLength; y = chipY + offset - pinWidth / 2;
        pw = pinLength; ph = pinWidth;
        labelX = x - 3; labelY = y + pinWidth / 2;
        anchor = 'end';
        break;
      case 1: // Bottom
        x = chipX + offset - pinWidth / 2; y = chipY + chipSize;
        pw = pinWidth; ph = pinLength;
        labelX = x + pinWidth / 2; labelY = y + pinLength + 3;
        anchor = 'end';
        break;
      case 2: // Right
        x = chipX + chipSize; y = chipY + chipSize - offset - pinWidth / 2;
        pw = pinLength; ph = pinWidth;
        labelX = x + pinLength + 3; labelY = y + pinWidth / 2;
        anchor = 'start';
        break;
      default: // Top
        x = chipX + chipSize - offset - pinWidth / 2; y = chipY - pinLength;
        pw = pinWidth; ph = pinLength;
        labelX = x + pinWidth / 2; labelY = y - 3;
        anchor = 'start';
        break;
    }

    const fill = pinColor(pin, assignmentsByPin, portColors, colors);
    parts.push(`<rect x="${x}" y="${y}" width="${pw}" height="${ph}" fill="${fill}" stroke="${colors.text}" stroke-width="0.5"/>`);

    // Label
    const label = esc(pinLabel(pin, assignmentsByPin));
    if (sideIndex === 1 || sideIndex === 3) {
      // Vertical labels for top/bottom
      parts.push(`<text x="${labelX}" y="${labelY}" text-anchor="${anchor}" dominant-baseline="middle" font-family="monospace" font-size="${fontSize}" fill="${colors.text}" transform="rotate(-90,${labelX},${labelY})">${label}</text>`);
    } else {
      parts.push(`<text x="${labelX}" y="${labelY}" text-anchor="${anchor}" dominant-baseline="middle" font-family="monospace" font-size="${fontSize}" fill="${colors.text}">${label}</text>`);
    }
  }

  return parts.join('\n  ');
}

// ============================================================
// BGA SVG
// ============================================================

function renderBGASvg(opts: SvgExportOptions): string {
  const { mcu, assignments, portColors, width, height, darkMode } = opts;
  const colors = getColors(darkMode);
  const assignmentsByPin = buildAssignmentMap(assignments);

  const rows = new Set<string>();
  const cols = new Set<number>();
  const pinByGrid = new Map<string, Pin>();

  for (const pin of mcu.pins) {
    const match = pin.position.match(/^([A-Z])(\d+)$/);
    if (match) {
      rows.add(match[1]);
      cols.add(parseInt(match[2], 10));
      pinByGrid.set(pin.position, pin);
    }
  }

  const sortedRows = [...rows].sort();
  const sortedCols = [...cols].sort((a, b) => a - b);
  const numRows = sortedRows.length;
  const numCols = sortedCols.length;

  if (numRows === 0 || numCols === 0) return '';

  const rowIndex = new Map(sortedRows.map((r, i) => [r, i]));
  const colIndex = new Map(sortedCols.map((c, i) => [c, i]));

  const margin = 50;
  const labelSpace = 20;
  const availW = width - 2 * margin - labelSpace;
  const availH = height - 2 * margin - labelSpace;
  const cellSize = Math.min(Math.max(8, availW / numCols), Math.max(8, availH / numRows), 24);
  const ballRadius = cellSize * 0.35;

  const gridW = numCols * cellSize;
  const gridH = numRows * cellSize;
  const originX = (width - gridW) / 2 + labelSpace / 2;
  const originY = (height - gridH) / 2 + labelSpace / 2;

  const parts: string[] = [];

  // Background
  parts.push(`<rect width="${width}" height="${height}" fill="${colors.bg}"/>`);

  // Chip body
  const chipPad = cellSize * 0.4;
  parts.push(`<rect x="${originX - chipPad}" y="${originY - chipPad}" width="${gridW + 2 * chipPad}" height="${gridH + 2 * chipPad}" fill="${colors.chipBg}" stroke="${colors.text}" stroke-width="2"/>`);

  // Pin 1 notch
  const ns = 10;
  const nx = originX - chipPad;
  const ny = originY - chipPad;
  parts.push(`<path d="M${nx},${ny} L${nx + ns},${ny} A${ns},${ns} 0 0,0 ${nx},${ny + ns} Z" fill="${colors.text}"/>`);

  // MCU name (top center)
  parts.push(`<text x="${width / 2}" y="12" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-weight="bold" font-size="10" fill="${colors.text}">${esc(mcu.refName)}</text>`);
  parts.push(`<text x="${width / 2}" y="24" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="9" fill="${colors.text}">${esc(mcu.package)}</text>`);

  // Row labels
  for (const row of sortedRows) {
    const ri = rowIndex.get(row)!;
    const ly = originY + ri * cellSize + cellSize / 2;
    parts.push(`<text x="${originX - chipPad - 4}" y="${ly}" text-anchor="end" dominant-baseline="middle" font-family="monospace" font-size="9" fill="${colors.text}">${row}</text>`);
  }

  // Column labels
  for (const col of sortedCols) {
    const ci = colIndex.get(col)!;
    const lx = originX + ci * cellSize + cellSize / 2;
    parts.push(`<text x="${lx}" y="${originY - chipPad - 1}" text-anchor="middle" dominant-baseline="auto" font-family="monospace" font-size="9" fill="${colors.text}">${col}</text>`);
  }

  // Balls
  const fontSize = Math.min(7, cellSize * 0.28);
  for (const pin of mcu.pins) {
    const match = pin.position.match(/^([A-Z])(\d+)$/);
    if (!match) continue;
    const ri = rowIndex.get(match[1]);
    const ci = colIndex.get(parseInt(match[2], 10));
    if (ri === undefined || ci === undefined) continue;

    const bx = originX + ci * cellSize + cellSize / 2;
    const by = originY + ri * cellSize + cellSize / 2;
    const fill = pinColor(pin, assignmentsByPin, portColors, colors);
    const pinAssignments = assignmentsByPin.get(pin.name);
    const hasAssignment = pinAssignments && pinAssignments.length > 0;

    parts.push(`<circle cx="${bx}" cy="${by}" r="${ballRadius}" fill="${fill}" stroke="${colors.text}" stroke-width="0.5"/>`);

    if (cellSize >= 16) {
      const gpio = pin.gpioPort && pin.gpioNumber !== undefined
        ? `P${pin.gpioPort}${pin.gpioNumber}`
        : pin.name.substring(0, 4);
      const textFill = hasAssignment ? '#ffffff' : colors.text;
      parts.push(`<text x="${bx}" y="${by}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="${fontSize}" fill="${textFill}">${esc(gpio)}</text>`);
    }
  }

  return parts.join('\n  ');
}

// ============================================================
// Public API
// ============================================================

export function exportSvg(
  mcu: Mcu,
  assignments: Assignment[],
  portColors: Map<string, string>,
): string {
  const darkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  const isBGA = /BGA|WLCSP/i.test(mcu.package);

  const assignmentsByPin = buildAssignmentMap(assignments);
  const pinCount = mcu.pins.length;

  // Estimate max label width (monospace char width ~= fontSize * 0.6)
  let maxLabelChars = 0;
  for (const pin of mcu.pins) {
    const label = pinLabel(pin, assignmentsByPin);
    if (label.length > maxLabelChars) maxLabelChars = label.length;
  }

  let width: number, height: number;
  if (isBGA) {
    const side = Math.ceil(Math.sqrt(pinCount));
    width = Math.max(400, side * 28 + 140);
    height = width;
  } else {
    const pinsPerSide = Math.floor(pinCount / 4);
    const pinSpacing = 14;
    const pinLength = 14;
    const fontSize = Math.min(9, pinSpacing * 0.65);
    // Monospace char width ~= fontSize * 0.6
    const labelPx = maxLabelChars * fontSize * 0.62 + 10;
    const chipSize = pinsPerSide * pinSpacing + 10;
    // chip + pins on both sides + labels on both sides + padding
    const size = chipSize + 2 * pinLength + 2 * labelPx + 20;
    width = Math.max(400, size);
    height = Math.max(400, size);
  }

  const opts: SvgExportOptions = { mcu, assignments, portColors, width, height, darkMode };
  const content = isBGA ? renderBGASvg(opts) : renderLQFPSvg(opts);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${content}
</svg>`;
}
