import type { Panel, HighlightStyle } from './panel';
import { parseConstraints } from '../parser/constraint-parser';
import type { ParseError, ParseResult } from '../parser/constraint-ast';
import type { Mcu, Assignment } from '../types';
import { getStdlibMacroNames, getStdlibTemplates } from '../parser/stdlib-macros';
import { resolveTemplates } from '../parser/template-resolver';
import { lintForCommonErrors, getCachedLintLib, type LintWarning } from '../parser/lint-common-errors';
import { escapeHtml, escapeRegex, createModal } from '../utils';
import { showContextMenu, type ContextMenuItem } from '../../ts_lib/src/context-menu';
import { getPeripherals, type Peripheral } from '../parser/peripheral-lib';
import { ConstraintMinimap } from './constraint-minimap';
import { renderMarkdown } from './markdown';
import syntaxHelpMd from './syntax-help.md?raw';
import { createCodeEditor, type CodeEditor } from './code-editor';

const KEYWORDS = new Set(['mcu', 'package', 'ram', 'rom', 'freq', 'temp', 'voltage', 'core', 'reserve', 'shared', 'pin', 'port', 'channel', 'config', 'group', 'require', 'macro', 'color', 'from', 'settings']);
const BUILTINS = new Set(['same_instance', 'diff_instance', 'instance', 'type', 'gpio_pin', 'gpio_port', 'channel_signal', 'channel_number', 'instance_number', 'pin_number', 'pin_row', 'pin_col', 'pin_distance', 'IN', 'OUT', 'dma', 'flag']);

/** Short docs shown as a hover tooltip over each keyword / built-in function. */
const KEYWORD_DOCS: Record<string, string> = {
  // Declarations
  mcu: 'Filter target MCUs by name (glob). e.g. mcu: STM32G4* | STM32F[405,407]',
  package: 'Filter MCUs by package (glob). e.g. package: LQFP[100,144] | BGA*',
  ram: 'Minimum RAM, or a range. Suffixes K/M. e.g. ram: 128K < 512K',
  rom: 'Minimum flash/ROM, or a range. Suffixes K/M. e.g. rom: 256K < 2M',
  freq: 'Minimum CPU frequency in MHz, or a range. e.g. freq: 100 < 480',
  temp: 'Operating temperature the part must cover (°C). e.g. temp: -40 < 85',
  voltage: 'Operating voltage the part must cover (V). e.g. voltage: 1.8 < 3.6',
  core: 'Required CPU core(s). + = all (dual-core), | = any. e.g. core: M4 + M7',
  reserve: 'Keep pins / peripheral instances / positions off-limits to the solver. e.g. reserve: PA13, ADC1',
  shared: 'Allow a peripheral instance to be used by more than one port. e.g. shared: ADC[1,2]',
  pin: 'Fix a pin to a signal. e.g. pin PA4 = DAC1_OUT1  (or = IN / = OUT)',
  port: 'A group of related channels. Optional: from <template>, color, @ placement.',
  channel: 'One signal that needs a pin. Optional @ placement (pin, !pin, ~anchor) and inline = <signal> mapping.',
  config: 'An alternative wiring of a port; the solver tries every config combination.',
  group: 'A physical grouping of channels inside a port. Takes an @ placement clause and pulls its members together. e.g. group "rail_3v3": @ ~NW',
  require: 'A constraint the solution must satisfy. require? makes it soft (best-effort).',
  macro: 'A reusable block of mappings/requires. Declare with params, then call by name.',
  color: 'Port colour in the package viewer. e.g. color "#2563eb"',
  from: 'Derive this port from a template port, inheriting its channels and configs.',
  settings: 'Override solver settings for this run. `settings from "complex":` starts from a preset.',
  // Placement anchor targets
  IN: 'GPIO input shorthand — maps to any free input-capable pin.',
  OUT: 'GPIO output shorthand — maps to any free output-capable pin.',
  // require() functions
  same_instance: 'True if the channels share one peripheral instance. Optional "TYPE" filter.',
  diff_instance: 'True if the channels use different peripheral instances.',
  instance: 'The peripheral instance of a channel (e.g. USART1). Optional "TYPE" filter.',
  type: 'The peripheral type of a channel (e.g. "USART").',
  gpio_pin: 'The pin assigned to a channel (e.g. "PA9").',
  gpio_port: 'The GPIO port of a channel\'s pin (e.g. "GPIO1").',
  channel_signal: 'The signal function of a channel (e.g. "TX", "CH3").',
  channel_number: 'The channel/signal number (e.g. 3 for TIM1_CH3).',
  instance_number: 'The peripheral instance number (e.g. 2 for SPI2).',
  pin_number: 'The package pin number / position of a channel\'s pin.',
  pin_row: 'Row of a channel\'s pin (BGA row, or LQFP y-component).',
  pin_col: 'Column of a channel\'s pin (BGA column, or LQFP x-component).',
  pin_distance: 'Physical distance between two channels\' pins. e.g. pin_distance(A, B) < 5',
  dma: 'True if the channel\'s signal has a DMA stream. Optional "TYPE" / "TYPE_REQUEST" filter.',
  flag: 'True if every pin of the channel carries a vendor pin flag with that value. e.g. flag(TX, "5V_tolerant", true)',
};

/** Highlight span attribute carrying the keyword doc, or '' when there is none. */
function docAttr(word: string): string {
  const doc = KEYWORD_DOCS[word];
  return doc ? ` data-doc="${escapeHtml(doc)}"` : '';
}

// ---- Double-click "add" helper: locate the cursor's structural context ----

export interface EditorContext {
  lineIdx: number;
  portIdx: number;       // index of the enclosing `port` line, or -1
  configIdx: number;     // index of the enclosing `config` line, or -1
  portHasConfig: boolean;
}

const indentOf = (l: string): number => (l.match(/^ */)?.[0].length ?? 0);
const isRequireLine = (l: string): boolean => /^\s*require\b/.test(l.trim());
/** Channel name from a mapping line (`CH = …` / `CH ?= …`), or null. */
const mappingChannel = (l: string): string | null => l.trim().match(/^([A-Za-z0-9_]+)\s*\??=/)?.[1] ?? null;

/** First line after a port's body (a column-0 non-blank line), or EOF. */
function portBodyEnd(lines: string[], portIdx: number): number {
  for (let i = portIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') return i;
  }
  return lines.length;
}

/** Index just past a config's (deeper-indented) body. */
function configBodyEnd(lines: string[], configIdx: number): number {
  const headerIndent = indentOf(lines[configIdx]);
  let end = configIdx + 1;
  for (let i = configIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= headerIndent) break;
    end = i + 1;
  }
  return end;
}

/** Add `channel CH` decls for names not already declared in the port. Returns count added. */
function injectChannels(lines: string[], portIdx: number, names: string[]): number {
  const end = portBodyEnd(lines, portIdx);
  const existing = new Set<string>();
  let lastChannel = portIdx;
  for (let i = portIdx + 1; i < end; i++) {
    const m = lines[i].match(/^\s+channel\s+([A-Za-z0-9_]+)/);
    if (m) { existing.add(m[1]); lastChannel = i; }
  }
  const toAdd = names.filter(n => !existing.has(n));
  if (toAdd.length === 0) return 0;
  lines.splice(lastChannel + 1, 0, ...toAdd.map(n => `  channel ${n}`));
  return toAdd.length;
}

/** Rename $vars in `body` that already appear in `text` so a second copy stays independent. */
function uniquifyVars(body: string[], text: string): string[] {
  const vars = new Set<string>();
  for (const l of body) for (const m of l.matchAll(/\$([A-Za-z0-9_]+)/g)) vars.add(m[1]);
  const rename = new Map<string, string>();
  for (const v of vars) {
    if (!new RegExp(`\\$${v}\\b`).test(text)) continue; // unused elsewhere → keep
    let n = 2, cand = `${v}${n}`;
    while (new RegExp(`\\$${cand}\\b`).test(text) || vars.has(cand)) cand = `${v}${++n}`;
    rename.set(v, cand);
  }
  if (rename.size === 0) return body;
  return body.map(l => l.replace(/\$([A-Za-z0-9_]+)/g, (_, v) => `$${rename.get(v) ?? v}`));
}

/**
 * Splice a peripheral into `lines` (mutating it) and return the 1-based line to
 * put the cursor on. Config-less port → short form (inline `channel CH = …` +
 * inline requires). Otherwise full form inside a config, adding missing
 * `channel CH` decls to the port.
 */
export function insertPeripheralLines(lines: string[], ctx: EditorContext, p: Peripheral): number {
  const body = uniquifyVars(p.lines, lines.join('\n'));
  const channels = body.map(mappingChannel).filter((c): c is string => c !== null);

  if (ctx.configIdx < 0 && !ctx.portHasConfig) {
    // Short form — inline into the port body.
    const inserted = body.map(l => isRequireLine(l) ? `  ${l}` : `  channel ${l}`);
    const end = portBodyEnd(lines, ctx.portIdx);
    let last = ctx.portIdx;
    for (let i = ctx.portIdx + 1; i < end; i++) if (lines[i].trim() !== '') last = i;
    lines.splice(last + 1, 0, ...inserted);
    return last + 2;
  }

  // Full form — channel decls on the port, mappings/requires in a config.
  const added = injectChannels(lines, ctx.portIdx, channels);
  if (ctx.configIdx >= 0) {
    const at = configBodyEnd(lines, ctx.configIdx + added);
    lines.splice(at, 0, ...body.map(l => `    ${l}`));
    return at + 1;
  }
  // Port uses configs but the cursor is not inside one → new config.
  let n = 0, cname = p.name;
  while (lines.some(l => new RegExp(`^\\s+config\\s+"${cname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(l))) cname = `${p.name} ${++n}`;
  const at = portBodyEnd(lines, ctx.portIdx);
  lines.splice(at, 0, '', `  config "${cname}":`, ...body.map(l => `    ${l}`));
  return at + 2;
}

/**
 * Whether a double-click should open the "add" helper, given the text the
 * browser selected. Anything containing a word character is a word/line
 * selection the user wants to keep; empty or whitespace-only means they
 * clicked blank space.
 */
export function opensHelperMenu(selectedText: string): boolean {
  return !/\S/.test(selectedText);
}

/** Determine whether the cursor line sits in a port and/or a config. */
export function analyzeEditorContext(lines: string[], lineIdx: number): EditorContext {
  let portIdx = -1;
  for (let i = Math.min(lineIdx, lines.length - 1); i >= 0; i--) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim() !== '') { // first column-0 statement above
      if (/^port\b/.test(l)) portIdx = i;
      break;
    }
  }

  let configIdx = -1, portHasConfig = false;
  if (portIdx >= 0) {
    const end = portBodyEnd(lines, portIdx);
    for (let i = portIdx + 1; i < end; i++) {
      if (/^\s+config\b/.test(lines[i])) {
        portHasConfig = true;
        if (i <= lineIdx) configIdx = i; // nearest enclosing config header at/above
      }
    }
  }
  return { lineIdx, portIdx, configIdx, portHasConfig };
}
const DEBOUNCE_MS = 300;

/** Syntax-highlight a single line of constraint code (no comment handling). */
function highlightCodeLine(code: string): string {
  let result = '';
  let i = 0;
  while (i < code.length) {
    if (code[i] === '"') {
      const start = i; i++;
      while (i < code.length && code[i] !== '"') i++;
      if (i < code.length) i++;
      result += `<span class="ce-string">${escapeHtml(code.substring(start, i))}</span>`;
      continue;
    }
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
      const word = code.substring(start, i);
      if (KEYWORDS.has(word)) {
        result += `<span class="ce-keyword"${docAttr(word)}>${escapeHtml(word)}</span>`;
      } else if (BUILTINS.has(word) || getStdlibMacroNames().has(word)) {
        result += `<span class="ce-builtin"${docAttr(word)}>${escapeHtml(word)}</span>`;
      } else {
        result += escapeHtml(word);
      }
      continue;
    }
    if (/[0-9]/.test(code[i])) {
      const start = i;
      while (i < code.length && /[0-9]/.test(code[i])) i++;
      result += `<span class="ce-number">${escapeHtml(code.substring(start, i))}</span>`;
      continue;
    }
    if ('=!&|^*@$?~'.includes(code[i])) {
      result += `<span class="ce-operator">${escapeHtml(code[i])}</span>`;
      i++; continue;
    }
    result += escapeHtml(code[i]); i++;
  }
  return result;
}

/** Syntax-highlight constraint code (multi-line, with comment handling). */
export function highlightConstraintCode(code: string): string {
  return code.split('\n').map(line => {
    const commentIdx = line.indexOf('#');
    let src = line, comment = '';
    if (commentIdx >= 0) {
      src = line.substring(0, commentIdx);
      comment = line.substring(commentIdx);
    }
    let result = highlightCodeLine(src);
    if (comment) result += `<span class="ce-comment">${escapeHtml(comment)}</span>`;
    return result;
  }).join('\n');
}

export class ConstraintEditor implements Panel {
  readonly id = 'constraint-editor';
  readonly title = 'Constraints';
  readonly headerTooltip = 'The constraint-language editor — describe the peripherals you need, then Solve (Ctrl+Enter). Hover a keyword for help.';

  private container!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private highlight!: HTMLPreElement;
  private highlightInner!: HTMLElement;
  private codeEditor!: CodeEditor;
  private errorPanel!: HTMLDivElement;
  private solverStatusBar!: HTMLDivElement;
  private parseResult: ParseResult | null = null;
  private lintWarnings: LintWarning[] = [];
  private lintWarningLines: Set<number> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private changeCallbacks: Array<(text: string, result: ParseResult) => void> = [];
  private hoverWord: string | null = null;

  // Minimap
  private minimap!: ConstraintMinimap;
  private highlightPinCallbacks: Array<(pins: Set<string>, color?: string, style?: HighlightStyle) => void> = [];
  /** Pins under the caret. The base highlight; minimap hover overrides it while hovering. */
  private caretHighlight: { pins: Set<string>; color: string } | null = null;
  /** Line the caret highlight was computed for, so we only recompute on a real move. */
  private caretLine = -1;
  /** Set while compare mode owns the viewer — the caret stands down (see doc.md, Comparing Solutions). */
  private compareActive = false;

  // Undo/redo
  private undoStack: string[] = [''];
  private undoIndex = 0;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_UNDO = 100;

  createView(container: HTMLElement): void {
    this.container = container;
    this.container.classList.add('constraint-editor');

    // Toolbar: [Solve] [stats] ... [Help]
    const toolbar = document.createElement('div');
    toolbar.className = 'ce-toolbar';

    const solveBtn = document.createElement('button');
    solveBtn.className = 'btn btn-small btn-primary';
    solveBtn.id = 'btn-solve';
    solveBtn.disabled = true;
    solveBtn.textContent = 'Solve';
    solveBtn.title = 'Solve the constraints (Ctrl+Enter) — click again to abort a running solve';
    toolbar.appendChild(solveBtn);

    const stats = document.createElement('span');
    stats.className = 'ce-stats';
    stats.id = 'ce-stats';
    toolbar.appendChild(stats);

    const spacer = document.createElement('span');
    spacer.className = 'ce-toolbar-spacer';
    toolbar.appendChild(spacer);

    const helpBtn = document.createElement('button');
    helpBtn.className = 'btn btn-small';
    helpBtn.textContent = 'Syntax Help';
    helpBtn.title = 'Constraint language syntax reference';
    helpBtn.addEventListener('click', () => this.showHelp());
    toolbar.appendChild(helpBtn);
    this.container.appendChild(toolbar);

    // Editor shell (gutter + highlight overlay + scroll sync) is shared with
    // the library / export dialogs — see createCodeEditor.
    this.codeEditor = createCodeEditor({
      highlighter: highlightConstraintCode,
      onInput: () => this.onInput(),
    });
    const editorWrapper = this.codeEditor.wrapper;
    this.textarea = this.codeEditor.textarea;
    this.highlight = this.codeEditor.highlight;
    this.highlightInner = this.codeEditor.highlightInner;
    this.textarea.placeholder = 'Enter constraints here...\n\n# Example:\nport CMD:\n  channel TX = USART*_TX\n  channel RX = USART*_RX\n  require same_instance(TX, RX)';

    const codeArea = this.codeEditor.codeArea;
    this.setupKeywordTooltips(codeArea);
    this.setupDoubleClickHelper();

    // Minimap
    this.minimap = new ConstraintMinimap();
    this.minimap.onScroll((scrollTop) => {
      this.textarea.scrollTop = scrollTop;
      this.syncScroll();
    });
    this.minimap.onCursorJump((line) => {
      this.setCursorToLine(line);
    });
    this.minimap.onHighlightPins((pins, color) => {
      // Hover and caret share one highlight slot downstream, so the editor
      // arbitrates: hovering a block takes over with the louder pulse, and
      // leaving it falls back to whatever the caret is on rather than clearing.
      if (pins.size > 0) {
        this.emitHighlight(pins, color, 'pulse');
      } else {
        this.emitCaretHighlight();
      }
    });
    editorWrapper.appendChild(this.minimap.element);

    this.container.appendChild(editorWrapper);

    // Error panel
    this.errorPanel = document.createElement('div');
    this.errorPanel.className = 'ce-error-panel';
    this.errorPanel.style.display = 'none';
    this.container.appendChild(this.errorPanel);

    // Solver status bar (solver errors/warnings shown here)
    // Solver output can run to many lines, so it lives in a collapsible bar:
    // the wrapper holds the toggle, the inner element is what callers write to.
    const statusWrap = document.createElement('div');
    statusWrap.className = 'ce-solver-status is-empty';

    const statusToggle = document.createElement('button');
    statusToggle.className = 'ce-status-toggle';
    statusToggle.type = 'button';
    statusToggle.title = 'Collapse solver output';
    statusToggle.textContent = '\u25BE'; // ▾

    this.solverStatusBar = document.createElement('div');
    this.solverStatusBar.className = 'ce-status-content';

    statusToggle.addEventListener('click', () => {
      const collapsed = statusWrap.classList.toggle('collapsed');
      statusToggle.textContent = collapsed ? '\u25B8' : '\u25BE'; // ▸ / ▾
      statusToggle.title = collapsed ? 'Expand solver output' : 'Collapse solver output';
    });

    statusWrap.appendChild(statusToggle);
    statusWrap.appendChild(this.solverStatusBar);
    this.container.appendChild(statusWrap);

    // Hide the whole bar (toggle included) while there is nothing to show.
    new MutationObserver(() => {
      statusWrap.classList.toggle('is-empty', this.solverStatusBar.textContent?.trim() === '');
    }).observe(this.solverStatusBar, { childList: true, subtree: true, characterData: true });

    // Event listeners
    this.textarea.addEventListener('input', () => this.onInput());
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Caret pin highlight. keyup covers arrow keys and typing, click and focus
    // cover the mouse; each is cheap because refreshCaretHighlight bails unless
    // the caret actually changed line.
    for (const ev of ['click', 'keyup', 'focus', 'select'] as const) {
      this.textarea.addEventListener(ev, () => this.refreshCaretHighlight());
    }

    // Resize observer for minimap
    const resizeObserver = new ResizeObserver(() => {
      this.minimap.resize(editorWrapper.clientHeight);
      this.syncMinimapViewport();
      this.syncScroll(); // width change moves the textarea's scroll offsets
    });
    resizeObserver.observe(editorWrapper);

    // Initial render
    this.updateHighlight();
    this.updateLineNumbers();
  }

  onStateChange(change: Record<string, unknown>): void {
    if (change['type'] === 'mcu-loaded') {
      this.minimap.setMcu(change['mcu'] as Mcu | null);
    }
    if (change['type'] === 'theme-changed') {
      this.minimap.paint();
    }
    if (change['type'] === 'compare-selected') {
      // Compare owns the viewer's highlight slot; the caret stands down until a
      // single solution is selected again (which clears compare mode below).
      this.compareActive = true;
      this.emitHighlight(new Set());
    }
    if (change['type'] === 'solution-selected') {
      this.compareActive = false;
      this.minimap.setAssignments((change['assignments'] as Assignment[]) || null);
      // Assignments changed what a line points at.
      this.caretLine = -1;
      this.refreshCaretHighlight();
      // Repaint minimap to reflect solution state
      if (this.parseResult) {
        const totalLines = this.textarea.value.split('\n').length;
        const errorLines = this.parseResult.errors.map(e => e.line);
        this.minimap.update(this.parseResult.ast, totalLines, errorLines);
      }
    }
  }

  onChange(callback: (text: string, result: ParseResult) => void): void {
    this.changeCallbacks.push(callback);
  }

  /** Register callback for pin highlighting (minimap hover and caret position) */
  onHighlightPins(callback: (pins: Set<string>, color?: string, style?: HighlightStyle) => void): void {
    this.highlightPinCallbacks.push(callback);
  }

  getText(): string {
    return this.textarea.value;
  }

  setText(text: string): void {
    this.textarea.value = text;
    this.onInput();
  }

  getParseResult(): ParseResult | null {
    return this.parseResult;
  }

  getSolveButton(): HTMLElement | null {
    return this.container.querySelector('#btn-solve');
  }

  getSolverStatusBar(): HTMLElement | null {
    return this.solverStatusBar ?? null;
  }

  /** Show pre-solve error lines in the minimap (merged with parser errors) */
  setPreSolveErrorLines(lines: number[]): void {
    if (!this.parseResult) return;
    const parserErrors = this.parseResult.errors.map(e => e.line);
    const allErrors = [...new Set([...parserErrors, ...lines])];
    const totalLines = this.textarea.value.split('\n').length;
    this.minimap.update(this.parseResult.ast, totalLines, allErrors, [...this.lintWarningLines]);
    // The AST just changed, so the caret's line may resolve differently now.
    this.refreshCaretHighlight(true);
  }

  // ====================
  // Caret pin highlight
  //
  // Put the caret on a port / group / config / channel line and that scope's
  // pins are ringed in the package viewer, so you can point at a line and see
  // where it lands. Deliberately static and quiet — it stays up while you work,
  // unlike the pulsing hover and search highlights.
  // ====================

  /** 1-based line the caret sits on. */
  private currentCaretLine(): number {
    const upto = this.textarea.value.slice(0, this.textarea.selectionStart);
    return upto.split('\n').length;
  }

  /** Recompute the caret highlight if the caret moved to a different line. */
  private refreshCaretHighlight(force = false): void {
    const line = this.currentCaretLine();
    if (!force && line === this.caretLine) return;
    this.caretLine = line;

    // A blank line points at nothing. Falling back to the enclosing port would
    // ring a whole block for a line the user is only passing through — and the
    // blank line between two ports would still show the one above it.
    const text = this.textarea.value.split('\n')[line - 1] ?? '';
    const hit = text.trim() === '' ? null : this.minimap.pinsForLine(line);
    this.caretHighlight = hit && hit.pins.size > 0 ? { pins: hit.pins, color: hit.color } : null;
    this.emitCaretHighlight();
  }

  /** Broadcast the caret highlight (or clear, when the caret is outside every port). */
  private emitCaretHighlight(): void {
    if (this.compareActive || !this.caretHighlight) {
      this.emitHighlight(new Set());
      return;
    }
    this.emitHighlight(this.caretHighlight.pins, this.caretHighlight.color, 'subtle');
  }

  private emitHighlight(pins: Set<string>, color?: string, style?: HighlightStyle): void {
    for (const cb of this.highlightPinCallbacks) cb(pins, color, style);
  }

  /** Move cursor to the start of a given line (1-based) and scroll into view */
  setCursorToLine(line: number): void {
    const lines = this.textarea.value.split('\n');
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    this.textarea.focus();
    this.textarea.selectionStart = offset;
    this.textarea.selectionEnd = offset;
    // Scroll textarea so the line is visible
    const lineHeight = 18; // matches CSS line-height
    const targetScroll = (line - 1) * lineHeight - this.textarea.clientHeight / 3;
    this.textarea.scrollTop = Math.max(0, targetScroll);
    this.syncScroll();
    this.refreshCaretHighlight();
  }

  getPinDeclarationSignal(pinName: string): string | null {
    const text = this.getText();
    const regex = new RegExp(`^\\s*pin\\s+${escapeRegex(pinName)}\\s*=\\s*(\\S+)`, 'm');
    const match = text.match(regex);
    return match ? match[1] : null;
  }

  insertPinDeclaration(pinName: string, signalName: string): void {
    const text = this.getText();
    const lines = text.split('\n');
    const pinLineRegex = new RegExp(`^\\s*pin\\s+${escapeRegex(pinName)}\\s*=`);

    const existingIndex = lines.findIndex(line => pinLineRegex.test(line));

    if (existingIndex >= 0) {
      lines[existingIndex] = `pin ${pinName} = ${signalName}`;
    } else {
      const insertIdx = this.findPinInsertionIndex(lines);
      lines.splice(insertIdx, 0, `pin ${pinName} = ${signalName}`);
    }

    this.setText(lines.join('\n'));
  }

  removePinDeclaration(pinName: string): boolean {
    const text = this.getText();
    const lines = text.split('\n');
    const pinLineRegex = new RegExp(`^\\s*pin\\s+${escapeRegex(pinName)}\\s*=`);

    const existingIndex = lines.findIndex(line => pinLineRegex.test(line));

    if (existingIndex >= 0) {
      lines.splice(existingIndex, 1);
      // Clean up double blank lines
      if (existingIndex < lines.length && lines[existingIndex] === '' &&
          existingIndex > 0 && lines[existingIndex - 1] === '') {
        lines.splice(existingIndex, 1);
      }
      this.setText(lines.join('\n'));
      return true;
    }
    return false;
  }

  private findPinInsertionIndex(lines: string[]): number {
    let lastPinLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^pin\s+/.test(trimmed)) {
        lastPinLine = i;
      }
    }

    if (lastPinLine >= 0) {
      return lastPinLine + 1;
    }
    return 0;
  }

  /**
   * Show a short doc tooltip when hovering a highlighted keyword / built-in.
   * The highlight layer sits under the (interactive) textarea and is
   * pointer-events:none, so we hit-test it by momentarily toggling that off for
   * the synchronous elementsFromPoint call — typing/selection stay unaffected.
   */
  private setupKeywordTooltips(codeArea: HTMLElement): void {
    const HOVER_DELAY_MS = 350;
    const tip = document.createElement('div');
    tip.className = 'ce-hovertip';
    tip.style.display = 'none';
    document.body.appendChild(tip); // fixed-position, avoids codeArea's overflow clip

    let timer: ReturnType<typeof setTimeout> | null = null;
    let px = 0, py = 0;

    const position = () => {
      const x = Math.min(px + 12, window.innerWidth - tip.offsetWidth - 8);
      const y = Math.min(py + 16, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = `${Math.max(4, x)}px`;
      tip.style.top = `${Math.max(4, y)}px`;
    };

    const hide = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      tip.style.display = 'none';
      this.hoverWord = null;
    };

    codeArea.addEventListener('mousemove', (e) => {
      const span = this.keywordSpanAt(e.clientX, e.clientY);
      const doc = span?.dataset.doc;
      if (!span || !doc) { hide(); return; }
      px = e.clientX; py = e.clientY;

      const word = span.textContent ?? '';
      if (word === this.hoverWord) {           // same keyword: follow cursor once shown
        if (tip.style.display === 'block') position();
        return;
      }
      // Moved onto a different keyword — reset and start the reveal delay.
      if (timer) clearTimeout(timer);
      tip.style.display = 'none';
      this.hoverWord = word;
      timer = setTimeout(() => {
        timer = null;
        tip.innerHTML = `<span class="ce-hovertip-kw">${escapeHtml(word)}</span> ${escapeHtml(doc)}`;
        tip.style.display = 'block';
        position();
      }, HOVER_DELAY_MS);
    });
    codeArea.addEventListener('mouseleave', hide);
    this.textarea.addEventListener('scroll', hide);
  }

  /** Find a highlighted keyword/built-in span under the pointer, if any. */
  private keywordSpanAt(x: number, y: number): HTMLElement | null {
    const prev = this.highlight.style.pointerEvents;
    this.highlight.style.pointerEvents = 'auto';
    const els = document.elementsFromPoint(x, y);
    this.highlight.style.pointerEvents = prev;
    for (const el of els) {
      if (el instanceof HTMLElement && el.dataset.doc) return el;
    }
    return null;
  }

  // ---------------- Double-click "add" helper ----------------

  private setupDoubleClickHelper(): void {
    this.textarea.addEventListener('dblclick', (e) => {
      // The browser has already extended the selection by the time dblclick
      // fires: a word (double-click) or a whole line (triple-click) selects
      // text, whereas clicking whitespace / past the end of a line selects
      // nothing. Only offer the helper in the latter case so normal text
      // selection keeps working.
      const { selectionStart, selectionEnd, value } = this.textarea;
      if (!opensHelperMenu(value.slice(selectionStart, selectionEnd))) return;

      e.preventDefault();
      const lines = value.split('\n');
      const lineIdx = (value.slice(0, selectionStart).match(/\n/g) || []).length;
      const ctx = analyzeEditorContext(lines, lineIdx);
      showContextMenu(e.clientX, e.clientY, this.buildHelperMenu(ctx));
    });
  }

  private buildHelperMenu(ctx: EditorContext): ContextMenuItem[] {
    const FILTERS: Array<[string, string]> = [
      ['mcu', 'mcu: STM32*'],
      ['package', 'package: LQFP*'],
      ['ram', 'ram: 128K'],
      ['rom', 'rom: 256K'],
      ['freq', 'freq: 80'],
      ['temp', 'temp: -40 < 85'],
      ['voltage', 'voltage: 1.8 < 3.6'],
      ['core', 'core: M4'],
    ];
    const items: ContextMenuItem[] = [
      { label: 'Add filter', children: FILTERS.map(([k, tmpl]) => ({ label: k, action: () => this.insertFilter(tmpl) })) },
      { label: 'Add port', action: () => this.insertPort(ctx) },
    ];
    if (ctx.portIdx >= 0) {
      items.push({ label: 'Add config', action: () => this.insertConfig(ctx) });
    }
    if (ctx.portIdx >= 0) {
      const peris = getPeripherals();
      items.push({
        label: 'Add periph',
        disabled: peris.length === 0,
        children: peris.map(p => ({ label: p.name, action: () => this.insertPeripheral(ctx, p) })),
      });
    }
    return items;
  }

  private applyEdit(lines: string[], cursorLine?: number): void {
    this.setText(lines.join('\n'));
    if (cursorLine) this.setCursorToLine(cursorLine);
    this.textarea.focus();
  }

  /** Filters are top-level; add one at the very top of the file. */
  private insertFilter(line: string): void {
    const lines = this.textarea.value.split('\n');
    lines.splice(0, 0, line);
    this.applyEdit(lines, 1);
  }

  /** Insert a fresh port skeleton after the current port (or at the cursor). */
  private insertPort(ctx: EditorContext): void {
    const lines = this.textarea.value.split('\n');
    let n = 0, name = 'PORT';
    while (lines.some(l => new RegExp(`^port\\s+${name}\\b`).test(l))) name = `PORT${++n}`;
    const at = ctx.portIdx >= 0 ? portBodyEnd(lines, ctx.portIdx) : Math.min(ctx.lineIdx + 1, lines.length);
    lines.splice(at, 0, '', `port ${name}:`, '  ');
    this.applyEdit(lines, at + 2);
  }

  /** Insert a fresh config skeleton into the current port (or at the cursor). */
  private insertConfig(ctx: EditorContext): void {
    const lines = this.textarea.value.split('\n');
    // Config lines are indented and quoted (`  config "NAME":`), so match that.
    let n = 0, name = 'CONFIG';
    while (lines.some(l => new RegExp(`^\\s*config\\s+"${name}"`).test(l))) name = `CONFIG${++n}`;
    const at = ctx.portIdx >= 0 ? portBodyEnd(lines, ctx.portIdx) : Math.min(ctx.lineIdx + 1, lines.length);
    lines.splice(at, 0, '', `  config "${name}":`, '  ');
    this.applyEdit(lines, at + 2);
  }

  /** Insert a library peripheral at the cursor's context (see insertPeripheralLines). */
  private insertPeripheral(ctx: EditorContext, p: Peripheral): void {
    if (ctx.portIdx < 0) return;
    const lines = this.textarea.value.split('\n');
    const cursorLine = insertPeripheralLines(lines, ctx, p);
    this.applyEdit(lines, cursorLine);
  }

  private onInput(): void {
    this.updateHighlight();
    this.updateLineNumbers();
    this.pushUndoSnapshot();

    // Debounced parsing
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.doParse();
    }, DEBOUNCE_MS);
  }

  private doParse(): void {
    const text = this.textarea.value;
    this.parseResult = parseConstraints(text);
    this.lintWarnings = computeLintWarnings(this.parseResult);
    this.lintWarningLines = new Set(this.lintWarnings.map(w => w.line).filter((n): n is number => n !== undefined));
    this.updateErrors(this.parseResult.errors, this.lintWarnings);
    this.updateHighlight(); // re-highlight with error/warning info

    // Update minimap
    const totalLines = text.split('\n').length;
    const errorLines = this.parseResult.errors.map(e => e.line);
    this.minimap.update(this.parseResult.ast, totalLines, errorLines, [...this.lintWarningLines]);

    for (const cb of this.changeCallbacks) {
      cb(text, this.parseResult);
    }
  }

  private pushUndoSnapshot(): void {
    // Debounce: group rapid edits into one snapshot
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => {
      const text = this.textarea.value;
      if (text === this.undoStack[this.undoIndex]) return;
      // Truncate any redo history
      this.undoStack.length = this.undoIndex + 1;
      this.undoStack.push(text);
      if (this.undoStack.length > ConstraintEditor.MAX_UNDO) {
        this.undoStack.shift();
      }
      this.undoIndex = this.undoStack.length - 1;
    }, 400);
  }

  undo(): void {
    if (this.undoIndex > 0) {
      // Save current state if it differs from top of stack
      const current = this.textarea.value;
      if (current !== this.undoStack[this.undoIndex]) {
        this.undoStack.length = this.undoIndex + 1;
        this.undoStack.push(current);
        this.undoIndex = this.undoStack.length - 1;
      }
      this.undoIndex--;
      this.textarea.value = this.undoStack[this.undoIndex];
      this.onInput();
    }
  }

  redo(): void {
    if (this.undoIndex < this.undoStack.length - 1) {
      this.undoIndex++;
      this.textarea.value = this.undoStack[this.undoIndex];
      this.onInput();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Undo/Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
      return;
    }

    // Tab inserts 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const value = this.textarea.value;
      this.textarea.value = value.substring(0, start) + '  ' + value.substring(end);
      this.textarea.selectionStart = this.textarea.selectionEnd = start + 2;
      this.onInput();
    }

    // Enter: auto-indent
    if (e.key === 'Enter') {
      const start = this.textarea.selectionStart;
      const value = this.textarea.value;
      // Find current line's indentation
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.substring(lineStart, start);
      const indent = line.match(/^(\s*)/)?.[1] || '';
      // If line ends with ':', add extra indent
      const trimmed = line.trim();
      const extra = trimmed.endsWith(':') ? '  ' : '';

      e.preventDefault();
      const insertion = '\n' + indent + extra;
      this.textarea.value = value.substring(0, start) + insertion + value.substring(start);
      this.textarea.selectionStart = this.textarea.selectionEnd = start + insertion.length;
      this.onInput();
    }
  }

  private updateHighlight(): void {
    const text = this.textarea.value;
    if (!text) {
      this.highlightInner.innerHTML = '';
      return;
    }

    const errorLines = new Set<number>();
    if (this.parseResult) {
      for (const err of this.parseResult.errors) {
        errorLines.add(err.line);
      }
    }

    const lines = text.split('\n');
    const highlighted = lines.map((line, idx) => {
      const lineNum = idx + 1;
      let html = this.highlightLine(line);
      if (errorLines.has(lineNum)) {
        html = `<span class="ce-error-line">${html}</span>`;
      } else if (this.lintWarningLines.has(lineNum)) {
        html = `<span class="ce-warning-line">${html}</span>`;
      }
      return html;
    });

    this.highlightInner.innerHTML = highlighted.join('\n');
    // Re-sync scroll after innerHTML replacement (which resets scrollTop)
    this.syncScroll();
  }

  private highlightLine(line: string): string {
    const commentIdx = line.indexOf('#');
    let code = line, comment = '';
    if (commentIdx >= 0) {
      code = line.substring(0, commentIdx);
      comment = line.substring(commentIdx);
    }
    let result = highlightCodeLine(code);
    if (comment) result += `<span class="ce-comment">${escapeHtml(comment)}</span>`;
    return result;
  }

  private updateLineNumbers(): void {
    this.codeEditor.renumber();
  }

  /** Ensure line numbers scrollHeight matches textarea scrollHeight so they scroll in sync */

  private updateErrors(errors: ParseError[], warnings: LintWarning[] = []): void {
    if (errors.length === 0 && warnings.length === 0) {
      this.errorPanel.style.display = 'none';
      return;
    }

    this.errorPanel.style.display = 'block';

    const errorHtml = errors
      .slice(0, 5)
      .map(err => {
        const suggestion = err.suggestion ? `<span class="ce-suggestion">${escapeHtml(err.suggestion)}</span>` : '';
        return `<div class="ce-error-item">
          <span class="ce-error-loc">Line ${err.line}:${err.column}</span>
          <span class="ce-error-msg">${escapeHtml(err.message)}</span>
          ${suggestion}
        </div>`;
      })
      .join('');

    const remaining = Math.max(0, 5 - errors.length);
    const warningHtml = warnings
      .slice(0, remaining)
      .map(w => {
        const loc = w.line !== undefined ? `Line ${w.line}` : 'Warning';
        return `<div class="ce-error-item ce-warning-item">
          <span class="ce-error-loc">${loc}</span>
          <span class="ce-error-msg">${escapeHtml(w.message)}</span>
        </div>`;
      })
      .join('');

    this.errorPanel.innerHTML = errorHtml + warningHtml;

    const shown = Math.min(errors.length, 5) + Math.min(warnings.length, remaining);
    const total = errors.length + warnings.length;
    if (total > shown) {
      this.errorPanel.innerHTML += `<div class="ce-error-more">...and ${total - shown} more</div>`;
    }
  }

  private syncScroll(): void {
    this.codeEditor.syncScroll();
    this.syncMinimapViewport();
  }

  private syncMinimapViewport(): void {
    this.minimap.updateViewport(this.textarea.scrollTop, this.textarea.clientHeight);
  }

  private showHelp(): void {
    const result = createModal({
      overlayClass: 'ce-help-overlay',
      modalClass: 'ce-help-modal',
      toggle: '.ce-help-overlay',
    });
    if (!result) return;
    const { modal, close } = result;
    modal.innerHTML = `
      <div class="ce-help-header">
        <strong>Constraint Syntax Reference</strong>
        <button class="btn btn-small ce-help-close">Close</button>
      </div>
      <div class="ce-help-body">${renderMarkdown(syntaxHelpMd)}</div>
    `;

    modal.querySelector('.ce-help-close')!.addEventListener('click', close);
  }
}

/**
 * Run common-error lint on the parsed AST. Macro expansion is best-effort
 * — if it throws (usually because of unfinished user edits), we fall back
 * to linting the raw AST so direct mappings still get flagged.
 */
function computeLintWarnings(parseResult: ParseResult): LintWarning[] {
  const lib = getCachedLintLib();
  if (lib.siblingsByToken.size === 0 || !parseResult.ast) return [];

  let ast = parseResult.ast;
  try {
    const expanded = resolveTemplates(ast, getStdlibTemplates());
    if (expanded.ast) ast = expanded.ast;
  } catch {
    // Fall back to raw AST — direct mappings still get linted.
  }

  return lintForCommonErrors(ast, lib);
}
