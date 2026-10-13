import DEFAULT_MACRO_LIBRARY_RAW from '../defaults/macro-library.txt?raw';
// ============================================================
// Macro Preprocessor
//
// Macros expand at the TEXT level, before the source is tokenized —
// the C preprocessor model. That is what lets a macro body contain any
// construct the grammar allows (channel declarations, whole configs)
// rather than only the mapping/require items an AST-level expander
// could splice into a config body, and what lets a parameter be pasted
// into the middle of a name:
//
//   macro efused(NAME):
//     channel ${NAME}_EN    = OUT
//     channel ${NAME}_PGOOD = IN
//     channel ${NAME}_SNS
//     adc(${NAME}_SNS)
//
//   port PWR:
//     efused(VBUS)        ->  channel VBUS_EN = OUT, ... , VBUS_SNS = ADC*_IN[0-15] | ...
//
// Expanded lines carry the line number of their CALL SITE, so editor
// squiggles and solver errors land on the call rather than drifting by
// the length of the expansion (C's behaviour, minus `#line`).
// ============================================================

import type { ParseError } from './constraint-ast';

/** Matches the AST-level expander this replaced, so deep nests still error the same way. */
export const MAX_EXPANSION_DEPTH = 10;

/** One line of source, tagged with the original line it should report as. */
export interface SourceLine {
  text: string;
  /** 1-based line in the user's file. Lines from an expansion carry the call site's. */
  line: number;
}

export interface MacroSignature {
  name: string;
  params: string[];
}

export interface PreprocessResult {
  /** Expanded source, with every `macro` definition removed. */
  text: string;
  /** Output line index -> original 1-based source line. */
  lineMap: number[];
  /** Signatures of every macro visible to this program (library + local). */
  macros: MacroSignature[];
  errors: ParseError[];
}

interface MacroDef {
  name: string;
  params: string[];
  body: SourceLine[];
  /** Line of the `macro` header; 0 for library macros (not in the user's file). */
  line: number;
}

// ------------------------------------------------------------
// The active macro library
//
// Kept here rather than read from storage so the parser stays free of
// any storage dependency (src/defaults/index.ts documents the cycle
// that would otherwise form). `primeStdlibSource` pushes the user's
// edited library in; until then the bundled default applies.
// ------------------------------------------------------------

let activeLibrary = DEFAULT_MACRO_LIBRARY_RAW.trim();

export function setMacroLibrary(source: string): void {
  activeLibrary = source;
}

export function getMacroLibrary(): string {
  return activeLibrary;
}

// ------------------------------------------------------------
// Definition collection
// ------------------------------------------------------------

const MACRO_HEADER = /^(\s*)macro\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:\s*(?:#.*)?$/;

/** `NAME(args)` on a line of its own, with an optional trailing comment. */
const MACRO_CALL = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*(?:#.*)?$/;

// Statement heads that can legally be followed by `(...)` — most notably
// `require (A & B)`. Without this exemption MACRO_CALL swallows the line and
// reports "Unknown macro 'require'". One canonical set, owned by the parser.
import { KEYWORDS as STATEMENT_KEYWORDS, MAX_RANGE_VALUES } from './constraint-parser';

/**
 * `channel NAME(args)` — shorthand for declaring the argument channels and
 * then applying the macro to them, so
 *
 *   channel adc(VBUS_SNS)          becomes    channel VBUS_SNS
 *                                             adc(VBUS_SNS)
 *   channel i2c_port(SDA, SCL)     becomes    channel SDA
 *                                             channel SCL
 *                                             i2c_port(SDA, SCL)
 *
 * Only arguments that are bare identifiers are declared — a macro taking a
 * pattern or a "TYPE" string contributes no channel for it.
 */
const CHANNEL_MACRO = /^channel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*(?:#.*)?$/;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const macroKey = (name: string, arity: number): string => `${name}/${arity}`;

const indentOf = (text: string): number => text.length - text.trimStart().length;

const isBlank = (text: string): boolean => text.trim() === '';

function splitLines(source: string): SourceLine[] {
  // Strip CRLF carriage returns — Windows-authored files otherwise leave a
  // trailing \r on every line that the tokenizer rejects.
  return source.split('\n').map((text, i) => ({
    text: text.endsWith('\r') ? text.slice(0, -1) : text,
    line: i + 1,
  }));
}

/**
 * Pull every `macro NAME(params):` block out of `lines`.
 * Returns the definitions plus the lines that remain.
 */
function collectDefs(
  lines: SourceLine[],
  errors: ParseError[],
  fromLibrary: boolean,
): { defs: Map<string, MacroDef>; rest: SourceLine[] } {
  const defs = new Map<string, MacroDef>();
  const rest: SourceLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = MACRO_HEADER.exec(lines[i].text);
    if (!header) {
      rest.push(lines[i]);
      continue;
    }

    const [, , name, rawParams] = header;
    const params = rawParams.trim() === ''
      ? []
      : rawParams.split(',').map(p => p.trim()).filter(p => p !== '');
    const { body, next } = blockAt(lines, i);

    if (body.length === 0) {
      errors.push({
        message: `Macro '${name}' has an empty body`,
        line: fromLibrary ? 1 : lines[i].line,
        column: 1,
      });
    }

    // Last definition of a name/arity wins, matching the map the AST-level
    // expander built. Local definitions are collected after library ones and
    // therefore shadow them.
    defs.set(macroKey(name, params.length), {
      name,
      params,
      body,
      line: fromLibrary ? 0 : lines[i].line,
    });

    i = next - 1;
  }

  return { defs, rest };
}

/**
 * The block under the header `lines[i]`: every following line indented deeper
 * than it. Blank lines belong to the body only when a deeper line follows
 * them, so trailing blanks are not dragged in. `next` is the index after it.
 */
function blockAt(lines: SourceLine[], i: number): { body: SourceLine[]; next: number } {
  const headerIndent = indentOf(lines[i].text);
  const body: SourceLine[] = [];
  let j = i + 1;
  let pendingBlanks: SourceLine[] = [];
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line.text)) {
      pendingBlanks.push(line);
      j++;
      continue;
    }
    if (indentOf(line.text) <= headerIndent) break;
    body.push(...pendingBlanks, line);
    pendingBlanks = [];
    j++;
  }
  return { body, next: j };
}

// ------------------------------------------------------------
// Parameter substitution
// ------------------------------------------------------------

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One regex covering both substitution forms, so a single left-to-right pass
 * does all of them. That matters: replacing parameters one at a time would let
 * an argument that happens to spell another parameter be substituted again
 * (`m(B, x)` on `macro m(A, B)` must not turn A's `B` into `x`).
 *
 *   ${NAME}  — pastes into the middle of an identifier: `${NAME}_EN`
 *   NAME     — whole word only, so `TX` in `TX = USART*_TX` rewrites the
 *              channel but leaves the signal pattern's `_TX` alone. This is
 *              what keeps every pre-existing library macro working.
 */
function buildSubstitution(params: string[]): RegExp | null {
  if (params.length === 0) return null;
  const alt = params.map(escapeRegex).join('|');
  return new RegExp(
    `\\$\\{(${alt})\\}|(^|[^A-Za-z0-9_$])(${alt})(?![A-Za-z0-9_])`,
    'g',
  );
}

function substitute(text: string, re: RegExp | null, args: Map<string, string>): string {
  if (!re) return text;
  re.lastIndex = 0;
  return text.replace(re, (match, braced: string | undefined, pre: string | undefined, bare: string | undefined) => {
    if (braced !== undefined) return args.get(braced) ?? match;
    return (pre ?? '') + (args.get(bare!) ?? bare!);
  });
}

/** Split a call's argument text on top-level commas, respecting nesting and quotes. */
function splitArgs(raw: string): string[] {
  if (raw.trim() === '') return [];
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of raw) {
    if (quoted) {
      current += ch;
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; current += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current.trim());
  return args;
}

/** True when parens and brackets in `raw` are balanced — guards the greedy call regex. */
function balanced(raw: string): boolean {
  let depth = 0;
  let quoted = false;
  for (const ch of raw) {
    if (quoted) { if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// ------------------------------------------------------------
// Ranges
//
// A `{...}` group stamps out one copy of its line per value. Every group
// on a line steps together, so they must all expand to the same length:
//
//   channel A{0-2} = FMC_A{0-2}   ->  channel A0 = FMC_A0
//                                     channel A1 = FMC_A1
//                                     channel A2 = FMC_A2
//
// Items are numeric ranges (`0-12`, descending `7-0`, zero-padded
// `00-15`), letter ranges (`A-H`) or literal names, mixed freely:
// `{TX, RX, 0-1}` is 4 values. Only port, channel, mapping, require and
// macro call lines take ranges. A port header copies its whole block; config
// and group headers are refused, as they would be copied without their body. `${...}` (macro parameters, comment
// interpolation) is never a range.
// ------------------------------------------------------------

const RANGE_GROUP = /(?<!\$)\{([^{}]*)\}/g;

/** Lines a range may stand on: `port ...`, `channel ...`, `require ...`, `NAME = ...` / `NAME ?= ...`, `macro(args)`. */
const RANGE_LINE = /^(?:port|channel|require)\b|^\w+\s*\??=(?!=)|^\w+\s*\(/;

/** `text` up to its `#` comment; a `#` inside a string does not count. */
function codeOf(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === '#' && !quoted) return text.slice(0, i);
  }
  return text;
}

/** The values of one `{...}` group, in order. Throws on a malformed item. */
function rangeValues(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(',')) {
    const item = raw.trim();
    const num = /^(\d+)\s*-\s*(\d+)$/.exec(item);
    const chr = /^([A-Z])\s*-\s*([A-Z])$/.exec(item) ?? /^([a-z])\s*-\s*([a-z])$/.exec(item);
    if (num || chr) {
      const [a, b] = num ? [+num[1], +num[2]] : [chr![1].charCodeAt(0), chr![2].charCodeAt(0)];
      if (out.length + Math.abs(b - a) + 1 > MAX_RANGE_VALUES) {
        throw new Error(`Range {${body}} too large (max ${MAX_RANGE_VALUES} values)`);
      }
      // A leading zero on either bound pads every value to the wider bound: `{00-15}` -> 00..15.
      const width = num && (/^0\d/.test(num[1]) || /^0\d/.test(num[2]))
        ? Math.max(num[1].length, num[2].length) : 0;
      const step = a <= b ? 1 : -1;
      for (let v = a; v !== b + step; v += step) {
        out.push(num ? String(v).padStart(width, '0') : String.fromCharCode(v));
      }
    } else if (/^\w+$/.test(item)) {
      out.push(item);
    } else {
      throw new Error(`Invalid range item '${item}' in {${body}} — use 0-12, A-H or a name`);
    }
  }
  return out;
}

/** One copy of `text` per range value, all groups zipped. Throws on bad or mismatched ranges. */
function expandRanges(text: string): string[] {
  const groups = [...text.matchAll(RANGE_GROUP)].map(m => rangeValues(m[1]));
  const n = groups[0].length;
  if (groups.some(g => g.length !== n)) {
    throw new Error(`Ranges on one line must have the same length (got ${groups.map(g => g.length).join(', ')})`);
  }
  return Array.from({ length: n }, (_, i) => {
    let k = 0;
    return text.replace(RANGE_GROUP, () => groups[k++][i]);
  });
}

// ------------------------------------------------------------
// Expansion
// ------------------------------------------------------------

/** "no such macro" / "no such arity" for a call that resolved to nothing. */
function unknownMacro(
  name: string,
  arity: number,
  macros: Map<string, MacroDef>,
  line: SourceLine,
): ParseError {
  const arities: number[] = [];
  for (const k of macros.keys()) {
    if (k.startsWith(name + '/')) arities.push(parseInt(k.split('/')[1], 10));
  }
  return {
    message: arities.length > 0
      ? `Macro '${name}' with ${arity} arguments not found. Available: ${arities.sort((a, b) => a - b).map(a => `${name}(${a} args)`).join(', ')}`
      : `Unknown macro '${name}'`,
    line: line.line,
    column: indentOf(line.text) + 1,
  };
}

function expandLines(
  lines: SourceLine[],
  macros: Map<string, MacroDef>,
  stack: Set<string>,
  depth: number,
  errors: ParseError[],
): SourceLine[] {
  if (depth > MAX_EXPANSION_DEPTH) {
    errors.push({
      message: `Maximum macro expansion depth (${MAX_EXPANSION_DEPTH}) exceeded`,
      line: lines[0]?.line ?? 1,
      column: 1,
    });
    return lines;
  }

  const out: SourceLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    // Ranges go first, so a ranged `channel NAME(args)` shorthand splits into
    // plain lines before the comma-splitting below ever sees its braces. The
    // range is found on the code alone, but the trailing comment is copied —
    // and expanded — along with it.
    const rangeAt = codeOf(line.text).search(RANGE_GROUP);
    if (rangeAt >= 0) {
      // A port header takes its whole block along — consumed even when the
      // range is bad, so the body does not dangle as stray indented lines.
      // Ranges inside the body expand per line within each copy, independent
      // of the header's.
      const block = /^port\b/.test(trimmed) ? blockAt(lines, i) : { body: [], next: i + 1 };
      i = block.next - 1;
      try {
        const copies = expandRanges(line.text);
        if (!RANGE_LINE.test(copies[0].trim())) {
          throw new Error('Ranges {...} are only allowed on port, channel, mapping, require and macro call lines');
        }
        for (const text of copies) {
          out.push(...expandLines([{ text, line: line.line }, ...block.body], macros, stack, depth, errors));
        }
      } catch (e) {
        errors.push({ message: (e as Error).message, line: line.line, column: rangeAt + 1 });
      }
      continue;
    }

    // `channel NAME(args)` desugars to channel declarations plus a plain call,
    // which the loop then expands like any other. Left alone when NAME is not a
    // macro, so an ordinary parse error still reports itself.
    const shorthand = CHANNEL_MACRO.exec(trimmed);
    if (shorthand && balanced(shorthand[2])) {
      const shorthandArgs = splitArgs(shorthand[2]);
      if (!macros.has(macroKey(shorthand[1], shorthandArgs.length))) {
        // `channel NAME(...)` is only ever the shorthand, so a name that is not
        // a macro is a broken call — say so, rather than leaving the parser to
        // report a stray '(' it cannot explain.
        errors.push(unknownMacro(shorthand[1], shorthandArgs.length, macros, line));
        continue;
      }
      const indent = line.text.slice(0, indentOf(line.text));
      const desugared: SourceLine[] = [
        ...shorthandArgs
          .filter(a => IDENTIFIER.test(a))
          .map(a => ({ text: `${indent}channel ${a}`, line: line.line })),
        { text: `${indent}${shorthand[1]}(${shorthandArgs.join(', ')})`, line: line.line },
      ];
      out.push(...expandLines(desugared, macros, stack, depth, errors));
      continue;
    }

    const call = MACRO_CALL.exec(trimmed);
    if (!call || STATEMENT_KEYWORDS.has(call[1]) || !balanced(call[2])) {
      out.push(line);
      continue;
    }

    const name = call[1];
    const args = splitArgs(call[2]);
    const key = macroKey(name, args.length);
    const def = macros.get(key);

    if (!def) {
      errors.push(unknownMacro(name, args.length, macros, line));
      continue;
    }

    // Keyed by name/arity like the lookup, so an overload calling a smaller
    // overload — encoder(A,B,Z) -> encoder(A,B) — is not recursion.
    if (stack.has(key)) {
      errors.push({
        message: `Recursive macro call detected: '${name}' (${args.length} args)`,
        line: line.line,
        column: indentOf(line.text) + 1,
      });
      continue;
    }

    const argMap = new Map<string, string>();
    for (let i = 0; i < def.params.length; i++) argMap.set(def.params[i], args[i]);
    const re = buildSubstitution(def.params);

    // Re-base the body onto the call site's indentation: the grammar is
    // indentation-sensitive, so a body written at one level has to land at
    // whatever level the call sits on, keeping its own relative structure.
    const callIndent = line.text.slice(0, indentOf(line.text));
    const bodyIndent = def.body.reduce(
      (min, b) => (isBlank(b.text) ? min : Math.min(min, indentOf(b.text))),
      Infinity,
    );
    const strip = Number.isFinite(bodyIndent) ? bodyIndent : 0;

    const substituted: SourceLine[] = def.body.map(b => ({
      text: isBlank(b.text) ? '' : callIndent + substitute(b.text.slice(strip), re, argMap),
      line: line.line,
    }));

    stack.add(key);
    out.push(...expandLines(substituted, macros, stack, depth + 1, errors));
    stack.delete(key);
  }

  return out;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Expand every macro in `source`, using `library` (the macro library, by
 * default the active one) for definitions the source does not provide itself.
 *
 * Only macro *definitions* are taken from the library — anything else it
 * contains (port templates) is resolved separately, on the AST.
 */
export function preprocess(source: string, library?: string): PreprocessResult {
  const errors: ParseError[] = [];
  const lib = library ?? activeLibrary;

  const macros = new Map<string, MacroDef>();
  if (lib.trim() !== '') {
    const { defs } = collectDefs(splitLines(lib), errors, true);
    for (const [key, def] of defs) macros.set(key, def);
  }

  const { defs: localDefs, rest } = collectDefs(splitLines(source), errors, false);
  for (const [key, def] of localDefs) macros.set(key, def);

  const expanded = expandLines(rest, macros, new Set(), 0, errors);

  return {
    text: expanded.map(l => l.text).join('\n'),
    lineMap: expanded.map(l => l.line),
    macros: [...macros.values()].map(d => ({ name: d.name, params: d.params })),
    errors,
  };
}

/** Signatures of the macros defined in `source`, without expanding anything. */
export function collectMacros(source: string): MacroSignature[] {
  const { defs } = collectDefs(splitLines(source), [], true);
  return [...defs.values()].map(d => ({ name: d.name, params: d.params }));
}
