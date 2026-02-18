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

// reserve: PH0, PH1, PA13, PA14
export interface ReserveDeclNode {
  type: 'reserve_decl';
  pins: string[];
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
  loc: SourceLocation;
}

// port CMD: ...
export interface PortDeclNode {
  type: 'port_decl';
  name: string;
  color?: string;
  channels: ChannelDeclNode[];
  configs: ConfigDeclNode[];
  loc: SourceLocation;
}

// channel TX @ PA1, PA2
export interface ChannelDeclNode {
  type: 'channel_decl';
  name: string;
  allowedPins?: string[];
  loc: SourceLocation;
}

// config "UART full duplex": ...
export interface ConfigDeclNode {
  type: 'config_decl';
  name: string;
  body: ConfigBodyNode[];
  loc: SourceLocation;
}

export type ConfigBodyNode = MappingNode | RequireNode | MacroCallNode;

// TX = USART*_TX & USART*_RX
export interface MappingNode {
  type: 'mapping';
  channelName: string;
  signalExprs: SignalExprNode[]; // joined by '&' (all required simultaneously)
  loc: SourceLocation;
}

// require same_instance(TX, RX)
export interface RequireNode {
  type: 'require';
  expression: ConstraintExprNode;
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
  | DotAccessNode;

// same_instance(TX, RX)
export interface FunctionCallNode {
  type: 'function_call';
  name: string;
  args: ConstraintExprNode[];
  loc: SourceLocation;
}

// expr == expr, expr & expr
export interface BinaryExprNode {
  type: 'binary_expr';
  operator: '==' | '!=' | '&' | '|' | '^';
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
