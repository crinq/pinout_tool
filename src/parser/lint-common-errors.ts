// ============================================================
// Common-error lint
//
// Detects mismatched channel-name / signal-name pairs from a
// user-editable library of "confusable" token groups. Classic case:
// `channel enc_miso = SPI*_MOSI` — the channel says MISO, the pattern
// says MOSI, they're from the same swap group, warn the user.
//
// Library syntax (one group per line, tokens space-separated):
//   miso mosi
//   tx rx
//   ch1 ch2 ch3 ch4 ch1n ch2n ch3n ch4n
//
// Comments start with `#`. Blank lines ignored. Case-insensitive.
// ============================================================

import type { ProgramNode, MappingNode, SignalPatternNode } from './constraint-ast';

export interface LintWarning {
  message: string;
  line?: number;
  portName: string;
  channelName: string;
}

/** Default seed. Edit via the Data Manager. */
export const DEFAULT_COMMON_ERRORS_LIBRARY = `\
# Groups of signal names that are commonly swapped by mistake.
# Format: one group per line, tokens space-separated, comments with #.
# Match rule: channel name and signal name both contain tokens from
# the same group (word-boundary substring, case-insensitive); if the
# two tokens differ, a warning is raised.

# SPI data lines
miso mosi

# UART / USART / LPUART direction
tx rx
cts rts

# I2C — sda/scl aren't confusable (different letter counts) but keep
# them here as documentation of the group concept.

# Timer channels (positive vs complementary output)
ch1 ch2 ch3 ch4
ch1n ch2n ch3n ch4n

# CAN
canrx cantx
`;

// ============================================================
// Lib parsing
// ============================================================

export interface LintLibrary {
  /** For each token, the set of sibling tokens in the same group. */
  siblingsByToken: Map<string, Set<string>>;
  /** For each token, the group index it belongs to (for hint text). */
  groupIndexByToken: Map<string, number>;
  /** Original group tokens, indexed. */
  groups: string[][];
}

const EMPTY_LIB: LintLibrary = {
  siblingsByToken: new Map(),
  groupIndexByToken: new Map(),
  groups: [],
};

// ponytail: module-level cache — primed at boot from storage, read by
// both the editor (inline lint on parse) and the solver (pre-solve check).
let cachedLib: LintLibrary = EMPTY_LIB;
export function primeCommonErrorsLib(source: string | null): void {
  cachedLib = parseCommonErrorsLibrary(source);
}
export function getCachedLintLib(): LintLibrary {
  return cachedLib;
}

export function parseCommonErrorsLibrary(source: string | null | undefined): LintLibrary {
  if (!source) return EMPTY_LIB;
  const siblings = new Map<string, Set<string>>();
  const groupIndex = new Map<string, number>();
  const groups: string[][] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const tokens = line.split(/\s+/).map(t => t.toLowerCase()).filter(Boolean);
    if (tokens.length < 2) continue; // single-token line is meaningless
    const idx = groups.length;
    groups.push(tokens);
    for (const t of tokens) {
      groupIndex.set(t, idx);
      const set = siblings.get(t) ?? new Set<string>();
      for (const other of tokens) if (other !== t) set.add(other);
      siblings.set(t, set);
    }
  }

  return { siblingsByToken: siblings, groupIndexByToken: groupIndex, groups };
}

// ============================================================
// Matcher
// ============================================================

/**
 * Return every library token that appears as a word-boundary substring
 * of `name` (case-insensitive). Empty when nothing matches.
 * A token is bounded by non-alphanumeric characters or the string edge —
 * `enc_miso` matches `miso`, `context` does NOT match `tx`.
 */
function tokensIn(name: string, lib: LintLibrary): string[] {
  if (lib.siblingsByToken.size === 0) return [];
  const lower = name.toLowerCase();
  const hits: string[] = [];
  for (const token of lib.siblingsByToken.keys()) {
    // Cheap contains check first; regex only when it might match.
    if (!lower.includes(token)) continue;
    // Escape regex meta (tokens should be alnum but be safe).
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    if (re.test(lower)) hits.push(token);
  }
  return hits;
}

// ============================================================
// AST walk
// ============================================================

/**
 * Lint every mapping in the expanded AST. Returns one warning per
 * suspicious (channel, signal-pattern) pairing.
 *
 * The AST should be *post-macro-expansion* — port templates and macro
 * bodies produce mappings with the final channel/signal names, which is
 * what the user actually gets.
 */
export function lintForCommonErrors(ast: ProgramNode, lib: LintLibrary): LintWarning[] {
  if (lib.siblingsByToken.size === 0) return [];
  const warnings: LintWarning[] = [];

  for (const stmt of ast.statements) {
    if (stmt.type !== 'port_decl') continue;
    for (const config of stmt.configs) {
      for (const body of config.body) {
        if (body.type !== 'mapping') continue;
        checkMapping(stmt.name, body, lib, warnings);
      }
    }
  }
  return warnings;
}

function checkMapping(
  portName: string,
  mapping: MappingNode,
  lib: LintLibrary,
  warnings: LintWarning[],
): void {
  const channelTokens = tokensIn(mapping.channelName, lib);
  if (channelTokens.length === 0) return;

  const problems = new Set<string>();
  for (const expr of mapping.signalExprs) {
    for (const alt of expr.alternatives) {
      const patternText = signalPatternText(alt);
      const sigTokens = tokensIn(patternText, lib);
      if (sigTokens.length === 0) continue;

      // For every (channelToken, sigToken) pair from the same group where
      // the tokens differ, that's a suspected swap.
      for (const ct of channelTokens) {
        const siblings = lib.siblingsByToken.get(ct);
        if (!siblings) continue;
        for (const st of sigTokens) {
          if (st !== ct && siblings.has(st)) {
            problems.add(`channel '${mapping.channelName}' (contains '${ct}') → ${patternText} (contains '${st}')`);
          }
        }
      }
    }
  }

  for (const p of problems) {
    warnings.push({
      message: `Possible ${p}. Common swap — double-check the mapping.`,
      line: mapping.loc?.line,
      portName,
      channelName: mapping.channelName,
    });
  }
}

/** Reconstruct the signal pattern text as the user would read it. */
function signalPatternText(alt: SignalPatternNode): string {
  return alt.raw || `${partText(alt.instancePart)}_${partText(alt.functionPart)}`;
}

function partText(part: SignalPatternNode['instancePart']): string {
  switch (part.type) {
    case 'literal': return part.value;
    case 'wildcard': return part.prefix + '*';
    case 'any': return '*';
    case 'range': return part.prefix + '[' + part.values.join(',') + ']';
  }
}
