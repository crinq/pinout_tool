// ============================================================
// Constraint Viewer — read-only topology view of parsed constraints
// ============================================================

import type { Panel } from '../../ts_lib/src/panel';
import type {
  ProgramNode,
  PortDeclNode,
  ChannelDeclNode,
  ConfigDeclNode,
  MappingNode,
  RequireNode,
  ConstraintExprNode,
  SignalExprNode,
} from '../parser/constraint-ast';
import type { ParseResult } from '../parser/constraint-ast';
import type { Mcu, Assignment } from '../types';
import { expandPatternToCandidates } from '../solver/pattern-matcher';
import { escapeHtml } from '../utils';

// Auto-assigned pastel colors for ports without explicit color
const DEFAULT_PORT_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d8', '#f97316', '#6366f1', '#14b8a6',
];

export class ConstraintViewer implements Panel {
  readonly id = 'constraint-viewer';
  readonly title = 'Constraints Viewer';

  private container!: HTMLElement;
  private content!: HTMLElement;
  private currentAst: ProgramNode | null = null;
  private currentMcu: Mcu | null = null;
  private currentAssignments: Assignment[] | null = null;
  private portColors: Map<string, string> = new Map();
  private showSolution = false;

  // Callback to set cursor in constraint editor
  private cursorCallback: ((line: number) => void) | null = null;
  // Callback to highlight pins in package viewer
  private highlightCallback: ((pins: Set<string>, color?: string) => void) | null = null;

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('constraint-viewer');

    this.content = document.createElement('div');
    this.content.className = 'cv-content';
    this.container.appendChild(this.content);

    this.render();
  }

  onStateChange(change: Record<string, unknown>): void {
    if (change['type'] === 'mcu-loaded') {
      this.currentMcu = change['mcu'] as Mcu;
      this.render();
    }
    if (change['type'] === 'solution-selected') {
      this.currentAssignments = (change['assignments'] as Assignment[]) || null;
      this.portColors = (change['portColors'] as Map<string, string>) || new Map();
      this.showSolution = true;
      this.render();
    }
    if (change['type'] === 'highlight-pins') {
      // Don't react to pin highlights from other panels
    }
  }

  /** Update from parsed AST (called by app on constraint change) */
  updateFromParse(result: ParseResult): void {
    this.currentAst = result.ast;
    this.showSolution = false;
    this.currentAssignments = null;
    this.render();
  }

  /** Register callback to jump cursor in constraint editor */
  onCursorJump(callback: (line: number) => void): void {
    this.cursorCallback = callback;
  }

  /** Register callback to highlight pins in package viewer */
  onHighlightPins(callback: (pins: Set<string>, color?: string) => void): void {
    this.highlightCallback = callback;
  }

  // ====================
  // Rendering
  // ====================

  private render(): void {
    if (!this.content) return;
    this.content.innerHTML = '';

    if (!this.currentAst) {
      this.content.innerHTML = '<div class="cv-empty">No constraints parsed</div>';
      return;
    }

    const ports = this.currentAst.statements.filter(
      (s): s is PortDeclNode => s.type === 'port_decl'
    );

    if (ports.length === 0) {
      this.content.innerHTML = '<div class="cv-empty">No ports defined</div>';
      return;
    }

    // Build port color map from AST (explicit colors) + auto-assign
    const colorMap = new Map<string, string>();
    let autoIdx = 0;
    for (const port of ports) {
      if (port.color) {
        colorMap.set(port.name, port.color);
      } else {
        colorMap.set(port.name, DEFAULT_PORT_COLORS[autoIdx % DEFAULT_PORT_COLORS.length]);
        autoIdx++;
      }
    }

    // Override with solution port colors if available
    for (const [name, color] of this.portColors) {
      colorMap.set(name, color);
    }

    // Build assignment lookup: portName.channelName -> Assignment[]
    const assignmentMap = new Map<string, Assignment[]>();
    if (this.showSolution && this.currentAssignments) {
      for (const a of this.currentAssignments) {
        const key = `${a.portName}.${a.channelName}`;
        if (!assignmentMap.has(key)) assignmentMap.set(key, []);
        assignmentMap.get(key)!.push(a);
      }
    }

    for (const port of ports) {
      const portEl = this.renderPort(port, colorMap.get(port.name) || '#888', assignmentMap);
      this.content.appendChild(portEl);
    }
  }

  private renderPort(
    port: PortDeclNode,
    color: string,
    assignmentMap: Map<string, Assignment[]>,
  ): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cv-port';
    box.style.borderColor = color;

    // Header
    const header = document.createElement('div');
    header.className = 'cv-port-header';
    header.style.background = color;

    let titleText = escapeHtml(port.name);
    if (port.template) {
      titleText += ` <span class="cv-port-template">: ${escapeHtml(port.template)}</span>`;
    }
    header.innerHTML = titleText;

    header.addEventListener('click', () => this.jumpToLine(port.loc.line));
    header.addEventListener('mouseenter', () => this.highlightPortPins(port));
    header.addEventListener('mouseleave', () => this.clearHighlight());

    box.appendChild(header);

    // Channels
    for (const ch of port.channels) {
      const chEl = this.renderChannel(ch, port, color, assignmentMap);
      box.appendChild(chEl);
    }

    // Configs
    for (const config of port.configs) {
      const configEl = this.renderConfig(config, port, color, assignmentMap);
      box.appendChild(configEl);
    }

    return box;
  }

  private renderChannel(
    ch: ChannelDeclNode,
    port: PortDeclNode,
    color: string,
    assignmentMap: Map<string, Assignment[]>,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cv-channel';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'cv-channel-name';
    nameSpan.textContent = ch.name;
    el.appendChild(nameSpan);

    if (ch.allowedPins && ch.allowedPins.length > 0) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'cv-pin-badge';
      pinBadge.textContent = `@ ${ch.allowedPins.join(', ')}`;
      el.appendChild(pinBadge);
    }

    // Show assignment if in solution mode
    const key = `${port.name}.${ch.name}`;
    const assignments = assignmentMap.get(key);
    if (this.showSolution && assignments && assignments.length > 0) {
      const assignSpan = document.createElement('span');
      assignSpan.className = 'cv-assignment';
      assignSpan.textContent = assignments.map(a => `${a.pinName}: ${a.signalName}`).join(', ');
      el.appendChild(assignSpan);
    }

    el.addEventListener('click', () => this.jumpToLine(ch.loc.line));
    el.addEventListener('mouseenter', () => this.highlightChannelPins(ch, port, color));
    el.addEventListener('mouseleave', () => this.clearHighlight());

    return el;
  }

  private renderConfig(
    config: ConfigDeclNode,
    port: PortDeclNode,
    color: string,
    assignmentMap: Map<string, Assignment[]>,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cv-config';

    const configHeader = document.createElement('div');
    configHeader.className = 'cv-config-header';
    configHeader.textContent = config.name;
    configHeader.addEventListener('click', () => this.jumpToLine(config.loc.line));
    el.appendChild(configHeader);

    for (const item of config.body) {
      if (item.type === 'mapping') {
        const mappingEl = this.renderMapping(item, port, color, assignmentMap);
        el.appendChild(mappingEl);
      } else if (item.type === 'require') {
        const reqEl = this.renderRequire(item);
        el.appendChild(reqEl);
      }
    }

    return el;
  }

  private renderMapping(
    mapping: MappingNode,
    port: PortDeclNode,
    color: string,
    assignmentMap: Map<string, Assignment[]>,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cv-mapping';

    const chName = document.createElement('span');
    chName.className = 'cv-mapping-channel';
    chName.textContent = mapping.channelName;
    el.appendChild(chName);

    const op = document.createElement('span');
    op.className = 'cv-mapping-op';
    op.textContent = mapping.optional ? ' ?= ' : ' = ';
    el.appendChild(op);

    // Show assignment or pattern
    const key = `${port.name}.${mapping.channelName}`;
    const assignments = assignmentMap.get(key);

    if (this.showSolution && assignments && assignments.length > 0) {
      const assignSpan = document.createElement('span');
      assignSpan.className = 'cv-assignment';
      assignSpan.textContent = assignments.map(a => `${a.pinName}: ${a.signalName}`).join(' + ');
      el.appendChild(assignSpan);
    } else {
      const pattern = document.createElement('span');
      pattern.className = 'cv-mapping-pattern';
      pattern.textContent = this.formatSignalExprs(mapping.signalExprs);
      el.appendChild(pattern);

      if (mapping.instanceBindings && mapping.instanceBindings.length > 0) {
        const vars = document.createElement('span');
        vars.className = 'cv-var-badge';
        vars.textContent = mapping.instanceBindings.map(v => `$${v}`).join(' ');
        el.appendChild(vars);
      }
    }

    el.addEventListener('click', () => this.jumpToLine(mapping.loc.line));
    el.addEventListener('mouseenter', () => this.highlightMappingPins(mapping, port, color));
    el.addEventListener('mouseleave', () => this.clearHighlight());

    return el;
  }

  private renderRequire(req: RequireNode): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cv-require';

    const label = document.createElement('span');
    label.className = 'cv-require-label';
    label.textContent = req.optional ? 'require? ' : 'require ';
    el.appendChild(label);

    const expr = document.createElement('span');
    expr.className = 'cv-require-expr';
    expr.textContent = this.formatExpr(req.expression);
    el.appendChild(expr);

    el.addEventListener('click', () => this.jumpToLine(req.loc.line));

    return el;
  }

  // ====================
  // Formatting helpers
  // ====================

  private formatSignalExprs(exprs: SignalExprNode[]): string {
    return exprs.map(expr =>
      expr.alternatives.map(alt => alt.raw).join(' | ')
    ).join(' + ');
  }

  private formatExpr(expr: ConstraintExprNode): string {
    switch (expr.type) {
      case 'function_call':
        return `${expr.name}(${expr.args.map(a => this.formatExpr(a)).join(', ')})`;
      case 'binary_expr':
        return `${this.formatExpr(expr.left)} ${expr.operator} ${this.formatExpr(expr.right)}`;
      case 'unary_expr':
        return `!${this.formatExpr(expr.operand)}`;
      case 'ident':
        return expr.name;
      case 'dot_access':
        return `${expr.object}.${expr.property}`;
      case 'string_literal':
        return `"${expr.value}"`;
      case 'number_literal':
        return String(expr.value);
    }
  }

  // ====================
  // Interactions
  // ====================

  private jumpToLine(line: number): void {
    if (this.cursorCallback) {
      this.cursorCallback(line);
    }
  }

  private highlightPortPins(port: PortDeclNode): void {
    if (!this.highlightCallback || !this.currentMcu) return;

    const pins = new Set<string>();
    for (const config of port.configs) {
      for (const item of config.body) {
        if (item.type === 'mapping') {
          this.collectMappingPins(item, port, pins);
        }
      }
    }

    const color = this.getPortColor(port.name);
    this.highlightCallback(pins, color);
  }

  private highlightChannelPins(ch: ChannelDeclNode, port: PortDeclNode, color: string): void {
    if (!this.highlightCallback || !this.currentMcu) return;

    const pins = new Set<string>();
    // Find mappings for this channel across all configs
    for (const config of port.configs) {
      for (const item of config.body) {
        if (item.type === 'mapping' && item.channelName === ch.name) {
          this.collectMappingPins(item, port, pins);
        }
      }
    }

    this.highlightCallback(pins, color);
  }

  private highlightMappingPins(mapping: MappingNode, port: PortDeclNode, color: string): void {
    if (!this.highlightCallback || !this.currentMcu) return;

    const pins = new Set<string>();
    this.collectMappingPins(mapping, port, pins);
    this.highlightCallback(pins, color);
  }

  private collectMappingPins(mapping: MappingNode, port: PortDeclNode, pins: Set<string>): void {
    if (!this.currentMcu) return;

    // Find allowed pins for this channel
    const ch = port.channels.find(c => c.name === mapping.channelName);
    const allowedPins = ch?.allowedPins ? new Set(ch.allowedPins) : undefined;

    for (const expr of mapping.signalExprs) {
      for (const pattern of expr.alternatives) {
        const candidates = expandPatternToCandidates(pattern, this.currentMcu, allowedPins);
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

  private getPortColor(portName: string): string {
    if (this.portColors.has(portName)) return this.portColors.get(portName)!;
    if (!this.currentAst) return '#888';

    const ports = this.currentAst.statements.filter(
      (s): s is PortDeclNode => s.type === 'port_decl'
    );
    let autoIdx = 0;
    for (const p of ports) {
      if (p.color) {
        if (p.name === portName) return p.color;
      } else {
        if (p.name === portName) return DEFAULT_PORT_COLORS[autoIdx % DEFAULT_PORT_COLORS.length];
        autoIdx++;
      }
    }
    return '#888';
  }
}
