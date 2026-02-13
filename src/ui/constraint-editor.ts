import type { Panel, StateChange } from './panel';
import { parseConstraints } from '../parser/constraint-parser';
import type { ParseError, ParseResult } from '../parser/constraint-ast';

const KEYWORDS = ['mcu', 'reserve', 'pin', 'port', 'channel', 'config', 'require', 'macro', 'color'];
const DEBOUNCE_MS = 300;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    this.textarea.placeholder = 'Enter constraints here...\n\n# Example:\nport CMD:\n  channel TX\n  channel RX\n\n  config "UART":\n    TX = USART*_TX\n    RX = USART*_RX\n    require same_instance(TX, RX)';
    codeArea.appendChild(this.textarea);

    this.highlight = document.createElement('pre');
    this.highlight.className = 'ce-highlight';
    codeArea.appendChild(this.highlight);

    editorWrapper.appendChild(codeArea);
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

    // Initial render
    this.updateHighlight();
    this.updateLineNumbers();
  }

  onStateChange(_change: StateChange): void {
    // No external state changes affect the editor currently
  }

  onChange(callback: (text: string, result: ParseResult) => void): void {
    this.changeCallbacks.push(callback);
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
    // Comment
    const commentIdx = line.indexOf('#');
    let code = line;
    let comment = '';
    if (commentIdx >= 0) {
      code = line.substring(0, commentIdx);
      comment = line.substring(commentIdx);
    }

    let result = this.highlightCode(code);
    if (comment) {
      result += `<span class="ce-comment">${this.escapeHtml(comment)}</span>`;
    }
    return result;
  }

  private highlightCode(code: string): string {
    // Tokenize for highlighting
    let result = '';
    let i = 0;

    while (i < code.length) {
      // String literal
      if (code[i] === '"') {
        const start = i;
        i++;
        while (i < code.length && code[i] !== '"') i++;
        if (i < code.length) i++;
        result += `<span class="ce-string">${this.escapeHtml(code.substring(start, i))}</span>`;
        continue;
      }

      // Word
      if (/[a-zA-Z_]/.test(code[i])) {
        const start = i;
        while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
        const word = code.substring(start, i);
        if (KEYWORDS.includes(word)) {
          result += `<span class="ce-keyword">${this.escapeHtml(word)}</span>`;
        } else if (word === 'same_instance' || word === 'diff_instance' || word === 'instance' ||
                   word === 'type' || word === 'gpio_pin' || word === 'gpio_port' || word === 'version' ||
                   word === 'uart_port' || word === 'uart_half_duplex' ||
                   word === 'spi_port' || word === 'spi_port_cs' ||
                   word === 'i2c_port' || word === 'encoder' || word === 'encoder_with_index' ||
                   word === 'pwm' || word === 'dac' || word === 'adc' || word === 'can_port' ||
                   word === 'IN' || word === 'OUT') {
          result += `<span class="ce-builtin">${this.escapeHtml(word)}</span>`;
        } else {
          result += this.escapeHtml(word);
        }
        continue;
      }

      // Number
      if (/[0-9]/.test(code[i])) {
        const start = i;
        while (i < code.length && /[0-9]/.test(code[i])) i++;
        result += `<span class="ce-number">${this.escapeHtml(code.substring(start, i))}</span>`;
        continue;
      }

      // Operator
      if ('=!&|^*@'.includes(code[i])) {
        result += `<span class="ce-operator">${this.escapeHtml(code[i])}</span>`;
        i++;
        continue;
      }

      // Default
      result += this.escapeHtml(code[i]);
      i++;
    }

    return result;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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
        const suggestion = err.suggestion ? `<span class="ce-suggestion">${this.escapeHtml(err.suggestion)}</span>` : '';
        return `<div class="ce-error-item">
          <span class="ce-error-loc">Line ${err.line}:${err.column}</span>
          <span class="ce-error-msg">${this.escapeHtml(err.message)}</span>
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
  }

  private showHelp(): void {
    // Remove existing overlay if any
    const existing = document.querySelector('.ce-help-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'ce-help-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'ce-help-modal';
    modal.innerHTML = `
      <div class="ce-help-header">
        <strong>Constraint Syntax Reference</strong>
        <button class="btn btn-small ce-help-close">Close</button>
      </div>
      <div class="ce-help-body">
        <section>
          <h3>Structure</h3>
          <pre class="ce-help-code"># MCU selection (glob patterns)
mcu: STM32F405*

# Reserve pins from solving
reserve: PH0, PH1

# Fix a pin to a specific signal
pin PA4 = DAC1_OUT1</pre>
        </section>

        <section>
          <h3>Ports, Channels &amp; Configs</h3>
          <pre class="ce-help-code">port CMD:
  channel TX          # unconstrained
  channel RX @ PA3    # pin-restricted

  config "UART full duplex":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)</pre>
          <p>Configs are mutually exclusive per port. The solver tries all combinations.</p>
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
          <code>&amp;</code> (multi-pin): channel gets a separate pin for EACH expression</p>
          <p>Evaluation: <code>A | B &amp; C | D</code> means <code>(A | B) &amp; (C | D)</code></p>
          <pre class="ce-help-code"># Channel accepts SPI or I2C (alternatives):
COMM = SPI*_MOSI | I2C*_SDA

# Channel gets an SPI pin AND an extra GPIO pin:
MOSI = SPI*_MOSI &amp; GPIO[1-2]_*</pre>
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
            <tr><td><code>type(A)</code></td><td>Get peripheral type</td></tr>
            <tr><td><code>gpio_port(A)</code></td><td>Get GPIO port (e.g., "GPIO1")</td></tr>
            <tr><td><code>gpio_port(A, "SPI")</code></td><td>Get GPIO port, filtered by type</td></tr>
            <tr><td><code>gpio_pin(A)</code></td><td>Get pin name (e.g., "PA4")</td></tr>
            <tr><td><code>gpio_pin(A, "SPI")</code></td><td>Get pin name, filtered by type</td></tr>
          </table>
        </section>

        <section>
          <h3>Standard Library Macros</h3>
          <p>Pre-defined macros for common peripherals:</p>
          <table>
            <tr><td><code>uart_port(TX, RX)</code></td><td>USART full-duplex (same instance)</td></tr>
            <tr><td><code>spi_port(MOSI, MISO, SCK)</code></td><td>SPI master 3-wire</td></tr>
            <tr><td><code>spi_port_cs(MOSI, MISO, SCK, NSS)</code></td><td>SPI master with chip select</td></tr>
            <tr><td><code>i2c_port(SDA, SCL)</code></td><td>I2C port</td></tr>
            <tr><td><code>encoder(A, B)</code></td><td>Timer encoder (CH1+CH2)</td></tr>
            <tr><td><code>encoder_with_index(A, B, Z)</code></td><td>Encoder + index (CH1+CH2+CH3)</td></tr>
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

    modal.querySelector('.ce-help-close')!.addEventListener('click', () => overlay.remove());

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }
}
