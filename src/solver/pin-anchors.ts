// ============================================================
// Placement anchors — geometry + build for the `@ ~...` syntax.
//
// A soft anchor (`@ ~PA1`, `@ ~1`, `@ ~NW`) nudges a channel's pin toward a
// target point via the pin_anchor cost function. A hard fixed anchor on a port
// or config (`@ PA1`) requires some channel to actually land on that pin.
//
// Coordinates are normalized to [0,1] with y=0 = north (top) and x=0 = west
// (left), matching how the package viewer draws a chip (BGA row A on top, LQFP
// pin 1 top-left) — so the compass "rotates with the package".
// ============================================================

import type { Mcu, Solution } from '../types';
import type { ProgramNode, PinAnchor } from '../parser/constraint-ast';
import {
  parseBgaPosition, parsePackagePinCount,
  type AnchorGeom, type SolutionAnchors,
} from './cost-functions';

type XY = { x: number; y: number };

/**
 * Compass region → normalized target point (extreme corner/edge model).
 * Each of N/S/E/W is a unit direction from the package center; the summed
 * direction is ray-cast to the bounding box, so e.g. NW hits the top-left
 * corner and NNW lands on the top edge left-of-center. C blends back toward
 * the center by its share of the letters.
 *   N/S/E/W/C and combinations (NW, NNW, NC). Returns null if unparseable.
 */
export function regionTargetXY(region: string): XY | null {
  const letters = region.toUpperCase().split('');
  if (letters.some(c => !'NSEWC'.includes(c))) return null;

  let dx = 0, dy = 0, cCount = 0;
  for (const c of letters) {
    if (c === 'N') dy -= 1;
    else if (c === 'S') dy += 1;
    else if (c === 'E') dx += 1;
    else if (c === 'W') dx -= 1;
    else cCount++; // C (center)
  }

  let edge: XY = { x: 0.5, y: 0.5 };
  if (dx !== 0 || dy !== 0) {
    const tX = dx !== 0 ? 0.5 / Math.abs(dx) : Infinity;
    const tY = dy !== 0 ? 0.5 / Math.abs(dy) : Infinity;
    const t = Math.min(tX, tY);
    edge = { x: 0.5 + dx * t, y: 0.5 + dy * t };
  }

  const cFrac = letters.length > 0 ? cCount / letters.length : 0;
  return { x: edge.x * (1 - cFrac) + 0.5 * cFrac, y: edge.y * (1 - cFrac) + 0.5 * cFrac };
}

/** Build the normalized-coordinate model for a package (BGA grid or LQFP perimeter). */
export function buildGeom(mcu: Mcu): AnchorGeom {
  const isBGA = /BGA|WLCSP/i.test(mcu.package);

  if (isBGA) {
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    for (const p of mcu.physicalPins) {
      const b = parseBgaPosition(p.position);
      if (!b) continue;
      minRow = Math.min(minRow, b.row); maxRow = Math.max(maxRow, b.row);
      minCol = Math.min(minCol, b.col); maxCol = Math.max(maxCol, b.col);
    }
    const rowSpan = maxRow - minRow || 1;
    const colSpan = maxCol - minCol || 1;
    return {
      scale: Math.max(rowSpan, colSpan) || 1,
      norm(position: string): XY | null {
        const b = parseBgaPosition(position);
        if (!b) return null;
        return { x: (b.col - minCol) / colSpan, y: (b.row - minRow) / rowSpan };
      },
    };
  }

  // LQFP/QFN perimeter: pin 1 top-left, numbering counter-clockwise down the
  // left edge, along the bottom, up the right, across the top.
  const total = parsePackagePinCount(mcu.package);
  const s = total > 0 ? total / 4 : 1;
  return {
    scale: s || 1,
    norm(position: string): XY | null {
      const p = parseInt(position, 10);
      if (isNaN(p)) return null;
      const u = (p - 1) / s; // 0..4 around the perimeter
      let x: number, y: number;
      if (u < 1) { x = 0; y = u; }
      else if (u < 2) { x = u - 1; y = 1; }
      else if (u < 3) { x = 1; y = 3 - u; }
      else { x = 4 - u; y = 0; }
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    },
  };
}

/** Build all placement anchors for a solve from the (macro-expanded) AST + MCU. */
export function buildAnchors(ast: ProgramNode, mcu: Mcu): SolutionAnchors {
  const geom = buildGeom(mcu);

  const resolve = (anchor: PinAnchor): XY | null => {
    if (anchor.kind === 'near_region') return regionTargetXY(anchor.target);
    if (anchor.kind === 'near_pin') {
      const pin = mcu.logicalPinByName.get(anchor.target);
      return pin ? geom.norm(pin.physical.position) : null;
    }
    return geom.norm(anchor.target); // near_pos
  };

  const byChannel = new Map<string, XY[]>();
  const hardPortPins: SolutionAnchors['hardPortPins'] = [];
  const hardConfigPins: SolutionAnchors['hardConfigPins'] = [];
  const add = (portName: string, channelName: string, t: XY | null) => {
    if (!t) return;
    const key = `${portName}\0${channelName}`;
    (byChannel.get(key) ?? byChannel.set(key, []).get(key)!).push(t);
  };

  for (const stmt of ast.statements) {
    if (stmt.type !== 'port_decl') continue;
    const portTarget = stmt.anchor ? resolve(stmt.anchor) : null;

    for (const ch of stmt.channels) {
      if (portTarget) add(stmt.name, ch.name, portTarget);         // port anchor → every channel
      if (ch.anchor) add(stmt.name, ch.name, resolve(ch.anchor));  // channel anchor
    }

    for (const cfg of stmt.configs) {
      if (cfg.anchor) {
        const t = resolve(cfg.anchor);
        for (const item of cfg.body) {
          if (item.type === 'mapping') add(stmt.name, item.channelName, t);
        }
      }
      if (cfg.anchorFixedPins?.length) {
        hardConfigPins.push({ portName: stmt.name, configName: cfg.name, pins: cfg.anchorFixedPins });
      }
    }

    if (stmt.anchorFixedPins?.length) {
      hardPortPins.push({ portName: stmt.name, pins: stmt.anchorFixedPins });
    }
  }

  return { byChannel, geom, hardPortPins, hardConfigPins };
}

/** Drop solutions that fail a hard fixed anchor (`port/config @ PA1`). */
export function filterByHardAnchors(solutions: Solution[], anchors: SolutionAnchors): Solution[] {
  const { hardPortPins, hardConfigPins } = anchors;
  if (hardPortPins.length === 0 && hardConfigPins.length === 0) return solutions;

  return solutions.filter(sol => {
    const portPins = new Set<string>();          // `${port}\0${pin}`
    const configPins = new Set<string>();        // `${port}\0${config}\0${pin}`
    for (const ca of sol.configAssignments) {
      for (const a of ca.assignments) {
        portPins.add(`${a.portName}\0${a.pinName}`);
        configPins.add(`${a.portName}\0${a.configurationName}\0${a.pinName}`);
      }
    }
    for (const { portName, pins } of hardPortPins) {
      if (!pins.every(p => portPins.has(`${portName}\0${p}`))) return false;
    }
    for (const { portName, configName, pins } of hardConfigPins) {
      if (!pins.every(p => configPins.has(`${portName}\0${configName}\0${p}`))) return false;
    }
    return true;
  });
}
