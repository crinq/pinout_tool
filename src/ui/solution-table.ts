import type { Panel, StateChange } from './panel';
import type { Solution, SolverResult } from '../types';

type SortKey = 'id' | 'cost' | 'pins' | 'peripherals';
type SortDir = 'asc' | 'desc';

interface SolutionGroup {
  key: string;
  label: string;
  solutions: Solution[];
}

/** A visible row — either a group header or a solution row */
type FlatItem =
  | { type: 'group'; group: SolutionGroup; groupNum: number }
  | { type: 'solution'; solution: Solution; group: SolutionGroup };

export class SolverSolutions implements Panel {
  readonly id = 'solver-solutions';
  readonly title = 'Solver Solutions';

  private container!: HTMLElement;
  private tableWrapper!: HTMLElement;
  private solverResult: SolverResult | null = null;
  private sortKey: SortKey = 'cost';
  private sortDir: SortDir = 'asc';
  private selectionCallbacks: Array<(solution: Solution) => void> = [];
  private saveCallbacks: Array<(solution: Solution) => void> = [];
  private focusCallbacks: Array<() => void> = [];
  private expandedGroups: Set<string> = new Set();

  /** Flat list of visible items for keyboard navigation */
  private flatItems: FlatItem[] = [];
  /** Index into flatItems of the currently focused/selected item (-1 = none) */
  private focusedIndex = -1;
  /** Computed groups (cached between render calls) */
  private groups: SolutionGroup[] = [];
  /** Whether we have multiple groups */
  private multipleGroups = false;

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('solution-table');

    // Table wrapper
    this.tableWrapper = document.createElement('div');
    this.tableWrapper.className = 'st-table-wrapper';
    this.tableWrapper.tabIndex = 0;
    this.tableWrapper.innerHTML = '<div class="st-empty">Run solver to see solutions</div>';
    this.container.appendChild(this.tableWrapper);

    this.tableWrapper.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.tableWrapper.addEventListener('focus', () => {
      for (const cb of this.focusCallbacks) cb();
      // If nothing focused yet, focus first item
      if (this.focusedIndex < 0 && this.flatItems.length > 0) {
        this.focusedIndex = 0;
        this.activateItem(0);
        this.render();
      }
    });
  }

  onStateChange(change: StateChange): void {
    if (change.type === 'solver-complete' && change.solverResult) {
      this.setSolverResult(change.solverResult);
    }
  }

  onSolutionSelected(callback: (solution: Solution) => void): void {
    this.selectionCallbacks.push(callback);
  }

  onSaveRequested(callback: (solution: Solution) => void): void {
    this.saveCallbacks.push(callback);
  }

  onFocusGained(callback: () => void): void {
    this.focusCallbacks.push(callback);
  }

  setSolverResult(result: SolverResult): void {
    this.solverResult = result;
    this.expandedGroups.clear();
    this.focusedIndex = 0;
    this.render();

    // Auto-select first group (previews its first solution)
    if (this.flatItems.length > 0) {
      this.activateItem(0);
      this.tableWrapper.focus();
    }
  }

  /** Clear visual selection (called when the other list gains focus) */
  deselect(): void {
    this.focusedIndex = -1;
    this.render();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.flatItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(
        this.focusedIndex < 0 ? 0 : this.focusedIndex + 1,
        this.flatItems.length - 1,
      );
      this.focusedIndex = next;
      this.activateItem(next);
      this.render();
      this.scrollToFocused();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(this.focusedIndex - 1, 0);
      this.focusedIndex = prev;
      this.activateItem(prev);
      this.render();
      this.scrollToFocused();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.expandAtFocus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.collapseAtFocus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sol = this.getSelectedSolution();
      if (sol) {
        for (const cb of this.saveCallbacks) cb(sol);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteAtFocus();
    }
  }

  /** Remove the focused solution from the result list */
  private deleteAtFocus(): void {
    if (!this.solverResult) return;
    const item = this.flatItems[this.focusedIndex];
    if (!item || item.type !== 'solution') return;

    const sol = item.solution;
    // Remove from the underlying solverResult.solutions array
    const idx = this.solverResult.solutions.indexOf(sol);
    if (idx >= 0) {
      this.solverResult.solutions.splice(idx, 1);
    }

    // Re-render and adjust focus
    this.render();
    if (this.focusedIndex >= this.flatItems.length) {
      this.focusedIndex = Math.max(0, this.flatItems.length - 1);
    }
    if (this.flatItems.length > 0) {
      this.activateItem(this.focusedIndex);
      this.render();
    }
  }

  /** Expand the group at (or containing) the focused item */
  private expandAtFocus(): void {
    const item = this.flatItems[this.focusedIndex];
    if (!item) return;

    const groupKey = item.group.key;

    if (!this.expandedGroups.has(groupKey)) {
      this.expandedGroups.add(groupKey);
      this.render();
      // Keep focus on the same group header
      this.focusedIndex = this.flatItems.findIndex(
        fi => fi.type === 'group' && fi.group.key === groupKey
      );
      if (this.focusedIndex === -1) this.focusedIndex = 0;
      this.scrollToFocused();
    }
  }

  /** Collapse the group at (or containing) the focused item, then select the group */
  private collapseAtFocus(): void {
    const item = this.flatItems[this.focusedIndex];
    if (!item) return;

    const groupKey = item.group.key;

    if (this.expandedGroups.has(groupKey)) {
      this.expandedGroups.delete(groupKey);
      this.render();
      // Focus the group header
      this.focusedIndex = this.flatItems.findIndex(
        fi => fi.type === 'group' && fi.group.key === groupKey
      );
      if (this.focusedIndex === -1) this.focusedIndex = 0;
      this.activateItem(this.focusedIndex);
      this.render();
      this.scrollToFocused();
    }
  }

  /** Activate an item: preview its solution (for groups, preview the first solution) */
  private activateItem(index: number): void {
    const item = this.flatItems[index];
    if (!item) return;

    if (item.type === 'group') {
      const first = item.group.solutions[0];
      if (first) {
        for (const cb of this.selectionCallbacks) cb(first);
      }
    } else {
      for (const cb of this.selectionCallbacks) cb(item.solution);
    }
  }

  private scrollToFocused(): void {
    const row = this.tableWrapper.querySelector('tr.st-focused') as HTMLElement | null;
    if (!row) return;

    const thead = this.tableWrapper.querySelector('thead');
    const headerHeight = thead ? thead.getBoundingClientRect().height : 0;
    const wrapperRect = this.tableWrapper.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();

    // If row is behind the sticky header, scroll it down into view
    if (rowRect.top < wrapperRect.top + headerHeight) {
      this.tableWrapper.scrollTop -= (wrapperRect.top + headerHeight - rowRect.top);
    } else if (rowRect.bottom > wrapperRect.bottom) {
      this.tableWrapper.scrollTop += (rowRect.bottom - wrapperRect.bottom);
    }
  }

  private render(): void {
    if (!this.solverResult || this.solverResult.solutions.length === 0) {
      this.tableWrapper.innerHTML = '<div class="st-empty">Run solver to see solutions</div>';
      this.flatItems = [];
      return;
    }

    const result = this.solverResult;

    // Group and sort solutions
    this.groups = this.groupSolutions(result.solutions);
    this.multipleGroups = this.groups.length > 1;

    // Build flat items list for navigation
    this.flatItems = [];
    for (let gi = 0; gi < this.groups.length; gi++) {
      const group = this.groups[gi];
      if (this.multipleGroups) {
        this.flatItems.push({ type: 'group', group, groupNum: gi + 1 });
      }
      if (!this.multipleGroups || this.expandedGroups.has(group.key)) {
        for (const sol of group.solutions) {
          this.flatItems.push({ type: 'solution', solution: sol, group });
        }
      }
    }

    // Clamp focus index
    if (this.focusedIndex >= this.flatItems.length) {
      this.focusedIndex = Math.max(0, this.flatItems.length - 1);
    }

    // Build table
    const table = document.createElement('table');
    table.className = 'st-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      ${this.headerCell('#', 'id')}
      ${this.headerCell('Cost', 'cost')}
      ${this.headerCell('Pins', 'pins')}
      ${this.headerCell('Periphs', 'peripherals')}
      <th>Solver</th>
    </tr>`;
    table.appendChild(thead);

    // Bind header clicks
    thead.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = (th as HTMLElement).dataset.sort as SortKey;
        if (this.sortKey === key) {
          this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortKey = key;
          this.sortDir = 'asc';
        }
        this.render();
      });
    });

    // Body
    const tbody = document.createElement('tbody');

    for (let fi = 0; fi < this.flatItems.length; fi++) {
      const item = this.flatItems[fi];
      const isFocused = fi === this.focusedIndex;

      if (item.type === 'group') {
        const group = item.group;
        const isExpanded = this.expandedGroups.has(group.key);

        const groupTr = document.createElement('tr');
        groupTr.className = 'st-group-header'
          + (isExpanded ? ' st-group-expanded' : '')
          + (isFocused ? ' st-focused' : '');
        const groupTd = document.createElement('td');
        groupTd.colSpan = 5;
        const arrow = isExpanded ? '\u25BE' : '\u25B8';
        const best = group.solutions[0];
        const bestCost = best ? `, best ${best.totalCost.toFixed(1)}` : '';
        groupTd.textContent = `${arrow} Group ${item.groupNum}: ${group.solutions.length} solutions${bestCost}`;
        groupTr.appendChild(groupTd);

        const idx = fi;
        groupTr.addEventListener('click', () => {
          this.focusedIndex = idx;
          if (this.expandedGroups.has(group.key)) {
            this.expandedGroups.delete(group.key);
          } else {
            this.expandedGroups.add(group.key);
          }
          this.activateItem(idx);
          this.render();
        });
        tbody.appendChild(groupTr);
      } else {
        const sol = item.solution;
        const tr = document.createElement('tr');
        tr.className = (isFocused ? 'st-row-selected st-focused' : '');
        tr.dataset.solutionId = String(sol.id);

        tr.innerHTML = `
          <td class="st-cell-id">${sol.id}</td>
          <td class="st-cell-cost">${sol.totalCost.toFixed(1)}</td>
          <td class="st-cell-pins">${this.countPins(sol)}</td>
          <td class="st-cell-perif">${this.countPeripherals(sol)}</td>
          <td class="st-cell-solver">${this.solverShortLabel(sol.solverOrigin)}</td>
        `;

        const idx = fi;
        tr.addEventListener('click', () => {
          this.focusedIndex = idx;
          this.activateItem(idx);
          this.render();
        });
        tbody.appendChild(tr);
      }
    }

    table.appendChild(tbody);
    this.tableWrapper.innerHTML = '';
    this.tableWrapper.appendChild(table);
  }

  private groupSolutions(solutions: Solution[]): SolutionGroup[] {
    const groupMap = new Map<string, SolutionGroup>();

    for (const sol of solutions) {
      const key = this.peripheralKey(sol);
      let group = groupMap.get(key);
      if (!group) {
        group = { key, label: this.peripheralLabel(sol), solutions: [] };
        groupMap.set(key, group);
      }
      group.solutions.push(sol);
    }

    // Sort solutions within each group
    for (const group of groupMap.values()) {
      group.solutions.sort((a, b) => {
        let cmp = 0;
        switch (this.sortKey) {
          case 'id': cmp = a.id - b.id; break;
          case 'cost': cmp = a.totalCost - b.totalCost; break;
          case 'pins': cmp = this.countPins(a) - this.countPins(b); break;
          case 'peripherals': cmp = this.countPeripherals(a) - this.countPeripherals(b); break;
        }
        return this.sortDir === 'asc' ? cmp : -cmp;
      });
    }

    // Sort groups by best cost in each group
    const groups = [...groupMap.values()];
    groups.sort((a, b) => {
      const aBest = a.solutions[0]?.totalCost ?? 0;
      const bBest = b.solutions[0]?.totalCost ?? 0;
      return aBest - bBest;
    });

    return groups;
  }

  /** Create a stable grouping key from port -> peripherals mapping */
  private peripheralKey(solution: Solution): string {
    const parts: string[] = [];
    const sortedPorts = [...solution.portPeripherals.keys()].sort();
    for (const port of sortedPorts) {
      const peripherals = [...solution.portPeripherals.get(port)!].sort();
      parts.push(`${port}:${peripherals.join(',')}`);
    }
    return parts.join('|');
  }

  /** Create a compact label listing unique peripherals across all ports */
  private peripheralLabel(solution: Solution): string {
    const allPeripherals = new Set<string>();
    for (const peripherals of solution.portPeripherals.values()) {
      for (const p of peripherals) allPeripherals.add(p);
    }
    return [...allPeripherals].sort().join(', ');
  }

  private headerCell(label: string, key: SortKey): string {
    const arrow = this.sortKey === key ? (this.sortDir === 'asc' ? ' ^' : ' v') : '';
    return `<th class="st-sortable" data-sort="${key}">${label}${arrow}</th>`;
  }

  private getSelectedSolution(): Solution | null {
    const item = this.flatItems[this.focusedIndex];
    if (!item) return null;
    if (item.type === 'solution') return item.solution;
    // For group focus, return first solution
    if (item.type === 'group') return item.group.solutions[0] ?? null;
    return null;
  }

  private countPins(solution: Solution): number {
    const pins = new Set<string>();
    for (const ca of solution.configAssignments) {
      for (const a of ca.assignments) {
        if (a.portName !== '<pinned>') pins.add(a.pinName);
      }
    }
    return pins.size;
  }

  private countPeripherals(solution: Solution): number {
    let count = 0;
    for (const peripherals of solution.portPeripherals.values()) {
      count += peripherals.size;
    }
    return count;
  }

  private static SOLVER_SHORT_LABELS: Record<string, string> = {
    'backtracking': 'BT',
    'two-phase': '2Ph',
    'randomized-restarts': 'Rnd',
    'cost-guided': 'CG',
    'diverse-instances': 'Div',
    'ac3': 'AC3',
    'dynamic-mrv': 'MRV',
  };

  private solverShortLabel(origin?: string): string {
    if (!origin) return '';
    return SolverSolutions.SOLVER_SHORT_LABELS[origin] ?? origin;
  }

}
