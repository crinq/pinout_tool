import { describe, it, expect } from 'vitest';
import { createCodeEditor } from '../src/ui/code-editor';

const esc = (s: string) => s.replace(/</g, '&lt;');

describe('shared code editor', () => {
  it('renders a gutter line per line', () => {
    const e = createCodeEditor({ highlighter: esc });
    e.textarea.value = 'a\nb\nc';
    e.refresh();
    expect(e.lineNumbersInner.querySelectorAll('.ce-line-num')).toHaveLength(3);
  });

  it('offsets both overlays by transform, not scrollTop', () => {
    // Regression: assigning scrollTop got clamped because the overlays are
    // shorter than the textarea, so the gutter lagged a line behind the text
    // once you scrolled past the end of the file.
    const e = createCodeEditor({ highlighter: esc });
    e.textarea.value = 'x\n'.repeat(200);
    e.refresh();
    Object.defineProperty(e.textarea, 'scrollTop', { value: 1234, writable: true });
    Object.defineProperty(e.textarea, 'scrollLeft', { value: 7, writable: true });
    e.syncScroll();
    expect(e.lineNumbersInner.style.transform).toBe('translateY(-1234px)');
    expect(e.highlightInner.style.transform).toBe('translate(-7px, -1234px)');
  });

  it('keeps gutter and highlight on the same offset', () => {
    const e = createCodeEditor({ highlighter: esc });
    Object.defineProperty(e.textarea, 'scrollTop', { value: 999, writable: true });
    e.syncScroll();
    const y = (t: string) => /translate(?:Y)?\(?(?:(-?\d+)px, )?(-?\d+)px\)/.exec(t)!.slice(-1)[0];
    expect(y(e.lineNumbersInner.style.transform)).toBe(y(e.highlightInner.style.transform));
  });

  it('Tab inserts an indent instead of leaving the field', () => {
    const e = createCodeEditor({ highlighter: esc });
    e.textarea.value = 'ab';
    e.textarea.selectionStart = e.textarea.selectionEnd = 1;
    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    e.textarea.dispatchEvent(ev);
    expect(e.textarea.value).toBe('a  b');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('escapes through the supplied highlighter', () => {
    const e = createCodeEditor({ highlighter: esc });
    e.textarea.value = '<script>';
    e.rehighlight();
    expect(e.highlightInner.innerHTML).toContain('&lt;script&gt;');
    expect(e.highlightInner.querySelector('script')).toBeNull();
  });

  it('with an onInput hook, typing does not clobber a custom highlight', () => {
    // The constraints editor paints its own annotated highlight in onInput.
    let calls = 0;
    const e = createCodeEditor({ highlighter: () => 'PLAIN', onInput: () => { calls++; e.highlightInner.innerHTML = 'ANNOTATED'; } });
    e.textarea.value = 'x';
    e.textarea.dispatchEvent(new Event('input'));
    expect(calls).toBe(1);
    expect(e.highlightInner.innerHTML).toBe('ANNOTATED');
    expect(e.lineNumbersInner.querySelectorAll('.ce-line-num')).toHaveLength(1);
  });

  it('can omit the gutter', () => {
    const e = createCodeEditor({ highlighter: esc, lineNumbers: false });
    expect(e.wrapper.querySelector('.ce-line-numbers')).toBeNull();
  });
});
