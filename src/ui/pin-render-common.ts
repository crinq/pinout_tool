// ============================================================
// Shared pin/pad helpers for the canvas viewer and the SVG export
// (they were byte-identical copies that could drift).
// ============================================================

import type { Assignment, LogicalPin, PhysicalPin } from '../types';

export /** Pick the logical pin best representing a physical pad in the viewer. */
function pickPrimaryLogical(
  phys: PhysicalPin,
  assignmentsByPin: Map<string, Assignment[]>,
): LogicalPin {
  for (const lp of phys.logicals) {
    if (assignmentsByPin.has(lp.name) && assignmentsByPin.get(lp.name)!.length > 0) return lp;
  }
  for (const lp of phys.logicals) if (lp.isDefaultVariant && lp.isAssignable) return lp;
  for (const lp of phys.logicals) if (lp.isAssignable) return lp;
  return phys.logicals[0];
}


export /** Aggregate assignments across every logical bonded to one physical pad. */
function physicalAssignments(
  phys: PhysicalPin,
  assignmentsByPin: Map<string, Assignment[]>,
): Assignment[] {
  const out: Assignment[] = [];
  for (const lp of phys.logicals) {
    const arr = assignmentsByPin.get(lp.name);
    if (arr) out.push(...arr);
  }
  return out;
}

