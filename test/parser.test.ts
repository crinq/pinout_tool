import { describe, it, expect } from 'vitest';
import { parseConstraints, parseSearchPattern, parseExpressionString } from '../src/parser/constraint-parser';
import { expandAllMacros } from '../src/parser/macro-expander';
import type {
  ProgramNode,
  McuDeclNode,
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

  // ========== ram/rom/freq declarations ==========

  describe('ram/rom/freq declarations', () => {
    it('should parse ram with min only', () => {
      const ast = parseOk('ram: 256K');
      const ram = ast.statements[0] as RamDeclNode;
      expect(ram.type).toBe('ram_decl');
      expect(ram.minBytes).toBe(256 * 1024);
      expect(ram.maxBytes).toBeUndefined();
    });

    it('should parse ram with max only', () => {
      const ast = parseOk('ram: < 1M');
      const ram = ast.statements[0] as RamDeclNode;
      expect(ram.minBytes).toBe(0);
      expect(ram.maxBytes).toBe(1024 * 1024);
    });

    it('should parse ram with min and max', () => {
      const ast = parseOk('ram: 128K < 512K');
      const ram = ast.statements[0] as RamDeclNode;
      expect(ram.minBytes).toBe(128 * 1024);
      expect(ram.maxBytes).toBe(512 * 1024);
    });

    it('should parse rom with range', () => {
      const ast = parseOk('rom: 256K < 2M');
      const rom = ast.statements[0] as RomDeclNode;
      expect(rom.minBytes).toBe(256 * 1024);
      expect(rom.maxBytes).toBe(2 * 1024 * 1024);
    });

    it('should parse freq with min only', () => {
      const ast = parseOk('freq: 480');
      const freq = ast.statements[0] as FreqDeclNode;
      expect(freq.minMHz).toBe(480);
      expect(freq.maxMHz).toBeUndefined();
    });

    it('should parse freq with max only', () => {
      const ast = parseOk('freq: < 200');
      const freq = ast.statements[0] as FreqDeclNode;
      expect(freq.minMHz).toBe(0);
      expect(freq.maxMHz).toBe(200);
    });

    it('should parse freq with min and max', () => {
      const ast = parseOk('freq: 100 < 480');
      const freq = ast.statements[0] as FreqDeclNode;
      expect(freq.minMHz).toBe(100);
      expect(freq.maxMHz).toBe(480);
    });
  });

  // ========== temp/voltage declarations ==========

  describe('temp/voltage declarations', () => {
    it('should parse temp with single value', () => {
      const ast = parseOk('temp: 85');
      const temp = ast.statements[0] as TempDeclNode;
      expect(temp.type).toBe('temp_decl');
      expect(temp.minTemp).toBe(85);
      expect(temp.maxTemp).toBeUndefined();
    });

    it('should parse temp with negative value', () => {
      const ast = parseOk('temp: -40');
      const temp = ast.statements[0] as TempDeclNode;
      expect(temp.minTemp).toBe(-40);
    });

    it('should parse temp with range', () => {
      const ast = parseOk('temp: -40 < 125');
      const temp = ast.statements[0] as TempDeclNode;
      expect(temp.minTemp).toBe(-40);
      expect(temp.maxTemp).toBe(125);
    });

    it('should parse temp with max only', () => {
      const ast = parseOk('temp: < 85');
      const temp = ast.statements[0] as TempDeclNode;
      expect(temp.minTemp).toBeUndefined();
      expect(temp.maxTemp).toBe(85);
    });

    it('should parse voltage with single value', () => {
      const ast = parseOk('voltage: 3.3');
      const v = ast.statements[0] as VoltageDeclNode;
      expect(v.type).toBe('voltage_decl');
      expect(v.minVoltage).toBe(3.3);
      expect(v.maxVoltage).toBeUndefined();
    });

    it('should parse voltage with range', () => {
      const ast = parseOk('voltage: 1.8 < 3.6');
      const v = ast.statements[0] as VoltageDeclNode;
      expect(v.minVoltage).toBe(1.8);
      expect(v.maxVoltage).toBe(3.6);
    });

    it('should parse voltage with < max', () => {
      const ast = parseOk('voltage: < 3.6');
      const v = ast.statements[0] as VoltageDeclNode;
      expect(v.minVoltage).toBeUndefined();
      expect(v.maxVoltage).toBe(3.6);
    });

    it('should parse voltage with V suffix', () => {
      const ast = parseOk('voltage: 3.3V');
      const v = ast.statements[0] as VoltageDeclNode;
      expect(v.minVoltage).toBe(3.3);
      expect(v.maxVoltage).toBeUndefined();
    });

    it('should parse voltage range with V suffix', () => {
      const ast = parseOk('voltage: 1.8V < 3.6V');
      const v = ast.statements[0] as VoltageDeclNode;
      expect(v.minVoltage).toBe(1.8);
      expect(v.maxVoltage).toBe(3.6);
    });
  });

  // ========== core declaration ==========

  describe('core declaration', () => {
    it('should parse single core', () => {
      const ast = parseOk('core: M4');
      const core = ast.statements[0] as CoreDeclNode;
      expect(core.type).toBe('core_decl');
      expect(core.required).toEqual([['M4']]);
    });

    it('should parse core with alternatives (OR)', () => {
      const ast = parseOk('core: M4 | M7');
      const core = ast.statements[0] as CoreDeclNode;
      expect(core.required).toEqual([['M4', 'M7']]);
    });

    it('should parse dual-core requirement (AND)', () => {
      const ast = parseOk('core: M4 + M7');
      const core = ast.statements[0] as CoreDeclNode;
      expect(core.required).toEqual([['M4'], ['M7']]);
    });

    it('should parse core with number suffix', () => {
      const ast = parseOk('core: M33');
      const core = ast.statements[0] as CoreDeclNode;
      expect(core.required).toEqual([['M33']]);
    });
  });

  // ========== reserve declaration ==========

  describe('reserve declaration', () => {
    it('should parse single pin', () => {
      const ast = parseOk('reserve: PA0');
      const res = ast.statements[0] as ReserveDeclNode;
      expect(res.type).toBe('reserve_decl');
      expect(res.patterns).toEqual([{ type: 'literal', value: 'PA0' }]);
    });

    it('should parse multiple pins', () => {
      const ast = parseOk('reserve: PH0, PH1, PA13, PA14');
      const res = ast.statements[0] as ReserveDeclNode;
      expect(res.patterns).toEqual([
        { type: 'literal', value: 'PH0' },
        { type: 'literal', value: 'PH1' },
        { type: 'literal', value: 'PA13' },
        { type: 'literal', value: 'PA14' },
      ]);
    });

    it('should parse peripheral patterns', () => {
      const ast = parseOk('reserve: PA1, ADC*, LPUART1, SPI[1,3], PB2');
      const res = ast.statements[0] as ReserveDeclNode;
      expect(res.patterns).toEqual([
        { type: 'literal', value: 'PA1' },
        { type: 'wildcard', prefix: 'ADC' },
        { type: 'literal', value: 'LPUART1' },
        { type: 'range', prefix: 'SPI', values: [1, 3] },
        { type: 'literal', value: 'PB2' },
      ]);
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

    it('should parse inline mapping on channel line', () => {
      const src = `port debug:
  channel SWDIO = *_SWDIO $dbg
  channel SWCLK = *_SWCLK $dbg`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.channels).toHaveLength(2);
      expect(port.configs).toHaveLength(1);
      expect(port.configs[0].name).toBe('debug');
      expect(port.configs[0].body).toHaveLength(2);
      const m = port.configs[0].body[0] as MappingNode;
      expect(m.type).toBe('mapping');
      expect(m.channelName).toBe('SWDIO');
      expect(m.instanceBindings).toEqual(['dbg']);
    });

    it('should parse inline mapping with require', () => {
      const src = `port COMM:
  channel TX = USART*_TX
  channel RX = USART*_RX
  require same_instance(TX, RX)`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.configs).toHaveLength(1);
      expect(port.configs[0].name).toBe('COMM');
      expect(port.configs[0].body).toHaveLength(3);
      expect((port.configs[0].body[2] as RequireNode).type).toBe('require');
    });

    it('should parse inline mapping with macro call', () => {
      const src = `macro uart_base(tx, rx):
  tx = USART*_TX
  rx = USART*_RX
  require same_instance(tx, rx)

port COMM:
  channel TX
  channel RX
  uart_base(TX, RX)`;
      const ast = parseOk(src);
      const port = ast.statements[1] as PortDeclNode;
      expect(port.configs).toHaveLength(1);
      expect(port.configs[0].name).toBe('COMM');
      expect((port.configs[0].body[0] as MacroCallNode).type).toBe('macro_call');
    });

    it('should parse inline mapping with color', () => {
      const src = `port debug:
  color "green"
  channel SWDIO = *_SWDIO
  channel SWCLK = *_SWCLK`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.color).toBe('green');
      expect(port.channels).toHaveLength(2);
      expect(port.configs).toHaveLength(1);
      expect(port.configs[0].body).toHaveLength(2);
    });

    it('should parse optional inline mapping with ?=', () => {
      const src = `port SENS:
  channel TEMP ?= ADC*_IN[0-7]`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      const m = port.configs[0].body[0] as MappingNode;
      expect(m.optional).toBe(true);
      expect(m.channelName).toBe('TEMP');
    });

    it('should parse inline mapping with pin restriction', () => {
      const src = `port CMD:
  channel TX @ PA9, PA2 = USART*_TX`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.channels[0].allowedPins).toEqual(['PA9', 'PA2']);
      expect(port.configs).toHaveLength(1);
      expect((port.configs[0].body[0] as MappingNode).channelName).toBe('TX');
    });

    it('should parse standalone mappings in port body (separate lines)', () => {
      const src = `port COMM:
  channel TX
  channel RX
  TX = USART*_TX
  RX = USART*_RX`;
      const ast = parseOk(src);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.channels).toHaveLength(2);
      expect(port.configs).toHaveLength(1);
      expect(port.configs[0].body).toHaveLength(2);
    });

    it('should error when mixing explicit config and inline mappings', () => {
      const src = `port P:
  channel A = USART*_TX
  config "SPI":
    A = SPI*_MOSI`;
      parseErr(src);
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

    it('should parse plus-joined signal expressions (multi-pin)', () => {
      const src = `port P:
  channel A
  config "X":
    A = USART*_TX + USART*_RX`;
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

  // ========== Port Templates ==========

  describe('port templates', () => {
    it('should parse port with from template', () => {
      const ast = parseOk(`port ENC0 from encoder_port:
  config "default":
    A = TIM1_CH1`);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.name).toBe('ENC0');
      expect(port.template).toBe('encoder_port');
    });

    it('should parse port from template with color', () => {
      const ast = parseOk(`port ENC0 from encoder_port color "blue":
  channel A
  config "default":
    A = TIM1_CH1`);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.template).toBe('encoder_port');
      expect(port.color).toBe('blue');
    });

    it('should parse body-less port from template', () => {
      const ast = parseOk(`port ENC0 from encoder_port`);
      const port = ast.statements[0] as PortDeclNode;
      expect(port.name).toBe('ENC0');
      expect(port.template).toBe('encoder_port');
      expect(port.channels).toHaveLength(0);
      expect(port.configs).toHaveLength(0);
    });
  });

  // ========== Macro Overloading ==========

  describe('macro overloading', () => {
    it('should parse macros with same name but different arity', () => {
      const ast = parseOk(`macro spi_port(MOSI, MISO, SCK):
  MOSI = SPI*_MOSI
  MISO = SPI*_MISO
  SCK = SPI*_SCK

macro spi_port(MOSI, MISO, SCK, NSS):
  spi_port(MOSI, MISO, SCK)
  NSS = SPI*_NSS`);
      const macros = ast.statements.filter(s => s.type === 'macro_decl') as MacroDeclNode[];
      expect(macros).toHaveLength(2);
      expect(macros[0].params).toHaveLength(3);
      expect(macros[1].params).toHaveLength(4);
    });
  });

  // ========== Macro Expansion ==========

  describe('macro expansion', () => {
    it('should expand macros with overloading by arity', () => {
      // expandAllMacros imported at top
      const ast = parseOk(`macro test(A):
  A = USART*_TX

macro test(A, B):
  A = USART*_TX
  B = USART*_RX

port P:
  channel X
  channel Y
  config "1arg":
    test(X)
  config "2arg":
    test(X, Y)`);
      const result = expandAllMacros(ast);
      expect(result.errors).toHaveLength(0);
      const port = result.ast.statements.find((s: any) => s.type === 'port_decl') as PortDeclNode;
      const cfg1 = port.configs.find(c => c.name === '1arg')!;
      const cfg2 = port.configs.find(c => c.name === '2arg')!;
      // 1-arg version: 1 mapping
      expect(cfg1.body.filter((b: any) => b.type === 'mapping')).toHaveLength(1);
      // 2-arg version: 2 mappings
      expect(cfg2.body.filter((b: any) => b.type === 'mapping')).toHaveLength(2);
    });

    it('should apply port template and merge channels/configs', () => {
      // expandAllMacros imported at top
      // Template port (has no "from")
      const ast = parseOk(`port encoder_port:
  channel A
  channel B
  config "quadrature":
    A = TIM*_CH1
    B = TIM*_CH2

port ENC0 from encoder_port:
  channel Z
  config "with_index":
    Z = TIM*_CH3`);
      const result = expandAllMacros(ast);
      expect(result.errors).toHaveLength(0);
      const enc0 = result.ast.statements.find(
        (s: any) => s.type === 'port_decl' && s.name === 'ENC0'
      ) as PortDeclNode;
      // Merged channels: A, B from template + Z from port
      expect(enc0.channels.map(c => c.name)).toEqual(['A', 'B', 'Z']);
      // Merged configs: "quadrature" from template + "with_index" from port
      expect(enc0.configs.map(c => c.name)).toEqual(['quadrature', 'with_index']);
      expect(enc0.template).toBeUndefined();
    });

    it('should report error for arity mismatch', () => {
      // expandAllMacros imported at top
      const ast = parseOk(`macro foo(A, B):
  A = USART*_TX
  B = USART*_RX

port P:
  channel X
  config "default":
    foo(X)`);
      const result = expandAllMacros(ast);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain('1 arguments not found');
    });
  });

  // ========== Instance Binding @var ==========

  describe('instance binding $var', () => {
    it('should parse $var after signal pattern', () => {
      const ast = parseOk(`port P:
  channel TX
  channel RX
  config "UART":
    TX = USART*_TX $u
    RX = USART*_RX $u`);
      const port = ast.statements[0] as PortDeclNode;
      const cfg = port.configs[0];
      const m0 = cfg.body[0] as MappingNode;
      const m1 = cfg.body[1] as MappingNode;
      expect(m0.instanceBindings).toEqual(['u']);
      expect(m1.instanceBindings).toEqual(['u']);
    });

    it('should desugar $var to same_instance require', () => {
      const ast = parseOk(`port P:
  channel TX
  channel RX
  channel CTS
  config "UART":
    TX = USART*_TX $u
    RX = USART*_RX $u
    CTS = USART*_CTS $u`);
      const result = expandAllMacros(ast);
      expect(result.errors).toHaveLength(0);
      const port = result.ast.statements[0] as PortDeclNode;
      const cfg = port.configs[0];
      // Should have 3 mappings + 1 require(same_instance)
      const requires = cfg.body.filter((b: any) => b.type === 'require');
      expect(requires.length).toBe(1);
      const req = requires[0] as RequireNode;
      expect(req.expression.type).toBe('function_call');
      if (req.expression.type === 'function_call') {
        expect(req.expression.name).toBe('same_instance');
        expect(req.expression.args).toHaveLength(3);
      }
    });

    it('should not generate require for single $var binding', () => {
      const ast = parseOk(`port P:
  channel TX
  config "UART":
    TX = USART*_TX $u`);
      const result = expandAllMacros(ast);
      const port = result.ast.statements[0] as PortDeclNode;
      const cfg = port.configs[0];
      const requires = cfg.body.filter((b: any) => b.type === 'require');
      expect(requires).toHaveLength(0);
    });
  });

  // ========== Optional Mappings & Requires ==========

  describe('optional mappings and requires', () => {
    it('should parse ?= as optional mapping', () => {
      const ast = parseOk(`port P:
  channel TX
  channel CTS
  config "UART":
    TX = USART*_TX
    CTS ?= USART*_CTS`);
      const port = ast.statements[0] as PortDeclNode;
      const cfg = port.configs[0];
      const m0 = cfg.body[0] as MappingNode;
      const m1 = cfg.body[1] as MappingNode;
      expect(m0.optional).toBeUndefined();
      expect(m1.optional).toBe(true);
      expect(m1.channelName).toBe('CTS');
    });

    it('should parse require? as optional require', () => {
      const ast = parseOk(`port P:
  channel TX
  channel CTS
  config "UART":
    TX = USART*_TX
    CTS ?= USART*_CTS
    require? same_instance(TX, CTS)`);
      const port = ast.statements[0] as PortDeclNode;
      const cfg = port.configs[0];
      const reqs = cfg.body.filter((b: any) => b.type === 'require');
      expect(reqs).toHaveLength(1);
      expect((reqs[0] as RequireNode).optional).toBe(true);
    });
  });

  // ========== Numeric Expressions ==========

  describe('numeric expressions in require', () => {
    it('should parse comparison operators < > <= >=', () => {
      const ast = parseOk(`port P:
  channel A
  channel B
  config "default":
    A = ADC*_IN[0-15]
    B = ADC*_IN[0-15]
    require channel_number(A) < channel_number(B)`);
      const port = ast.statements[0] as PortDeclNode;
      const req = port.configs[0].body[2] as RequireNode;
      expect(req.expression.type).toBe('binary_expr');
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.operator).toBe('<');
      }
    });

    it('should parse <= operator', () => {
      const ast = parseOk(`port P:
  channel A
  config "default":
    A = TIM*_CH1
    require instance_number(A) <= 5`);
      const port = ast.statements[0] as PortDeclNode;
      const req = port.configs[0].body[1] as RequireNode;
      expect(req.expression.type).toBe('binary_expr');
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.operator).toBe('<=');
        expect(req.expression.right.type).toBe('number_literal');
      }
    });

    it('should parse arithmetic expressions', () => {
      const ast = parseOk(`port P:
  channel A
  channel B
  config "default":
    A = ADC*_IN[0-15]
    B = ADC*_IN[0-15]
    require pin_number(A) - pin_number(B) < 5`);
      const port = ast.statements[0] as PortDeclNode;
      const req = port.configs[0].body[2] as RequireNode;
      // Should be (pin_number(A) - pin_number(B)) < 5
      expect(req.expression.type).toBe('binary_expr');
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.operator).toBe('<');
        expect(req.expression.left.type).toBe('binary_expr');
        if (req.expression.left.type === 'binary_expr') {
          expect(req.expression.left.operator).toBe('-');
        }
      }
    });

    it('should parse number literals in expressions', () => {
      const ast = parseOk(`port P:
  channel A
  config "default":
    A = TIM*_CH1
    require channel_number(A) != 3`);
      const port = ast.statements[0] as PortDeclNode;
      const req = port.configs[0].body[1] as RequireNode;
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.operator).toBe('!=');
        expect(req.expression.right).toEqual(expect.objectContaining({ type: 'number_literal', value: 3 }));
      }
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

  // ========== Pin Position Functions ==========

  describe('pin position functions in require', () => {
    it('should parse pin_row and pin_col', () => {
      const ast = parseOk(`port P:
  channel TX
  channel RX
  config "default":
    TX = USART*_TX
    RX = USART*_RX
    require pin_row(TX) == pin_row(RX)`);
      const port = ast.statements[0] as PortDeclNode;
      const req = port.configs[0].body[2] as RequireNode;
      expect(req.expression.type).toBe('binary_expr');
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.operator).toBe('==');
        expect(req.expression.left.type).toBe('function_call');
        if (req.expression.left.type === 'function_call') {
          expect(req.expression.left.name).toBe('pin_row');
        }
      }
    });

    it('should parse pin_distance', () => {
      const ast = parseOk(`port P:
  channel MOSI
  channel MISO
  config "SPI":
    MOSI = SPI*_MOSI
    MISO = SPI*_MISO
    require pin_distance(MOSI, MISO) < 5`);
      const port = ast.statements[0] as PortDeclNode;
      const req = port.configs[0].body[2] as RequireNode;
      expect(req.expression.type).toBe('binary_expr');
      if (req.expression.type === 'binary_expr') {
        expect(req.expression.left.type).toBe('function_call');
        if (req.expression.left.type === 'function_call') {
          expect(req.expression.left.name).toBe('pin_distance');
          expect(req.expression.left.args).toHaveLength(2);
        }
      }
    });
  });

  // ========== parseExpressionString ==========

  describe('parseExpressionString', () => {
    it('should parse a function call expression', () => {
      const expr = parseExpressionString('instance(TX)');
      expect(expr).not.toBeNull();
      expect(expr!.type).toBe('function_call');
      if (expr!.type === 'function_call') {
        expect(expr!.name).toBe('instance');
        expect(expr!.args).toHaveLength(1);
      }
    });

    it('should parse arithmetic expressions', () => {
      const expr = parseExpressionString('pin_number(A) + 1');
      expect(expr).not.toBeNull();
      expect(expr!.type).toBe('binary_expr');
    });

    it('should return null for empty input', () => {
      expect(parseExpressionString('')).toBeNull();
    });
  });

  // ========== Comment Interpolation ==========

  describe('comment interpolation', () => {
    it('should interpolate instance() from assignments', async () => {
      const { interpolateCommentFromAssignments } = await import('../src/solver/comment-interpolation');
      const assignments = [
        { pinName: 'PA9', signalName: 'USART1_TX', portName: 'CMD', channelName: 'TX', configurationName: 'UART' },
        { pinName: 'PA10', signalName: 'USART1_RX', portName: 'CMD', channelName: 'RX', configurationName: 'UART' },
      ];
      const result = interpolateCommentFromAssignments(
        '${instance(TX)}_TX on pin ${gpio_pin(TX)}',
        'CMD',
        assignments as any
      );
      expect(result).toBe('USART1_TX on pin PA9');
    });

    it('should leave non-interpolated comments unchanged', async () => {
      const { interpolateCommentFromAssignments } = await import('../src/solver/comment-interpolation');
      expect(interpolateCommentFromAssignments('plain comment', 'P', [])).toBe('plain comment');
    });

    it('should replace unknown channels with ?', async () => {
      const { interpolateCommentFromAssignments } = await import('../src/solver/comment-interpolation');
      const result = interpolateCommentFromAssignments('${instance(UNKNOWN)}', 'P', []);
      expect(result).toBe('?');
    });
  });
});
