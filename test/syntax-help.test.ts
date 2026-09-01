import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderMarkdown } from '../src/ui/markdown';

// The syntax reference lives in src/ui/syntax-help.md and is rendered at open
// time, so a broken table or fence shows up as missing content, not a crash.
const md = readFileSync(join(__dirname, '../src/ui/syntax-help.md'), 'utf-8');
const html = renderMarkdown(md);
const dom = () => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('syntax help content', () => {
  it('renders every section as a heading', () => {
    const headings = [...dom().querySelectorAll('h3')].map(h => h.textContent);
    expect(headings.length).toBe(19);
    expect(headings).toContain('Structure');
    expect(headings).toContain('Groups');
    expect(headings).toContain('Built-in Functions');
    expect(headings).toContain('Full Example');
  });

  it('renders the code examples as fenced blocks', () => {
    const pres = dom().querySelectorAll('pre');
    expect(pres.length).toBe(20);
    for (const p of pres) expect(p.textContent!.trim().length).toBeGreaterThan(0);
  });

  it('renders the three reference tables with a header row', () => {
    const tables = [...dom().querySelectorAll('table')];
    expect(tables.length).toBe(3);
    for (const t of tables) {
      expect(t.querySelectorAll('thead th').length).toBe(2);
      expect(t.querySelectorAll('tbody tr').length).toBeGreaterThan(3);
    }
  });

  it('keeps the inline code spans', () => {
    // 114 in the hand-written HTML this replaced.
    expect(dom().querySelectorAll('p code, td code, li code').length).toBeGreaterThanOrEqual(100);
  });

  it('leaves no raw HTML tags or entities behind from the conversion', () => {
    expect(md).not.toMatch(/<(section|pre|h3|td|tr|table|br|b)\b/);
    expect(md).not.toMatch(/&(mdash|hellip|lt|gt|amp);/);
  });

  it('documents the keywords the highlighter knows', () => {
    for (const kw of ['mcu', 'package', 'reserve', 'shared', 'port', 'channel',
                      'config', 'group', 'require', 'macro', 'settings']) {
      expect(md, kw).toContain(kw);
    }
  });

  it('escapes markup in the output rather than injecting it', () => {
    const d = dom();
    expect(d.querySelector('script')).toBeNull();
    expect(d.textContent).toContain('rom: < 2M');   // a literal `<` survived
  });
});
