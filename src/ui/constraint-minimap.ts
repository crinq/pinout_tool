// ============================================================
// Constraint Minimap — block overview of constraint structure
// ============================================================

import type {
  ProgramNode,
  PortDeclNode,
  ConfigDeclNode,
  MappingNode,
} from '../parser/constraint-ast';
import type { Mcu, Assignment } from '../types';
import { expandPatternToCandidates } from '../solver/pattern-matcher';

const DEFAULT_PORT_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d8', '#f97316', '#6366f1', '#14b8a6',
];

const LINE_HEIGHT = 18; // must match CSS line-height
const MINIMAP_WIDTH = 80;
const BLOCK_H_PAD = 2;
const BLOCK_V_PAD = 1;
const TOP_PAD = 4;
const LABEL_FONT = '8px sans-serif';
const CONFIG_FONT = '7px sans-serif';

/** Convert any CSS color to rgba with given alpha (0-1). Uses an offscreen canvas for parsing. */
const _colorCanvas = document.createElement('canvas');
_colorCanvas.width = _colorCanvas.height = 1;
const _colorCtx = _colorCanvas.getContext('2d', { willReadFrequently: true })!;
function colorWithAlpha(color: string, alpha: number): string {
  _colorCtx.clearRect(0, 0, 1, 1);
  _colorCtx.fillStyle = color;
  _colorCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = _colorCtx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r},${g},${b},${alpha})`;
}

interface MinimapBlock {
  startLine: number; // 1-based
  endLine: number;   // 1-based, inclusive
  color: string;
  label: string;
  port: PortDeclNode | null;
  configs: { name: string; startLine: number; endLine: number; configNode: ConfigDeclNode }[];
}

const DECL_TYPE_LABELS: Record<string, string> = {
  mcu_decl: 'MCU', package_decl: 'PKG', ram_decl: 'RAM', rom_decl: 'ROM',
  freq_decl: 'FREQ', temp_decl: 'TEMP', voltage_decl: 'VOLT', core_decl: 'CORE',
  reserve_decl: 'RESERVE', shared_decl: 'SHARED', pin_decl: 'PIN',
};

export class ConstraintMinimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private blocks: MinimapBlock[] = [];
  private totalLines = 1;
  private scrollTop = 0;
  private viewportHeight = 0;
  private dragging = false;
  private hoveredBlock: MinimapBlock | null = null;

  private mcu: Mcu | null = null;
  private ast: ProgramNode | null = null;
  private assignments: Assignment[] | null = null;
  private errorLines: number[] = [];

  private scrollCallback: ((scrollTop: number) => void) | null = null;
  private highlightCallback: ((pins: Set<string>, color?: string) => void) | null = null;
  private cursorCallback: ((line: number) => void) | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ce-minimap';
    this.canvas.width = MINIMAP_WIDTH;
    this.canvas.height = 100;
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    window.addEventListener('mousemove', (e) => { if (this.dragging) this.onDrag(e); });
    window.addEventListener('mouseup', () => { this.dragging = false; });
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  onScroll(callback: (scrollTop: number) => void): void {
    this.scrollCallback = callback;
  }

  onCursorJump(callback: (line: number) => void): void {
    this.cursorCallback = callback;
  }

  onHighlightPins(callback: (pins: Set<string>, color?: string) => void): void {
    this.highlightCallback = callback;
  }

  setMcu(mcu: Mcu | null): void {
    this.mcu = mcu;
  }

  setAssignments(assignments: Assignment[] | null): void {
    this.assignments = assignments;
  }

  /** Update from parsed AST */
  update(ast: ProgramNode | null, totalLines: number, errorLines?: number[]): void {
    this.ast = ast;
    this.totalLines = totalLines;
    this.errorLines = errorLines || [];
    this.buildBlocks();
    this.paint();
  }

  /** Update viewport position (called on editor scroll) */
  updateViewport(scrollTop: number, viewportHeight: number): void {
    this.scrollTop = scrollTop;
    this.viewportHeight = viewportHeight;
    this.paint();
  }

  /** Resize canvas to match container */
  resize(height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = MINIMAP_WIDTH * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = MINIMAP_WIDTH + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.scale(dpr, dpr);
    this.paint();
  }

  // ====================
  // Block building
  // ====================

  private buildBlocks(): void {
    this.blocks = [];
    if (!this.ast) return;

    // Collect non-port, non-macro declarations into a single header block
    const declTypes = new Set<string>();
    let declStartLine = Infinity;
    let declEndLine = 0;
    for (const stmt of this.ast.statements) {
      const label = DECL_TYPE_LABELS[stmt.type];
      if (label) {
        declTypes.add(label);
        declStartLine = Math.min(declStartLine, stmt.loc.line);
        declEndLine = Math.max(declEndLine, stmt.loc.line);
      }
    }
    if (declTypes.size > 0) {
      this.blocks.push({
        startLine: declStartLine,
        endLine: declEndLine,
        color: '#6b7280', // grey
        label: [...declTypes].join(', '),
        port: null,
        configs: [],
      });
    }

    // Port blocks
    const ports = this.ast.statements.filter(
      (s): s is PortDeclNode => s.type === 'port_decl'
    );

    let autoIdx = 0;
    for (const port of ports) {
      const color = port.color || DEFAULT_PORT_COLORS[autoIdx++ % DEFAULT_PORT_COLORS.length];

      const startLine = port.loc.line;
      const endLine = this.getBlockEndLine(port, ports);

      let label = port.name;
      if (port.template) label += ` : ${port.template}`;

      const configs: MinimapBlock['configs'] = [];
      for (const config of port.configs) {
        const cStart = config.loc.line;
        const cEnd = this.getConfigEndLine(config, port);
        configs.push({ name: config.name, startLine: cStart, endLine: cEnd, configNode: config });
      }

      this.blocks.push({ startLine, endLine, color, label, port, configs });
    }
  }

  private getBlockEndLine(port: PortDeclNode, _allPorts: PortDeclNode[]): number {
    if (!this.ast) return this.totalLines;

    const stmts = this.ast.statements;
    const myIdx = stmts.indexOf(port);
    if (myIdx >= 0 && myIdx < stmts.length - 1) {
      return stmts[myIdx + 1].loc.line - 1;
    }
    return this.totalLines;
  }

  private getConfigEndLine(config: ConfigDeclNode, port: PortDeclNode): number {
    const configIdx = port.configs.indexOf(config);
    if (configIdx < port.configs.length - 1) {
      return port.configs[configIdx + 1].loc.line - 1;
    }
    // Last config: ends at port's end or next channel/statement
    return this.getBlockEndLine(port, this.ast!.statements.filter(
      (s): s is PortDeclNode => s.type === 'port_decl'
    ));
  }

  // ====================
  // Painting
  // ====================

  paint(): void {
    const w = MINIMAP_WIDTH;
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    if (this.totalLines <= 0) return;

    const scale = (h - TOP_PAD) / (this.totalLines * LINE_HEIGHT);
    const lineToY = (line: number) => TOP_PAD + (line - 1) * LINE_HEIGHT * scale;

    // Pass 1: backgrounds and borders
    for (const block of this.blocks) {
      const y = lineToY(block.startLine);
      const blockH = Math.max(4, (block.endLine - block.startLine + 1) * LINE_HEIGHT * scale);

      if (block.port) {
        ctx.fillStyle = colorWithAlpha(block.color, 0.06);
        ctx.fillRect(BLOCK_H_PAD, y + BLOCK_V_PAD, w - 2 * BLOCK_H_PAD, blockH - 2 * BLOCK_V_PAD);

        ctx.fillStyle = block.color;
        ctx.fillRect(BLOCK_H_PAD, y + BLOCK_V_PAD, 3, blockH - 2 * BLOCK_V_PAD);
      }

      for (const config of block.configs) {
        const cy = lineToY(config.startLine);
        const ch = Math.max(2, (config.endLine - config.startLine + 1) * LINE_HEIGHT * scale);
        ctx.fillStyle = colorWithAlpha(block.color, 0.15);
        ctx.fillRect(BLOCK_H_PAD + 6, cy + 1, w - 2 * BLOCK_H_PAD - 8, ch - 2);
      }
    }

    // Pass 2: labels (drawn on top so they're never obscured by backgrounds)
    for (const block of this.blocks) {
      const y = lineToY(block.startLine);
      ctx.font = 'bold ' + LABEL_FONT;
      ctx.fillStyle = this.getLabelColor();
      const labelX = BLOCK_H_PAD + 5;
      const maxLabelW = w - BLOCK_H_PAD - 7;
      const lines = this.wrapText(ctx, block.label, maxLabelW);
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], labelX, y + 9 + li * 10, maxLabelW);
      }

      for (const config of block.configs) {
        // Skip config label when it matches the port name (inline config shorthand)
        if (block.port && config.name === block.port.name) continue;
        const cy = lineToY(config.startLine);
        const ch = Math.max(2, (config.endLine - config.startLine + 1) * LINE_HEIGHT * scale);
        if (ch > 8) {
          ctx.font = 'bold ' + CONFIG_FONT;
          ctx.fillStyle = this.getLabelColor();
          ctx.fillText(config.name, BLOCK_H_PAD + 14, cy + Math.min(9, ch - 1), w - BLOCK_H_PAD - 16);
        }
      }
    }

    // Hovered block highlight
    if (this.hoveredBlock) {
      const y = lineToY(this.hoveredBlock.startLine);
      const blockH = Math.max(4, (this.hoveredBlock.endLine - this.hoveredBlock.startLine + 1) * LINE_HEIGHT * scale);
      ctx.fillStyle = colorWithAlpha(this.hoveredBlock.color, 0.2);
      ctx.fillRect(BLOCK_H_PAD, y + BLOCK_V_PAD, w - 2 * BLOCK_H_PAD, blockH - 2 * BLOCK_V_PAD);
    }

    // Viewport rectangle
    const vpY = TOP_PAD + this.scrollTop * scale;
    const vpH = Math.max(8, this.viewportHeight * scale);

    ctx.fillStyle = this.getViewportFill();
    ctx.fillRect(0, vpY, w, vpH);

    ctx.strokeStyle = this.getViewportStroke();
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpY + 0.5, w - 1, vpH - 1);

    // Error markers
    if (this.errorLines.length > 0) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
      for (const line of this.errorLines) {
        const ey = lineToY(line);
        const eh = Math.max(3, LINE_HEIGHT * scale);
        ctx.fillRect(0, ey, w, eh);
      }
    }
  }

  /** Word-wrap text by comma-separated segments to fit within maxWidth */
  private wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    if (ctx.measureText(text).width <= maxWidth) return [text];

    const parts = text.split(', ');
    const lines: string[] = [];
    let current = '';
    for (const part of parts) {
      const candidate = current ? current + ', ' + part : part;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  private getLabelColor(): string {
    return document.documentElement.dataset.theme === 'dark' ? '#ffffff' : '#000000';
  }

  private getViewportFill(): string {
    return document.documentElement.dataset.theme === 'dark'
      ? 'rgba(255,255,255,0.08)'
      : 'rgba(0,0,0,0.06)';
  }

  private getViewportStroke(): string {
    return document.documentElement.dataset.theme === 'dark'
      ? 'rgba(255,255,255,0.25)'
      : 'rgba(0,0,0,0.15)';
  }

  // ====================
  // Interactions
  // ====================

  private yToScrollTop(clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const h = rect.height;
    const scale = (h - TOP_PAD) / (this.totalLines * LINE_HEIGHT);

    // Center viewport on click point
    const targetScrollTop = (y - TOP_PAD) / scale - this.viewportHeight / 2;
    const maxScroll = this.totalLines * LINE_HEIGHT - this.viewportHeight;
    return Math.max(0, Math.min(maxScroll, targetScrollTop));
  }

  /** Hit-test: returns the line to jump to if a block/config was clicked, or null for empty space */
  private hitTestLine(clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const h = rect.height;
    const scale = (h - TOP_PAD) / (this.totalLines * LINE_HEIGHT);

    for (const block of this.blocks) {
      const by = TOP_PAD + (block.startLine - 1) * LINE_HEIGHT * scale;
      const bh = (block.endLine - block.startLine + 1) * LINE_HEIGHT * scale;
      if (y >= by && y <= by + bh) {
        // Check configs first (more specific)
        for (const config of block.configs) {
          const cy = TOP_PAD + (config.startLine - 1) * LINE_HEIGHT * scale;
          const ch = (config.endLine - config.startLine + 1) * LINE_HEIGHT * scale;
          if (y >= cy && y <= cy + ch) {
            return config.startLine;
          }
        }
        return block.startLine;
      }
    }
    return null;
  }

  private onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    // Click on a block/config → jump cursor
    const line = this.hitTestLine(e.clientY);
    if (line !== null && this.cursorCallback) {
      this.cursorCallback(line);
      return;
    }
    // Click on empty space → scroll
    this.dragging = true;
    const scrollTop = this.yToScrollTop(e.clientY);
    if (this.scrollCallback) this.scrollCallback(scrollTop);
  }

  private onDrag(e: MouseEvent): void {
    if (!this.dragging) return;
    const scrollTop = this.yToScrollTop(e.clientY);
    if (this.scrollCallback) this.scrollCallback(scrollTop);
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.dragging) return;

    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    const scale = (h - TOP_PAD) / (this.totalLines * LINE_HEIGHT);

    // Find hovered block
    let found: MinimapBlock | null = null;
    for (const block of this.blocks) {
      const by = TOP_PAD + (block.startLine - 1) * LINE_HEIGHT * scale;
      const bh = (block.endLine - block.startLine + 1) * LINE_HEIGHT * scale;
      if (y >= by && y <= by + bh) {
        found = block;
        break;
      }
    }

    if (found !== this.hoveredBlock) {
      this.hoveredBlock = found;
      this.paint();
      this.updateHighlight();
    }
    this.canvas.style.cursor = 'pointer';
  }

  private onMouseLeave(): void {
    if (this.hoveredBlock) {
      this.hoveredBlock = null;
      this.paint();
      this.clearHighlight();
    }
  }

  private updateHighlight(): void {
    if (!this.highlightCallback || !this.mcu || !this.hoveredBlock) {
      this.clearHighlight();
      return;
    }

    const port = this.hoveredBlock.port;
    if (!port) return; // declarations block — no pins to highlight

    const pins = new Set<string>();

    // If we have a solution, show assigned pins for this port
    if (this.assignments) {
      for (const a of this.assignments) {
        if (a.portName === port.name) {
          pins.add(a.pinName);
        }
      }
    } else {
      // Show all candidate pins for this port's mappings
      for (const config of port.configs) {
        for (const item of config.body) {
          if (item.type === 'mapping') {
            this.collectMappingPins(item as MappingNode, port, pins);
          }
        }
      }
    }

    this.highlightCallback(pins, this.hoveredBlock.color);
  }

  private collectMappingPins(mapping: MappingNode, port: PortDeclNode, pins: Set<string>): void {
    if (!this.mcu) return;
    const ch = port.channels.find(c => c.name === mapping.channelName);
    const allowedPins = ch?.allowedPins ? new Set(ch.allowedPins) : undefined;

    for (const expr of mapping.signalExprs) {
      for (const pattern of expr.alternatives) {
        const candidates = expandPatternToCandidates(pattern, this.mcu, allowedPins);
        for (const c of candidates) {
          pins.add(c.pin.name);
        }
      }
    }
  }

  private clearHighlight(): void {
    if (this.highlightCallback) {
      this.highlightCallback(new Set());
    }
  }
}
