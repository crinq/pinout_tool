// ============================================================
// Minimal Markdown → HTML renderer (dependency-free)
//
// Covers what doc.md uses: ATX headings (with GitHub-style slug ids for
// in-page anchors), fenced code blocks, pipe tables, blockquotes, ordered/
// unordered lists (indent nesting), horizontal rules, paragraphs, and the
// inline set `code` / **bold** / *italic* / [text](href). Not a full
// CommonMark implementation — just enough to render the project docs.
// ============================================================

// Code-span placeholder marker: a NUL control char, which never appears in
// source markdown and survives HTML-escaping and the bold/italic/link passes.
const MARK = String.fromCharCode(0);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** GitHub-style heading slug: lowercase, drop punctuation, spaces → hyphens. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

/** Render inline markdown within a single text run. */
function renderInline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `${MARK}${codes.push(c) - 1}${MARK}`);
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, href: string) => `<a href="${escapeAttr(href)}">${t}</a>`);
  s = s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i: string) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

interface OpenList { type: 'ul' | 'ol'; indent: number; }

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const lists: OpenList[] = [];
  let para: string[] = [];
  let i = 0;

  const closeLists = () => { while (lists.length) out.push(lists.pop()!.type === 'ul' ? '</ul>' : '</ol>'); };
  const flushPara = () => {
    if (para.length) { out.push(`<p>${renderInline(para.join(' '))}</p>`); para = []; }
  };
  const block = () => { flushPara(); closeLists(); };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    if (/^```/.test(trimmed)) {
      block();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { body.push(lines[i]); i++; }
      i++; // closing fence
      out.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      block();
      const level = h[1].length;
      out.push(`<h${level} id="${slug(h[2])}">${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { block(); out.push('<hr>'); i++; continue; }

    // Pipe table (header row followed by a |---|---| separator)
    if (/^\|/.test(trimmed) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      block();
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const header = cells(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      const th = header.map(c => `<th>${renderInline(c)}</th>`).join('');
      const trs = rows.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      block();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { q.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${renderInline(q.join(' '))}</blockquote>`);
      continue;
    }

    // List item (indent-based nesting)
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const indent = li[1].length;
      const type: 'ul' | 'ol' = /\d/.test(li[2]) ? 'ol' : 'ul';
      while (lists.length && indent < lists[lists.length - 1].indent) out.push(lists.pop()!.type === 'ul' ? '</ul>' : '</ol>');
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        out.push(type === 'ul' ? '<ul>' : '<ol>'); lists.push({ type, indent });
      } else if (top.type !== type) {
        out.push(lists.pop()!.type === 'ul' ? '</ul>' : '</ol>');
        out.push(type === 'ul' ? '<ul>' : '<ol>'); lists.push({ type, indent });
      }
      out.push(`<li>${renderInline(li[3])}</li>`);
      i++;
      continue;
    }

    // Blank line ends the current block
    if (trimmed === '') { block(); i++; continue; }

    // Paragraph text (accumulate consecutive lines)
    if (lists.length) closeLists();
    para.push(trimmed);
    i++;
  }

  block();
  return out.join('\n');
}
