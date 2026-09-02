// ============================================================
// Simple JS syntax highlighter for the export function editor
// ============================================================

import { escapeHtml as escHtml } from '../utils';

const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'switch',
  'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'true', 'false', 'null', 'undefined', 'this',
]);

export function highlightJs(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];

    // Line comment
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const slice = end === -1 ? code.substring(i) : code.substring(i, end);
      out.push(`<span class="hl-comment">${escHtml(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // Block comment
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const slice = end === -1 ? code.substring(i) : code.substring(i, end + 2);
      out.push(`<span class="hl-comment">${escHtml(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // String (single, double, backtick)
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && code[j] !== ch) {
        if (code[j] === '\\') j++; // skip escaped char
        j++;
      }
      if (j < n) j++; // include closing quote
      const slice = code.substring(i, j);
      out.push(`<span class="hl-string">${escHtml(slice)}</span>`);
      i = j;
      continue;
    }

    // Number
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      let j = i;
      if (ch === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(code[j])) j++;
      } else {
        while (j < n && ((code[j] >= '0' && code[j] <= '9') || code[j] === '.')) j++;
      }
      out.push(`<span class="hl-number">${escHtml(code.substring(i, j))}</span>`);
      i = j;
      continue;
    }

    // Word (identifier or keyword)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let j = i + 1;
      while (j < n && ((code[j] >= 'a' && code[j] <= 'z') || (code[j] >= 'A' && code[j] <= 'Z') || (code[j] >= '0' && code[j] <= '9') || code[j] === '_' || code[j] === '$')) j++;
      const word = code.substring(i, j);
      if (JS_KEYWORDS.has(word)) {
        out.push(`<span class="hl-keyword">${escHtml(word)}</span>`);
      } else {
        out.push(escHtml(word));
      }
      i = j;
      continue;
    }

    // Default: single character
    out.push(escHtml(ch));
    i++;
  }

  return out.join('');
}
