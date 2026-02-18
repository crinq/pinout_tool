import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import { expandAllMacros, extractMacros } from '../src/parser/macro-expander';
import { getStdlibMacros } from '../src/parser/stdlib-macros';
import type {
  ProgramNode,
  PortDeclNode,
  MappingNode,
  RequireNode,
  MacroDeclNode,
} from '../src/parser/constraint-ast';

function parseOk(source: string): ProgramNode {
  const result = parseConstraints(source);
  expect(result.errors, result.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  expect(result.ast).not.toBeNull();
  return result.ast!;
}

describe('Macro expander', () => {
  // ========== extractMacros ==========

  describe('extractMacros', () => {
    it('should extract macro declarations from AST', () => {
      const ast = parseOk(`macro my_uart(TX, RX):
  TX = USART*_TX
  RX = USART*_RX
  require same_instance(TX, RX)`);
      const macros = extractMacros(ast);
      expect(macros.size).toBe(1);
      expect(macros.has('my_uart')).toBe(true);
      expect(macros.get('my_uart')!.params).toEqual(['TX', 'RX']);
    });

    it('should extract multiple macros', () => {
      const ast = parseOk(`macro a(X):
  X = USART*_TX

macro b(Y):
  Y = SPI*_MOSI`);
      const macros = extractMacros(ast);
      expect(macros.size).toBe(2);
    });
  });

  // ========== basic expansion ==========

  describe('basic expansion', () => {
    it('should expand a simple macro call', () => {
      const ast = parseOk(`macro my_uart(TX, RX):
  TX = USART*_TX
  RX = USART*_RX
  require same_instance(TX, RX)

port CMD:
  channel A
  channel B
  config "USART":
    my_uart(A, B)`);

      const { ast: expanded, errors } = expandAllMacros(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const config = port.configs[0];
      expect(config.body).toHaveLength(3); // 2 mappings + 1 require

      const mapping0 = config.body[0] as MappingNode;
      expect(mapping0.channelName).toBe('A'); // TX → A
      const mapping1 = config.body[1] as MappingNode;
      expect(mapping1.channelName).toBe('B'); // RX → B
      const req = config.body[2] as RequireNode;
      expect(req.expression.type).toBe('function_call');
    });
  });

  // ========== parameter substitution ==========

  describe('parameter substitution', () => {
    it('should substitute in mapping channel names', () => {
      const ast = parseOk(`macro test_macro(OUT):
  OUT = DAC*_OUT[1-2]

port P:
  channel DAC_OUT
  config "X":
    test_macro(DAC_OUT)`);

      const { ast: expanded, errors } = expandAllMacros(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const mapping = port.configs[0].body[0] as MappingNode;
      expect(mapping.channelName).toBe('DAC_OUT');
    });

    it('should substitute in require expressions', () => {
      const ast = parseOk(`macro check(A, B):
  require same_instance(A, B)

port P:
  channel TX
  channel RX
  config "X":
    TX = USART*_TX
    RX = USART*_RX
    check(TX, RX)`);

      const { ast: expanded, errors } = expandAllMacros(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const req = port.configs[0].body[2] as RequireNode;
      expect(req.expression.type).toBe('function_call');
      if (req.expression.type === 'function_call') {
        // Check args were substituted
        expect(req.expression.args[0].type).toBe('ident');
        if (req.expression.args[0].type === 'ident') {
          expect(req.expression.args[0].name).toBe('TX');
        }
      }
    });
  });

  // ========== error handling ==========

  describe('error handling', () => {
    it('should report unknown macro', () => {
      const ast = parseOk(`port P:
  channel A
  config "X":
    unknown_macro(A)`);

      const { errors } = expandAllMacros(ast);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Unknown macro');
    });

    it('should report wrong argument count', () => {
      const ast = parseOk(`macro my_uart(TX, RX):
  TX = USART*_TX
  RX = USART*_RX

port P:
  channel A
  config "X":
    my_uart(A)`);

      const { errors } = expandAllMacros(ast);
      expect(errors.some(e => e.message.includes('expects 2 arguments'))).toBe(true);
    });

    it('should detect recursive macros', () => {
      const ast = parseOk(`macro loop(X):
  loop(X)

port P:
  channel A
  config "X":
    loop(A)`);

      const { errors } = expandAllMacros(ast);
      expect(errors.some(e => e.message.includes('Recursive'))).toBe(true);
    });
  });

  // ========== stdlib macros ==========

  describe('stdlib macros', () => {
    it('should parse all stdlib macros', () => {
      const macros = getStdlibMacros();
      expect(macros.size).toBeGreaterThan(0);

      // Check known macros exist
      expect(macros.has('uart_port')).toBe(true);
      expect(macros.has('spi_port')).toBe(true);
      expect(macros.has('i2c_port')).toBe(true);
      expect(macros.has('encoder')).toBe(true);
      expect(macros.has('pwm')).toBe(true);
      expect(macros.has('dac')).toBe(true);
      expect(macros.has('adc')).toBe(true);
      expect(macros.has('can_port')).toBe(true);
    });

    it('should expand stdlib macro uart_port', () => {
      const ast = parseOk(`port P:
  channel TX
  channel RX
  config "USART":
    uart_port(TX, RX)`);

      const { ast: expanded, errors } = expandAllMacros(ast, getStdlibMacros());
      expect(errors).toHaveLength(0);

      const port = expanded.statements[0] as PortDeclNode;
      const config = port.configs[0];
      expect(config.body).toHaveLength(3); // TX mapping, RX mapping, require

      const txMapping = config.body[0] as MappingNode;
      expect(txMapping.channelName).toBe('TX');

      const rxMapping = config.body[1] as MappingNode;
      expect(rxMapping.channelName).toBe('RX');
    });

    it('should expand stdlib macro spi_port', () => {
      const ast = parseOk(`port P:
  channel MOSI
  channel MISO
  channel SCK
  config "SPI":
    spi_port(MOSI, MISO, SCK)`);

      const { ast: expanded, errors } = expandAllMacros(ast, getStdlibMacros());
      expect(errors).toHaveLength(0);

      const port = expanded.statements[0] as PortDeclNode;
      const config = port.configs[0];
      // 3 mappings + 2 require (same_instance(MOSI,MISO) + same_instance(MOSI,SCK))
      expect(config.body).toHaveLength(5);
    });

    it('should expand stdlib macro encoder', () => {
      const ast = parseOk(`port P:
  channel A
  channel B
  config "ENC":
    encoder(A, B)`);

      const { ast: expanded, errors } = expandAllMacros(ast, getStdlibMacros());
      expect(errors).toHaveLength(0);

      const port = expanded.statements[0] as PortDeclNode;
      const config = port.configs[0];
      // 2 mappings + 2 requires (same_instance + instance check)
      expect(config.body).toHaveLength(4);
    });
  });

  // ========== extra macros don't override local ==========

  describe('macro precedence', () => {
    it('should prefer local macros over stdlib', () => {
      const ast = parseOk(`macro uart_port(TX, RX):
  TX = USART1_TX
  RX = USART1_RX

port P:
  channel TX
  channel RX
  config "X":
    uart_port(TX, RX)`);

      const { ast: expanded, errors } = expandAllMacros(ast, getStdlibMacros());
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const txMapping = port.configs[0].body[0] as MappingNode;
      // Should use the local macro (USART1_TX literal), not stdlib (USART*_TX)
      const pattern = txMapping.signalExprs[0].alternatives[0];
      expect(pattern.instancePart.type).toBe('literal');
    });
  });
});
