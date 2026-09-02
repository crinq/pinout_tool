// ============================================================
// Shared helpers for the two solution list panels (solver results
// and project solutions) — these were copy-pasted and had already
// drifted (only one side memoized the counts).
// ============================================================

import type { Solution } from '../types';

/** Unique pins used by a solution (memoized on the solution). */
export function countSolutionPins(solution: Solution): number {
  if (solution._pinCount != null) return solution._pinCount;
  const pins = new Set<string>();
  for (const ca of solution.configAssignments) {
    for (const a of ca.assignments) {
      if (a.portName !== '<pinned>') pins.add(a.pinName);
    }
  }
  solution._pinCount = pins.size;
  return pins.size;
}

/** Total peripheral instances used by a solution (memoized). */
export function countSolutionPeripherals(solution: Solution): number {
  if (solution._peripheralCount != null) return solution._peripheralCount;
  let count = 0;
  for (const peripherals of solution.portPeripherals.values()) {
    count += peripherals.size;
  }
  solution._peripheralCount = count;
  return count;
}

/** Sortable <th> with the current sort direction arrow. */
export function sortHeaderCell(label: string, key: string, sortKey: string, sortDir: 'asc' | 'desc'): string {
  const arrow = sortKey === key ? (sortDir === 'asc' ? ' ^' : ' v') : '';
  return `<th class="st-sortable" data-sort="${key}">${label}${arrow}</th>`;
}

/** Keep the focused row visible below the sticky header of a scroll wrapper. */
export function scrollFocusedRowIntoView(wrapper: HTMLElement): void {
  const row = wrapper.querySelector('tr.st-focused') as HTMLElement | null;
  if (!row) return;

  const thead = wrapper.querySelector('thead');
  const headerHeight = thead ? thead.getBoundingClientRect().height : 0;
  const wrapperRect = wrapper.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();

  // If row is behind the sticky header, scroll it down into view
  if (rowRect.top < wrapperRect.top + headerHeight) {
    wrapper.scrollTop -= (wrapperRect.top + headerHeight - rowRect.top);
  } else if (rowRect.bottom > wrapperRect.bottom) {
    wrapper.scrollTop += (rowRect.bottom - wrapperRect.bottom);
  }
}
