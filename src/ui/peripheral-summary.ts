import type { Panel, StateChange } from './panel';
import type { Mcu, Assignment } from '../types';

export class PeripheralSummary implements Panel {
  readonly id = 'peripheral-summary';
  readonly title = 'Peripherals';

  private container!: HTMLElement;
  private listEl!: HTMLElement;
  private mcu: Mcu | null = null;
  private portColors = new Map<string, string>();
  private portPeripherals = new Map<string, Set<string>>();
  private currentAssignments: Assignment[] = [];
  private totalAssignablePins = 0;
  private gpioCount = 0;
  private dmaStreamAssignment = new Map<string, string>();

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
      this.gpioCount = change.gpioCount ?? 0;
      this.dmaStreamAssignment = change.dmaStreamAssignment ?? new Map();
      this.portPeripherals = this.derivePeripherals(this.currentAssignments);
      this.render();
    } else if (change.type === 'mcu-loaded' && change.mcu) {
      this.mcu = change.mcu;
      this.totalAssignablePins = change.mcu.pins.filter(p => p.isAssignable).length;
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

  /**
   * Abbreviate a DMA stream name: "DMA2_Stream7" → "D2S7", "DMA1_Stream0" → "D1S0"
   */
  private shortStream(name: string): string {
    const m = name.match(/DMA(\d+)_Stream(\d+)/);
    return m ? `D${m[1]}S${m[2]}` : name;
  }

  /**
   * Build per-instance DMA stream info for a port's assignments.
   * Returns a map of peripheralInstance → list of abbreviated stream names.
   * e.g. "USART1" → ["D2S7", "D2S2"]
   */
  private deriveDmaByInstance(
    portAssignments: Assignment[],
    dmaMap: Map<string, string>
  ): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const a of portAssignments) {
      const ui = a.signalName.indexOf('_');
      if (ui === -1) continue;
      const instance = a.signalName.substring(0, ui);
      const stream = dmaMap.get(a.signalName);
      if (!stream) continue;
      const arr = result.get(instance) ?? [];
      const short = this.shortStream(stream);
      if (!arr.includes(short)) arr.push(short);
      result.set(instance, arr);
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

    const dmaMap = this.dmaStreamAssignment;

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
    const freePins = this.totalAssignablePins > 0
      ? this.totalAssignablePins - pins.size
      : 0;
    const pinText = this.totalAssignablePins > 0
      ? `${pins.size}/${this.totalAssignablePins} pins (${freePins} free)`
      : `${pins.size} pins`;
    const gpioText = this.gpioCount > 0 ? `, ${this.gpioCount} GPIOs` : '';
    const dmaCount = new Set(dmaMap.values()).size;
    const dmaText = dmaCount > 0 ? `, ${dmaCount} DMA streams` : '';
    summary.textContent = `${pinText}, ${peripherals.size} peripherals${gpioText}${dmaText}`;
    this.listEl.appendChild(summary);

    for (const port of ports) {
      const portPeripherals = this.portPeripherals.get(port)!;
      const row = document.createElement('div');
      row.className = 'ps-row';

      const portSpan = document.createElement('span');
      portSpan.className = 'ps-port';
      portSpan.textContent = port;
      const color = this.portColors.get(port);
      if (color) portSpan.style.color = color;

      // Build peripheral list with inline DMA info
      // e.g. "SPI1(D1S0, D1S2), USART1"
      const portAssignments = this.currentAssignments.filter(a => a.portName === port);
      const instanceDma = this.deriveDmaByInstance(portAssignments, dmaMap);

      const perifParts: string[] = [];
      for (const inst of [...portPeripherals].sort()) {
        const dmaStreams = instanceDma.get(inst);
        if (dmaStreams && dmaStreams.length > 0) {
          perifParts.push(`${inst}(${dmaStreams.join(', ')})`);
        } else {
          perifParts.push(inst);
        }
      }

      const perifSpan = document.createElement('span');
      perifSpan.className = 'ps-peripherals';
      perifSpan.textContent = perifParts.join(', ');

      row.appendChild(portSpan);
      row.appendChild(perifSpan);
      this.listEl.appendChild(row);
    }

    this.renderUnused(peripherals);
  }

  /**
   * Render unused peripheral instances and free DMA streams.
   */
  private renderUnused(usedInstances: Set<string>): void {
    const mcu = this.mcu;
    if (!mcu) return;

    // Collect all pin-mappable instances (those that have signals on pins)
    const allInstances = new Set<string>();
    for (const instance of mcu.peripheralSignals.keys()) {
      allInstances.add(instance);
    }

    // Group unused instances by peripheral type
    const unusedByType = new Map<string, string[]>();
    for (const instance of allInstances) {
      if (usedInstances.has(instance)) continue;
      const p = mcu.peripheralByInstance.get(instance);
      const type = p?.type ?? instance;
      if (type === 'GPIO' || type === 'RCC' || type === 'SYS') continue;
      const arr = unusedByType.get(type) ?? [];
      arr.push(instance);
      unusedByType.set(type, arr);
    }

    if (unusedByType.size > 0) {
      const section = document.createElement('div');
      section.className = 'ps-unused';

      const header = document.createElement('div');
      header.className = 'ps-unused-header';
      const totalUnused = [...unusedByType.values()].reduce((s, a) => s + a.length, 0);
      header.textContent = `${totalUnused} unused peripherals`;
      section.appendChild(header);

      const types = [...unusedByType.keys()].sort();
      for (const type of types) {
        const instances = unusedByType.get(type)!.sort();
        const row = document.createElement('div');
        row.className = 'ps-unused-row';
        row.textContent = `${type}: ${instances.join(', ')}`;
        section.appendChild(row);
      }

      this.listEl.appendChild(section);
    }

    // Free DMA streams
    if (mcu.dma) {
      const usedStreamNames = new Set(this.dmaStreamAssignment.values());
      const freeStreams = mcu.dma.streams
        .filter(s => !usedStreamNames.has(s.name))
        .map(s => this.shortStream(s.name));

      if (freeStreams.length > 0) {
        const section = document.createElement('div');
        section.className = 'ps-unused';

        const header = document.createElement('div');
        header.className = 'ps-unused-header';
        header.textContent = `${freeStreams.length}/${mcu.dma.streams.length} free DMA streams`;
        section.appendChild(header);

        const row = document.createElement('div');
        row.className = 'ps-unused-row';
        row.textContent = freeStreams.join(', ');
        section.appendChild(row);

        this.listEl.appendChild(section);
      }
    }
  }
}
