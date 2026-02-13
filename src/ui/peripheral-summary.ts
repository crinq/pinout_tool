import type { Panel, StateChange } from './panel';
import type { Assignment } from '../types';

export class PeripheralSummary implements Panel {
  readonly id = 'peripheral-summary';
  readonly title = 'Peripherals';

  private container!: HTMLElement;
  private listEl!: HTMLElement;
  private portColors = new Map<string, string>();
  private portPeripherals = new Map<string, Set<string>>();

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
      this.portPeripherals = this.derivePeripherals(change.assignments ?? []);
      this.render();
    } else if (change.type === 'solver-complete') {
      this.portPeripherals.clear();
      this.render();
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
