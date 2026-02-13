// ============================================================
// Standard Library Macros
// Pre-defined macros for common peripheral configurations.
// These are parsed at startup and available in all projects.
// ============================================================

import { parseConstraints } from './constraint-parser';
import { extractMacros } from './macro-expander';
import type { MacroDeclNode } from './constraint-ast';

const STDLIB_SOURCE = `
# UART / USART full-duplex
macro uart_port(TX, RX):
  TX = USART*_TX
  RX = USART*_RX
  require same_instance(TX, RX)

# UART half-duplex (single wire)
macro uart_half_duplex(TX):
  TX = USART*_TX

# SPI master (3-wire + optional CS)
macro spi_port(MOSI, MISO, SCK):
  MOSI = SPI*_MOSI
  MISO = SPI*_MISO
  SCK = SPI*_SCK
  require same_instance(MOSI, MISO)
  require same_instance(MOSI, SCK)

# SPI master with chip select
macro spi_port_cs(MOSI, MISO, SCK, NSS):
  MOSI = SPI*_MOSI
  MISO = SPI*_MISO
  SCK = SPI*_SCK
  NSS = SPI*_NSS
  require same_instance(MOSI, MISO)
  require same_instance(MOSI, SCK)
  require same_instance(MOSI, NSS)

# I2C port
macro i2c_port(SDA, SCL):
  SDA = I2C*_SDA
  SCL = I2C*_SCL
  require same_instance(SDA, SCL)

# Timer encoder (2-channel quadrature)
macro encoder(A, B):
  A = TIM*_CH1
  B = TIM*_CH2
  require same_instance(A, B, "TIM")

# Timer encoder with index
macro encoder_with_index(A, B, Z):
  A = TIM*_CH1
  B = TIM*_CH2
  Z = TIM*_CH3
  require same_instance(A, B, "TIM")
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
  require same_instance(TX, RX)
`;

let cachedStdlib: Map<string, MacroDeclNode> | null = null;

/**
 * Get the stdlib macro definitions (parsed once, cached).
 */
export function getStdlibMacros(): Map<string, MacroDeclNode> {
  if (cachedStdlib) return cachedStdlib;

  const result = parseConstraints(STDLIB_SOURCE);
  if (result.ast) {
    cachedStdlib = extractMacros(result.ast);
  } else {
    cachedStdlib = new Map();
  }
  return cachedStdlib;
}

/**
 * Get the stdlib source text (for display in help/editor).
 */
export function getStdlibSource(): string {
  return STDLIB_SOURCE.trim();
}
