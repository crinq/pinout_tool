// ============================================================
// Port colours
//
// One rule, used everywhere a port is drawn: the minimap, the constraints
// viewer, and — via the map app.ts broadcasts — the package viewer, the SVG
// export, the peripheral summary and the solution table. Keeping it in one
// place is the point: a port that reads red on the right has to be red on the
// package too.
// ============================================================

import type { ProgramNode, PortDeclNode } from '../parser/constraint-ast';
import { contentHash } from '../defaults';

export const PORT_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d8', '#f97316', '#6366f1', '#14b8a6',
];

/** Palette slot a port prefers, from its name — so it keeps its colour when another port is inserted above it. */
function preferredSlot(portName: string): number {
  return parseInt(contentHash(portName), 36) % PORT_PALETTE.length;
}

/**
 * Colour for every port in the program.
 *
 * An explicit `color "..."` always wins. Otherwise the port takes the palette
 * slot its name hashes to, which keeps the colour stable as the file is edited
 * around it. Ten slots and a hash collide often enough to matter (four ports
 * collide about half the time), so a taken slot advances to the next free one:
 * only an actual collision depends on declaration order.
 */
export function buildPortColorMap(ast: ProgramNode | null): Map<string, string> {
  const colors = new Map<string, string>();
  if (!ast) return colors;

  const ports = ast.statements.filter((s): s is PortDeclNode => s.type === 'port_decl');
  const taken = new Set<number>();

  for (const port of ports) {
    if (port.color) {
      colors.set(port.name, port.color);
      continue;
    }
    let slot = preferredSlot(port.name);
    for (let i = 0; i < PORT_PALETTE.length && taken.has(slot); i++) {
      slot = (slot + 1) % PORT_PALETTE.length;
    }
    taken.add(slot);
    colors.set(port.name, PORT_PALETTE[slot]);
  }

  return colors;
}
