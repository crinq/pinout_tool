import type { Panel } from './panel';
import { parseConstraints } from '../parser/constraint-parser';
import type { ParseError, ParseResult } from '../parser/constraint-ast';
import type { Mcu, Assignment } from '../types';
import { getStdlibMacroNames } from '../parser/stdlib-macros';
import { escapeHtml, escapeRegex, createModal } from '../utils';
import { ConstraintMinimap } from './constraint-minimap';

const KEYWORDS = new Set(['mcu', 'package', 'ram', 'rom', 'freq', 'temp', 'voltage', 'core', 'reserve', 'shared', 'pin', 'port', 'channel', 'config', 'require', 'macro', 'color', 'from']);
const BUILTINS = new Set(['same_instance', 'diff_instance', 'instance', 'type', 'gpio_pin', 'gpio_port', 'channel_signal', 'channel_number', 'instance_number', 'pin_number', 'pin_row', 'pin_col', 'pin_distance', 'IN', 'OUT', 'dma']);
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
        result += `<span class="ce-keyword">${escapeHtml(word)}</span>`;
      } else if (BUILTINS.has(word) || getStdlibMacroNames().has(word)) {
        result += `<span class="ce-builtin">${escapeHtml(word)}</span>`;
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
    if ('=!&|^*@$?'.includes(code[i])) {
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

  private container!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private highlight!: HTMLPreElement;
  private lineNumbers!: HTMLDivElement;
  private errorPanel!: HTMLDivElement;
  private solverStatusBar!: HTMLDivElement;
  private parseResult: ParseResult | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private changeCallbacks: Array<(text: string, result: ParseResult) => void> = [];

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
    helpBtn.textContent = 'Help';
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
    this.minimap.update(this.parseResult.ast, totalLines, allErrors);
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
    this.updateErrors(this.parseResult.errors);
    this.updateHighlight(); // re-highlight with error info

    // Update minimap
    const totalLines = text.split('\n').length;
    const errorLines = this.parseResult.errors.map(e => e.line);
    this.minimap.update(this.parseResult.ast, totalLines, errorLines);

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
      .join('');
  }

  private updateErrors(errors: ParseError[]): void {
    if (errors.length === 0) {
      this.errorPanel.style.display = 'none';
      return;
    }

    this.errorPanel.style.display = 'block';
    this.errorPanel.innerHTML = errors
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

    if (errors.length > 5) {
      this.errorPanel.innerHTML += `<div class="ce-error-more">...and ${errors.length - 5} more errors</div>`;
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
          <p><code>|</code> (alternatives): pin matches ANY of the patterns<br>
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
          <p>Channel comments are included in exports. Use <code>{}</code> placeholders for dynamic values:</p>
          <pre class="ce-help-code">port CMD:
  channel TX  # UART TX: {signal} on {pin}
  channel RX  # UART RX: {signal} on {pin}</pre>
          <p>Available placeholders: <code>{pin}</code>, <code>{signal}</code>, <code>{port}</code>,
          <code>{channel}</code>, <code>{config}</code>, <code>{instance}</code>, <code>{type}</code>,
          <code>{function}</code>, <code>{number}</code>, <code>{gpio_port}</code></p>
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
