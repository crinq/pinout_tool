// ============================================================
// Constraint Parser for Proposal C Syntax
// Hand-written recursive descent with indentation tracking
// ============================================================

import type {
  ProgramNode,
  StatementNode,
  McuDeclNode,
  PackageDeclNode,
  RamDeclNode,
  RomDeclNode,
  FreqDeclNode,
  TempDeclNode,
  VoltageDeclNode,
  CoreDeclNode,
  ReserveDeclNode,
  SharedDeclNode,
  PinDeclNode,
  PortDeclNode,
  ChannelDeclNode,
  ConfigDeclNode,
  GroupDeclNode,
  SettingsDeclNode,
  SettingsEntryNode,
  SettingValue,
  PinAnchor,
  ConfigBodyNode,
  MappingNode,
  RequireNode,
  SignalExprNode,
  SignalPatternNode,
  PatternPart,
  ConstraintExprNode,
  BinaryExprNode,
  MacroDeclNode,
  MacroCallNode,
  SourceLocation,
  ParseError,
  ParseWarning,
  ParseResult,
} from './constraint-ast';
import { preprocess } from './preprocessor';

// ============================================================
// Token Types
// ============================================================

type TokenType =
  | 'KEYWORD'     // mcu, reserve, pin, port, channel, config, require, macro
  | 'IDENT'       // identifiers (letters and digits, NO underscore)
  | 'STRING'      // "quoted string"
  | 'NUMBER'      // integer literals
  | 'COLON'       // :
  | 'COMMA'       // ,
  | 'PIPE'        // |
  | 'PLUS'        // +
  | 'EQUALS'      // =
  | 'EQEQ'        // ==
  | 'BANGEQ'      // !=
  | 'AMP'         // &
  | 'CARET'       // ^
  | 'BANG'         // !
  | 'AT'          // @
  | 'DOLLAR'      // $
  | 'STAR'        // *
  | 'DOT'         // .
  | 'LPAREN'      // (
  | 'RPAREN'      // )
  | 'LBRACKET'    // [
  | 'RBRACKET'    // ]
  | 'LT'          // <
  | 'GT'          // >
  | 'DASH'        // -
  | 'QUESTION'    // ?
  | 'UNDERSCORE'  // _
  | 'TILDE'       // ~
  | 'COMMENT'     // # inline comment text
  | 'NEWLINE'
  | 'INDENT'
  | 'DEDENT'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

/** Upper bound on values a `[n-m]` range may expand to. */
const MAX_RANGE_VALUES = 1024;

export const KEYWORDS = new Set([
  'mcu', 'package', 'ram', 'rom', 'freq', 'temp', 'voltage', 'core', 'reserve', 'pin', 'port', 'channel', 'config', 'require', 'macro', 'color', 'shared', 'from', 'settings', 'group',
]);

// ============================================================
// Lexer
// ============================================================

/**
 * `lineMap` maps an index in `source` back to the line it should report as.
 * The macro preprocessor supplies one so tokens produced by an expansion carry
 * the call site's line instead of a position in the expanded text.
 */
function tokenize(source: string, lineMap?: number[]): { tokens: Token[]; errors: ParseError[] } {
  const tokens: Token[] = [];
  const errors: ParseError[] = [];
  const lines = source.split('\n');
  const indentStack: number[] = [0];
  const srcLine = (idx: number): number => lineMap?.[idx] ?? idx + 1;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = srcLine(lineIdx);

    // Skip blank lines and comment-only lines
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // Compute indentation level (number of leading spaces)
    const indent = line.length - line.trimStart().length;
    const currentIndent = indentStack[indentStack.length - 1];

    if (indent > currentIndent) {
      indentStack.push(indent);
      tokens.push({ type: 'INDENT', value: '', line: lineNum, column: 1 });
    } else if (indent < currentIndent) {
      while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
        indentStack.pop();
        tokens.push({ type: 'DEDENT', value: '', line: lineNum, column: 1 });
      }
      if (indentStack[indentStack.length - 1] !== indent) {
        errors.push({
          message: `Inconsistent indentation (${indent} spaces, expected ${indentStack[indentStack.length - 1]})`,
          line: lineNum,
          column: 1,
        });
      }
    }

    // Tokenize the content of the line (skip leading whitespace)
    let col = indent;
    while (col < line.length) {
      const ch = line[col];

      // Skip spaces within a line (\r for CRLF input tokenized directly,
      // without going through the preprocessor)
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        col++;
        continue;
      }

      // Comment - rest of line
      if (ch === '#') {
        const commentText = line.substring(col + 1).trim();
        if (commentText) {
          tokens.push({ type: 'COMMENT', value: commentText, line: lineNum, column: col + 1 });
        }
        break;
      }

      const colNum = col + 1; // 1-based

      // String literal
      if (ch === '"') {
        const start = col;
        col++;
        while (col < line.length && line[col] !== '"') {
          col++;
        }
        if (col >= line.length) {
          errors.push({ message: 'Unterminated string literal', line: lineNum, column: colNum });
          break;
        }
        col++; // skip closing quote
        tokens.push({ type: 'STRING', value: line.substring(start + 1, col - 1), line: lineNum, column: colNum });
        continue;
      }

      // Number
      if (ch >= '0' && ch <= '9') {
        const start = col;
        while (col < line.length && line[col] >= '0' && line[col] <= '9') {
          col++;
        }
        tokens.push({ type: 'NUMBER', value: line.substring(start, col), line: lineNum, column: colNum });
        continue;
      }

      // Identifier / Keyword (letters only, NO underscore - underscore is a separate token)
      if (isLetter(ch)) {
        const start = col;
        while (col < line.length && isLetterOrDigit(line[col])) {
          col++;
        }
        const word = line.substring(start, col);
        const type: TokenType = KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT';
        tokens.push({ type, value: word, line: lineNum, column: colNum });
        continue;
      }

      // Two-character operators
      if (ch === '=' && col + 1 < line.length && line[col + 1] === '=') {
        tokens.push({ type: 'EQEQ', value: '==', line: lineNum, column: colNum });
        col += 2;
        continue;
      }
      if (ch === '!' && col + 1 < line.length && line[col + 1] === '=') {
        tokens.push({ type: 'BANGEQ', value: '!=', line: lineNum, column: colNum });
        col += 2;
        continue;
      }

      // Single-character tokens (including underscore)
      const singleCharMap: Record<string, TokenType> = {
        ':': 'COLON',
        ',': 'COMMA',
        '|': 'PIPE',
        '+': 'PLUS',
        '=': 'EQUALS',
        '&': 'AMP',
        '^': 'CARET',
        '!': 'BANG',
        '@': 'AT',
        '$': 'DOLLAR',
        '*': 'STAR',
        '.': 'DOT',
        '(': 'LPAREN',
        ')': 'RPAREN',
        '[': 'LBRACKET',
        ']': 'RBRACKET',
        '<': 'LT',
        '>': 'GT',
        '-': 'DASH',
        '?': 'QUESTION',
        '_': 'UNDERSCORE',
        '~': 'TILDE',
      };

      if (singleCharMap[ch]) {
        tokens.push({ type: singleCharMap[ch], value: ch, line: lineNum, column: colNum });
        col++;
        continue;
      }

      // Unknown character
      errors.push({ message: `Unexpected character '${ch}'`, line: lineNum, column: colNum });
      col++;
    }

    // End of line
    tokens.push({ type: 'NEWLINE', value: '', line: lineNum, column: line.length + 1 });
  }

  // Close remaining indents
  const lastLine = srcLine(lines.length - 1);
  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push({ type: 'DEDENT', value: '', line: lastLine, column: 1 });
  }

  tokens.push({ type: 'EOF', value: '', line: lastLine + 1, column: 1 });
  return { tokens, errors };
}

function isLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isLetterOrDigit(ch: string): boolean {
  return isLetter(ch) || (ch >= '0' && ch <= '9');
}

// ============================================================
// Parser
// ============================================================

class Parser {
  private tokens: Token[];
  private pos = 0;
  private errors: ParseError[] = [];
  private warnings: ParseWarning[] = [];

  constructor(tokens: Token[], lexErrors: ParseError[]) {
    this.tokens = tokens;
    this.errors = [...lexErrors];
  }

  parse(): ParseResult {
    const statements: StatementNode[] = [];
    const loc = this.loc();

    this.skipNewlines();

    while (!this.isAtEnd()) {
      try {
        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
        }
      } catch {
        // Error recovery: skip to next line
        this.skipToNextStatement();
      }
      this.skipNewlines();
    }

    const program: ProgramNode = { type: 'program', statements, loc };
    return {
      ast: program,
      errors: this.errors,
      warnings: this.warnings,
    };
  }

  // --------------------------------------------------------
  // Compound identifiers: IDENT (_IDENT | _NUMBER)*
  // Used for names that contain underscores:
  //   port names (ADC_IN), channel names (V_SENSE),
  //   macro names (uart_port), function names (same_instance)
  // --------------------------------------------------------

  private parseCompoundIdent(): string {
    let name = this.expectSimpleIdent();
    while (this.check('UNDERSCORE')) {
      const next = this.peekAhead(1);
      if (next && (next.type === 'IDENT' || next.type === 'KEYWORD' || next.type === 'NUMBER')) {
        this.advance(); // consume underscore
        name += '_' + this.advance().value;
      } else {
        break;
      }
    }
    return name;
  }

  // Expect a simple IDENT or KEYWORD token (no underscore joining)
  private expectSimpleIdent(): string {
    const tok = this.peek();
    if (tok.type === 'IDENT' || tok.type === 'KEYWORD') {
      this.advance();
      return tok.value;
    }
    this.error(`Expected identifier, got '${tok.value || tok.type}'`, tok);
    return '<error>';
  }

  // --------------------------------------------------------
  // Statement parsing
  // --------------------------------------------------------

  private parseStatement(): StatementNode | null {
    const tok = this.peek();

    if (tok.type === 'KEYWORD') {
      switch (tok.value) {
        case 'mcu': return this.parseMcuDecl();
        case 'package': return this.parsePackageDecl();
        case 'ram': return this.parseMemoryDecl('ram');
        case 'rom': return this.parseMemoryDecl('rom');
        case 'freq': return this.parseFreqDecl();
        case 'settings': return this.parseSettingsDecl();
        case 'temp': return this.parseTempDecl();
        case 'voltage': return this.parseVoltageDecl();
        case 'core': return this.parseCoreDecl();
        case 'reserve': return this.parseReserveDecl();
        case 'shared': return this.parseSharedDecl();
        case 'pin': return this.parsePinDecl();
        case 'port': return this.parsePortDecl();
        case 'macro': return this.parseMacroDecl();
        default:
          this.error(`Unexpected keyword '${tok.value}' at top level`, tok);
          this.advance();
          return null;
      }
    }

    if (tok.type === 'NEWLINE' || tok.type === 'EOF') {
      this.advance();
      return null;
    }

    this.error(`Expected a declaration (mcu, package, ram, rom, freq, temp, voltage, core, reserve, shared, pin, port, macro), got '${tok.value || tok.type}'`, tok);
    this.advance();
    return null;
  }

  // mcu: pattern (| pattern)*
  private parseMcuDecl(): McuDeclNode {
    const loc = this.loc();
    this.expectKeyword('mcu');
    this.expect('COLON');

    const patterns: string[] = [];
    patterns.push(this.parseGlobPattern());

    while (this.check('PIPE')) {
      this.advance();
      patterns.push(this.parseGlobPattern());
    }

    this.expectNewlineOrEnd();
    return { type: 'mcu_decl', patterns, loc };
  }

  // package: pattern (| pattern)*
  private parsePackageDecl(): PackageDeclNode {
    const loc = this.loc();
    this.expectKeyword('package');
    this.expect('COLON');

    const patterns: string[] = [];
    patterns.push(this.parseGlobPattern());

    while (this.check('PIPE')) {
      this.advance();
      patterns.push(this.parseGlobPattern());
    }

    this.expectNewlineOrEnd();
    return { type: 'package_decl', patterns, loc };
  }

  // ram: 1024K | ram: < 512K | ram: 256K < 1024K
  // rom: 512K  | rom: < 2M  | rom: 256K < 2M
  private parseMemoryDecl(keyword: 'ram' | 'rom'): RamDeclNode | RomDeclNode {
    const loc = this.loc();
    this.expectKeyword(keyword);
    this.expect('COLON');

    let minBytes = 0;
    let maxBytes: number | undefined;

    if (this.check('LT')) {
      // ram: < 100K (max only)
      this.advance();
      maxBytes = Math.floor(this.parseMemoryValue());
    } else {
      const value = this.parseMemoryValue();
      if (this.check('LT')) {
        // ram: 10K < 100K (min and max)
        this.advance();
        minBytes = Math.floor(value);
        maxBytes = Math.floor(this.parseMemoryValue());
      } else {
        // ram: 10K (min only)
        minBytes = Math.floor(value);
      }
    }

    this.expectNewlineOrEnd();

    if (keyword === 'ram') {
      return { type: 'ram_decl', minBytes, maxBytes, loc } as RamDeclNode;
    }
    return { type: 'rom_decl', minBytes, maxBytes, loc } as RomDeclNode;
  }

  /** Parse a memory value with optional K/KB/M/MB suffix. */
  private parseMemoryValue(): number {
    const numTok = this.expect('NUMBER');
    let value = parseFloat(numTok.value);

    if (this.check('IDENT') || this.check('KEYWORD')) {
      const suffix = this.peek().value.toUpperCase();
      if (suffix === 'K' || suffix === 'KB') {
        value *= 1024;
        this.advance();
      } else if (suffix === 'M' || suffix === 'MB') {
        value *= 1024 * 1024;
        this.advance();
      }
    }

    return value;
  }

  // freq: 480 | freq: < 200 | freq: 100 < 480
  private parseFreqDecl(): FreqDeclNode {
    const loc = this.loc();
    this.expectKeyword('freq');
    this.expect('COLON');

    let minMHz = 0;
    let maxMHz: number | undefined;

    if (this.check('LT')) {
      // freq: < 200
      this.advance();
      maxMHz = parseFloat(this.expect('NUMBER').value);
    } else {
      const numTok = this.expect('NUMBER');
      const value = parseFloat(numTok.value);
      if (this.check('LT')) {
        // freq: 100 < 480
        this.advance();
        minMHz = value;
        maxMHz = parseFloat(this.expect('NUMBER').value);
      } else {
        // freq: 480
        minMHz = value;
      }
    }

    this.expectNewlineOrEnd();
    return { type: 'freq_decl', minMHz, maxMHz, loc };
  }

  /** Parse a decimal number, possibly negative (e.g., -40, 3.3, 1.8). */
  private parseDecimalNumber(): number {
    let neg = false;
    if (this.check('DASH')) {
      neg = true;
      this.advance();
    }
    const intPart = this.expect('NUMBER').value;
    let value = parseFloat(intPart);
    if (this.check('DOT')) {
      this.advance();
      if (this.check('NUMBER')) {
        const fracPart = this.peek().value;
        this.advance();
        value = parseFloat(`${intPart}.${fracPart}`);
      }
    }
    return neg ? -value : value;
  }

  // settings:                      NEWLINE INDENT (key: value)* DEDENT
  // settings from "default":       — start from a named preset, then override
  //
  // Values: a number (with optional `ms`/`s` unit, normalised to ms),
  // 0/1 or true/false, or a comma-separated list of strings.
  private parseSettingsDecl(): SettingsDeclNode {
    const loc = this.loc();
    this.expectKeyword('settings');

    let preset: string | undefined;
    if (this.check('KEYWORD') && this.peek().value === 'from') {
      this.advance();
      preset = this.expectString();
    }

    this.expect('COLON');
    this.skipComment();
    this.expectNewlineOrEnd();

    const entries: SettingsEntryNode[] = [];
    if (!this.check('INDENT')) {
      // `settings from "complex":` with no body is a plain preset load.
      if (!preset) this.error('Expected indented block after settings declaration', this.peek());
      return { type: 'settings_decl', preset, entries, loc };
    }
    this.expect('INDENT');

    while (!this.check('DEDENT') && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check('DEDENT') || this.isAtEnd()) break;

      const entryLoc = this.loc();
      const key = this.parseCompoundIdent();
      this.expect('COLON');
      const value = this.parseSettingValue();
      this.skipComment();
      this.expectNewlineOrEnd();
      if (value !== null) entries.push({ key, value, loc: entryLoc });
    }

    if (this.check('DEDENT')) this.advance();
    return { type: 'settings_decl', preset, entries, loc };
  }

  /** One settings value: string list, boolean, or number with optional time unit. */
  private parseSettingValue(): SettingValue | null {
    if (this.check('STRING')) {
      const list = [this.expectString()];
      while (this.check('COMMA')) {
        this.advance();
        list.push(this.expectString());
      }
      return list;
    }
    if (this.check('IDENT')) {
      const word = this.peek().value.toLowerCase();
      if (word === 'true' || word === 'false') {
        this.advance();
        return word === 'true';
      }
    }
    if (this.check('NUMBER') || this.check('DASH')) {
      const n = this.parseDecimalNumber();
      // Optional time unit — `3s` and `3000ms` both mean 3000.
      if (this.check('IDENT')) {
        const unit = this.peek().value.toLowerCase();
        if (unit === 'ms') { this.advance(); return n; }
        if (unit === 's') { this.advance(); return n * 1000; }
      }
      return n;
    }
    this.error(`Expected a settings value (number, "string", or true/false), got '${this.peek().value || this.peek().type}'`, this.peek());
    this.skipToNextLine();
    return null;
  }

  // temp: -40 < 85 | temp: 85 | temp: < 125
  // Every form specifies working point(s) the MCU's range must cover:
  //   temp: 85      → point 85 in range   (min ≤ 85 ≤ max)
  //   temp: < 85    → point 85 in range   (same as bare — the point must fit)
  //   temp: -40 < 85 → interval [-40, 85] in range (min ≤ -40, 85 ≤ max)
  private parseTempDecl(): TempDeclNode {
    const loc = this.loc();
    this.expectKeyword('temp');
    this.expect('COLON');

    let minTemp: number | undefined;
    let maxTemp: number | undefined;

    if (this.check('LT')) {
      this.advance();
      const value = this.parseDecimalNumber();
      minTemp = value;
      maxTemp = value;
    } else {
      const value = this.parseDecimalNumber();
      if (this.check('LT')) {
        this.advance();
        minTemp = value;
        maxTemp = this.parseDecimalNumber();
      } else {
        minTemp = value;
        maxTemp = value;
      }
    }

    this.expectNewlineOrEnd();
    return { type: 'temp_decl', minTemp, maxTemp, loc };
  }

  // voltage: 1.8 < 3.3 | voltage: 3.3 | voltage: < 3.6
  // Working-point coverage, same as temp:
  //   voltage: 3.3     → point 3.3 in range   (min ≤ 3.3 ≤ max)
  //   voltage: < 2.5   → point 2.5 in range   (same as bare)
  //   voltage: 1.8 < 3.6 → interval [1.8, 3.6] in range (min ≤ 1.8, 3.6 ≤ max)
  // Optional V suffix ignored (e.g., voltage: 3.3V, voltage: 1.8V < 3.6V)
  private parseVoltageDecl(): VoltageDeclNode {
    const loc = this.loc();
    this.expectKeyword('voltage');
    this.expect('COLON');

    const parseVoltageValue = (): number => {
      const val = this.parseDecimalNumber();
      // Skip optional V unit suffix
      if (this.check('IDENT') && this.peek().value.toUpperCase() === 'V') {
        this.advance();
      }
      return val;
    };

    let minVoltage: number | undefined;
    let maxVoltage: number | undefined;

    if (this.check('LT')) {
      this.advance();
      const value = parseVoltageValue();
      minVoltage = value;
      maxVoltage = value;
    } else {
      const value = parseVoltageValue();
      if (this.check('LT')) {
        this.advance();
        minVoltage = value;
        maxVoltage = parseVoltageValue();
      } else {
        minVoltage = value;
        maxVoltage = value;
      }
    }

    this.expectNewlineOrEnd();
    return { type: 'voltage_decl', minVoltage, maxVoltage, loc };
  }

  // core: M4 | core: M4 | M7 | core: M4 + M7
  // + separates AND groups, | separates alternatives within a group
  private parseCoreDecl(): CoreDeclNode {
    const loc = this.loc();
    this.expectKeyword('core');
    this.expect('COLON');

    const required: string[][] = [];
    const parseAlternatives = (): string[] => {
      const alts: string[] = [];
      alts.push(this.parseCorePattern());
      while (this.check('PIPE')) {
        this.advance();
        alts.push(this.parseCorePattern());
      }
      return alts;
    };

    required.push(parseAlternatives());
    while (this.check('PLUS')) {
      this.advance();
      required.push(parseAlternatives());
    }

    this.expectNewlineOrEnd();
    return { type: 'core_decl', required, loc };
  }

  /** Parse a core pattern like M4, M7, M33. Consumes IDENT/KEYWORD + optional NUMBER. */
  private parseCorePattern(): string {
    let name = '';
    if (this.check('IDENT') || this.check('KEYWORD')) {
      name = this.peek().value;
      this.advance();
    }
    if (this.check('NUMBER')) {
      name += this.peek().value;
      this.advance();
    }
    if (!name) {
      this.error('Expected core name (e.g., M4, M7, M33)', this.peek());
      return '<error>';
    }
    return name;
  }

  // Parse a glob pattern (sequence of ident, *, number, underscore, dash, brackets)
  private parseGlobPattern(): string {
    let result = '';
    while (!this.isAtEnd() && !this.check('PIPE') && !this.check('NEWLINE') && !this.check('EOF')) {
      const tok = this.peek();
      if (tok.type === 'IDENT' || tok.type === 'KEYWORD' || tok.type === 'STAR' ||
          tok.type === 'NUMBER' || tok.type === 'DASH' || tok.type === 'UNDERSCORE' ||
          tok.type === 'LBRACKET' || tok.type === 'RBRACKET' || tok.type === 'COMMA' ||
          tok.type === 'QUESTION') {
        result += tok.value;
        this.advance();
      } else {
        break;
      }
    }
    return result.trim();
  }

  // reserve: pattern (, pattern)*
  // pattern can be pin names (PA1, PB2) or peripheral patterns (ADC*, SPI[1,3], LPUART1)
  private parseReserveDecl(): ReserveDeclNode {
    const loc = this.loc();
    this.expectKeyword('reserve');
    this.expect('COLON');

    const patterns: PatternPart[] = [];
    patterns.push(this.parsePatternPart());

    while (this.check('COMMA')) {
      this.advance();
      patterns.push(this.parsePatternPart());
    }

    this.expectNewlineOrEnd();
    return { type: 'reserve_decl', patterns, loc };
  }

  // shared: pattern (, pattern)*
  // pattern uses same syntax as signal instance part: ADC1, ADC*, ADC[1,2], TIM[1-3]
  private parseSharedDecl(): SharedDeclNode {
    const loc = this.loc();
    this.expectKeyword('shared');
    this.expect('COLON');

    const patterns: PatternPart[] = [];
    patterns.push(this.parsePatternPart());

    while (this.check('COMMA')) {
      this.advance();
      patterns.push(this.parsePatternPart());
    }

    this.expectNewlineOrEnd();
    return { type: 'shared_decl', patterns, loc };
  }

  // pin pin_name = signal_name
  private parsePinDecl(): PinDeclNode {
    const loc = this.loc();
    this.expectKeyword('pin');
    const pinName = this.parsePinName();
    this.expect('EQUALS');
    const signalName = this.parseRawName();

    const comment = this.skipComment();
    this.expectNewlineOrEnd();
    return { type: 'pin_decl', pinName, signalName, comment, loc };
  }

  // port IDENT: NEWLINE INDENT port_body DEDENT
  // port IDENT from TEMPLATE: ...
  // port IDENT from TEMPLATE color "red"
  private parsePortDecl(): PortDeclNode {
    const loc = this.loc();
    this.expectKeyword('port');
    const name = this.parseCompoundIdent();

    // Optional: from TEMPLATE
    let template: string | undefined;
    if (this.check('KEYWORD') && this.peek().value === 'from') {
      this.advance();
      template = this.parseCompoundIdent();
    }

    const channels: ChannelDeclNode[] = [];
    const configs: ConfigDeclNode[] = [];
    const groups: GroupDeclNode[] = [];
    let color: string | undefined;
    let comment: string | undefined;
    let anchor: PinAnchor | undefined;
    let anchorFixedPins: string[] | undefined;
    let anchorExcludedPins: string[] | undefined;

    // Inline color (before colon): port NAME from TMPL color "red"
    if (this.check('KEYWORD') && this.peek().value === 'color') {
      this.advance();
      color = this.expectString();
    }

    // Port may have no body (template-only with just color)
    if (this.check('NEWLINE') || this.check('EOF') || this.check('COMMENT')) {
      comment = this.skipComment();
      this.expectNewlineOrEnd();
      return { type: 'port_decl', name, template, channels, configs, color, comment, loc };
    }

    this.expect('COLON');

    // Optional placement clause on the header: `port CMD: @ ~NW` / `@ PA1, !PB1`
    if (this.check('AT')) {
      const at = this.parseAtClause();
      anchor = at.anchor;
      anchorFixedPins = at.fixedPins;
      anchorExcludedPins = at.excludedPins;
    }

    comment = this.skipComment();
    this.expectNewline();

    if (!this.check('INDENT')) {
      // A header-only port is valid when it derives from a template or only
      // overrides placement (e.g. `enc1 from enc0: @ ~NW`).
      if (template || anchor || anchorFixedPins) {
        return { type: 'port_decl', name, template, channels, configs, color, comment, anchor, anchorFixedPins, anchorExcludedPins, loc };
      }
      this.error('Expected indented block after port declaration', this.peek());
      return { type: 'port_decl', name, template, channels, configs, loc };
    }
    this.expect('INDENT');

    // Collect inline config body items (mappings, requires, macro calls)
    // that appear directly in the port body without an explicit config block
    const inlineConfigBody: ConfigBodyNode[] = [];

    while (!this.check('DEDENT') && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check('DEDENT') || this.isAtEnd()) break;

      const tok = this.peek();
      if (tok.type === 'KEYWORD' && tok.value === 'channel') {
        const [ch, mapping] = this.parseChannelDecl();
        channels.push(ch);
        if (mapping) inlineConfigBody.push(mapping);
      } else if (tok.type === 'KEYWORD' && tok.value === 'config') {
        configs.push(this.parseConfigDecl());
      } else if (tok.type === 'KEYWORD' && tok.value === 'group') {
        groups.push(this.parseGroupDecl(channels, inlineConfigBody));
      } else if (tok.type === 'KEYWORD' && tok.value === 'color') {
        this.advance();
        color = this.expectString();
        this.expectNewlineOrEnd();
      } else if (tok.type === 'KEYWORD' && tok.value === 'require') {
        // Inline require → goes into implicit config
        inlineConfigBody.push(this.parseRequireStmt());
      } else if (tok.type === 'IDENT' || tok.type === 'KEYWORD') {
        // Could be a mapping (NAME = ...) or macro call (NAME(...))
        const lookAhead = this.peekPastCompoundIdent();
        if (lookAhead === 'EQUALS' || lookAhead === 'QUESTION') {
          inlineConfigBody.push(this.parseMapping());
        } else if (lookAhead === 'LPAREN') {
          inlineConfigBody.push(this.parseMacroCall());
        } else {
          this.error(`Expected 'channel', 'config', 'group', 'color', mapping, or require inside port, got '${tok.value || tok.type}'`, tok);
          this.skipToNextLine();
        }
      } else {
        this.error(`Expected 'channel', 'config', 'group', 'color', mapping, or require inside port, got '${tok.value || tok.type}'`, tok);
        this.skipToNextLine();
      }
    }

    if (this.check('DEDENT')) {
      this.advance();
    }

    // If inline config body items were found, wrap them in an implicit config
    // named after the port
    if (inlineConfigBody.length > 0) {
      if (configs.length > 0) {
        this.error(`Port '${name}' cannot have both explicit config blocks and inline mappings/requires`, this.tokens[this.pos - 1] ?? this.peek());
      }
      configs.push({
        type: 'config_decl',
        name,
        body: inlineConfigBody,
        loc,
      });
    }

    return {
      type: 'port_decl', name, template, channels, configs, color, comment,
      groups: groups.length > 0 ? groups : undefined,
      anchor, anchorFixedPins, anchorExcludedPins, loc,
    };
  }

  // group "NAME": (@ ...)? NEWLINE INDENT channel_decl* DEDENT
  //
  // A grouping of channels within a port, for placement only. Members are
  // appended to the port's flat channel list tagged with the group name; any
  // mapping or require the body carries (a channel's inline `= …`, or lines a
  // macro expanded into the group) flows to the port's implicit config exactly
  // as it would one level up.
  private parseGroupDecl(
    channels: ChannelDeclNode[],
    inlineConfigBody: ConfigBodyNode[],
  ): GroupDeclNode {
    const loc = this.loc();
    this.expectKeyword('group');
    const name = this.expectString();
    this.expect('COLON');

    let anchor: PinAnchor | undefined;
    let anchorFixedPins: string[] | undefined;
    let anchorExcludedPins: string[] | undefined;
    if (this.check('AT')) {
      const at = this.parseAtClause();
      anchor = at.anchor;
      anchorFixedPins = at.fixedPins;
      anchorExcludedPins = at.excludedPins;
    }
    this.skipComment();
    this.expectNewline();

    if (!this.check('INDENT')) {
      this.error('Expected indented block after group declaration', this.peek());
      return { type: 'group_decl', name, anchor, anchorFixedPins, anchorExcludedPins, loc };
    }
    this.expect('INDENT');

    while (!this.check('DEDENT') && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check('DEDENT') || this.isAtEnd()) break;

      const tok = this.peek();
      if (tok.type === 'KEYWORD' && tok.value === 'channel') {
        const [ch, mapping] = this.parseChannelDecl();
        channels.push({ ...ch, group: name });
        if (mapping) inlineConfigBody.push(mapping);
      } else if (tok.type === 'KEYWORD' && tok.value === 'require') {
        inlineConfigBody.push(this.parseRequireStmt());
      } else if (tok.type === 'IDENT' || tok.type === 'KEYWORD') {
        const lookAhead = this.peekPastCompoundIdent();
        if (lookAhead === 'EQUALS' || lookAhead === 'QUESTION') {
          inlineConfigBody.push(this.parseMapping());
        } else {
          this.error(`Expected 'channel', mapping, or require inside group "${name}", got '${tok.value || tok.type}'`, tok);
          this.skipToNextLine();
        }
      } else {
        this.error(`Expected 'channel', mapping, or require inside group "${name}", got '${tok.value || tok.type}'`, tok);
        this.skipToNextLine();
      }
    }

    if (this.check('DEDENT')) this.advance();

    return { type: 'group_decl', name, anchor, anchorFixedPins, anchorExcludedPins, loc };
  }

  // Parse a `@` placement clause (AT already at current token).
  //   @ PA1, PA2   fixed pin restriction        -> { fixedPins }
  //   @ ~PA1       proximity to a pin           -> { anchor: near_pin }
  //   @ ~1 / ~A1   proximity to a position      -> { anchor: near_pos }
  //   @ ~NW        proximity to a compass region -> { anchor: near_region }
  private parseAtClause(): { fixedPins?: string[]; excludedPins?: string[]; anchor?: PinAnchor } {
    this.expect('AT');
    if (this.check('TILDE')) {
      this.advance();
      if (this.check('NUMBER')) {
        const target = this.peek().value;
        this.advance();
        return { anchor: { kind: 'near_pos', target } };
      }
      const raw = this.parsePinName(); // IDENT + optional NUMBER
      if (/^P[A-Z]\d+$/i.test(raw)) return { anchor: { kind: 'near_pin', target: raw.toUpperCase() } };
      if (/^[NSEWC]+$/i.test(raw)) return { anchor: { kind: 'near_region', target: raw.toUpperCase() } };
      if (/^[A-Z]+\d+$/i.test(raw)) return { anchor: { kind: 'near_pos', target: raw.toUpperCase() } };
      this.error(`Invalid anchor '~${raw}' (expected a pin like ~PA1, a position like ~1, or a region like ~NW)`, this.peek());
      return {};
    }
    // Comma-separated list mixing required pins and `!pin` exclusions,
    // e.g. `@ PA1, !PB1`.
    const fixedPins: string[] = [];
    const excludedPins: string[] = [];
    do {
      if (this.check('BANG')) {
        this.advance();
        excludedPins.push(this.parsePinName());
      } else {
        fixedPins.push(this.parsePinName());
      }
      if (!this.check('COMMA')) break;
      this.advance();
    } while (!this.isAtEnd());
    return {
      fixedPins: fixedPins.length > 0 ? fixedPins : undefined,
      excludedPins: excludedPins.length > 0 ? excludedPins : undefined,
    };
  }

  // channel IDENT (@ pin_list | @ ~target)? (= signal_expr ($var)* )?
  // Returns [channel, optionalInlineMapping]
  private parseChannelDecl(): [ChannelDeclNode, MappingNode | null] {
    const loc = this.loc();
    this.expectKeyword('channel');
    const name = this.parseCompoundIdent();

    let allowedPins: string[] | undefined;
    let excludedPins: string[] | undefined;
    let anchor: PinAnchor | undefined;
    if (this.check('AT')) {
      const at = this.parseAtClause();
      allowedPins = at.fixedPins;
      excludedPins = at.excludedPins;
      anchor = at.anchor;
    }

    // Inline mapping: channel X = SIGNAL $var
    let inlineMapping: MappingNode | null = null;
    if (this.check('EQUALS') || this.check('QUESTION')) {
      let optional: boolean | undefined;
      if (this.check('QUESTION')) {
        this.advance();
        optional = true;
      }
      this.expect('EQUALS');

      const signalExprs: SignalExprNode[] = [];
      signalExprs.push(this.parseSignalExpr());
      while (this.check('PLUS')) {
        this.advance();
        signalExprs.push(this.parseSignalExpr());
      }

      let instanceBindings: string[] | undefined;
      while (this.check('DOLLAR')) {
        this.advance();
        if (!instanceBindings) instanceBindings = [];
        instanceBindings.push(this.parseCompoundIdent());
      }

      inlineMapping = { type: 'mapping', channelName: name, signalExprs, optional, instanceBindings, loc };
    }

    const comment = this.skipComment();
    this.expectNewlineOrEnd();
    return [{ type: 'channel_decl', name, allowedPins, excludedPins, anchor, comment, loc }, inlineMapping];
  }

  // config STRING: (@ ...)? NEWLINE INDENT config_body DEDENT
  private parseConfigDecl(): ConfigDeclNode {
    const loc = this.loc();
    this.expectKeyword('config');
    const name = this.expectString();
    this.expect('COLON');

    // Optional placement clause: `config "UART": @ ~NW` / `@ PA1`
    let anchor: PinAnchor | undefined;
    let anchorFixedPins: string[] | undefined;
    let anchorExcludedPins: string[] | undefined;
    if (this.check('AT')) {
      const at = this.parseAtClause();
      anchor = at.anchor;
      anchorFixedPins = at.fixedPins;
      anchorExcludedPins = at.excludedPins;
    }
    this.skipComment();
    this.expectNewline();

    const body: ConfigBodyNode[] = [];

    if (!this.check('INDENT')) {
      this.error('Expected indented block after config declaration', this.peek());
      return { type: 'config_decl', name, body, anchor, anchorFixedPins, anchorExcludedPins, loc };
    }
    this.expect('INDENT');

    while (!this.check('DEDENT') && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check('DEDENT') || this.isAtEnd()) break;

      const item = this.parseConfigBodyItem();
      if (item) {
        body.push(item);
      }
    }

    if (this.check('DEDENT')) {
      this.advance();
    }

    return { type: 'config_decl', name, body, anchor, anchorFixedPins, anchorExcludedPins, loc };
  }

  private parseConfigBodyItem(): ConfigBodyNode | null {
    const tok = this.peek();

    // require or require? statement
    if (tok.type === 'KEYWORD' && tok.value === 'require') {
      return this.parseRequireStmt();
    }

    // IDENT could be a mapping (IDENT = ... or IDENT ?= ...) or a macro call (IDENT(...))
    if (tok.type === 'IDENT' || tok.type === 'KEYWORD') {
      // Look ahead past a possible compound ident to find '=', '?=', or '('
      const lookAhead = this.peekPastCompoundIdent();
      if (lookAhead === 'EQUALS') {
        return this.parseMapping();
      }
      if (lookAhead === 'QUESTION') {
        return this.parseMapping(); // ?= optional mapping
      }
      if (lookAhead === 'LPAREN') {
        return this.parseMacroCall();
      }
      this.error(`Expected mapping (name = ...) or macro call (name(...)), got '${tok.value}'`, tok);
      this.skipToNextLine();
      return null;
    }

    this.error(`Unexpected '${tok.value || tok.type}' in config body`, tok);
    this.skipToNextLine();
    return null;
  }

  // Look ahead past a compound identifier to see what follows
  private peekPastCompoundIdent(): TokenType | null {
    let i = this.pos;
    // Skip first IDENT/KEYWORD
    if (i < this.tokens.length && (this.tokens[i].type === 'IDENT' || this.tokens[i].type === 'KEYWORD')) {
      i++;
    }
    // Skip (_IDENT | _KEYWORD | _NUMBER)*
    while (i + 1 < this.tokens.length && this.tokens[i].type === 'UNDERSCORE') {
      const next = this.tokens[i + 1];
      if (next.type === 'IDENT' || next.type === 'KEYWORD' || next.type === 'NUMBER') {
        i += 2;
      } else {
        break;
      }
    }
    if (i < this.tokens.length) {
      return this.tokens[i].type;
    }
    return null;
  }

  // IDENT = signal_expr (+ signal_expr)*  ($var)*
  // IDENT ?= signal_expr ...  (optional mapping)
  private parseMapping(): MappingNode {
    const loc = this.loc();
    const channelName = this.parseCompoundIdent();

    // Check for ?= (optional) or = (required)
    let optional: boolean | undefined;
    if (this.check('QUESTION')) {
      this.advance();
      optional = true;
    }
    this.expect('EQUALS');

    const signalExprs: SignalExprNode[] = [];
    signalExprs.push(this.parseSignalExpr());

    while (this.check('PLUS')) {
      this.advance();
      signalExprs.push(this.parseSignalExpr());
    }

    // Optional instance variable bindings: $var $var2 ...
    let instanceBindings: string[] | undefined;
    while (this.check('DOLLAR')) {
      this.advance();
      if (!instanceBindings) instanceBindings = [];
      instanceBindings.push(this.parseCompoundIdent());
    }

    this.expectNewlineOrEnd();
    return { type: 'mapping', channelName, signalExprs, optional, instanceBindings, loc };
  }

  // require constraint_expr
  // require? constraint_expr  (optional — vacuous truth if channels unassigned)
  private parseRequireStmt(): RequireNode {
    const loc = this.loc();
    this.expectKeyword('require');
    let optional: boolean | undefined;
    if (this.check('QUESTION')) {
      this.advance();
      optional = true;
    }
    const expression = this.parseConstraintExpr();
    this.expectNewlineOrEnd();
    return { type: 'require', expression, optional, loc };
  }

  // signal_expr := signal_pattern (| signal_pattern)*
  private parseSignalExpr(): SignalExprNode {
    const loc = this.loc();
    const alternatives: SignalPatternNode[] = [];
    alternatives.push(this.parseSignalPattern());

    while (this.check('PIPE')) {
      this.advance();
      alternatives.push(this.parseSignalPattern());
    }

    return { type: 'signal_expr', alternatives, loc };
  }

  // signal_pattern: pattern_part _ pattern_part
  //   OR: IN | OUT (shorthand for GPIO*_*, any assignable pin)
  // e.g., USART*_TX, TIM[1-3]_CH1, ADC*_IN[0-7], *_TX, OUT, IN
  private parseSignalPattern(): SignalPatternNode {
    const loc = this.loc();
    const startPos = this.pos;

    const instancePart = this.parsePatternPart();

    // Handle IN/OUT shorthand: no underscore means simple GPIO pin
    if (!this.check('UNDERSCORE')) {
      if (instancePart.type === 'literal' && (instancePart.value === 'IN' || instancePart.value === 'OUT')) {
        return {
          type: 'signal_pattern',
          instancePart: { type: 'wildcard', prefix: 'GPIO' },
          functionPart: { type: 'any' },
          raw: instancePart.value,
          loc,
        };
      }
      this.error("Expected '_' in signal pattern (use IN or OUT for simple GPIO)", this.peek());
    } else {
      this.advance(); // consume underscore
    }

    const functionPart = this.parsePatternPart();

    // Reconstruct raw text
    const raw = this.tokens.slice(startPos, this.pos).map(t => t.value).join('');

    return { type: 'signal_pattern', instancePart, functionPart, raw, loc };
  }

  // pattern_part: IDENT | IDENT* | * | IDENT[range] | IDENT NUMBER | IDENT NUMBER * | NUMBER (position) | etc.
  /**
   * Optional `_C` suffix of a dual-pad analog pin (PC2_C). The lexer splits the
   * underscore off, so pin names have to re-join it — without this, `PC2_C`
   * parses as `PC2` and leaves `_C` behind as a syntax error.
   */
  private parseCSuffix(): string {
    if (!this.check('UNDERSCORE')) return '';
    const next = this.tokens[this.pos + 1];
    if (next?.type !== 'IDENT' || next.value.toUpperCase() !== 'C') return '';
    this.advance(); // _
    this.advance(); // C
    return '_C';
  }

  private parsePatternPart(): PatternPart {
    // Just *
    if (this.check('STAR')) {
      this.advance();
      return { type: 'any' };
    }

    // Bare NUMBER → numeric position literal (e.g. `reserve: 11`).
    // Used by reserve declarations to lock a package pin by position.
    if (this.check('NUMBER')) {
      const value = this.peek().value;
      this.advance();
      return { type: 'literal', value };
    }

    // Must start with IDENT (or KEYWORD in edge cases)
    let prefix = '';
    if (this.check('IDENT') || this.check('KEYWORD')) {
      prefix = this.peek().value;
      this.advance();
    } else {
      this.error('Expected identifier, number, or \'*\' in signal pattern', this.peek());
      return { type: 'literal', value: '' };
    }

    // Greedily consume trailing NUMBER tokens that are part of the literal
    // e.g., USART + 1 → "USART1", CH + 1 → "CH1"
    if (this.check('NUMBER')) {
      prefix += this.peek().value;
      this.advance();
    }

    // Dual-pad analog pin (`reserve: PC2_C`) — see parseCSuffix.
    const cSuffix = this.parseCSuffix();
    if (cSuffix) return { type: 'literal', value: prefix + cSuffix };

    // Check for wildcard: prefix*
    if (this.check('STAR')) {
      this.advance();
      return { type: 'wildcard', prefix };
    }

    // Check for range: prefix[range]
    if (this.check('LBRACKET')) {
      this.advance();
      const values = this.parseRange();
      this.expect('RBRACKET');
      return { type: 'range', prefix, values };
    }

    return { type: 'literal', value: prefix };
  }

  // range: range_elem (, range_elem)*
  // range_elem: NUMBER | NUMBER-NUMBER
  private parseRange(): number[] {
    const values: number[] = [];
    this.parseRangeElem(values);

    while (this.check('COMMA')) {
      this.advance();
      this.parseRangeElem(values);
    }

    return values;
  }

  private parseRangeElem(values: number[]): void {
    const startTok = this.peek();
    const n = this.expectNumber();

    if (this.check('DASH')) {
      this.advance();
      const m = this.expectNumber();
      // Ranges materialize into an array — an unbounded or reversed range
      // must be an error, not a tab-freezing 1e9-element loop (the editor
      // reparses on every keystroke).
      if (m < n) {
        this.error(`Invalid range [${n}-${m}]: end is less than start`, startTok);
        return;
      }
      if (m - n + 1 > MAX_RANGE_VALUES) {
        this.error(`Range [${n}-${m}] too large (max ${MAX_RANGE_VALUES} values)`, startTok);
        return;
      }
      for (let i = n; i <= m; i++) {
        values.push(i);
      }
    } else {
      values.push(n);
    }
  }

  // --------------------------------------------------------
  // Constraint expression parsing
  // --------------------------------------------------------

  private parseConstraintExpr(): ConstraintExprNode {
    return this.parseBinaryExpr(0);
  }

  // Precedence climbing
  // Level 0: | (lowest)
  // Level 1: ^
  // Level 2: &
  // Level 3: == != < > <= >=
  // Level 4: + - (arithmetic)
  // Level 5: ! (unary, handled in parsePrimary)
  private readonly precedenceMap: Record<string, number> = {
    '|': 0,
    '^': 1,
    '&': 2,
    '==': 3,
    '!=': 3,
    '<': 3,
    '>': 3,
    '<=': 3,
    '>=': 3,
    '+': 4,
    '-': 4,
  };

  private readonly tokenToOp: Record<string, BinaryExprNode['operator']> = {
    'EQEQ': '==',
    'BANGEQ': '!=',
    'AMP': '&',
    'PIPE': '|',
    'CARET': '^',
    'PLUS': '+',
    'DASH': '-',
  };

  /** Try to read a binary operator from the token stream. Handles compound <= and >= */
  private tryReadBinaryOp(): BinaryExprNode['operator'] | null {
    const tok = this.peek();
    // Check for compound <= and >= (two tokens: LT/GT + EQUALS)
    if (tok.type === 'LT') {
      if (this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === 'EQUALS') {
        return '<=';
      }
      return '<';
    }
    if (tok.type === 'GT') {
      if (this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === 'EQUALS') {
        return '>=';
      }
      return '>';
    }
    return this.tokenToOp[tok.type] ?? null;
  }

  private parseBinaryExpr(minPrec: number): ConstraintExprNode {
    let left = this.parsePrimaryExpr();

    while (true) {
      const op = this.tryReadBinaryOp();
      if (!op) break;

      const prec = this.precedenceMap[op];
      if (prec === undefined || prec < minPrec) break;

      // Consume operator token(s)
      this.advance();
      if (op === '<=' || op === '>=') this.advance(); // consume second token (EQUALS)

      const right = this.parseBinaryExpr(prec + 1);
      const loc = left.loc;
      left = { type: 'binary_expr', operator: op, left, right, loc };
    }

    return left;
  }

  private parsePrimaryExpr(): ConstraintExprNode {
    const tok = this.peek();

    // Unary !
    if (tok.type === 'BANG') {
      this.advance();
      const operand = this.parsePrimaryExpr();
      return { type: 'unary_expr', operator: '!', operand, loc: { line: tok.line, column: tok.column } };
    }

    // Parenthesized expression
    if (tok.type === 'LPAREN') {
      this.advance();
      const expr = this.parseConstraintExpr();
      this.expect('RPAREN');
      return expr;
    }

    // Peripheral pattern used as a value (`TIM[1-5,8,20]`, `TIM*`). The
    // bracket/star after the identifier is what distinguishes it; a bare
    // identifier stays a channel reference.
    if (tok.type === 'IDENT') {
      const after = this.tokens[this.pos + 1];
      const afterNum = after?.type === 'NUMBER' ? this.tokens[this.pos + 2] : after;
      if (afterNum?.type === 'LBRACKET' || afterNum?.type === 'STAR') {
        const from = this.pos;
        const pattern = this.parsePatternPart();
        const text = this.tokens.slice(from, this.pos).map(t => t.value).join('');
        return { type: 'pattern_literal', pattern, text, loc: { line: tok.line, column: tok.column } };
      }
    }

    // Boolean literal — recognised before identifiers so `true`/`false` are
    // never treated as channel references (which would make a require look
    // vacuous and get skipped).
    if (tok.type === 'IDENT' && /^(true|false)$/i.test(tok.value)) {
      this.advance();
      return {
        type: 'boolean_literal',
        value: tok.value.toLowerCase() === 'true',
        loc: { line: tok.line, column: tok.column },
      };
    }

    // String literal
    if (tok.type === 'STRING') {
      this.advance();
      return { type: 'string_literal', value: tok.value, loc: { line: tok.line, column: tok.column } };
    }

    // Number literal
    if (tok.type === 'NUMBER') {
      this.advance();
      return { type: 'number_literal', value: parseInt(tok.value, 10), loc: { line: tok.line, column: tok.column } };
    }

    // IDENT/KEYWORD - could be function call, dot access, or plain identifier
    if (tok.type === 'IDENT' || tok.type === 'KEYWORD') {
      const loc = { line: tok.line, column: tok.column };
      const name = this.parseCompoundIdent();

      // Function call: name(...)
      if (this.check('LPAREN')) {
        this.advance();
        const args: ConstraintExprNode[] = [];
        if (!this.check('RPAREN')) {
          args.push(this.parseConstraintExpr());
          while (this.check('COMMA')) {
            this.advance();
            args.push(this.parseConstraintExpr());
          }
        }
        this.expect('RPAREN');
        return { type: 'function_call', name, args, loc };
      }

      // Dot access: name.property
      if (this.check('DOT')) {
        this.advance();
        const property = this.parseCompoundIdent();
        return { type: 'dot_access', object: name, property, loc };
      }

      // Plain identifier
      return { type: 'ident', name, loc };
    }

    this.error(`Expected expression, got '${tok.value || tok.type}'`, tok);
    this.advance();
    return { type: 'ident', name: '<error>', loc: { line: tok.line, column: tok.column } };
  }

  // --------------------------------------------------------
  // Macro parsing
  // --------------------------------------------------------

  // macro IDENT(param_list): NEWLINE INDENT macro_body DEDENT
  private parseMacroDecl(): MacroDeclNode {
    const loc = this.loc();
    this.expectKeyword('macro');
    const name = this.parseCompoundIdent();
    this.expect('LPAREN');

    const params: string[] = [];
    if (!this.check('RPAREN')) {
      params.push(this.parseCompoundIdent());
      while (this.check('COMMA')) {
        this.advance();
        params.push(this.parseCompoundIdent());
      }
    }
    this.expect('RPAREN');
    this.expect('COLON');
    this.expectNewline();

    const body: ConfigBodyNode[] = [];

    if (!this.check('INDENT')) {
      this.error('Expected indented block after macro declaration', this.peek());
      return { type: 'macro_decl', name, params, body, loc };
    }
    this.expect('INDENT');

    while (!this.check('DEDENT') && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check('DEDENT') || this.isAtEnd()) break;

      const item = this.parseConfigBodyItem();
      if (item) {
        body.push(item);
      }
    }

    if (this.check('DEDENT')) {
      this.advance();
    }

    return { type: 'macro_decl', name, params, body, loc };
  }

  // macro_call: IDENT(arg_list)
  private parseMacroCall(): MacroCallNode {
    const loc = this.loc();
    const name = this.parseCompoundIdent();
    this.expect('LPAREN');

    const args: string[] = [];
    if (!this.check('RPAREN')) {
      args.push(this.parseCompoundIdent());
      while (this.check('COMMA')) {
        this.advance();
        args.push(this.parseCompoundIdent());
      }
    }
    this.expect('RPAREN');

    this.expectNewlineOrEnd();
    return { type: 'macro_call', name, args, loc };
  }

  // --------------------------------------------------------
  // Helper: parse pin name (e.g., PA0, PH1, PA13)
  // With separate underscore tokenization, PA0 = IDENT("PA") + NUMBER("0")
  // --------------------------------------------------------

  private parsePinName(): string {
    let name = '';
    const tok = this.peek();
    if (tok.type === 'IDENT' || tok.type === 'KEYWORD') {
      name = tok.value;
      this.advance();
    } else {
      this.error(`Expected pin name, got '${tok.value || tok.type}'`, tok);
      this.advance();
      return '<error>';
    }
    // Pin name is followed by a number (e.g., "PA" + "0", "PA" + "13")
    if (this.check('NUMBER')) {
      name += this.peek().value;
      this.advance();
    }
    name += this.parseCSuffix();
    return name;
  }

  // Parse a raw name composed of IDENT, NUMBER, UNDERSCORE, STAR tokens
  // Used for signal names in pin declarations (e.g., DAC1_OUT1, USB_DM)
  private parseRawName(): string {
    let result = '';
    while (!this.isAtEnd() && !this.check('NEWLINE') && !this.check('EOF')) {
      const tok = this.peek();
      if (tok.type === 'IDENT' || tok.type === 'KEYWORD' || tok.type === 'NUMBER' ||
          tok.type === 'UNDERSCORE' || tok.type === 'STAR') {
        result += tok.value;
        this.advance();
      } else {
        break;
      }
    }
    return result;
  }

  // --------------------------------------------------------
  // Token helpers
  // --------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] || { type: 'EOF', value: '', line: 0, column: 0 };
  }

  private peekAhead(offset: number): Token | null {
    const idx = this.pos + offset;
    if (idx < this.tokens.length) {
      return this.tokens[idx];
    }
    return null;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (this.pos < this.tokens.length) {
      this.pos++;
    }
    return tok;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private expect(type: TokenType): Token {
    if (this.check(type)) {
      return this.advance();
    }
    const tok = this.peek();
    this.error(`Expected ${type}, got '${tok.value || tok.type}'`, tok);
    return tok;
  }

  private expectKeyword(keyword: string): Token {
    const tok = this.peek();
    if (tok.type === 'KEYWORD' && tok.value === keyword) {
      return this.advance();
    }
    this.error(`Expected '${keyword}', got '${tok.value || tok.type}'`, tok);
    return tok;
  }

  private expectString(): string {
    const tok = this.peek();
    if (tok.type === 'STRING') {
      this.advance();
      return tok.value;
    }
    this.error(`Expected string literal, got '${tok.value || tok.type}'`, tok);
    return '<error>';
  }

  private expectNumber(): number {
    const tok = this.peek();
    if (tok.type === 'NUMBER') {
      this.advance();
      return parseInt(tok.value, 10);
    }
    this.error(`Expected number, got '${tok.value || tok.type}'`, tok);
    return 0;
  }

  private expectNewline(): void {
    this.skipComment();
    if (this.check('NEWLINE')) {
      this.advance();
    } else if (!this.check('EOF') && !this.check('DEDENT')) {
      this.error('Expected end of line', this.peek());
    }
  }

  private expectNewlineOrEnd(): void {
    this.skipComment();
    if (this.check('NEWLINE')) {
      this.advance();
    } else if (this.check('EOF') || this.check('DEDENT')) {
      // OK
    } else {
      this.error('Expected end of line', this.peek());
    }
  }

  /** Skip a COMMENT token if present, returning its value or undefined */
  private skipComment(): string | undefined {
    if (this.check('COMMENT')) {
      const value = this.peek().value;
      this.advance();
      return value;
    }
    return undefined;
  }

  private isAtEnd(): boolean {
    return this.peek().type === 'EOF';
  }

  private loc(): SourceLocation {
    const tok = this.peek();
    return { line: tok.line, column: tok.column };
  }

  // --------------------------------------------------------
  // Error handling & recovery
  // --------------------------------------------------------

  private error(message: string, tok: Token): void {
    this.errors.push({
      message,
      line: tok.line,
      column: tok.column,
    });
  }

  private skipNewlines(): void {
    while (this.check('NEWLINE')) {
      this.advance();
    }
  }

  private skipToNextLine(): void {
    while (!this.isAtEnd() && !this.check('NEWLINE') && !this.check('DEDENT')) {
      this.advance();
    }
    if (this.check('NEWLINE')) {
      this.advance();
    }
  }

  private skipToNextStatement(): void {
    while (!this.isAtEnd()) {
      if (this.check('NEWLINE')) {
        this.advance();
        const next = this.peek();
        if (next.type === 'KEYWORD' || next.type === 'EOF') {
          break;
        }
      } else if (this.check('DEDENT')) {
        this.advance();
      } else {
        this.advance();
      }
    }
  }

  /** Parse a standalone signal pattern (for search). */
  parseStandaloneSignalPattern(): SignalPatternNode | null {
    this.skipNewlines();
    if (this.isAtEnd()) return null;
    try {
      return this.parseSignalPattern();
    } catch {
      return null;
    }
  }

  parseStandaloneExpr(): ConstraintExprNode | null {
    this.skipNewlines();
    if (this.isAtEnd()) return null;
    try {
      return this.parseConstraintExpr();
    } catch {
      return null;
    }
  }
}

// ============================================================
// Public API
// ============================================================

export interface ParseOptions {
  /**
   * Macro library to draw definitions from. Defaults to the active library
   * (the user's edited one once primed, the bundled default before that).
   * Pass `''` to parse a program in isolation — the library itself is parsed
   * that way, so its own definitions are not expanded into it.
   */
  macroLibrary?: string;
}

export function parseConstraints(source: string, opts?: ParseOptions): ParseResult {
  // Macros expand on the text, before tokenizing — see parser/preprocessor.ts.
  const pre = preprocess(source, opts?.macroLibrary);
  const { tokens, errors: lexErrors } = tokenize(pre.text, pre.lineMap);
  const parser = new Parser(tokens, [...pre.errors, ...lexErrors]);
  return parser.parse();
}

/**
 * Parse a standalone signal pattern string like "TIM*_CH1" or "ADC*_IN[1-4]".
 * Returns the parsed SignalPatternNode, or null if the input is invalid.
 */
export function parseSearchPattern(input: string): SignalPatternNode | null {
  if (!input.trim()) return null;
  const { tokens } = tokenize(input);
  const parser = new Parser(tokens, []);
  return parser.parseStandaloneSignalPattern();
}

/** Parse a standalone constraint expression like "instance(TX)" or "pin_number(A) + 1" */
export function parseExpressionString(input: string): ConstraintExprNode | null {
  if (!input.trim()) return null;
  const { tokens } = tokenize(input);
  const parser = new Parser(tokens, []);
  return parser.parseStandaloneExpr();
}
