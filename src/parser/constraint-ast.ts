// ============================================================
// AST Node Types for Proposal C Constraint Syntax
// ============================================================

export interface SourceLocation {
  line: number;
  column: number;
}

// Top-level program
export interface ProgramNode {
  type: 'program';
  statements: StatementNode[];
  loc: SourceLocation;
}

export type StatementNode =
  | McuDeclNode
  | PackageDeclNode
  | RamDeclNode
  | RomDeclNode
  | FreqDeclNode
  | SettingsDeclNode
  | TempDeclNode
  | VoltageDeclNode
  | CoreDeclNode
  | ReserveDeclNode
  | PinDeclNode
  | PortDeclNode
  | MacroDeclNode
  | SharedDeclNode;

// mcu: STM32G473* | STM32F405*
export interface McuDeclNode {
  type: 'mcu_decl';
  patterns: string[];
  loc: SourceLocation;
}

// package: LQFP* | BGA*
export interface PackageDeclNode {
  type: 'package_decl';
  patterns: string[];
  loc: SourceLocation;
}

// ram: 1024K | ram: < 512K | ram: 256K < 1024K
export interface RamDeclNode {
  type: 'ram_decl';
  minBytes: number;
  maxBytes?: number;
  loc: SourceLocation;
}

// rom: 512K | rom: < 2M | rom: 256K < 2M
export interface RomDeclNode {
  type: 'rom_decl';
  minBytes: number;
  maxBytes?: number;
  loc: SourceLocation;
}

// freq: 480 | freq: < 200 | freq: 100 < 480
export interface FreqDeclNode {
  type: 'freq_decl';
  minMHz: number;
  maxMHz?: number;
  loc: SourceLocation;
}

// settings:                      — override solver settings for this run
//   timeout: 3s
//   solvers: "mrv-group", "hybrid"
// settings from "default":        — start from a named preset, then override
export type SettingValue = number | boolean | string[];

export interface SettingsEntryNode {
  key: string;
  value: SettingValue;
  loc: SourceLocation;
}

export interface SettingsDeclNode {
  type: 'settings_decl';
  /** Named preset to start from ("default", "complex"); omitted = current settings. */
  preset?: string;
  entries: SettingsEntryNode[];
  loc: SourceLocation;
}

// temp: -40 < 85  (operating temperature range in °C)
export interface TempDeclNode {
  type: 'temp_decl';
  minTemp?: number;
  maxTemp?: number;
  loc: SourceLocation;
}

// voltage: 1.8 < 3.3  (operating voltage range in V)
export interface VoltageDeclNode {
  type: 'voltage_decl';
  minVoltage?: number;
  maxVoltage?: number;
  loc: SourceLocation;
}

// core: M4 | core: M4 | M7 | core: M4 + M7
export interface CoreDeclNode {
  type: 'core_decl';
  /** Core patterns that must be present (AND, joined by +). Each inner list is alternatives (OR, joined by |). */
  required: string[][];
  loc: SourceLocation;
}

// reserve: PH0, PH1, ADC*, SPI[1,3]
export interface ReserveDeclNode {
  type: 'reserve_decl';
  patterns: PatternPart[];
  loc: SourceLocation;
}

// shared: ADC1, ADC*, ADC[1,2]
export interface SharedDeclNode {
  type: 'shared_decl';
  patterns: PatternPart[];
  loc: SourceLocation;
}

// pin PA4 = DAC1_OUT1
export interface PinDeclNode {
  type: 'pin_decl';
  pinName: string;
  signalName: string;
  comment?: string;
  loc: SourceLocation;
}

// Soft placement hint from the `@ ~...` syntax. A bare `@ PA1` (fixed pin
// restriction) is NOT an anchor — it stays in `allowedPins` (channel) or
// `anchorFixedPins` (port/config). Anchors only nudge cost, they never filter.
//   @ ~PA1  -> { kind: 'near_pin', target: 'PA1' }
//   @ ~1    -> { kind: 'near_pos', target: '1' }   (package position)
//   @ ~NW   -> { kind: 'near_region', target: 'NW' } (compass region)
export type PinAnchor =
  | { kind: 'near_pin'; target: string }
  | { kind: 'near_pos'; target: string }
  | { kind: 'near_region'; target: string };

// group "rail_3v3": @ ~NW      — a physical grouping of channels within a port
//   channel EN = OUT
//   channel PGOOD = IN
//
// Groups only affect placement: their channels stay in the port's flat
// `channels` list under their own names, so mappings, requires and cross-port
// references address them exactly as before. What a group adds is a placement
// scope (its `@` clause) and a clustering cost that pulls its members together
// independently of the rest of the port.
export interface GroupDeclNode {
  type: 'group_decl';
  name: string;
  /** `group "g": @ ~NW` — soft, applies to every channel of the group. */
  anchor?: PinAnchor;
  /** `group "g": @ PA1` — hard: some channel of the group must use each pin. */
  anchorFixedPins?: string[];
  /** `group "g": @ !PB1` — hard: no channel of the group may use these pins. */
  anchorExcludedPins?: string[];
  loc: SourceLocation;
}

// port CMD: ...
// port ENC0 from encoder_port:
export interface PortDeclNode {
  type: 'port_decl';
  name: string;
  template?: string;
  color?: string;
  comment?: string;
  channels: ChannelDeclNode[];
  configs: ConfigDeclNode[];
  /** Declared `group` blocks; members carry the name in `ChannelDeclNode.group`. */
  groups?: GroupDeclNode[];
  // `port CMD: @ ~NW`  — soft, applies to every channel of the port.
  anchor?: PinAnchor;
  // `port CMD: @ PA1`  — hard: some channel of the port must use each listed pin.
  anchorFixedPins?: string[];
  // `port CMD: @ !PB1` — hard: no channel of the port may use these pins.
  anchorExcludedPins?: string[];
  loc: SourceLocation;
}

// channel TX @ PA1, PA2   (fixed → allowedPins)
// channel TX @ !PA1       (excluded → excludedPins)
// channel TX @ ~PA1       (soft → anchor)
export interface ChannelDeclNode {
  type: 'channel_decl';
  name: string;
  /** Name of the enclosing `group` block, when the channel was declared in one. */
  group?: string;
  allowedPins?: string[];
  /** `@ !PA1` — this channel may not use these pins. */
  excludedPins?: string[];
  anchor?: PinAnchor;
  comment?: string;
  loc: SourceLocation;
}

// config "UART full duplex": ...
// config "UART": @ ~NW    (soft, applies to channels mapped in this config)
export interface ConfigDeclNode {
  type: 'config_decl';
  name: string;
  body: ConfigBodyNode[];
  anchor?: PinAnchor;
  anchorFixedPins?: string[];
  /** `config "x": @ !PB1` — no channel mapped in this config may use these pins. */
  anchorExcludedPins?: string[];
  loc: SourceLocation;
}

export type ConfigBodyNode = MappingNode | RequireNode | MacroCallNode;

// TX = USART*_TX + USART*_RX
// CTS ?= USART*_CTS  (optional mapping)
// TX = USART*_TX $u   (variable assignment)
export interface MappingNode {
  type: 'mapping';
  channelName: string;
  signalExprs: SignalExprNode[]; // joined by '+' (all required simultaneously)
  optional?: boolean; // ?= optional mapping
  instanceBindings?: string[]; // $var bindings — channels sharing a $name get same_instance constraint
  loc: SourceLocation;
}

// require same_instance(TX, RX)
// require? same_instance(TX, CTS)  (optional require)
export interface RequireNode {
  type: 'require';
  expression: ConstraintExprNode;
  optional?: boolean; // require? — vacuous truth if referenced channels unassigned
  loc: SourceLocation;
}

// Signal expression: signal_pattern | signal_pattern (alternatives)
export interface SignalExprNode {
  type: 'signal_expr';
  alternatives: SignalPatternNode[]; // joined by '|' (any one matches)
  loc: SourceLocation;
}

// USART*_TX, TIM[1-3]_CH1, ADC*_IN[0-7]
export interface SignalPatternNode {
  type: 'signal_pattern';
  instancePart: PatternPart;
  functionPart: PatternPart;
  raw: string; // original text for display
  loc: SourceLocation;
}

export type PatternPart =
  | { type: 'literal'; value: string }
  | { type: 'wildcard'; prefix: string }       // e.g., USART* -> prefix="USART"
  | { type: 'any' }                             // just *
  | { type: 'range'; prefix: string; values: number[] }; // e.g., TIM[1,3] or TIM[1-8]

// Constraint expressions
export type ConstraintExprNode =
  | FunctionCallNode
  | BinaryExprNode
  | UnaryExprNode
  | IdentNode
  | StringLiteralNode
  | NumberLiteralNode
  | BooleanLiteralNode
  | PatternLiteralNode
  | DotAccessNode;

// same_instance(TX, RX)
export interface FunctionCallNode {
  type: 'function_call';
  name: string;
  args: ConstraintExprNode[];
  loc: SourceLocation;
}

// expr == expr, expr & expr, expr < expr, expr + expr
export interface BinaryExprNode {
  type: 'binary_expr';
  operator: '==' | '!=' | '<' | '>' | '<=' | '>=' | '&' | '|' | '^' | '+' | '-';
  left: ConstraintExprNode;
  right: ConstraintExprNode;
  loc: SourceLocation;
}

// !expr
export interface UnaryExprNode {
  type: 'unary_expr';
  operator: '!';
  operand: ConstraintExprNode;
  loc: SourceLocation;
}

// TX, A, etc.
export interface IdentNode {
  type: 'ident';
  name: string;
  loc: SourceLocation;
}

// CMD.TX (cross-port reference)
export interface DotAccessNode {
  type: 'dot_access';
  object: string;
  property: string;
  loc: SourceLocation;
}

// "string literal"
export interface StringLiteralNode {
  type: 'string_literal';
  value: string;
  loc: SourceLocation;
}

// true, false — a distinct node so they are never mistaken for a channel
// reference (which would make a require look vacuous and get skipped).
// A peripheral pattern used as a value, e.g. `TIM[1-5,8,20]` or `TIM*` in
// `require instance(A, "TIM") == TIM[1-5,8,20]`. Compared by matching rather
// than string equality — see matchPatternToInstance.
export interface PatternLiteralNode {
  type: 'pattern_literal';
  pattern: PatternPart;
  /** Source text, for error messages and the read-only viewer. */
  text: string;
  loc: SourceLocation;
}

export interface BooleanLiteralNode {
  type: 'boolean_literal';
  value: boolean;
  loc: SourceLocation;
}

// 42, 3
export interface NumberLiteralNode {
  type: 'number_literal';
  value: number;
  loc: SourceLocation;
}

// macro uart_port(tx_ch, rx_ch): ...
export interface MacroDeclNode {
  type: 'macro_decl';
  name: string;
  params: string[];
  body: ConfigBodyNode[];
  loc: SourceLocation;
}

// uart_port(TX, RX)
export interface MacroCallNode {
  type: 'macro_call';
  name: string;
  args: string[];
  loc: SourceLocation;
}

// ============================================================
// Parse Result
// ============================================================

export interface ParseError {
  message: string;
  line: number;
  column: number;
  suggestion?: string;
}

export interface ParseWarning {
  message: string;
  line: number;
  column: number;
}

export interface ParseResult {
  ast: ProgramNode | null;
  errors: ParseError[];
  warnings: ParseWarning[];
}
