import { describe, it, expect } from 'vitest';
import { parseConstraints, parseSearchPattern } from '../src/parser/constraint-parser';
import type {
  ProgramNode,
  McuDeclNode,
  ReserveDeclNode,
  SharedDeclNode,
  PinDeclNode,
  PortDeclNode,
  MacroDeclNode,
  ConfigDeclNode,
  MappingNode,
  RequireNode,
  MacroCallNode,
  SignalPatternNode,
} from '../src/parser/constraint-ast';

// Helper: parse and expect no errors
function parseOk(source: string): ProgramNode {
  const result = parseConstraints(source);
  expect(result.errors, result.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  expect(result.ast).not.toBeNull();
  return result.ast!;
}

// Helper: parse and expect errors
function parseErr(source: string): void {
  const result = parseConstraints(source);
  expect(result.errors.length).toBeGreaterThan(0);
}

describe('Constraint parser', () => {
  // ========== MCU declaration ==========

  describe('mcu declaration', () => {
    it('should parse single mcu pattern', () => {
      const ast = parseOk('mcu: STM32F405*');
      const mcu = ast.statements[0] as McuDeclNode;
      expect(mcu.type).toBe('mcu_decl');
      expect(mcu.patterns).toEqual(['STM32F405*']);
    });

    it('should parse multiple mcu patterns with pipe', () => {
      const ast = parseOk('mcu: STM32F405* | STM32G474*');
      const mcu = ast.statements[0] as McuDeclNode;
      expect(mcu.patterns).toEqual(['STM32F405*', 'STM32G474*']);
    });

    it('should parse mcu pattern with dashes', () => {
      const ast = parseOk('mcu: STM32G474R-B*');
      const mcu = ast.statements[0] as McuDeclNode;
      expect(mcu.patterns[0]).toBe('STM32G474R-B*');
    });
  });

  // ========== reserve declaration ==========

  describe('reserve declaration', () => {
    it('should parse single pin', () => {
      const ast = parseOk('reserve: PA0');
      const res = ast.statements[0] as ReserveDeclNode;
      expect(res.type).toBe('reserve_decl');
      expect(res.pins).toEqual(['PA0']);
    });

    it('should parse multiple pins', () => {
      const ast = parseOk('reserve: PH0, PH1, PA13, PA14');
      const res = ast.statements[0] as ReserveDeclNode;
      expect(res.pins).toEqual(['PH0', 'PH1', 'PA13', 'PA14']);
    });
  });

  // ========== shared declaration ==========

  describe('shared declaration', () => {
    it('should parse wildcard pattern', () => {
      const ast = parseOk('shared: ADC*');
      const shared = ast.statements[0] as SharedDeclNode;
      expect(shared.type).toBe('shared_decl');
      expect(shared.patterns).toHaveLength(1);
      expect(shared.patterns[0]).toEqual({ type: 'wildcard', prefix: 'ADC' });
    });

    it('should parse literal pattern', () => {
      const ast = parseOk('shared: ADC1');
      const shared = ast.statements[0] as SharedDeclNode;
      expect(shared.patterns[0]).toEqual({ type: 'literal', value: 'ADC1' });
    });

    it('should parse range pattern', () => {
      const ast = parseOk('shared: ADC[1,2]');
      const shared = ast.statements[0] as SharedDeclNode;
      expect(shared.patterns[0]).toEqual({ type: 'range', prefix: 'ADC', values: [1, 2] });
    });

    it('should parse multiple shared patterns', () => {
      const ast = parseOk('shared: ADC*, DAC*');
      const shared = ast.statements[0] as SharedDeclNode;
      expect(shared.patterns).toHaveLength(2);
    });
  });

  // ========== pin declaration ==========

  describe('pin declaration', () => {
    it('should parse pin assignment', () => {
      const ast = parseOk('pin PA4 = DAC1_OUT1');
      const pin = ast.statements[0] as PinDeclNode;
      expect(pin.type).toBe('pin_decl');
      expect(pin.pinName).toBe('PA4');
      expect(pin.signalName).toBe('DAC1_OUT1');
    });

    it('should parse pin with high number', () => {
      const ast = parseOk('pin PA13 = SYS_JTMS');
      const pin = ast.statements[0] as PinDeclNode;
      expect(pin.pinName).toBe('PA13');
    });
  });

  // ========== port declaration ==========

  describe('port declaration', () => {
    it('should parse port with channels and single config', () => {
      const src = `port CMD:
  channel TX
  channel RX

  config "USART":
    TX = USART*_TX
    RX = USART*_RX`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.type).toBe('port_decl');
      expect(port.name).toBe('CMD');
      expect(port.channels).toHaveLength(2);
      expect(port.configs).toHaveLength(1);
    });

    it('should parse port with color', () => {
      const src = `port LED:
  channel OUT
  color "red"

  config "GPIO":
    OUT = OUT`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.color).toBe('red');
    });

    it('should parse port with underscore name', () => {
      const src = `port FB_0:
  channel A

  config "X":
    A = USART*_TX`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.name).toBe('FB_0');
    });

    it('should parse multiple configs', () => {
      const src = `port P:
  channel A

  config "USART":
    A = USART*_TX

  config "SPI":
    A = SPI*_MOSI`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.configs).toHaveLength(2);
      expect(port.configs[0].name).toBe('USART');
      expect(port.configs[1].name).toBe('SPI');
    });
  });

  // ========== channel declaration ==========

  describe('channel declaration', () => {
    it('should parse channel with allowed pins', () => {
      const src = `port P:
  channel TX @ PA1, PA2, PB6

  config "X":
    TX = USART*_TX`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.channels[0].name).toBe('TX');
      expect(port.channels[0].allowedPins).toEqual(['PA1', 'PA2', 'PB6']);
    });

    it('should parse channel without allowed pins', () => {
      const src = `port P:
  channel TX

  config "X":
    TX = USART*_TX`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.channels[0].allowedPins).toBeUndefined();
    });
  });

  // ========== signal patterns ==========

  describe('signal patterns', () => {
    it('should parse literal instance and function', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART1_TX`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.instancePart).toEqual({ type: 'literal', value: 'USART1' });
      expect(pat.functionPart).toEqual({ type: 'literal', value: 'TX' });
    });

    it('should parse wildcard instance', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART*_TX`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.instancePart).toEqual({ type: 'wildcard', prefix: 'USART' });
    });

    it('should parse any (*) instance', () => {
      const src = `port P:
  channel A
  config "X":
    A = *_SWDIO`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.instancePart).toEqual({ type: 'any' });
    });

    it('should parse range instance', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART[1,2,3]_TX`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.instancePart).toEqual({ type: 'range', prefix: 'USART', values: [1, 2, 3] });
    });

    it('should parse range with dash', () => {
      const src = `port P:
  channel A
  config "X":
    A = TIM[1-5,8]_CH1`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.instancePart).toEqual({
        type: 'range', prefix: 'TIM', values: [1, 2, 3, 4, 5, 8],
      });
    });

    it('should parse range function part', () => {
      const src = `port P:
  channel A
  config "X":
    A = TIM*_CH[1-4]`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.functionPart).toEqual({ type: 'range', prefix: 'CH', values: [1, 2, 3, 4] });
    });

    it('should parse alternatives with pipe', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART*_TX | SPI*_MOSI`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      expect(mapping.signalExprs[0].alternatives).toHaveLength(2);
    });

    it('should parse IN/OUT shorthand', () => {
      const src = `port P:
  channel A
  config "X":
    A = OUT`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      const pat = mapping.signalExprs[0].alternatives[0];
      expect(pat.instancePart).toEqual({ type: 'wildcard', prefix: 'GPIO' });
      expect(pat.functionPart).toEqual({ type: 'any' });
    });

    it('should parse ampersand-joined signal expressions', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART*_TX & USART*_RX`;
      const ast = parseOk(src);
      const mapping = (ast.statements[0] as PortDeclNode).configs[0].body[0] as MappingNode;
      expect(mapping.signalExprs).toHaveLength(2);
    });
  });

  // ========== require expressions ==========

  describe('require expressions', () => {
    it('should parse same_instance function call', () => {
      const src = `port P:
  channel TX
  channel RX
  config "X":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[2] as RequireNode;
      expect(req.type).toBe('require');
      expect(req.expression.type).toBe('function_call');
      if (req.expression.type === 'function_call') {
        expect(req.expression.name).toBe('same_instance');
        expect(req.expression.args).toHaveLength(2);
      }
    });

    it('should parse function call with string arg', () => {
      const src = `port P:
  channel TX
  channel RX
  config "X":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX, "USART")`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[2] as RequireNode;
      if (req.expression.type === 'function_call') {
        expect(req.expression.args).toHaveLength(3);
        expect(req.expression.args[2].type).toBe('string_literal');
      }
    });

    it('should parse diff_instance', () => {
      const src = `port P:
  channel A
  channel B
  config "X":
    A = ADC1_IN[0-4]
    B = ADC2_IN[0-4]
    require diff_instance(A, B, "ADC")`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[2] as RequireNode;
      if (req.expression.type === 'function_call') {
        expect(req.expression.name).toBe('diff_instance');
      }
    });

    it('should parse equality comparison', () => {
      const src = `port P:
  channel A
  config "X":
    A = TIM*_CH[1,2]
    require instance(A, "TIM") == "TIM1"`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[1] as RequireNode;
      expect(req.expression.type).toBe('binary_expr');
    });

    it('should parse NOT expression', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART*_TX
    require !same_instance(A, A)`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[1] as RequireNode;
      expect(req.expression.type).toBe('unary_expr');
    });

    it('should parse AND expression', () => {
      const src = `port P:
  channel A
  channel B
  config "X":
    A = USART*_TX
    B = USART*_RX
    require same_instance(A, B) & instance(A, "USART") == USART1`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[2] as RequireNode;
      expect(req.expression.type).toBe('binary_expr');
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.operator).toBe('&');
      }
    });

    it('should parse dot access (cross-port reference)', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART*_TX
    require instance(A, "USART") == CMD.TX`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const req = config.body[1] as RequireNode;
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.right.type).toBe('dot_access');
      }
    });
  });

  // ========== macro declaration ==========

  describe('macro declaration', () => {
    it('should parse macro with params and body', () => {
      const src = `macro uart_port(TX, RX):
  TX = USART*_TX
  RX = USART*_RX
  require same_instance(TX, RX, "USART")`;
      const ast = parseOk(src);
      const macro = ast.statements[0] as MacroDeclNode;
      expect(macro.type).toBe('macro_decl');
      expect(macro.name).toBe('uart_port');
      expect(macro.params).toEqual(['TX', 'RX']);
      expect(macro.body).toHaveLength(3);
    });

    it('should parse macro with no params', () => {
      const src = `macro my_macro():
  require same_instance(A, B)`;
      const ast = parseOk(src);
      const macro = ast.statements[0] as MacroDeclNode;
      expect(macro.params).toHaveLength(0);
    });
  });

  // ========== macro call ==========

  describe('macro call', () => {
    it('should parse macro call inside config', () => {
      const src = `port P:
  channel TX
  channel RX
  config "USART":
    uart_port(TX, RX)`;
      const ast = parseOk(src);
      const config = (ast.statements[0] as PortDeclNode).configs[0];
      const call = config.body[0] as MacroCallNode;
      expect(call.type).toBe('macro_call');
      expect(call.name).toBe('uart_port');
      expect(call.args).toEqual(['TX', 'RX']);
    });
  });

  // ========== comments and blank lines ==========

  describe('comments and blank lines', () => {
    it('should skip comments', () => {
      const src = `# This is a comment
shared: ADC*
# Another comment`;
      const ast = parseOk(src);
      expect(ast.statements).toHaveLength(1);
    });

    it('should skip blank lines', () => {
      const src = `shared: ADC*

reserve: PA0`;
      const ast = parseOk(src);
      expect(ast.statements).toHaveLength(2);
    });

    it('should handle inline comments', () => {
      const src = `port P:
  channel TX  # the transmit channel

  config "X":
    TX = USART*_TX  # match any USART`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.channels[0].name).toBe('TX');
    });
  });

  // ========== multiple statements ==========

  describe('multiple statements', () => {
    it('should parse a complete program', () => {
      const src = `shared: ADC*

reserve: PH0, PH1

port clock:
  channel IN
  channel OUT
  config "XTAL":
    IN = RCC_OSCIN
    OUT = RCC_OSCOUT

port CMD:
  channel TX
  channel RX
  config "USART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)`;
      const ast = parseOk(src);
      expect(ast.statements).toHaveLength(4);
      expect(ast.statements[0].type).toBe('shared_decl');
      expect(ast.statements[1].type).toBe('reserve_decl');
      expect(ast.statements[2].type).toBe('port_decl');
      expect(ast.statements[3].type).toBe('port_decl');
    });
  });

  // ========== error cases ==========

  describe('error cases', () => {
    it('should report error for missing colon after mcu', () => {
      parseErr('mcu STM32F405*');
    });

    it('should report error for unexpected keyword at top level', () => {
      parseErr('config "X":');
    });

    it('should report error for inconsistent indentation', () => {
      const src = `port P:
  channel TX
 config "X":
    TX = USART*_TX`;
      parseErr(src);
    });

    it('should report error for unterminated string', () => {
      parseErr('port P:\n  config "unterminated:\n    A = USART*_TX');
    });

    it('should recover from errors and continue parsing', () => {
      const src = `shared: ADC*
invalid_token @@@
reserve: PA0`;
      const result = parseConstraints(src);
      expect(result.errors.length).toBeGreaterThan(0);
      // Should still parse the valid statements
      expect(result.ast).not.toBeNull();
    });
  });

  // ========== parseSearchPattern ==========

  describe('parseSearchPattern', () => {
    it('should parse a simple signal pattern', () => {
      const pat = parseSearchPattern('TIM*_CH1');
      expect(pat).not.toBeNull();
      expect(pat!.instancePart).toEqual({ type: 'wildcard', prefix: 'TIM' });
      expect(pat!.functionPart).toEqual({ type: 'literal', value: 'CH1' });
    });

    it('should parse wildcard pattern', () => {
      const pat = parseSearchPattern('ADC*_IN[1-4]');
      expect(pat).not.toBeNull();
      expect(pat!.instancePart).toEqual({ type: 'wildcard', prefix: 'ADC' });
      expect(pat!.functionPart).toEqual({ type: 'range', prefix: 'IN', values: [1, 2, 3, 4] });
    });

    it('should return null for empty input', () => {
      expect(parseSearchPattern('')).toBeNull();
      expect(parseSearchPattern('  ')).toBeNull();
    });
  });
});
