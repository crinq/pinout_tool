import type { Mcu, Pin, Signal, Assignment } from '../types';
import type { Panel, StateChange } from './panel';
import { parseSearchPattern } from '../parser/constraint-parser';
import { expandPatternToCandidates } from '../solver/pattern-matcher';

interface PinRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pin: Pin;
  labelX: number;
  labelY: number;
  labelRotation: number;
  side: 'left' | 'top' | 'right' | 'bottom';
}

export class PackageViewer implements Panel {
  readonly id = 'package-viewer';
  readonly title = 'Package Viewer';

  private container!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private tooltip!: HTMLElement;
  private mcu: Mcu | null = null;
  private assignments: Assignment[] = [];
  private portColors: Map<string, string> = new Map();
  private pinRects: PinRect[] = [];
  private hoveredPin: Pin | null = null;
  private selectedPin: Pin | null = null;
  private pinClickCallbacks: Array<(pin: Pin) => void> = [];
  private popup: HTMLElement | null = null;
  private popupCloseHandler: ((ev: MouseEvent) => void) | null = null;
  private pinAssignCallbacks: Array<(pinName: string, signalName: string) => void> = [];
  private pinUnassignCallbacks: Array<(pinName: string) => void> = [];
  private pinDeclLookup: ((pinName: string) => string | null) | null = null;

  // View transform state
  private zoom = 1;
  private rotation = 0; // 0, 1, 2, 3 => 0°, 90°, 180°, 270°
  private zoomLabel!: HTMLElement;
  private minZoom = 0.3;
  private maxZoom = 5;
  private mouseZoomGain = 0.1;

  // Search / highlight state
  private searchInput!: HTMLInputElement;
  private searchMatchPins: Set<string> = new Set();
  private searchMatchSignals: Set<string> = new Set();
  private searchAnimationId: number | null = null;
  private searchAnimPhase = 0;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Hover-based signal highlight state
  private hoverMatchPins: Set<string> = new Set();
  private signalToPins: Map<string, string[]> = new Map();

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('package-viewer');

    // View toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'pv-toolbar';
    toolbar.innerHTML = `
      <button class="btn btn-small pv-btn" title="Zoom in">+</button>
      <button class="btn btn-small pv-btn" title="Zoom out">&minus;</button>
      <span class="pv-zoom-label">100%</span>
      <button class="btn btn-small pv-btn" title="Rotate 90° clockwise">&#x21BB;</button>
      <button class="btn btn-small pv-btn" title="Reset view">Reset</button>
    `;
    this.container.appendChild(toolbar);

    const buttons = toolbar.querySelectorAll('.pv-btn');
    buttons[0].addEventListener('click', () => this.zoomBy(0.2));
    buttons[1].addEventListener('click', () => this.zoomBy(-0.2));
    this.zoomLabel = toolbar.querySelector('.pv-zoom-label')!;
    buttons[2].addEventListener('click', () => this.rotateCW());
    buttons[3].addEventListener('click', () => this.resetView());

    // Search input
    const separator = document.createElement('span');
    separator.className = 'pv-toolbar-separator';
    toolbar.appendChild(separator);

    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.className = 'pv-search-input';
    this.searchInput.placeholder = 'Search signals...';
    this.searchInput.title = 'Search: TIM*_CH1, ADC*_IN[1-4], PA0';
    toolbar.appendChild(this.searchInput);

    this.searchInput.addEventListener('input', () => {
      if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = setTimeout(() => {
        this.executeSearch(this.searchInput.value);
      }, 150);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.searchInput.value = '';
        this.executeSearch('');
        this.searchInput.blur();
      }
    });

    // Export buttons
    const exportSep = document.createElement('span');
    exportSep.className = 'pv-toolbar-separator';
    toolbar.appendChild(exportSep);

    const exportPngBtn = document.createElement('button');
    exportPngBtn.className = 'btn btn-small pv-btn';
    exportPngBtn.title = 'Export view as PNG image';
    exportPngBtn.textContent = 'PNG';
    exportPngBtn.addEventListener('click', () => this.exportImage());
    toolbar.appendChild(exportPngBtn);

    const exportJsonBtn = document.createElement('button');
    exportJsonBtn.className = 'btn btn-small pv-btn';
    exportJsonBtn.title = 'Export solution as JSON';
    exportJsonBtn.textContent = 'JSON';
    exportJsonBtn.addEventListener('click', () => this.exportJSON());
    toolbar.appendChild(exportJsonBtn);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'package-canvas';
    this.container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'pin-tooltip';
    this.tooltip.style.display = 'none';
    this.container.appendChild(this.tooltip);

    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? -this.mouseZoomGain : this.mouseZoomGain);
    }, { passive: false });

    const resizeObserver = new ResizeObserver(() => this.render());
    resizeObserver.observe(this.container);
  }

  onStateChange(change: StateChange): void {
    if (change.type === 'mcu-loaded' && change.mcu) {
      this.setMcu(change.mcu);
    }
    if (change.type === 'solution-selected' && change.assignments) {
      this.portColors = change.portColors || new Map();
      this.setAssignments(change.assignments);
    }
    if (change.type === 'theme-changed') {
      this.render();
    }
  }

  setMcu(mcu: Mcu): void {
    this.mcu = mcu;
    this.assignments = [];
    this.hoveredPin = null;
    this.selectedPin = null;
    this.hoverMatchPins.clear();
    if (this.searchInput) this.searchInput.value = '';
    this.searchMatchPins.clear();
    this.searchMatchSignals.clear();
    this.stopSearchAnimation();
    this.buildSignalToPins(mcu);
    this.render();
  }

  setAssignments(assignments: Assignment[]): void {
    this.assignments = assignments;
    this.render();
  }

  onPinClick(callback: (pin: Pin) => void): void {
    this.pinClickCallbacks.push(callback);
  }

  setZoomLimits(minZoom: number, maxZoom: number, mouseZoomGain: number): void {
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.mouseZoomGain = mouseZoomGain;
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));
    if (this.zoomLabel) {
      this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    }
  }

  onPinAssign(callback: (pinName: string, signalName: string) => void): void {
    this.pinAssignCallbacks.push(callback);
  }

  onPinUnassign(callback: (pinName: string) => void): void {
    this.pinUnassignCallbacks.push(callback);
  }

  setPinDeclLookup(fn: (pinName: string) => string | null): void {
    this.pinDeclLookup = fn;
  }

  private zoomBy(delta: number): void {
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta));
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.render();
  }

  private rotateCW(): void {
    this.rotation = (this.rotation + 1) % 4;
    this.render();
  }

  private resetView(): void {
    this.zoom = 1;
    this.rotation = 0;
    this.zoomLabel.textContent = '100%';
    this.render();
  }

  private exportImage(): void {
    if (!this.mcu) return;
    const dataUrl = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${this.mcu.refName}_pinout.png`;
    a.click();
  }

  private exportJSON(): void {
    if (!this.mcu || this.assignments.length === 0) return;

    const data = {
      mcuRef: this.mcu.refName,
      package: this.mcu.package,
      assignments: this.assignments.map(a => ({
        pinName: a.pinName,
        signalName: a.signalName,
        portName: a.portName,
        channelName: a.channelName,
        configurationName: a.configurationName,
      })),
      portColors: Object.fromEntries(this.portColors),
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.mcu.refName}_solution.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  render(): void {
    if (!this.mcu) {
      this.renderEmpty();
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    // Use canvas rect (not container) since toolbar takes space above
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;

    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Apply view transform (zoom + rotation around center)
    const cx = width / 2;
    const cy = height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(this.rotation * Math.PI / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-cx, -cy);

    if (this.isBGA()) {
      this.renderBGA(ctx, width, height);
    } else {
      this.renderLQFP(ctx, width, height);
    }

  }

  private isBGA(): boolean {
    const pkg = this.mcu?.package ?? '';
    return /BGA|WLCSP/i.test(pkg);
  }

  private renderEmpty(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;

    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = 'var(--text-secondary, #666)';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Drop an MCU XML file to view package', width / 2, height / 2);
  }

  private renderLQFP(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const mcu = this.mcu!;
    const totalPins = mcu.pins.length;

    // Parse pin count from package name (e.g., "LQFP100" -> 100)
    const packageMatch = mcu.package.match(/(\d+)/);
    const packagePinCount = packageMatch ? parseInt(packageMatch[1], 10) : totalPins;
    const pinsPerSide = Math.floor(packagePinCount / 4);

    // Layout parameters
    const margin = 80;
    const pinLength = 14;
    const pinWidth = Math.min(8, Math.max(3, (Math.min(width, height) - 2 * margin - 40) / pinsPerSide * 0.7));
    const pinSpacing = Math.min(14, (Math.min(width, height) - 2 * margin - 40) / pinsPerSide);

    const chipSize = pinsPerSide * pinSpacing + 10;
    const chipX = (width - chipSize) / 2;
    const chipY = (height - chipSize) / 2;

    // Draw chip body
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim() || '#f5f5f5';
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1a1a1a';
    ctx.lineWidth = 2;
    ctx.fillRect(chipX, chipY, chipSize, chipSize);
    ctx.strokeRect(chipX, chipY, chipSize, chipSize);

    // Pin 1 marker (notch at top-left corner of chip, near pin 1)
    const notchSize = 12;
    ctx.beginPath();
    ctx.moveTo(chipX, chipY);
    ctx.lineTo(chipX + notchSize, chipY);
    ctx.arc(chipX + notchSize, chipY + notchSize, notchSize, -Math.PI / 2, Math.PI, true);
    ctx.lineTo(chipX, chipY);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1a1a1a';
    ctx.fill();

    // Draw MCU name in center
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1a1a1a';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mcu.refName, chipX + chipSize / 2, chipY + chipSize / 2 - 8);
    ctx.font = '10px monospace';
    ctx.fillText(mcu.package, chipX + chipSize / 2, chipY + chipSize / 2 + 8);

    // Build assignment lookup (grouped by pin, all configs)
    const assignmentsByPin = new Map<string, Assignment[]>();
    for (const a of this.assignments) {
      if (!assignmentsByPin.has(a.pinName)) assignmentsByPin.set(a.pinName, []);
      assignmentsByPin.get(a.pinName)!.push(a);
    }

    // Compute pin positions (LQFP standard: pin 1 at top-left, counterclockwise)
    // Left side: top→bottom, Bottom side: left→right, Right side: bottom→top, Top side: right→left
    this.pinRects = [];

    // Sort pins by position
    const sortedPins = [...mcu.pins].sort((a, b) => parseInt(a.position, 10) - parseInt(b.position, 10));

    for (let i = 0; i < sortedPins.length && i < packagePinCount; i++) {
      const pin = sortedPins[i];
      const sideIndex = Math.floor(i / pinsPerSide);
      const indexOnSide = i % pinsPerSide;

      let x = 0, y = 0, pw = 0, ph = 0;
      let labelX = 0, labelY = 0, labelRotation = 0;
      let side: PinRect['side'] = 'left';

      const offset = 5 + indexOnSide * pinSpacing + pinSpacing / 2;

      switch (sideIndex) {
        case 0: // Left side (top to bottom)
          x = chipX - pinLength;
          y = chipY + offset - pinWidth / 2;
          pw = pinLength;
          ph = pinWidth;
          labelX = x - 3;
          labelY = y + pinWidth / 2;
          labelRotation = 0;
          side = 'left';
          break;
        case 1: // Bottom side (left to right)
          x = chipX + offset - pinWidth / 2;
          y = chipY + chipSize;
          pw = pinWidth;
          ph = pinLength;
          labelX = x + pinWidth / 2;
          labelY = y + pinLength + 3;
          labelRotation = -Math.PI / 2;
          side = 'bottom';
          break;
        case 2: // Right side (bottom to top)
          x = chipX + chipSize;
          y = chipY + chipSize - offset - pinWidth / 2;
          pw = pinLength;
          ph = pinWidth;
          labelX = x + pinLength + 3;
          labelY = y + pinWidth / 2;
          labelRotation = 0;
          side = 'right';
          break;
        case 3: // Top side (right to left)
          x = chipX + chipSize - offset - pinWidth / 2;
          y = chipY - pinLength;
          pw = pinWidth;
          ph = pinLength;
          labelX = x + pinWidth / 2;
          labelY = y - 3;
          labelRotation = -Math.PI / 2;
          side = 'top';
          break;
      }

      this.pinRects.push({ x, y, width: pw, height: ph, pin, labelX, labelY, labelRotation, side });

      // Determine pin color
      const pinAssignments = assignmentsByPin.get(pin.name);
      const isHovered = this.hoveredPin === pin;
      const isSelected = this.selectedPin === pin;

      let fillColor: string;
      if (isHovered) {
        fillColor = '#fbbf24'; // yellow
      } else if (isSelected) {
        fillColor = '#f97316'; // orange
      } else if (pinAssignments && pinAssignments.length > 0) {
        // Use port color if set, otherwise default assigned color
        const portName = pinAssignments.find(a => a.portName !== '<pinned>')?.portName;
        const portColor = portName ? this.portColors.get(portName) : undefined;
        fillColor = portColor || getComputedStyle(document.documentElement).getPropertyValue('--pin-assigned').trim() || '#3b82f6';
      } else if (!pin.isAssignable) {
        fillColor = getComputedStyle(document.documentElement).getPropertyValue('--pin-reserved').trim() || '#374151';
      } else {
        fillColor = getComputedStyle(document.documentElement).getPropertyValue('--pin-unassigned').trim() || '#9ca3af';
      }

      ctx.fillStyle = fillColor;
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1a1a1a';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, pw, ph);

      // Draw pin label (counter-rotate so labels stay readable regardless of view rotation)
      ctx.save();
      ctx.translate(labelX, labelY);
      // Counter the global view rotation so text stays screen-aligned
      ctx.rotate(-this.rotation * Math.PI / 2);

      // Compute the effective screen side after view rotation
      const sideNames: PinRect['side'][] = ['left', 'top', 'right', 'bottom'];
      const screenSideIdx = (sideNames.indexOf(side) + this.rotation) % 4;
      const screenSide = sideNames[screenSideIdx];

      // Apply label rotation based on screen side
      const screenLabelRotation = (screenSide === 'top' || screenSide === 'bottom') ? -Math.PI / 2 : 0;
      ctx.rotate(screenLabelRotation);

      const fontSize = Math.min(9, pinSpacing * 0.65);
      const searchColor = this.getSearchHighlightColor(pin.name);
      ctx.fillStyle = searchColor || getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1a1a1a';
      ctx.font = searchColor ? `bold ${fontSize}px monospace` : `${fontSize}px monospace`;
      ctx.textBaseline = 'middle';

      // Label text
      const gpio = pin.gpioPort && pin.gpioNumber !== undefined
        ? `P${pin.gpioPort}${pin.gpioNumber}`
        : pin.name.substring(0, 6);
      let label: string;
      if (pinAssignments && pinAssignments.length > 0) {
        const nonPinned = pinAssignments.filter(a => a.portName !== '<pinned>');
        if (nonPinned.length > 0) {
          // Show port.channel then all unique signal names across configs
          const portChannel = `${nonPinned[0].portName}.${nonPinned[0].channelName}`;
          const signals = [...new Set(nonPinned.map(a => a.signalName))];
          label = `${gpio} ${portChannel} ${signals.join(' ')}`;
        } else {
          // Pinned assignments — show all unique signal names
          const signals = [...new Set(pinAssignments.map(a => a.signalName))];
          label = `${gpio} ${signals.join(' ')}`;
        }
      } else {
        label = gpio;
      }

      if (screenSide === 'left') {
        ctx.textAlign = 'right';
      } else if (screenSide === 'right') {
        ctx.textAlign = 'left';
      } else if (screenSide === 'top') {
        ctx.textAlign = 'left';
      } else {
        ctx.textAlign = 'right';
      }

      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  private renderBGA(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const mcu = this.mcu!;

    // Parse BGA grid from positions (e.g., "A1", "K11")
    const rows = new Set<string>();
    const cols = new Set<number>();
    const pinByGrid = new Map<string, Pin>();

    for (const pin of mcu.pins) {
      const match = pin.position.match(/^([A-Z])(\d+)$/);
      if (match) {
        rows.add(match[1]);
        cols.add(parseInt(match[2], 10));
        pinByGrid.set(pin.position, pin);
      }
    }

    const sortedRows = [...rows].sort();
    const sortedCols = [...cols].sort((a, b) => a - b);
    const numRows = sortedRows.length;
    const numCols = sortedCols.length;

    if (numRows === 0 || numCols === 0) return;

    const rowIndex = new Map(sortedRows.map((r, i) => [r, i]));
    const colIndex = new Map(sortedCols.map((c, i) => [c, i]));

    // Layout
    const margin = 50;
    const labelSpace = 20;
    const availW = width - 2 * margin - labelSpace;
    const availH = height - 2 * margin - labelSpace;
    const cellSize = Math.min(
      Math.max(8, availW / numCols),
      Math.max(8, availH / numRows),
      24
    );
    const ballRadius = cellSize * 0.35;

    const gridW = numCols * cellSize;
    const gridH = numRows * cellSize;
    const originX = (width - gridW) / 2 + labelSpace / 2;
    const originY = (height - gridH) / 2 + labelSpace / 2;

    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1a1a1a';

    // Draw chip body
    const chipPad = cellSize * 0.4;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim() || '#f5f5f5';
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 2;
    ctx.fillRect(originX - chipPad, originY - chipPad, gridW + 2 * chipPad, gridH + 2 * chipPad);
    ctx.strokeRect(originX - chipPad, originY - chipPad, gridW + 2 * chipPad, gridH + 2 * chipPad);

    // Pin 1 marker (notch at top-left corner, same style as LQFP)
    const notchSize = 10;
    const nx = originX - chipPad;
    const ny = originY - chipPad;
    ctx.beginPath();
    ctx.moveTo(nx, ny);
    ctx.lineTo(nx + notchSize, ny);
    ctx.arc(nx + notchSize, ny + notchSize, notchSize, -Math.PI / 2, Math.PI, true);
    ctx.lineTo(nx, ny);
    ctx.fillStyle = textColor;
    ctx.fill();

    // Counter-rotation angle to keep text screen-aligned
    const counterAngle = -this.rotation * Math.PI / 2;

    // Draw MCU name at fixed screen position (independent of rotation)
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = textColor;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mcu.refName, width / 2, 12);
    ctx.font = '9px monospace';
    ctx.fillText(mcu.package, width / 2, 24);
    ctx.restore();

    // Label alignment/baseline lookup based on rotation
    // Grid-left maps to: screen-left(0), screen-top(1), screen-right(2), screen-bottom(3)
    const rowAligns: CanvasTextAlign[] = ['right', 'center', 'left', 'center'];
    const rowBaselines: CanvasTextBaseline[] = ['middle', 'bottom', 'middle', 'top'];
    const colAligns: CanvasTextAlign[] = ['center', 'left', 'center', 'right'];
    const colBaselines: CanvasTextBaseline[] = ['bottom', 'middle', 'top', 'middle'];
    const rot = this.rotation % 4;

    // Row labels (A, B, C...)
    for (const row of sortedRows) {
      const ri = rowIndex.get(row)!;
      const ly = originY + ri * cellSize + cellSize / 2;
      ctx.save();
      ctx.translate(originX - chipPad - 4, ly);
      ctx.rotate(counterAngle);
      ctx.fillStyle = textColor;
      ctx.font = '9px monospace';
      ctx.textAlign = rowAligns[rot];
      ctx.textBaseline = rowBaselines[rot];
      ctx.fillText(row, 0, 0);
      ctx.restore();
    }

    // Column labels (1, 2, 3...)
    for (const col of sortedCols) {
      const ci = colIndex.get(col)!;
      const lx = originX + ci * cellSize + cellSize / 2;
      ctx.save();
      ctx.translate(lx, originY - chipPad - 1);
      ctx.rotate(counterAngle);
      ctx.fillStyle = textColor;
      ctx.font = '9px monospace';
      ctx.textAlign = colAligns[rot];
      ctx.textBaseline = colBaselines[rot];
      ctx.fillText(String(col), 0, 0);
      ctx.restore();
    }

    // Build assignment lookup
    const assignmentsByPin = new Map<string, Assignment[]>();
    for (const a of this.assignments) {
      if (!assignmentsByPin.has(a.pinName)) assignmentsByPin.set(a.pinName, []);
      assignmentsByPin.get(a.pinName)!.push(a);
    }

    // Draw balls
    this.pinRects = [];
    for (const pin of mcu.pins) {
      const match = pin.position.match(/^([A-Z])(\d+)$/);
      if (!match) continue;
      const ri = rowIndex.get(match[1]);
      const ci = colIndex.get(parseInt(match[2], 10));
      if (ri === undefined || ci === undefined) continue;

      const cx = originX + ci * cellSize + cellSize / 2;
      const cy = originY + ri * cellSize + cellSize / 2;

      // Store rect for hit testing
      this.pinRects.push({
        x: cx - ballRadius,
        y: cy - ballRadius,
        width: ballRadius * 2,
        height: ballRadius * 2,
        pin,
        labelX: cx,
        labelY: cy,
        labelRotation: 0,
        side: 'left', // not used for BGA
      });

      // Color
      const pinAssignments = assignmentsByPin.get(pin.name);
      const isHovered = this.hoveredPin === pin;
      const isSelected = this.selectedPin === pin;

      let fillColor: string;
      if (isHovered) {
        fillColor = '#fbbf24';
      } else if (isSelected) {
        fillColor = '#f97316';
      } else if (pinAssignments && pinAssignments.length > 0) {
        const portName = pinAssignments.find(a => a.portName !== '<pinned>')?.portName;
        const portColor = portName ? this.portColors.get(portName) : undefined;
        fillColor = portColor || getComputedStyle(document.documentElement).getPropertyValue('--pin-assigned').trim() || '#3b82f6';
      } else if (!pin.isAssignable) {
        fillColor = getComputedStyle(document.documentElement).getPropertyValue('--pin-reserved').trim() || '#374151';
      } else {
        fillColor = getComputedStyle(document.documentElement).getPropertyValue('--pin-unassigned').trim() || '#9ca3af';
      }

      ctx.beginPath();
      ctx.arc(cx, cy, ballRadius, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Draw pin name inside ball if large enough
      if (cellSize >= 16) {
        const gpio = pin.gpioPort && pin.gpioNumber !== undefined
          ? `P${pin.gpioPort}${pin.gpioNumber}`
          : pin.name.substring(0, 4);
        const fontSize = Math.min(7, cellSize * 0.28);
        const searchColor = this.getSearchHighlightColor(pin.name);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(counterAngle);
        ctx.fillStyle = searchColor || (isHovered || isSelected || (pinAssignments && pinAssignments.length > 0) ? '#fff' : textColor);
        ctx.font = searchColor ? `bold ${fontSize}px monospace` : `${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(gpio, 0, 0);
        ctx.restore();
      }
    }
  }

  /** Inverse-transform screen coordinates to canvas drawing coordinates */
  private screenToCanvas(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    let x = clientX - rect.left;
    let y = clientY - rect.top;

    const cx = rect.width / 2;
    const cy = rect.height / 2;

    // Translate to center
    x -= cx;
    y -= cy;

    // Inverse rotation
    const angle = -this.rotation * Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;

    // Inverse zoom
    return [rx / this.zoom + cx, ry / this.zoom + cy];
  }

  private hitTest(clientX: number, clientY: number): Pin | null {
    const [x, y] = this.screenToCanvas(clientX, clientY);

    // Use a slightly larger hit area for easier clicking
    const pad = 3;
    for (const pr of this.pinRects) {
      if (x >= pr.x - pad && x <= pr.x + pr.width + pad &&
          y >= pr.y - pad && y <= pr.y + pr.height + pad) {
        return pr.pin;
      }
    }
    return null;
  }

  private onMouseMove(e: MouseEvent): void {
    const pin = this.hitTest(e.clientX, e.clientY);

    if (pin !== this.hoveredPin) {
      this.hoveredPin = pin;
      this.updateHoverMatches();
      this.render();
    }

    if (pin) {
      this.showTooltip(e, pin);
    } else {
      this.hideTooltip();
    }
  }

  private onMouseLeave(): void {
    this.hoveredPin = null;
    this.updateHoverMatches();
    this.hideTooltip();
    this.render();
  }

  private onClick(e: MouseEvent): void {
    this.closePopup();

    const pin = this.hitTest(e.clientX, e.clientY);
    if (pin) {
      this.selectedPin = pin;
      this.render();
      for (const cb of this.pinClickCallbacks) {
        cb(pin);
      }

      if (pin.isAssignable) {
        const signals = pin.signals.filter(s => s.name !== 'GPIO');
        if (signals.length > 0) {
          this.showAssignmentPopup(e, pin, signals);
        }
      }
    } else {
      this.selectedPin = null;
      this.render();
    }
  }

  private showAssignmentPopup(e: MouseEvent, pin: Pin, signals: Signal[]): void {
    this.closePopup();

    const popup = document.createElement('div');
    popup.className = 'pv-assign-popup';

    const header = document.createElement('div');
    header.className = 'pv-assign-header';
    header.textContent = pin.name;
    popup.appendChild(header);

    const currentSignal = this.pinDeclLookup?.(pin.name) ?? null;

    if (currentSignal) {
      const removeItem = document.createElement('div');
      removeItem.className = 'pv-assign-item pv-assign-remove';
      removeItem.textContent = `Remove (${currentSignal})`;
      removeItem.addEventListener('click', (ev) => {
        ev.stopPropagation();
        for (const cb of this.pinUnassignCallbacks) {
          cb(pin.name);
        }
        this.closePopup();
      });
      popup.appendChild(removeItem);
    }

    const list = document.createElement('div');
    list.className = 'pv-assign-list';

    for (const signal of signals) {
      const item = document.createElement('div');
      item.className = 'pv-assign-item';
      if (signal.name === currentSignal) {
        item.classList.add('pv-assign-current');
      }
      if (this.searchMatchSignals.has(signal.name)) {
        item.classList.add('pv-assign-match');
      }
      item.textContent = signal.name;
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        for (const cb of this.pinAssignCallbacks) {
          cb(pin.name, signal.name);
        }
        this.closePopup();
      });
      list.appendChild(item);
    }

    popup.appendChild(list);
    this.container.appendChild(popup);
    this.popup = popup;

    // Position near the click
    const rect = this.container.getBoundingClientRect();
    let popupX = e.clientX - rect.left + 10;
    let popupY = e.clientY - rect.top + 10;

    popup.style.left = `${popupX}px`;
    popup.style.top = `${popupY}px`;

    // Adjust if overflowing
    requestAnimationFrame(() => {
      const pRect = popup.getBoundingClientRect();
      if (popupX + pRect.width > rect.width) {
        popupX = Math.max(4, rect.width - pRect.width - 4);
        popup.style.left = `${popupX}px`;
      }
      if (popupY + pRect.height > rect.height) {
        popupY = Math.max(4, rect.height - pRect.height - 4);
        popup.style.top = `${popupY}px`;
      }
    });

    // Close on click outside
    this.popupCloseHandler = (ev: MouseEvent) => {
      if (!popup.contains(ev.target as Node)) {
        this.closePopup();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this.popupCloseHandler!);
    }, 0);
  }

  private closePopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    if (this.popupCloseHandler) {
      document.removeEventListener('mousedown', this.popupCloseHandler);
      this.popupCloseHandler = null;
    }
  }

  private showTooltip(e: MouseEvent, pin: Pin): void {
    const signals = pin.signals
      .filter(s => s.name !== 'GPIO')
      .map(s => s.name);

    // Collect all assignments for this pin across configs
    const pinAssignments = this.assignments.filter(a => a.pinName === pin.name);

    let html = `<strong>${pin.name}</strong> (pos ${pin.position}, ${pin.type})<br>`;
    if (pinAssignments.length > 0) {
      for (const a of pinAssignments) {
        const label = a.portName !== '<pinned>'
          ? `${a.portName}.${a.channelName} [${a.configurationName}]`
          : 'pinned';
        html += `<span class="tooltip-assigned">${label}: ${a.signalName}</span><br>`;
      }
    }
    if (signals.length > 0) {
      const formatted = signals.map(s =>
        this.searchMatchSignals.has(s)
          ? `<span class="tooltip-match">${s}</span>`
          : s
      );
      html += `<span class="tooltip-signals">${formatted.join(', ')}</span>`;
    } else {
      html += '<span class="tooltip-none">No peripheral signals</span>';
    }

    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';

    const rect = this.container.getBoundingClientRect();
    const tooltipX = e.clientX - rect.left + 15;
    const tooltipY = e.clientY - rect.top + 15;
    this.tooltip.style.left = `${tooltipX}px`;
    this.tooltip.style.top = `${tooltipY}px`;

    // Keep tooltip within container
    const tRect = this.tooltip.getBoundingClientRect();
    if (tooltipX + tRect.width > rect.width) {
      this.tooltip.style.left = `${tooltipX - tRect.width - 30}px`;
    }
    if (tooltipY + tRect.height > rect.height) {
      this.tooltip.style.top = `${tooltipY - tRect.height - 30}px`;
    }
  }

  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }

  // ============================================================
  // Hover-based alternative pin highlight
  // ============================================================

  private buildSignalToPins(mcu: Mcu): void {
    this.signalToPins.clear();
    for (const pin of mcu.pins) {
      for (const sig of pin.signals) {
        if (sig.name === 'GPIO') continue;
        let list = this.signalToPins.get(sig.name);
        if (!list) { list = []; this.signalToPins.set(sig.name, list); }
        list.push(pin.name);
      }
    }
  }

  private updateHoverMatches(): void {
    this.hoverMatchPins.clear();
    if (!this.hoveredPin || this.assignments.length === 0) {
      this.updateAnimation();
      return;
    }
    // Only use signals that are actually assigned to this pin in the current solution
    const assignedSignals = new Set<string>();
    for (const a of this.assignments) {
      if (a.pinName === this.hoveredPin.name) {
        assignedSignals.add(a.signalName);
      }
    }
    if (assignedSignals.size === 0) {
      this.updateAnimation();
      return;
    }
    // Find other pins that can map to at least one of the assigned signals
    for (const sigName of assignedSignals) {
      const pins = this.signalToPins.get(sigName);
      if (pins) {
        for (const p of pins) {
          if (p !== this.hoveredPin!.name) {
            this.hoverMatchPins.add(p);
          }
        }
      }
    }
    this.updateAnimation();
  }

  // ============================================================
  // Pin/Signal Search
  // ============================================================

  private executeSearch(query: string): void {
    this.searchMatchPins.clear();
    this.searchMatchSignals.clear();

    if (!query.trim() || !this.mcu) {
      this.updateAnimation();
      this.render();
      return;
    }

    const trimmed = query.trim().toUpperCase();

    // Tier 1: Exact pin name match (PA0, PB12, etc.)
    for (const pin of this.mcu.pins) {
      const gpioName = (pin.gpioPort && pin.gpioNumber !== undefined)
        ? `P${pin.gpioPort}${pin.gpioNumber}`
        : pin.name;
      if (gpioName.toUpperCase() === trimmed || pin.name.toUpperCase() === trimmed) {
        this.searchMatchPins.add(pin.name);
      }
    }

    // Tier 2: Signal pattern match (TIM*_CH1, ADC*_IN[1-4], etc.)
    if (this.searchMatchPins.size === 0) {
      const patternNode = parseSearchPattern(query.trim());
      if (patternNode) {
        const candidates = expandPatternToCandidates(patternNode, this.mcu);
        for (const c of candidates) {
          this.searchMatchPins.add(c.pin.name);
          this.searchMatchSignals.add(c.signalName);
        }
      }
    }

    // Tier 3: Substring fallback on signal names
    if (this.searchMatchPins.size === 0) {
      for (const pin of this.mcu.pins) {
        for (const sig of pin.signals) {
          if (sig.name.toUpperCase().includes(trimmed)) {
            this.searchMatchPins.add(pin.name);
            this.searchMatchSignals.add(sig.name);
          }
        }
      }
    }

    this.updateAnimation();
    if (this.searchMatchPins.size === 0) {
      this.render();
    }
  }

  /** Start or stop the pulsating animation based on whether any pins need highlighting */
  private updateAnimation(): void {
    const needsAnimation = this.searchMatchPins.size > 0 || this.hoverMatchPins.size > 0;
    if (needsAnimation) {
      this.startSearchAnimation();
    } else {
      this.stopSearchAnimation();
    }
  }

  private startSearchAnimation(): void {
    if (this.searchAnimationId !== null) return;

    let lastTime = performance.now();
    const PULSE_PERIOD_MS = 1200;

    const animate = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      this.searchAnimPhase = (this.searchAnimPhase + dt / PULSE_PERIOD_MS) % 1;
      this.render();
      this.searchAnimationId = requestAnimationFrame(animate);
    };

    this.searchAnimationId = requestAnimationFrame(animate);
  }

  private stopSearchAnimation(): void {
    if (this.searchAnimationId !== null) {
      cancelAnimationFrame(this.searchAnimationId);
      this.searchAnimationId = null;
    }
    this.searchAnimPhase = 0;
  }

  private getSearchHighlightColor(pinName: string): string | null {
    if (!this.searchMatchPins.has(pinName) && !this.hoverMatchPins.has(pinName)) return null;
    const intensity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(this.searchAnimPhase * Math.PI * 2));
    return `rgba(251, 191, 36, ${intensity})`;
  }
}
