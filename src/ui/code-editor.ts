// ============================================================
// Shared textarea-with-highlight-overlay editor
// Extracted from the constraints editor so the library / export
// dialogs get the same behaviour instead of each re-implementing it.
// ============================================================

export interface CodeEditor {
  /** Root element — append this where the editor should appear. */
  wrapper: HTMLElement;
  /** Overlay host; extra affordances (tooltips, menus) attach here. */
  codeArea: HTMLElement;
  textarea: HTMLTextAreaElement;
  /** Highlight overlay; its inner span is what actually gets transformed. */
  highlight: HTMLPreElement;
  highlightInner: HTMLElement;
  lineNumbers: HTMLElement;
  lineNumbersInner: HTMLElement;
  /** Re-render the highlight overlay from the textarea's value. */
  rehighlight(): void;
  /** Re-render the line-number gutter from the textarea's value. */
  renumber(): void;
  /** rehighlight + renumber. */
  refresh(): void;
  /** Re-apply the scroll offset (call after replacing innerHTML). */
  syncScroll(): void;
}

export interface CodeEditorOptions {
  /** Turns source text into highlight HTML. */
  highlighter: (source: string) => string;
  /** Show the line-number gutter (default true). */
  lineNumbers?: boolean;
  /** Indent inserted on Tab; '' disables the Tab handler (default two spaces). */
  tabInsert?: string;
  /** Called after the value changes through typing or Tab. */
  onInput?: () => void;
}

export function createCodeEditor(opts: CodeEditorOptions): CodeEditor {
  const showLineNumbers = opts.lineNumbers !== false;
  const tabInsert = opts.tabInsert ?? '  ';

  const wrapper = document.createElement('div');
  wrapper.className = 'ce-editor-wrapper';

  const lineNumbers = document.createElement('div');
  lineNumbers.className = 'ce-line-numbers';
  const lineNumbersInner = document.createElement('div');
  lineNumbersInner.className = 'ce-line-nums-inner';
  lineNumbersInner.innerHTML = '<div class="ce-line-num">1</div>';
  lineNumbers.appendChild(lineNumbersInner);
  if (showLineNumbers) wrapper.appendChild(lineNumbers);

  const codeArea = document.createElement('div');
  codeArea.className = 'ce-code-area';

  const textarea = document.createElement('textarea');
  textarea.className = 'ce-textarea';
  textarea.spellcheck = false;
  textarea.autocapitalize = 'off';
  textarea.autocomplete = 'off';
  codeArea.appendChild(textarea);

  const highlight = document.createElement('pre');
  highlight.className = 'ce-highlight';
  const highlightInner = document.createElement('span');
  highlightInner.className = 'ce-highlight-inner';
  highlight.appendChild(highlightInner);
  codeArea.appendChild(highlight);

  wrapper.appendChild(codeArea);

  /**
   * Offset the overlays by transform rather than assigning scrollTop. The
   * highlight and gutter are shorter than the textarea (the textarea reserves a
   * screenful of scroll past the last line, which the overlays don't mirror),
   * so scrollTop got clamped near the bottom and the line numbers drifted a
   * line away from the text. A transform has no such limit.
   */
  const syncScroll = (): void => {
    const x = textarea.scrollLeft, y = textarea.scrollTop;
    highlightInner.style.transform = `translate(${-x}px, ${-y}px)`;
    lineNumbersInner.style.transform = `translateY(${-y}px)`;
  };

  const rehighlight = (): void => {
    highlightInner.innerHTML = opts.highlighter(textarea.value) + '\n';
  };

  const renumber = (): void => {
    if (!showLineNumbers) return;
    const count = textarea.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= count; i++) html += `<div class="ce-line-num">${i}</div>`;
    lineNumbersInner.innerHTML = html;
  };

  const refresh = (): void => { rehighlight(); renumber(); syncScroll(); };

  // With an onInput hook the caller repaints the highlight itself (it may
  // annotate it with parse results), so only the gutter is refreshed here.
  textarea.addEventListener('input', () => {
    if (opts.onInput) { renumber(); syncScroll(); opts.onInput(); } else { refresh(); }
  });
  textarea.addEventListener('scroll', syncScroll);

  if (tabInsert) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = textarea;
      textarea.value = value.slice(0, s) + tabInsert + value.slice(t);
      textarea.selectionStart = textarea.selectionEnd = s + tabInsert.length;
      if (opts.onInput) { renumber(); syncScroll(); opts.onInput(); } else { refresh(); }
    });
  }

  return { wrapper, codeArea, textarea, highlight, highlightInner, lineNumbers, lineNumbersInner, rehighlight, renumber, refresh, syncScroll };
}
