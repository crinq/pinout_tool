import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import { resolveTemplates } from '../src/parser/template-resolver';
import { collectMacros, getMacroLibrary } from '../src/parser/preprocessor';
import type {
  ProgramNode,
  PortDeclNode,
  MappingNode,
  RequireNode,
} from '../src/parser/constraint-ast';

function parseOk(source: string): ProgramNode {
  const result = parseConstraints(source);
  expect(result.errors, result.errors.map(e => `L${e.line}: ${e.message}`).join('\n')).toHaveLength(0);
  expect(result.ast).not.toBeNull();
  return result.ast!;
}

// Macro expansion itself lives in test/preprocessor.test.ts. What is covered
// here is the AST-level half: that library macros survive the round trip with
// the right shape, plus `$var` desugaring and port templates.
describe('Template resolver', () => {
  describe('stdlib macros', () => {
    it('should define all stdlib macros', () => {
      const keys = new Set(collectMacros(getMacroLibrary()).map(m => `${m.name}/${m.params.length}`));
      expect(keys.size).toBeGreaterThan(0);
      for (const key of ['uart_port/2', 'spi_port/3', 'i2c_port/2', 'encoder/2',
                         'pwm/1', 'dac/1', 'adc/1', 'can_port/2']) {
        expect(keys.has(key), key).toBe(true);
      }
    });

    it('should expand stdlib macro uart_port', () => {
      const ast = parseOk(`port P:
  channel TX
  channel RX
  config "USART":
    uart_port(TX, RX)`);

      const { ast: expanded, errors } = resolveTemplates(ast);
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

      const { ast: expanded, errors } = resolveTemplates(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements[0] as PortDeclNode;
      const config = port.configs[0];
      // 3 mappings + 1 require (same_instance(MOSI,MISO,SCK,"SPI"))
      expect(config.body).toHaveLength(4);
    });

    it('should expand stdlib macro encoder', () => {
      const ast = parseOk(`port P:
  channel A
  channel B
  config "ENC":
    encoder(A, B)`);

      const { ast: expanded, errors } = resolveTemplates(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements[0] as PortDeclNode;
      const config = port.configs[0];
      // 2 mappings + 1 require: both map with `$t`, which desugars to a
      // single same_instance(A, B). See macro-library.txt.
      expect(config.body).toHaveLength(3);
    });
  });

  describe('variable binding desugaring', () => {
    it('should desugar instance wildcard $var to same_instance', () => {
      const ast = parseOk(`
port CMD:
  channel TX
  channel RX
  config "UART":
    TX = USART*_TX $u
    RX = USART*_RX $u
`);
      const { ast: expanded, errors } = resolveTemplates(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const requires = port.configs[0].body.filter(b => b.type === 'require') as RequireNode[];
      expect(requires.length).toBeGreaterThanOrEqual(1);
      // Should have same_instance(TX, RX) or same_instance(RX, TX)
      const sameInst = requires.find(r =>
        r.expression.type === 'function_call' && r.expression.name === 'same_instance'
      );
      expect(sameInst).toBeDefined();
    });

    it('should desugar function wildcard $var to channel_signal equality', () => {
      const ast = parseOk(`
port ENC:
  channel A
  channel B
  config "quadrature":
    A = TIM1_CH* $ch
    B = TIM1_CH* $ch
`);
      const { ast: expanded, errors } = resolveTemplates(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const requires = port.configs[0].body.filter(b => b.type === 'require') as RequireNode[];
      expect(requires.length).toBeGreaterThanOrEqual(1);
      // Should have channel_signal(A) == channel_signal(B), NOT same_instance
      const sameInst = requires.find(r =>
        r.expression.type === 'function_call' && r.expression.name === 'same_instance'
      );
      expect(sameInst).toBeUndefined();
      const chNumEq = requires.find(r =>
        r.expression.type === 'binary_expr' && r.expression.operator === '=='
      );
      expect(chNumEq).toBeDefined();
    });

    it('should desugar mixed wildcards: $t for instance, $ch for function', () => {
      const ast = parseOk(`
port ENC:
  channel A
  channel B
  config "quadrature":
    A = TIM*_CH* $t $ch
    B = TIM*_CH* $t $ch
`);
      const { ast: expanded, errors } = resolveTemplates(ast);
      expect(errors).toHaveLength(0);

      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      const requires = port.configs[0].body.filter(b => b.type === 'require') as RequireNode[];
      // Should have both same_instance (for $t) and channel_number == (for $ch)
      const sameInst = requires.find(r =>
        r.expression.type === 'function_call' && r.expression.name === 'same_instance'
      );
      const chNumEq = requires.find(r =>
        r.expression.type === 'binary_expr' && r.expression.operator === '=='
      );
      expect(sameInst).toBeDefined();
      expect(chNumEq).toBeDefined();
    });

    it('should error when more $vars than wildcards', () => {
      const ast = parseOk(`
port CMD:
  channel TX
  config "UART":
    TX = USART1_TX $u $extra
`);
      const { errors } = resolveTemplates(ast);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toContain('wildcard');
    });

    it('should strip $var bindings from expanded AST', () => {
      const ast = parseOk(`
port CMD:
  channel TX
  channel RX
  config "UART":
    TX = USART*_TX $u
    RX = USART*_RX $u
`);
      const { ast: expanded } = resolveTemplates(ast);
      const port = expanded.statements.find(s => s.type === 'port_decl') as PortDeclNode;
      for (const item of port.configs[0].body) {
        if (item.type === 'mapping') {
          expect((item as MappingNode).instanceBindings).toBeUndefined();
        }
      }
    });
  });

  describe('port-template placement anchors', () => {
    it('a derived port inherits the template channels and overrides its anchor', () => {
      const ast = parseOk(`
port enc0: @ ~NE
  channel MOSI
  config "spi":
    MOSI = SPI*_MOSI

port enc1 from enc0: @ ~NW
`);
      const { ast: expanded } = resolveTemplates(ast);
      const enc1 = expanded.statements.find(
        s => s.type === 'port_decl' && (s as PortDeclNode).name === 'enc1'
      ) as PortDeclNode;
      expect(enc1.channels.map(c => c.name)).toEqual(['MOSI']); // inherited
      expect(enc1.anchor).toEqual({ kind: 'near_region', target: 'NW' }); // overridden
    });

    it('a derived port with no anchor inherits the template anchor', () => {
      const ast = parseOk(`
port enc0: @ ~NE
  channel MOSI
  config "spi":
    MOSI = SPI*_MOSI

port enc2 from enc0:
  channel SCK
`);
      const { ast: expanded } = resolveTemplates(ast);
      const enc2 = expanded.statements.find(
        s => s.type === 'port_decl' && (s as PortDeclNode).name === 'enc2'
      ) as PortDeclNode;
      expect(enc2.anchor).toEqual({ kind: 'near_region', target: 'NE' });
    });
  });
});
