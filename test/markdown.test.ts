import { describe, it, expect } from 'vitest';
import { renderMarkdown, slug } from '../src/ui/markdown';

describe('markdown renderer', () => {
  it('slugs headings GitHub-style', () => {
    expect(slug('MCU Selection')).toBe('mcu-selection');
    expect(slug('Constraints (require)')).toBe('constraints-require');
    expect(slug('Built-in Functions')).toBe('built-in-functions');
  });

  it('renders headings with anchor ids', () => {
    expect(renderMarkdown('## MCU Selection')).toBe('<h2 id="mcu-selection">MCU Selection</h2>');
  });

  it('renders inline code, bold, italic and links', () => {
    expect(renderMarkdown('use `pin PA5 = SPI1_SCK` here'))
      .toContain('<code>pin PA5 = SPI1_SCK</code>');
    expect(renderMarkdown('**bold** and *em*'))
      .toBe('<p><strong>bold</strong> and <em>em</em></p>');
    expect(renderMarkdown('see [Overview](#overview)'))
      .toContain('<a href="#overview">Overview</a>');
  });

  it('escapes HTML in text and code', () => {
    expect(renderMarkdown('a < b & c')).toBe('<p>a &lt; b &amp; c</p>');
    expect(renderMarkdown('`<tag>`')).toContain('<code>&lt;tag&gt;</code>');
  });

  it('renders fenced code blocks verbatim (escaped, unformatted)', () => {
    const html = renderMarkdown('```\nmcu: STM32*\npin PA4 = DAC1_OUT1\n```');
    expect(html).toBe('<pre class="md-code"><code>mcu: STM32*\npin PA4 = DAC1_OUT1</code></pre>');
    // Markdown inside a fence must NOT be interpreted.
    expect(renderMarkdown('```\n**not bold**\n```')).toContain('**not bold**');
  });

  it('renders pipe tables', () => {
    const md = '| Fn | Meaning |\n|----|---------|\n| `dma()` | requires DMA |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th>Fn</th>');
    expect(html).toContain('<td><code>dma()</code></td>');
  });

  it('renders nested ordered/unordered lists', () => {
    const md = '1. First\n2. Second\n   - a\n   - b';
    const html = renderMarkdown(md);
    expect(html).toContain('<ol>');
    expect(html).toContain('<ul>');
    // The nested <ul> must be closed before the <ol> closes.
    expect(html.indexOf('</ul>')).toBeLessThan(html.lastIndexOf('</ol>'));
  });

  it('does not misread a plain number as a code span', () => {
    // Regression: the code-span placeholder must not collide with real digits.
    expect(renderMarkdown('there are 3 ports and `x` here'))
      .toBe('<p>there are 3 ports and <code>x</code> here</p>');
  });
});
