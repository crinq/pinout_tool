import type { Panel } from './panel';
import { parseConstraints } from '../parser/constraint-parser';
import type { ParseError, ParseResult } from '../parser/constraint-ast';
import type { Mcu, Assignment } from '../types';
import { getStdlibMacroNames, getStdlibMacros, getStdlibTemplates } from '../parser/stdlib-macros';
import { expandAllMacros } from '../parser/macro-expander';
import { lintForCommonErrors, getCachedLintLib, type LintWarning } from '../parser/lint-common-errors';
import { escapeHtml, escapeRegex, createModal } from '../utils';
import { showContextMenu, type ContextMenuItem } from '../../ts_lib/src/context-menu';
import { getPeripherals, type Peripheral } from '../parser/peripheral-lib';
import { ConstraintMinimap } from './constraint-minimap';

const KEYWORDS = new Set(['mcu', 'package', 'ram', 'rom', 'freq', 'temp', 'voltage', 'core', 'reserve', 'shared', 'pin', 'port', 'channel', 'config', 'require', 'macro', 'color', 'from', 'settings']);
const BUILTINS = new Set(['same_instance', 'diff_instance', 'instance', 'type', 'gpio_pin', 'gpio_port', 'channel_signal', 'channel_number', 'instance_number', 'pin_number', 'pin_row', 'pin_col', 'pin_distance', 'IN', 'OUT', 'dma']);

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
  private lineNumbers!: HTMLDivElement;
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
  private highlightPinCallbacks: Array<(pins: Set<string>, color?: string) => void> = [];

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

    // Editor wrapper (line numbers + code area)
    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'ce-editor-wrapper';

    // Line numbers
    this.lineNumbers = document.createElement('div');
    this.lineNumbers.className = 'ce-line-numbers';
    this.lineNumbers.textContent = '1';
    editorWrapper.appendChild(this.lineNumbers);

    // Code area (highlight + textarea overlay)
    const codeArea = document.createElement('div');
    codeArea.className = 'ce-code-area';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'ce-textarea';
    this.textarea.spellcheck = false;
    this.textarea.autocapitalize = 'off';
    this.textarea.autocomplete = 'off';
    this.textarea.placeholder = 'Enter constraints here...\n\n# Example:\nport CMD:\n  channel TX = USART*_TX\n  channel RX = USART*_RX\n  require same_instance(TX, RX)';
    codeArea.appendChild(this.textarea);

    this.highlight = document.createElement('pre');
    this.highlight.className = 'ce-highlight';
    codeArea.appendChild(this.highlight);

    this.setupKeywordTooltips(codeArea);
    this.setupDoubleClickHelper();

    editorWrapper.appendChild(codeArea);

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
      for (const cb of this.highlightPinCallbacks) cb(pins, color);
    });
    editorWrapper.appendChild(this.minimap.element);

    this.container.appendChild(editorWrapper);

    // Error panel
    this.errorPanel = document.createElement('div');
    this.errorPanel.className = 'ce-error-panel';
    this.errorPanel.style.display = 'none';
    this.container.appendChild(this.errorPanel);

    // Solver status bar (solver errors/warnings shown here)
    this.solverStatusBar = document.createElement('div');
    this.solverStatusBar.className = 'ce-solver-status';
    this.container.appendChild(this.solverStatusBar);

    // Event listeners
    this.textarea.addEventListener('input', () => this.onInput());
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Resize observer for minimap
    const resizeObserver = new ResizeObserver(() => {
      this.minimap.resize(editorWrapper.clientHeight);
      this.syncMinimapViewport();
      this.syncLineNumbersHeight();
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
    if (change['type'] === 'solution-selected') {
      this.minimap.setAssignments((change['assignments'] as Assignment[]) || null);
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

  /** Register callback for minimap pin highlighting */
  onHighlightPins(callback: (pins: Set<string>, color?: string) => void): void {
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
      this.highlight.innerHTML = '';
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

    this.highlight.innerHTML = highlighted.join('\n');
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
    const lines = this.textarea.value.split('\n');
    this.lineNumbers.innerHTML = lines
      .map((_, i) => `<div class="ce-line-num">${i + 1}</div>`)
      .join('') + '<div class="ce-line-spacer"></div>';
    this.syncLineNumbersHeight();
  }

  /** Ensure line numbers scrollHeight matches textarea scrollHeight so they scroll in sync */
  private syncLineNumbersHeight(): void {
    const spacer = this.lineNumbers.querySelector('.ce-line-spacer') as HTMLElement | null;
    if (!spacer) return;
    spacer.style.height = '0';
    const diff = this.textarea.scrollHeight - this.lineNumbers.scrollHeight;
    if (diff > 0) {
      spacer.style.height = diff + 'px';
    }
  }

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
    this.highlight.scrollTop = this.textarea.scrollTop;
    this.highlight.scrollLeft = this.textarea.scrollLeft;
    this.lineNumbers.scrollTop = this.textarea.scrollTop;
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
      <div class="ce-help-body">
        <section>
          <h3>Structure</h3>
          <pre class="ce-help-code"># MCU selection (glob patterns, searches stored MCUs)
mcu: STM32F405*
mcu: STM32G4*VE | STM32F4*VG

# Filter by package, RAM/ROM/freq/temp/voltage
package: LQFP[100,144] | BGA*
ram: 256K          # minimum 256KB
rom: < 2M          # maximum 2MB
freq: 100 < 480    # between 100 and 480 MHz
temp: -40 < 85     # operating temperature range
voltage: 1.8 < 3.3  # operating voltage range (V suffix optional)
core: M4           # MCU must have Cortex-M4
core: M4 + M7      # dual-core (both required)

# Reserve pins and peripherals from solving
reserve: PH0, PH1, ADC*, SPI[1,3]

# Allow peripheral instance sharing across ports
shared: ADC*

# Fix a pin to a specific signal
pin PA4 = DAC1_OUT1</pre>
        </section>

        <section>
          <h3>Shared Peripherals</h3>
          <p>By default, a peripheral instance (e.g., ADC1) is exclusive to one port.
          Use <code>shared</code> to allow multiple ports to use the same instance (individual signals remain exclusive):</p>
          <pre class="ce-help-code"># Exact instance
shared: ADC1

# Wildcard (all ADC instances)
shared: ADC*

# Range
shared: ADC[1,2], TIM[1-4]</pre>
        </section>

        <section>
          <h3>Ports, Channels &amp; Configs</h3>
          <pre class="ce-help-code"># Inline config (single config ports):
port CMD:
  channel TX = USART*_TX
  channel RX @ PA3 = USART*_RX  # pin-restricted
  require same_instance(TX, RX)

# Explicit configs (multiple alternatives):
port CMD:
  channel TX
  channel RX

  config "UART full duplex":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)

  config "UART half duplex":
    TX = USART*_TX</pre>
          <p>For single-config ports, write mappings on the <code>channel</code> line with <code>=</code> (creates an implicit config named after the port).
          For multiple alternatives, use explicit <code>config</code> blocks &mdash; the solver tries all combinations.
          Inline <code>#</code> comments on port, channel, and pin lines are available in custom export functions.</p>
        </section>

        <section>
          <h3>Solver Settings</h3>
          <pre class="ce-help-code">settings:
  timeout: 3s              # or 3000ms
  solvers: "mrv-group", "hybrid"
  skip_gpio_mapping: 0     # 0/1 or true/false
  pin_proximity: 5         # any cost-function weight

# start from a preset, then override
settings from "complex":
  timeout: 30s</pre>
          <p>Overrides solver settings for this run only &mdash; your saved Settings are untouched.
          Keys: <code>timeout</code>, <code>dynamic_timeout</code>, <code>solvers</code>, <code>max_solutions</code>,
          <code>max_groups</code>, <code>max_solutions_per_group</code>, <code>num_restarts</code>,
          <code>skip_gpio_mapping</code>, <code>post_optimize</code>, <code>squared_costs</code>,
          plus any cost-function id (<code>pin_count</code>, <code>pin_proximity</code>, <code>pin_anchor</code>, &hellip;).
          Presets: <code>"default"</code>, <code>"complex"</code>.</p>
        </section>

        <section>
          <h3>Pin Placement (<code>@</code>)</h3>
          <pre class="ce-help-code"># Hard: restrict a channel to specific pins
channel TX @ PA1, PB2
channel TX @ !PA1        # exclude a pin
channel TX @ PA1, !PB2   # required and excluded can be mixed

# Soft: nudge toward a pin / position / compass region
channel TX @ ~PA1        # near pin PA1
channel TX @ ~1          # near package position 1 (or ~A1 on BGA)
channel TX @ ~NW         # near the north-west of the package

# Port / config placement (after the colon)
port CMD: @ PA1          # some channel must use PA1 (hard)
port CMD: @ !PB1         # no channel may use PB1 (hard)
port CMD: @ ~NW          # pull every channel toward NW (soft)
config "UART": @ ~NW     # only the channels in this config</pre>
          <p>Bare pins (<code>@ PA1</code>) filter candidates; <code>!pin</code> removes a pin from them.
          A <code>~</code> anchor is soft &mdash; it only biases ranking via the <b>Pin Anchor</b> cost weight.
          Compass letters <code>N/S/E/W/C</code> combine
          (<code>NW</code>, <code>NNW</code>, <code>NC</code>) and rotate with the package as drawn.</p>
        </section>

        <section>
          <h3>Port Color</h3>
          <p>Use <code>color</code> to visually distinguish ports in the package viewer:</p>
          <pre class="ce-help-code">port CMD:
  color "red"
  channel TX
  channel RX
  ...</pre>
          <p>Any CSS color value works (<code>"#ff0000"</code>, <code>"orange"</code>, <code>"rgb(0,128,255)"</code>).</p>
        </section>

        <section>
          <h3>Signal Patterns</h3>
          <table>
            <tr><td><code>USART1_TX</code></td><td>Exact match</td></tr>
            <tr><td><code>USART*_TX</code></td><td>Any USART instance, TX</td></tr>
            <tr><td><code>TIM[1-3]_CH1</code></td><td>TIM1, TIM2, or TIM3, CH1</td></tr>
            <tr><td><code>ADC*_IN[0-7]</code></td><td>Any ADC, inputs 0-7</td></tr>
            <tr><td><code>*_TX</code></td><td>Any peripheral, TX signal</td></tr>
            <tr><td><code>OUT</code> / <code>IN</code></td><td>Any GPIO pin (simple I/O)</td></tr>
          </table>
        </section>

        <section>
          <h3>Operators in Mappings</h3>
          <p><code>|</code> (alternatives): channel matches ANY of the patterns<br>
          <code>+</code> (multi-pin): channel gets a separate pin for EACH expression</p>
          <p>Evaluation: <code>A | B + C | D</code> means <code>(A | B) + (C | D)</code></p>
          <pre class="ce-help-code"># Channel accepts SPI or I2C (alternatives):
COMM = SPI*_MOSI | I2C*_SDA

# Channel gets an SPI pin AND an extra GPIO pin:
MOSI = SPI*_MOSI + GPIO[1-2]_*</pre>
          <p>To restrict a channel to a specific GPIO port without extra pins, use <code>require</code>:</p>
          <pre class="ce-help-code">require gpio_port(MOSI) == "GPIO1"  # port A only</pre>
        </section>

        <section>
          <h3>Built-in Functions</h3>
          <table>
            <tr><td><code>same_instance(A, B)</code></td><td>Same peripheral instance</td></tr>
            <tr><td><code>same_instance(A, B, "TIM")</code></td><td>Same instance, filtered by type</td></tr>
            <tr><td><code>diff_instance(A, B)</code></td><td>Different instances</td></tr>
            <tr><td><code>instance(A)</code></td><td>Get instance name</td></tr>
            <tr><td><code>instance(A, "TIM")</code></td><td>Get instance name, filtered by type</td></tr>
            <tr><td><code>type(A)</code></td><td>Get peripheral type</td></tr>
            <tr><td><code>type(A, "TIM")</code></td><td>Get peripheral type, filtered by type</td></tr>
            <tr><td><code>gpio_port(A)</code></td><td>Get GPIO port (e.g., "GPIO1")</td></tr>
            <tr><td><code>gpio_port(A, "SPI")</code></td><td>Get GPIO port, filtered by type</td></tr>
            <tr><td><code>gpio_pin(A)</code></td><td>Get pin name (e.g., "PA4")</td></tr>
            <tr><td><code>gpio_pin(A, "SPI")</code></td><td>Get pin name, filtered by type</td></tr>
            <tr><td><code>pin_number(A)</code></td><td>Physical pin number (integer)</td></tr>
            <tr><td><code>channel_number(A)</code></td><td>Peripheral channel/input number</td></tr>
            <tr><td><code>channel_signal(A)</code></td><td>Signal function name (e.g., "TX", "CH3")</td></tr>
            <tr><td><code>instance_number(A)</code></td><td>Peripheral instance number</td></tr>
            <tr><td><code>pin_row(A)</code></td><td>BGA row / LQFP y-component</td></tr>
            <tr><td><code>pin_col(A)</code></td><td>BGA column / LQFP x-component</td></tr>
            <tr><td><code>pin_distance(A, B)</code></td><td>Physical distance between pins</td></tr>
            <tr><td><code>dma(A)</code></td><td>DMA stream available for channel</td></tr>
            <tr><td><code>dma(A, "USART")</code></td><td>DMA check filtered by type</td></tr>
          </table>
          <p>Numeric functions support comparison: <code>&lt;</code>, <code>&gt;</code>, <code>&lt;=</code>, <code>&gt;=</code>, <code>+</code>, <code>-</code></p>
          <pre class="ce-help-code">require channel_number(A) < channel_number(B)
require pin_number(A) - pin_number(B) < 5
require dma(TX)</pre>
        </section>

        <section>
          <h3>Variable Assignment ($)</h3>
          <p>Use <code>$name</code> after a mapping to assign the resolved value to a variable.
          Variables map positionally to wildcards (instance first, then function).
          Channels sharing the same <code>$name</code> must resolve to the same value.
          Scoped to the port (across all configs).</p>
          <pre class="ce-help-code"># Instance wildcard: $u → same_instance(TX, RX)
TX = USART*_TX $u
RX = USART*_RX $u

# Function wildcard: $ch → channel_signal(A) == channel_signal(B)
A = TIM1_CH* $ch
B = TIM1_CH* $ch

# Both: $t → same_instance, $ch → channel_signal ==
A = TIM*_CH* $t $ch
B = TIM*_CH* $t $ch</pre>
        </section>

        <section>
          <h3>Optional Mappings and Requires</h3>
          <p>Use <code>?=</code> for optional mappings &mdash; assigned if possible, skipped without error if not.
          Any <code>require</code> referencing an unassigned optional channel is automatically skipped (vacuous truth).</p>
          <pre class="ce-help-code">port CMD:
  channel TX
  channel RX
  channel CTS
  channel RTS

  config "UART":
    TX = USART*_TX $u
    RX = USART*_RX $u
    CTS ?= USART*_CTS $u
    RTS ?= USART*_RTS $u</pre>
          <p>Use <code>require?</code> for soft constraints &mdash; ignored if they evaluate to false:</p>
          <pre class="ce-help-code">require? gpio_port(TX) == gpio_port(RX)</pre>
        </section>

        <section>
          <h3>Port Templates</h3>
          <p>Define a port once, instantiate multiple times with <code>from</code>:</p>
          <pre class="ce-help-code">port encoder_port:
  channel A
  channel B
  config "quadrature":
    encoder(A, B)

port ENC0 from encoder_port color "orange"
port ENC1 from encoder_port color "green"

# Override specific configs:
port ENC2 from encoder_port color "red":
  config "quadrature":
    A = TIM[1-3]_CH1
    B = TIM[1-3]_CH2</pre>
          <p>Templates chain &mdash; a port declared with <code>from X</code> can itself be used as a template
          by another port. Cycles are detected and reported as errors.</p>
        </section>

        <section>
          <h3>Common-Error Lint</h3>
          <p>The editor warns when a channel name and its signal pattern reference
          different tokens from the same "confusable" group &mdash; e.g. a channel called
          <code>miso</code> mapped to <code>SPI*_MOSI</code>.</p>
          <p>Warning lines get a yellow wavy underline and a matching marker in the
          minimap; details appear in the status panel below the editor.
          Edit the swap-group library via <b>Data Manager &gt; Common-error Lint Library</b>.</p>
          <pre class="ce-help-code"># Library format: one group per line, tokens separated by spaces.
# The lint flags any mapping where channel + signal contain
# different tokens from the same group.
miso mosi
tx rx
cts rts
ch1 ch2 ch3 ch4</pre>
        </section>

        <section>
          <h3>Standard Library Macros</h3>
          <p>Pre-defined macros for common peripherals. Edit via <b>Data Manager &gt; Macro Library</b>.</p>
          <table>
            <tr><td><code>uart_port(TX, RX)</code></td><td>USART full-duplex (same instance)</td></tr>
            <tr><td><code>uart_half_duplex(TX)</code></td><td>USART TX only</td></tr>
            <tr><td><code>spi_port(MOSI, MISO, SCK)</code></td><td>SPI master 3-wire</td></tr>
            <tr><td><code>spi_port(MOSI, MISO, SCK, NSS)</code></td><td>SPI master with chip select</td></tr>
            <tr><td><code>i2c_port(SDA, SCL)</code></td><td>I2C port</td></tr>
            <tr><td><code>encoder(A, B)</code></td><td>Timer encoder (CH1+CH2)</td></tr>
            <tr><td><code>encoder(A, B, Z)</code></td><td>Encoder + index (CH1+CH2+CH3/4)</td></tr>
            <tr><td><code>pwm(CH)</code></td><td>PWM on any timer channel</td></tr>
            <tr><td><code>dac(OUT)</code></td><td>DAC output</td></tr>
            <tr><td><code>adc(IN)</code></td><td>ADC input</td></tr>
            <tr><td><code>can_port(TX, RX)</code></td><td>CAN bus</td></tr>
          </table>
          <pre class="ce-help-code"># Usage in a config:
config "UART":
  uart_port(TX, RX)</pre>
        </section>

        <section>
          <h3>Simple I/O Pins</h3>
          <p>Use <code>OUT</code> and <code>IN</code> for simple GPIO pins (LEDs, buttons, etc.):</p>
          <pre class="ce-help-code">port STATUS:
  channel LED
  channel BTN

  config "GPIO":
    LED = OUT
    BTN = IN</pre>
          <p>Both match any assignable GPIO pin. The distinction is semantic.</p>
        </section>

        <section>
          <h3>GPIO Port Constraints</h3>
          <p>Use <code>gpio_port(CH)</code> in require to restrict a channel to a GPIO port.<br>
          Port mapping: A=GPIO1, B=GPIO2, C=GPIO3, D=GPIO4, ...</p>
          <pre class="ce-help-code"># USART TX must be on port A:
require gpio_port(TX) == "GPIO1"

# LED must be on port B:
require gpio_port(LED) == "GPIO2"

# TX and RX on the same GPIO port:
require gpio_port(TX) == gpio_port(RX)</pre>
          <p>GPIO signals are also available for multi-pin mappings: <code>GPIO1_*</code>, <code>GPIO[1-2]_*</code></p>
        </section>

        <section>
          <h3>Comment Interpolation</h3>
          <p>Channel comments are included in exports. Use <code>\${expr}</code> for dynamic values:</p>
          <pre class="ce-help-code">port CMD:
  channel TX  # \${instance(TX)}_TX on pin \${gpio_pin(TX)}
  channel RX  # \${instance(RX)}_RX on pin \${gpio_pin(RX)}</pre>
          <p>Supported expressions: <code>\${instance(CH)}</code>, <code>\${gpio_pin(CH)}</code>,
          <code>\${type(CH)}</code>, or any channel name <code>\${CH}</code> (resolves to signal name).
          If evaluation fails, <code>?</code> is substituted.</p>
        </section>

        <section>
          <h3>Full Example</h3>
          <pre class="ce-help-code">reserve: PH0, PH1, PA13, PA14
pin PA4 = DAC1_OUT1

port CMD:
  color "#2563eb"
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)

port FB:
  color "#16a34a"
  channel A
  channel B

  config "Encoder":
    encoder(A, B)

port SENSOR:
  channel MOSI
  channel MISO
  channel SCK

  config "SPI":
    spi_port(MOSI, MISO, SCK)</pre>
        </section>
      </div>
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
    const expanded = expandAllMacros(ast, getStdlibMacros(), getStdlibTemplates());
    if (expanded.ast) ast = expanded.ast;
  } catch {
    // Fall back to raw AST — direct mappings still get linted.
  }

  return lintForCommonErrors(ast, lib);
}
