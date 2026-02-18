import type { Panel, StateChange } from './panel';
import type { Assignment } from '../types';

export class PeripheralSummary implements Panel {
  readonly id = 'peripheral-summary';
  readonly title = 'Peripherals';

  private container!: HTMLElement;
  private listEl!: HTMLElement;
  private portColors = new Map<string, string>();
  private portPeripherals = new Map<string, Set<string>>();
  private currentAssignments: Assignment[] = [];

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('peripheral-summary');

    this.listEl = document.createElement('div');
    this.listEl.className = 'ps-list';
    this.container.appendChild(this.listEl);

    this.render();
  }

  onStateChange(change: StateChange): void {
    if (change.type === 'solution-selected') {
      this.portColors = change.portColors ?? new Map();
      this.currentAssignments = change.assignments ?? [];
      this.portPeripherals = this.derivePeripherals(this.currentAssignments);
      this.render();
    } else if (change.type === 'solver-complete') {
      // Only clear when there are no solutions; when solutions exist,
      // the auto-selected solution will fire 'solution-selected' to populate us
      if (!change.solverResult?.solutions?.length) {
        this.portPeripherals.clear();
        this.currentAssignments = [];
        this.render();
      }
    }
  }

  private derivePeripherals(assignments: Assignment[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const a of assignments) {
      const underscoreIdx = a.signalName.indexOf('_');
      if (underscoreIdx === -1) continue;
      const instance = a.signalName.substring(0, underscoreIdx);
      const set = result.get(a.portName) ?? new Set();
      set.add(instance);
      result.set(a.portName, set);
    }
    return result;
  }

  private render(): void {
    if (!this.listEl) return;

    if (this.portPeripherals.size === 0) {
      this.listEl.innerHTML = '<div class="ps-empty">Select a solution to see peripherals</div>';
      return;
    }

    const ports = [...this.portPeripherals.keys()].sort();
    this.listEl.innerHTML = '';

    // Summary line: pin and peripheral counts
    const pins = new Set<string>();
    const peripherals = new Set<string>();
    for (const a of this.currentAssignments) {
      if (a.portName !== '<pinned>') pins.add(a.pinName);
      const ui = a.signalName.indexOf('_');
      if (ui !== -1) peripherals.add(a.signalName.substring(0, ui));
    }
    const summary = document.createElement('div');
    summary.className = 'ps-summary';
    summary.textContent = `${pins.size} pins, ${peripherals.size} peripherals`;
    this.listEl.appendChild(summary);

    for (const port of ports) {
      const peripherals = this.portPeripherals.get(port)!;
      const row = document.createElement('div');
      row.className = 'ps-row';

      const portSpan = document.createElement('span');
      portSpan.className = 'ps-port';
      portSpan.textContent = port;
      const color = this.portColors.get(port);
      if (color) portSpan.style.color = color;

      const perifSpan = document.createElement('span');
      perifSpan.className = 'ps-peripherals';
      perifSpan.textContent = [...peripherals].sort().join(', ');

      row.appendChild(portSpan);
      row.appendChild(perifSpan);
      this.listEl.appendChild(row);
    }
  }
}
