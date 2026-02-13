import type { Panel, StateChange } from './panel';
import type { Solution, SolverResult, Assignment } from '../types';

type SortKey = 'id' | 'cost' | 'pins' | 'peripherals';
type SortDir = 'asc' | 'desc';

export class SolutionTable implements Panel {
  readonly id = 'solution-table';
  readonly title = 'Solutions';

  private container!: HTMLElement;
  private tableWrapper!: HTMLElement;
  private solverResult: SolverResult | null = null;
  private selectedSolutionId: number | null = null;
  private sortKey: SortKey = 'cost';
  private sortDir: SortDir = 'asc';
  private selectionCallbacks: Array<(solution: Solution) => void> = [];
  private sortedSolutions: Solution[] = [];
  private focusedIndex = 0;

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('solution-table');

    // Table wrapper
    this.tableWrapper = document.createElement('div');
    this.tableWrapper.className = 'st-table-wrapper';
    this.tableWrapper.tabIndex = 0;
    this.tableWrapper.innerHTML = '<div class="st-empty">Load MCU and enter constraints, then click Solve</div>';
    this.container.appendChild(this.tableWrapper);

    this.tableWrapper.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  onStateChange(change: StateChange): void {
    if (change.type === 'solver-complete' && change.solverResult) {
      this.setSolverResult(change.solverResult);
    }
  }

  onSolutionSelected(callback: (solution: Solution) => void): void {
    this.selectionCallbacks.push(callback);
  }

  setSolverResult(result: SolverResult): void {
    this.solverResult = result;
    this.selectedSolutionId = null;
    this.focusedIndex = 0;
    this.render();

    // Auto-select first solution
    if (this.sortedSolutions.length > 0) {
      this.selectSolution(this.sortedSolutions[0]);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.sortedSolutions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusedIndex = Math.min(this.focusedIndex + 1, this.sortedSolutions.length - 1);
      this.selectSolution(this.sortedSolutions[this.focusedIndex]);
      this.scrollToFocused();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
      this.selectSolution(this.sortedSolutions[this.focusedIndex]);
      this.scrollToFocused();
    }
  }

  private scrollToFocused(): void {
    const row = this.tableWrapper.querySelector(`tr[data-solution-id="${this.selectedSolutionId}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  private render(): void {
    if (!this.solverResult) {
      this.tableWrapper.innerHTML = '<div class="st-empty">No solutions yet</div>';
      return;
    }

    const result = this.solverResult;

    // Sort solutions
    this.sortedSolutions = [...result.solutions];
    const sorted = this.sortedSolutions;
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

    // Build table
    const table = document.createElement('table');
    table.className = 'st-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      ${this.headerCell('#', 'id')}
      ${this.headerCell('Cost', 'cost')}
      ${this.headerCell('Pins', 'pins')}
      ${this.headerCell('Peripherals', 'peripherals')}
      <th>Assignments</th>
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
    const displayCount = Math.min(sorted.length, 200);

    for (let i = 0; i < displayCount; i++) {
      const sol = sorted[i];
      const tr = document.createElement('tr');
      tr.className = sol.id === this.selectedSolutionId ? 'st-row-selected' : '';
      tr.dataset.solutionId = String(sol.id);

      const assignments = this.getAllAssignments(sol);
      const summary = assignments
        .filter(a => a.portName !== '<pinned>')
        .slice(0, 6)
        .map(a => `${a.channelName}:${this.abbreviatePin(a.pinName)}=${this.abbreviateSignal(a.signalName)}`)
        .join(', ');
      const more = assignments.length > 6 ? ` +${assignments.length - 6}` : '';

      tr.innerHTML = `
        <td class="st-cell-id">${sol.id}</td>
        <td class="st-cell-cost">${sol.totalCost.toFixed(1)}</td>
        <td class="st-cell-pins">${this.countPins(sol)}</td>
        <td class="st-cell-perif">${this.countPeripherals(sol)}</td>
        <td class="st-cell-assign">${summary}${more}</td>
      `;

      tr.addEventListener('click', () => {
        this.focusedIndex = i;
        this.selectSolution(sol);
      });
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    this.tableWrapper.innerHTML = '';
    this.tableWrapper.appendChild(table);

    if (sorted.length > displayCount) {
      const more = document.createElement('div');
      more.className = 'st-more';
      more.textContent = `Showing ${displayCount} of ${sorted.length} solutions`;
      this.tableWrapper.appendChild(more);
    }

  }

  private headerCell(label: string, key: SortKey): string {
    const arrow = this.sortKey === key ? (this.sortDir === 'asc' ? ' ^' : ' v') : '';
    return `<th class="st-sortable" data-sort="${key}">${label}${arrow}</th>`;
  }

  private selectSolution(solution: Solution): void {
    this.selectedSolutionId = solution.id;
    this.render();
    for (const cb of this.selectionCallbacks) {
      cb(solution);
    }
  }

  private getAllAssignments(solution: Solution): Assignment[] {
    // Use first config combination for display summary
    if (solution.configAssignments.length === 0) return [];
    return solution.configAssignments[0].assignments;
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

  private abbreviatePin(name: string): string {
    // PA4 -> PA4, keep short
    return name.length > 5 ? name.substring(0, 5) : name;
  }

  private abbreviateSignal(name: string): string {
    return name.length > 12 ? name.substring(0, 10) + '..' : name;
  }
}
