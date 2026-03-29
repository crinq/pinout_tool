// ============================================================
// Standard Library Macros
// Pre-defined macros for common peripheral configurations.
// These are parsed at startup and available in all projects.
// Users can edit the library via the Data Manager.
// ============================================================

import { parseConstraints } from './constraint-parser';
import { extractMacros } from './macro-expander';
import type { MacroDeclNode, PortDeclNode } from './constraint-ast';
import { loadMacroLibrary, saveMacroLibrary } from '../storage';

export const DEFAULT_MACRO_LIBRARY = `\
# UART / USART full-duplex
macro uart_port(TX, RX):
  TX = USART*_TX
  RX = USART*_RX
  require same_instance(TX, RX, "USART")

# UART half-duplex (single wire)
macro uart_half_duplex(TX):
  TX = USART*_TX

# SPI master (3-wire)
macro spi_port(MOSI, MISO, SCK):
  MOSI = SPI*_MOSI
  MISO = SPI*_MISO
  SCK = SPI*_SCK
  require same_instance(MOSI, MISO, SCK, "SPI")

# SPI master with chip select (overload)
macro spi_port(MOSI, MISO, SCK, NSS):
  spi_port(MOSI, MISO, SCK)
  NSS = SPI*_NSS
  require same_instance(MOSI, NSS, "SPI")

# I2C port
macro i2c_port(SDA, SCL):
  SDA = I2C*_SDA
  SCL = I2C*_SCL
  require same_instance(SDA, SCL, "I2C")

# Timer encoder (2-channel quadrature)
macro encoder(A, B):
  A = TIM*_CH[1,2]
  B = TIM*_CH[1,2]
  require same_instance(A, B, "TIM")
  require instance(A, "TIM") == TIM[1-5,8,20]

# Timer encoder with index (overload)
macro encoder(A, B, Z):
  encoder(A, B)
  Z = TIM*_CH[3,4]
  require same_instance(A, Z, "TIM")

# PWM output on a single timer channel
macro pwm(CH):
  CH = TIM*_CH[1-4]

# DAC output
macro dac(OUT):
  OUT = DAC*_OUT[1-2]

# ADC input
macro adc(IN):
  IN = ADC*_IN[0-15]

# CAN bus
macro can_port(TX, RX):
  TX = CAN*_TX
  RX = CAN*_RX
  require same_instance(TX, RX, "CAN")
`;

let cachedStdlib: Map<string, MacroDeclNode> | null = null;
let cachedTemplates: Map<string, PortDeclNode> | null = null;
let cachedSource: string | null = null;

/**
 * Seed the macro library in localStorage if not present.
 */
export function seedMacroLibrary(): void {
  if (loadMacroLibrary() === null) {
    saveMacroLibrary(DEFAULT_MACRO_LIBRARY.trim());
  }
}

/**
 * Invalidate the cached macros so they are re-parsed on next access.
 * Call this after the user edits the macro library.
 */
export function invalidateStdlibCache(): void {
  cachedStdlib = null;
  cachedTemplates = null;
  cachedSource = null;
}

/**
 * Get the current macro library source (from localStorage or default).
 */
export function getStdlibSource(): string {
  if (cachedSource !== null) return cachedSource;
  cachedSource = loadMacroLibrary() ?? DEFAULT_MACRO_LIBRARY.trim();
  return cachedSource;
}

/**
 * Get the stdlib macro definitions (parsed once, cached).
 */
export function getStdlibMacros(): Map<string, MacroDeclNode> {
  if (cachedStdlib) return cachedStdlib;
  parseStdlib();
  return cachedStdlib!;
}

/**
 * Get port templates from the stdlib (parsed once, cached).
 */
export function getStdlibTemplates(): Map<string, PortDeclNode> {
  if (cachedTemplates) return cachedTemplates;
  parseStdlib();
  return cachedTemplates!;
}

function parseStdlib(): void {
  const source = getStdlibSource();
  const result = parseConstraints(source);
  if (result.ast) {
    cachedStdlib = extractMacros(result.ast);
    cachedTemplates = new Map();
    for (const stmt of result.ast.statements) {
      if (stmt.type === 'port_decl') {
        cachedTemplates.set(stmt.name, stmt);
      }
    }
  } else {
    cachedStdlib = new Map();
    cachedTemplates = new Map();
  }
}

/**
 * Get the names of all macros in the current library (without arity suffix).
 */
export function getStdlibMacroNames(): Set<string> {
  const names = new Set<string>();
  for (const key of getStdlibMacros().keys()) {
    names.add(key.split('/')[0]);
  }
  return names;
}
