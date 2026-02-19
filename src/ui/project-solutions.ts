import type { Panel, StateChange } from './panel';
import type { Solution } from '../types';

type SortKey = 'id' | 'cost' | 'pins' | 'peripherals';
type SortDir = 'asc' | 'desc';

export class ProjectSolutions implements Panel {
  readonly id = 'project-solutions';
  readonly title = 'Project Solutions';

  private container!: HTMLElement;
  private tableWrapper!: HTMLElement;
  private solutions: Solution[] = [];
  private sortKey: SortKey = 'id';
  private sortDir: SortDir = 'asc';
  private focusedIndex = -1;
  private selectionCallbacks: Array<(solution: Solution) => void> = [];
  private focusCallbacks: Array<() => void> = [];

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('solution-table');

    // Table wrapper
    this.tableWrapper = document.createElement('div');
    this.tableWrapper.className = 'st-table-wrapper';
    this.tableWrapper.tabIndex = 0;
    this.tableWrapper.innerHTML = '<div class="st-empty">No project solutions</div>';
    this.container.appendChild(this.tableWrapper);

    this.tableWrapper.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.tableWrapper.addEventListener('focus', () => {
      for (const cb of this.focusCallbacks) cb();
      // If nothing focused yet, focus first item
      if (this.focusedIndex < 0 && this.solutions.length > 0) {
        this.focusedIndex = 0;
        this.activateItem(0);
        this.render();
      }
    });

  }

  onStateChange(_change: StateChange): void {
    // ProjectSolutions does not react to solver-complete or other state changes.
    // It only gets populated via explicit addSolution/setSolutions calls.
  }

  onSolutionSelected(callback: (solution: Solution) => void): void {
    this.selectionCallbacks.push(callback);
  }

  onFocusGained(callback: () => void): void {
    this.focusCallbacks.push(callback);
  }

  /** Populate from deserialized project data */
  setSolutions(solutions: Solution[]): void {
    this.solutions = [...solutions];
    this.focusedIndex = solutions.length > 0 ? 0 : -1;
    this.render();

    // Auto-select first solution if we have any
    if (this.solutions.length > 0) {
      this.activateItem(0);
    }
  }

  /** Append a solution (e.g. from Enter in solver list) */
  addSolution(solution: Solution): void {
    // Assign an ID within the project list
    const maxId = this.solutions.reduce((m, s) => Math.max(m, s.id), 0);
    const clone = { ...solution, id: maxId + 1 };
    this.solutions.push(clone);
    this.focusedIndex = this.solutions.length - 1;
    this.render();
    this.activateItem(this.focusedIndex);
    this.scrollToFocused();

    // Grab focus so user can see the newly added solution
    this.tableWrapper.focus();
  }

  /** Return the current in-memory solution list */
  getSolutions(): Solution[] {
    return [...this.solutions];
  }

  /** Clear all solutions */
  clear(): void {
    this.solutions = [];
    this.focusedIndex = -1;
    this.render();
  }

  /** Clear visual selection (called when the other list gains focus) */
  deselect(): void {
    this.focusedIndex = -1;
    this.render();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.solutions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(
        this.focusedIndex < 0 ? 0 : this.focusedIndex + 1,
        this.solutions.length - 1,
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
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.renameAtFocus();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteAtFocus();
    }
  }

  private renameAtFocus(): void {
    if (this.focusedIndex < 0 || this.focusedIndex >= this.solutions.length) return;
    const sol = this.solutions[this.focusedIndex];
    const current = sol.name || `Solution ${sol.id}`;
    const newName = prompt('Rename solution:', current);
    if (newName === null) return;
    sol.name = newName.trim() || undefined;
    this.render();
  }

  private deleteAtFocus(): void {
    if (this.focusedIndex < 0 || this.focusedIndex >= this.solutions.length) return;

    this.solutions.splice(this.focusedIndex, 1);

    // Adjust focus
    if (this.focusedIndex >= this.solutions.length) {
      this.focusedIndex = this.solutions.length - 1;
    }

    this.render();

    if (this.solutions.length > 0 && this.focusedIndex >= 0) {
      this.activateItem(this.focusedIndex);
    }
  }

  private activateItem(index: number): void {
    const sol = this.solutions[index];
    if (sol) {
      for (const cb of this.selectionCallbacks) cb(sol);
    }
  }

  private scrollToFocused(): void {
    const row = this.tableWrapper.querySelector('tr.st-focused') as HTMLElement | null;
    if (!row) return;

    const thead = this.tableWrapper.querySelector('thead');
    const headerHeight = thead ? thead.getBoundingClientRect().height : 0;
    const wrapperRect = this.tableWrapper.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();

    if (rowRect.top < wrapperRect.top + headerHeight) {
      this.tableWrapper.scrollTop -= (wrapperRect.top + headerHeight - rowRect.top);
    } else if (rowRect.bottom > wrapperRect.bottom) {
      this.tableWrapper.scrollTop += (rowRect.bottom - wrapperRect.bottom);
    }
  }

  private render(): void {
    if (this.solutions.length === 0) {
      this.tableWrapper.innerHTML = '<div class="st-empty">No project solutions</div>';
      return;
    }

    // Sort solutions
    const sorted = [...this.solutions];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (this.sortKey) {
        case 'id': cmp = a.id - b.id; break;
        case 'cost': cmp = a.totalCost - b.totalCost; break;
        case 'pins': cmp = this.countPins(a) - this.countPins(b); break;
        case 'peripherals': cmp = this.countPeripherals(a) - this.countPeripherals(b); break;
      }
      return this.sortDir === 'asc' ? cmp : -cmp;
    });

    // Map original indices for focus tracking (focusedIndex is into this.solutions, not sorted)
    // Actually, keep focusedIndex as the index into the DISPLAYED (sorted) list for simplicity.
    // But we need to track which solution is focused, not which index.
    // For now: focus is by position in display order.

    const table = document.createElement('table');
    table.className = 'st-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      ${this.headerCell('#', 'id')}
      <th>Name</th>
      ${this.headerCell('Cost', 'cost')}
      ${this.headerCell('Pins', 'pins')}
      ${this.headerCell('Periphs', 'peripherals')}
    </tr>`;
    table.appendChild(thead);

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

    for (let i = 0; i < sorted.length; i++) {
      const sol = sorted[i];
      // Find the original index in this.solutions for focus matching
      const origIdx = this.solutions.indexOf(sol);
      const isFocused = origIdx === this.focusedIndex;

      const tr = document.createElement('tr');
      tr.className = isFocused ? 'st-row-selected st-focused' : '';
      tr.dataset.solutionId = String(sol.id);

      const displayName = sol.name || `Solution ${sol.id}`;
      tr.innerHTML = `
        <td class="st-cell-id">${sol.id}</td>
        <td class="st-cell-name">${this.escapeHtml(displayName)}</td>
        <td class="st-cell-cost">${sol.totalCost.toFixed(1)}</td>
        <td class="st-cell-pins">${this.countPins(sol)}</td>
        <td class="st-cell-perif">${this.countPeripherals(sol)}</td>
      `;

      tr.addEventListener('click', () => {
        this.focusedIndex = origIdx;
        this.activateItem(origIdx);
        this.render();
      });
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    this.tableWrapper.innerHTML = '';
    this.tableWrapper.appendChild(table);
  }

  private headerCell(label: string, key: SortKey): string {
    const arrow = this.sortKey === key ? (this.sortDir === 'asc' ? ' ^' : ' v') : '';
    return `<th class="st-sortable" data-sort="${key}">${label}${arrow}</th>`;
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

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
