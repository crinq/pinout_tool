// ============================================================
// Peripheral snippet library
//
// A user-editable set of named peripheral snippets used by the constraint
// editor's double-click helper. Each snippet is a `#Name` header followed by
// mapping and `require` lines, e.g.
//
//   #USART
//   TX = USART*_TX $u
//   RX = USART*_RX $u
//   require dma(TX, "USART_TX")
//   require dma(RX, "USART_RX")
//
// A mapping line (`CH = signal [$var]`) contributes a channel; a `require`
// line is copied verbatim. The editor inserts these in short form (inline
// `channel CH = …`) into a config-less port, or in full form inside a config
// (adding the missing `channel CH` declarations to the port).
// ============================================================

import { loadPeripheralLibrary, savePeripheralLibrary } from '../storage';

export interface Peripheral {
  name: string;
  /** Body lines, trimmed — mapping lines (`CH = …`) and `require …` lines. */
  lines: string[];
}

export const DEFAULT_PERIPHERAL_LIBRARY = `\
#USART
TX = USART*_TX $u
RX = USART*_RX $u
require dma(TX, "USART_TX")
require dma(RX, "USART_RX")

#SPI master + NSS
SCK = SPI*_SCK $s
MISO = SPI*_MISO $s
MOSI = SPI*_MOSI $s
NSS = SPI*_NSS $s
require dma(MISO, "SPI_RX")
require dma(MOSI, "SPI_TXX")

#I2C
SCL = I2C*_SCL $i
SDA = I2C*_SDA $i

#CAN
TX = CAN*_TX $c
RX = CAN*_RX $c

`;

/** Parse the library text into named peripheral snippets. */
export function parsePeripheralLibrary(text: string): Peripheral[] {
  const out: Peripheral[] = [];
  let current: Peripheral | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      current = { name: line.slice(1).trim(), lines: [] };
      if (current.name) out.push(current);
      else current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return out.filter(p => p.lines.length > 0);
}

// --- Cached, KV-backed source (mirrors the macro library) ---

let cachedSource: string | null = null;
let cachedPeripherals: Peripheral[] | null = null;

/** Seed the library in storage if absent and prime the cache. */
export async function seedPeripheralLibrary(): Promise<void> {
  if ((await loadPeripheralLibrary()) === null) {
    await savePeripheralLibrary(DEFAULT_PERIPHERAL_LIBRARY.trim());
  }
  await primePeripheralSource();
}

/** Refresh the cache from storage — call after the user saves an edit. */
export async function primePeripheralSource(): Promise<void> {
  cachedSource = (await loadPeripheralLibrary()) ?? DEFAULT_PERIPHERAL_LIBRARY.trim();
  cachedPeripherals = null;
}

export function getPeripheralSource(): string {
  if (cachedSource !== null) return cachedSource;
  cachedSource = DEFAULT_PERIPHERAL_LIBRARY.trim();
  return cachedSource;
}

export function getPeripherals(): Peripheral[] {
  if (cachedPeripherals) return cachedPeripherals;
  cachedPeripherals = parsePeripheralLibrary(getPeripheralSource());
  return cachedPeripherals;
}
