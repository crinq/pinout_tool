// ============================================================
// MCU JSON Parser
//
// Parses the unified vendor JSON schema (see ../mcu_data/data/) into the
// same `Mcu` shape used by the CubeMX XML parser. One JSON file describes
// one die with N package variants — this parser emits one `Mcu` per
// variant so the rest of the app can stay package-centric.
//
// Differences from the XML path worth knowing:
//   - `packages[].pins[].alt_names` is the canonical source for shared
//     bond pads + PINREMAP variants. Each name + alt_name becomes its own
//     LogicalPin sharing one PhysicalPin (same model the XML parser
//     synthesizes from `Variant="PINREMAP"` rows).
//   - Peripheral signals come from `peripherals[].pins[]` (AF-keyed) and
//     are joined to logical pins by GPIO name.
//   - Multi-token instance names (USB_OTG_HS, USB_DEVICE) are kept
//     verbatim on `Signal.peripheralInstance` instead of being truncated
//     at the first underscore (the XML parser's lossy default). Pattern
//     matching still works via `startsWith` for wildcards.
//   - DMA, IOModes, hyphenated `SYS_JTCK-SWCLK`, and `_C` analog-switch
//     siblings are not yet emitted by the vendor data — fields stay
//     empty. The next data revision will fill these in.
// ============================================================

import {
  type Mcu, type Peripheral, type LogicalPin, type PhysicalPin, type PinType, type Signal,
  type DmaData, type DmaStreamInfo,
} from '../types';
import { normalizePeripheralType } from './mcu-xml-parser';

// ============================================================
// Schema (the slice we use)
//
// As of the latest revision the catalogue exposes pin↔signal mappings on
// the GPIO side rather than per-peripheral. Each `gpios[]` entry lists
// every alternate function (`alternate_functions`, AF-keyed) and every
// non-AF function (`additional_functions`) the net carries. The package
// pin record (`packages[].pins[]`) only points into that GPIO list via
// `names`.
// ============================================================

type AltFunctions = Record<string, string | string[]>;

interface JsonGpio {
  name: string;                          // "PA0"
  port?: string;                         // "a"
  pin?: number;                          // 0
  alternate_functions?: AltFunctions;
  additional_functions?: string[];
}

interface JsonPackagePin {
  position: string;
  /** GPIO names bonded to this package pad. Multiple names = shared bond pad. */
  names: string[];
  /** "io" | "power" | "reset" | "boot" | "mono_io" | "nc" | (future). */
  type?: string;
}

interface JsonPackage {
  name: string;
  variant: string;
  pins: JsonPackagePin[];
}

interface JsonDmaToken {
  /** Either an opaque token like "DMA1_CH3" or "DMAMUX1_CH0(51)". */
  dma: string;
  enable_condition?: unknown;
}

type JsonDmaItem = string | JsonDmaToken;

interface JsonPeripheralDmaEntry {
  /** Signal short name ("TX", "RX") or full instance name ("ADC1") for instance-level DMA. */
  signal: string;
  dma?: JsonDmaItem[];
}

interface JsonPeripheral {
  name: string;
  kind: string;
  version?: string;
  register_block?: string;
  dma_channels?: JsonPeripheralDmaEntry[];
}

interface JsonDmaChannel {
  name: string;
  channel: number;
  dmamux?: string | null;
  dmamux_channel?: number | null;
}

interface JsonDmaController {
  name: string;
  channels?: JsonDmaChannel[];
}

interface JsonCore {
  name?: string;
  type_full?: string;
  freq_max_hz?: number;
}

interface JsonMemory {
  kind: string;
  size: number;
}

export interface McuJsonDocument {
  schema?: number;
  name: string;
  family: string;
  sub_family?: string;
  line?: string;
  cores?: JsonCore[];
  voltage?: { min_v?: number; max_v?: number };
  temperature?: { min_c?: number; max_c?: number };
  memory?: JsonMemory[];
  packages?: JsonPackage[];
  peripherals?: JsonPeripheral[];
  gpios?: JsonGpio[];
  dma_controllers?: JsonDmaController[];
  die?: string;
}

// ============================================================
// Helpers
// ============================================================

const GPIO_NAME_RE = /^P([A-Z])(\d+)$/;

/**
 * Map the JSON `pin.type` discriminator onto the existing `PinType`
 * enum. Unknown values fall back to `Power` so the rest of the model
 * still works (the pin just becomes non-assignable).
 */
function pinTypeFromJson(type?: string): { pinType: PinType; assignable: boolean } {
  switch ((type ?? '').toLowerCase()) {
    case 'io':       return { pinType: 'I/O',    assignable: true };
    case 'mono_io':  return { pinType: 'MonoIO', assignable: true };
    case 'reset':    return { pinType: 'Reset',  assignable: false };
    case 'boot':     return { pinType: 'Boot',   assignable: false };
    case 'power':    return { pinType: 'Power',  assignable: false };
    case 'nc':       return { pinType: 'Power',  assignable: false };
    default:         return { pinType: 'Power',  assignable: false };
  }
}

// ============================================================
// DMA token grammar
//
// Per the format spec, a peripheral's `dma_channels[].dma[]` carries
// opaque tokens in one of two shapes:
//
//   "DMA<n>_CH<m>"             — fixed-mapping (F1/F2/F4/F7). The token
//                                IS the physical stream's name, no mux.
//   "DMAMUX<n>_CH<m>(<req>)"   — DMAMUX-routed (G0/G4/H5/H7/L4+/U5/...).
//                                <m> is the DMAMUX channel slot, <req>
//                                is the mux request input. The actual
//                                downstream physical channel comes from
//                                `dma_controllers[].channels[]` whose
//                                `dmamux === DMAMUX<n>` and
//                                `dmamux_channel === <m>`.
//
// The synthesizer normalises both shapes to one stream name (matching
// the DmaStreamInfo.name the rest of the app already uses) so callers
// don't have to discriminate.
// ============================================================

const FIXED_DMA_TOKEN_RE = /^DMA\d+_CH\d+$/;
const DMAMUX_TOKEN_RE = /^DMAMUX(\d+)_CH(\d+)\((\d+)\)$/;

interface ParsedDmaToken {
  /** Resolved physical stream name, e.g. "DMA1_CH1" or "DMA2_CH7". */
  streamName: string;
  /** DMAMUX request input number when the token is mux-routed; null otherwise. */
  request: number | null;
}

function parseDmaToken(
  token: string,
  muxResolver: Map<string, string>,
): ParsedDmaToken | null {
  if (FIXED_DMA_TOKEN_RE.test(token)) {
    return { streamName: token, request: null };
  }
  const m = token.match(DMAMUX_TOKEN_RE);
  if (m) {
    const muxName = `DMAMUX${m[1]}`;
    const muxChannel = parseInt(m[2], 10);
    const request = parseInt(m[3], 10);
    const streamName = muxResolver.get(`${muxName}:${muxChannel}`);
    if (!streamName) return null;
    return { streamName, request };
  }
  return null;
}

function parseGpioName(name: string): { port: string; number: number; baseName: string } | null {
  const m = name.match(GPIO_NAME_RE);
  if (!m) return null;
  return { port: m[1], number: parseInt(m[2], 10), baseName: `P${m[1]}${m[2]}` };
}

function gpioPortNumber(letter: string): number {
  return letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
}

/**
 * Match the XML parser's `collapseSignalName`: keep the first underscore as
 * the instance/function separator, drop every later underscore in the
 * function part. Constraint signal patterns rely on this convention.
 *
 * Example: "USB_OTG_HS_ULPI_STP" → "USB_OTGHSULPISTP".
 */
function collapseSignalName(name: string): string {
  const idx = name.indexOf('_');
  if (idx === -1) return name;
  const head = name.substring(0, idx);
  const tail = name.substring(idx + 1).replace(/_/g, '');
  return `${head}_${tail}`;
}

/** Try to read an instance number off the END of a peripheral name. */
function instanceNumberOf(name: string): number | undefined {
  const m = name.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Convert a raw signal string from the GPIO entry (e.g. "USART1_TX",
 * "ADC1_IN0", "SPI1_I2S_CK") into a Signal. The leading underscore
 * splits instance from function the same way the XML pipeline does
 * (collapseSignalName), so multi-token signal functions stay matchable
 * by constraint patterns like `SPI*_I2SCK`.
 */
function buildSignalFromName(rawName: string, ioModes?: string): Signal | null {
  if (!rawName) return null;
  const collapsed = collapseSignalName(rawName);
  // Split on first underscore to identify peripheral instance.
  const idx = collapsed.indexOf('_');
  if (idx === -1) {
    // Bare name (e.g. "GPIO") — treat the whole thing as an instance
    // with no function. Rare in the vendor data but still well-formed.
    return {
      name: collapsed,
      peripheralInstance: collapsed,
      peripheralType: collapsed,
      instanceNumber: undefined,
      signalFunction: undefined,
      ioModes,
    };
  }
  const instanceName = collapsed.substring(0, idx);
  const functionName = collapsed.substring(idx + 1);
  const { type: peripheralType } = typeFromInstance(instanceName, '');
  return {
    name: collapsed,
    peripheralInstance: instanceName,
    peripheralType,
    instanceNumber: instanceNumberOf(instanceName),
    signalFunction: functionName,
    ioModes,
  };
}

/**
 * Derive the canonical peripheral type from the instance name (mirrors
 * what the XML parser does with `<IP Name="...">`). The vendor JSON's
 * `kind` field is too coarse — `timer` covers TIM*, `otg` covers
 * USB_OTG_FS/HS, `bdma`/`gpdma`/`lpdma`/`dma` all cover DMA controllers
 * — so the constraint solver's type-bucket lookup misses if we use kind
 * directly. Falling back to the instance name keeps `mcu.typeToInstances`
 * keyed the same way the XML path produces.
 */
function typeFromInstance(instanceName: string, kind: string): { type: string; original: string } {
  // Special cases where the instance name doesn't yield a clean prefix
  // but the `kind` value tells us exactly what bucket to use.
  if (kind === 'gpio') return { type: 'GPIO', original: 'GPIO' };

  // Strip a trailing digit run to find the prefix: "USART1" → "USART",
  // "LPUART1" → "LPUART", "DMA1" → "DMA", "USB_OTG_FS" → "USB_OTG_FS".
  const m = instanceName.match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : instanceName;
  const original = prefix.toUpperCase();

  // For multi-token names like "USB_OTG_FS" or "USB1_OTG_HS", normalize
  // down to the leading peripheral family ("USB"). normalizePeripheralType
  // already handles compounds by taking the part before the first
  // underscore, but it doesn't strip a trailing digit off that head, so
  // "USB1_OTG_HS" keeps its "1". Do that step explicitly.
  let base = original;
  if (base.includes('_')) base = base.substring(0, base.indexOf('_'));
  base = base.replace(/\d+$/, '') || original;

  return { type: normalizePeripheralType(base), original };
}

// ============================================================
// Public API
// ============================================================

// ============================================================
// DMA synthesizer
//
// Build a DmaData from the JSON document. Every physical channel in
// `dma_controllers[]` becomes a DmaStreamInfo (using the JSON's name
// verbatim — DMA1_CH3, DMA2_CH7, …). Each peripheral signal token is
// resolved to a stream and added to that stream's request list.
//
// Coverage notes:
//  - Both fixed-mapping (F4-class) and DMAMUX (C0/G0/G4/H5/H7/L4+/U5/…)
//    tokens land in the same shape.
//  - `enable_condition` variants are accepted as-is — the routing is
//    listed even though the constraint solver doesn't model the
//    register-state condition.
//  - Instance-level requests (signal === peripheral.name, used for
//    whole-peripheral DMA on ADC/DAC) are emitted under the bare
//    instance key so `instanceToDmaStreams` populates correctly.
// ============================================================

function synthesizeDmaDataFromJson(doc: McuJsonDocument): DmaData | undefined {
  const ctrls = doc.dma_controllers ?? [];
  if (ctrls.length === 0) return undefined;

  // Build streams + DMAMUX→stream resolver in one pass.
  const streams: DmaStreamInfo[] = [];
  const streamByName = new Map<string, DmaStreamInfo>();
  // key: "DMAMUX1:0" → stream name "DMA1_CH1"
  const muxResolver = new Map<string, string>();

  for (const ctrl of ctrls) {
    for (const ch of ctrl.channels ?? []) {
      if (!ch.name) continue;
      const stream: DmaStreamInfo = {
        name: ch.name,
        controller: ctrl.name,
        streamNumber: ch.channel ?? 0,
        requests: [],
      };
      streams.push(stream);
      streamByName.set(ch.name, stream);
      if (ch.dmamux && ch.dmamux_channel !== undefined && ch.dmamux_channel !== null) {
        muxResolver.set(`${ch.dmamux}:${ch.dmamux_channel}`, ch.name);
      }
    }
  }

  if (streams.length === 0) return undefined;

  for (const p of doc.peripherals ?? []) {
    if (!p.dma_channels) continue;
    for (const entry of p.dma_channels) {
      if (!entry.signal || !entry.dma) continue;
      // Spec: when the signal field equals the peripheral name the entry is
      // an instance-level (whole-peripheral) DMA mapping. Bare instance key
      // populates `instanceToDmaStreams`; the buildDmaData helper at the
      // bottom of this file detects "no underscore" → instance lookup.
      const isInstanceLevel = entry.signal === p.name;
      const sigKey = isInstanceLevel ? p.name : `${p.name}_${entry.signal}`;

      for (const item of entry.dma) {
        const token = typeof item === 'string' ? item : item.dma;
        if (!token) continue;
        const parsed = parseDmaToken(token, muxResolver);
        if (!parsed) continue;
        const stream = streamByName.get(parsed.streamName);
        if (!stream) continue;
        // Reuse the request entry if this same (instance, signal) pair
        // already exists on the stream — keeps the stream's request list
        // small and matches what the XML parser produces.
        let req = stream.requests.find(
          r => r.peripheralInstance === p.name && r.signalNames.includes(sigKey),
        );
        if (!req) {
          req = { signalNames: [sigKey], peripheralInstance: p.name };
          stream.requests.push(req);
        }
      }
    }
  }

  return buildDmaDataFromStreams(doc.die ?? doc.name ?? '', streams);
}

function buildDmaDataFromStreams(version: string, streams: DmaStreamInfo[]): DmaData {
  const signalToDmaStreams = new Map<string, DmaStreamInfo[]>();
  const instanceToDmaStreams = new Map<string, DmaStreamInfo[]>();

  for (const stream of streams) {
    for (const req of stream.requests) {
      for (const sigName of req.signalNames) {
        const arr = signalToDmaStreams.get(sigName) ?? [];
        if (!arr.includes(stream)) arr.push(stream);
        signalToDmaStreams.set(sigName, arr);
      }
      // Mirror dma-xml-parser's heuristic: a signal name without an
      // underscore is an instance-level request. Index by instance for
      // findDmaStreamsForSignal's fallback path.
      if (req.signalNames.length === 1 && !req.signalNames[0].includes('_')) {
        const arr = instanceToDmaStreams.get(req.peripheralInstance) ?? [];
        if (!arr.includes(stream)) arr.push(stream);
        instanceToDmaStreams.set(req.peripheralInstance, arr);
      }
    }
  }

  return { version, streams, signalToDmaStreams, instanceToDmaStreams };
}

// Re-export for test suites that want to drive the synthesizer directly.
export { synthesizeDmaDataFromJson };

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Parse a vendor JSON string into one Mcu per package variant.
 * The same `Mcu` shape used by the XML parser is returned, so consumers
 * (solver, UI, storage) don't have to discriminate between sources.
 */
export function parseMcuJson(jsonString: string): Mcu[] {
  const doc = JSON.parse(jsonString) as McuJsonDocument;
  return parseMcuJsonDoc(doc);
}

export function parseMcuJsonDoc(doc: McuJsonDocument): Mcu[] {
  if (!doc.packages || doc.packages.length === 0) return [];

  // Family field on stored Mcu mirrors the XML's "STM32C0" style.
  const family = (doc.family ?? '').toUpperCase();
  const line = doc.line ?? '';

  const cores = (doc.cores ?? []).map(c => c.type_full ?? c.name ?? '').filter(Boolean);
  const freqMHz = Math.max(...(doc.cores ?? []).map(c => c.freq_max_hz ?? 0)) / 1_000_000 || 0;
  const voltage = {
    min: doc.voltage?.min_v ?? 0,
    max: doc.voltage?.max_v ?? 0,
  };
  const temperature = {
    min: doc.temperature?.min_c ?? 0,
    max: doc.temperature?.max_c ?? 0,
  };

  // memory[].size is in bytes — convert to KB to match the XML parser's
  // unit (`<Flash>32</Flash>` is already in KB).
  let flashKB = 0;
  let ramKB = 0;
  let ccmKB: number | undefined;
  for (const m of doc.memory ?? []) {
    const kb = (m.size ?? 0) / 1024;
    if (m.kind === 'flash') flashKB += kb;
    else if (m.kind === 'ram') {
      // Heuristic: a region named CCMRAM/CCM/DTCM/ITCM is reported as ccmRam
      // for parity with the XML field. The XML's `<CCMRam>` tag is also
      // size-only and does not distinguish between TCMs.
      if (/CCM|DTCM|ITCM/i.test((m as JsonMemory & { name?: string }).name ?? '')) {
        ccmKB = (ccmKB ?? 0) + kb;
      } else {
        ramKB += kb;
      }
    }
  }

  // Build the peripheral list once — every package variant shares it.
  const peripherals: Peripheral[] = [];
  for (const p of doc.peripherals ?? []) {
    if (!p.name || !p.kind) continue;
    const { type, original } = typeFromInstance(p.name, p.kind);
    peripherals.push({
      instanceName: p.name,
      type,
      originalType: original,
      version: p.version ?? '',
    });
  }

  // Pre-index pin↔signal mappings by GPIO name. The vendor JSON keeps
  // these on the GPIO entry: `alternate_functions` is keyed by AF
  // number and stores one or more signal names; `additional_functions`
  // is a flat list of non-AF signals (analog inputs, wakeup pins,
  // remap-only options).
  const signalsByPin = new Map<string, Signal[]>();
  for (const g of doc.gpios ?? []) {
    if (!g.name) continue;
    const list: Signal[] = [];

    if (g.alternate_functions) {
      for (const [af, value] of Object.entries(g.alternate_functions)) {
        const signals = Array.isArray(value) ? value : [value];
        for (const rawSig of signals) {
          const sig = buildSignalFromName(rawSig, `AF${af}`);
          if (sig) list.push(sig);
        }
      }
    }
    for (const rawSig of g.additional_functions ?? []) {
      const sig = buildSignalFromName(rawSig, undefined);
      if (sig) list.push(sig);
    }

    if (list.length > 0) signalsByPin.set(g.name, list);
  }

  // DMA is shared across every variant of the same die — synthesize once.
  const dma = synthesizeDmaDataFromJson(doc);

  const result: Mcu[] = [];
  for (const pkg of doc.packages) {
    result.push(buildVariantMcu({
      doc, pkg, family, line, cores, freqMHz, voltage, temperature,
      flashKB, ramKB, ccmKB, peripherals, signalsByPin, dma,
    }));
  }
  return result;
}

interface VariantBuildArgs {
  doc: McuJsonDocument;
  pkg: JsonPackage;
  family: string;
  line: string;
  cores: string[];
  freqMHz: number;
  voltage: { min: number; max: number };
  temperature: { min: number; max: number };
  flashKB: number;
  ramKB: number;
  ccmKB?: number;
  peripherals: Peripheral[];
  signalsByPin: Map<string, Signal[]>;
  dma?: DmaData;
}

function buildVariantMcu(a: VariantBuildArgs): Mcu {
  const physicalPinByPosition = new Map<string, PhysicalPin>();
  const logicalPins: LogicalPin[] = [];

  for (const row of a.pkg.pins) {
    let physical = physicalPinByPosition.get(row.position);
    if (!physical) {
      physical = { position: row.position, logicals: [] };
      physicalPinByPosition.set(row.position, physical);
    }

    // `names[]` holds every GPIO net bonded to this pad. First entry is
    // the default; the rest are PINREMAP-style alternates that share the
    // physical (mutually exclusive at runtime).
    const names = row.names && row.names.length > 0 ? row.names : [];
    if (names.length === 0) continue;

    const { pinType, assignable } = pinTypeFromJson(row.type);
    for (let i = 0; i < names.length; i++) {
      addLogical(
        physical,
        names[i],
        i === 0,                             // first → default variant
        pinType,
        assignable,
        a.signalsByPin,
        logicalPins,
        i === 0 ? undefined : 'ALT',
      );
    }
  }

  const physicalPins = Array.from(physicalPinByPosition.values());

  // Derived maps (mirror the XML path so consumers can ignore the source).
  const logicalPinByName = new Map<string, LogicalPin>();
  const logicalPinsByName = new Map<string, LogicalPin[]>();
  const logicalPinByGpioName = new Map<string, LogicalPin>();
  const signalToLogicalPins = new Map<string, LogicalPin[]>();
  const peripheralByInstance = new Map<string, Peripheral>();
  const typeToInstances = new Map<string, string[]>();
  const peripheralSignals = new Map<string, Set<string>>();
  const logicalSignalSet = new Map<string, Set<string>>();

  for (const p of a.peripherals) {
    peripheralByInstance.set(p.instanceName, p);
    const arr = typeToInstances.get(p.type) ?? [];
    arr.push(p.instanceName);
    typeToInstances.set(p.type, arr);
  }

  const gpioInstances = new Set<string>();

  for (const lp of logicalPins) {
    if (!logicalPinByName.has(lp.name)) logicalPinByName.set(lp.name, lp);
    const arr = logicalPinsByName.get(lp.name) ?? [];
    arr.push(lp);
    logicalPinsByName.set(lp.name, arr);

    const gpio = parseGpioName(lp.name);
    if (gpio) logicalPinByGpioName.set(gpio.baseName, lp);

    const sigSet = new Set<string>();
    for (const sig of lp.signals) {
      sigSet.add(sig.name);

      if (sig.name !== 'GPIO') {
        const arr2 = signalToLogicalPins.get(sig.name) ?? [];
        arr2.push(lp);
        signalToLogicalPins.set(sig.name, arr2);
      }

      if (sig.peripheralInstance) {
        const sigs = peripheralSignals.get(sig.peripheralInstance) ?? new Set();
        sigs.add(sig.name);
        peripheralSignals.set(sig.peripheralInstance, sigs);

        if (sig.peripheralType === 'GPIO') gpioInstances.add(sig.peripheralInstance);
      }
    }
    logicalSignalSet.set(lp.name, sigSet);
  }

  // Synthesize GPIO peripheral entries for every GPIO port that pin
  // signals reference, matching what the XML path does.
  const peripherals = [...a.peripherals];
  for (const gpioInst of gpioInstances) {
    if (!peripheralByInstance.has(gpioInst)) {
      const gpioPeripheral: Peripheral = {
        instanceName: gpioInst,
        type: 'GPIO',
        originalType: 'GPIO',
        version: '',
      };
      peripherals.push(gpioPeripheral);
      peripheralByInstance.set(gpioInst, gpioPeripheral);
      const arr = typeToInstances.get('GPIO') ?? [];
      arr.push(gpioInst);
      typeToInstances.set('GPIO', arr);
    }
  }

  return {
    refName: a.pkg.variant,
    family: a.family,
    line: a.line,
    package: a.pkg.name,
    cores: a.cores,
    frequency: a.freqMHz,
    flash: a.flashKB,
    ram: a.ramKB,
    ccmRam: a.ccmKB,
    ioCount: logicalPins.filter(l => l.isAssignable).length,
    voltage: a.voltage,
    temperature: a.temperature,
    hasPowerPad: false,
    peripherals,
    logicalPins,
    physicalPins,
    logicalPinByName,
    logicalPinsByName,
    logicalPinByGpioName,
    physicalPinByPosition,
    peripheralByInstance,
    signalToLogicalPins,
    typeToInstances,
    peripheralSignals,
    logicalSignalSet,
    dma: a.dma,
  };
}

function addLogical(
  physical: PhysicalPin,
  rawName: string,
  isDefault: boolean,
  pinType: PinType,
  isAssignable: boolean,
  signalsByPin: Map<string, Signal[]>,
  logicalPins: LogicalPin[],
  variantGroup?: string,
): void {
  const gpio = parseGpioName(rawName);

  // Copy the GPIO's signal list (alternate + additional functions),
  // then synthesize the GPIO digital signal the solver expects so
  // `mcu.signalToLogicalPins` carries a `GPIOn_m` entry per assignable
  // pin (parity with the XML path).
  const signals: Signal[] = (signalsByPin.get(rawName) ?? []).map(s => ({ ...s }));
  if (gpio) {
    const portNum = gpioPortNumber(gpio.port);
    signals.push({
      name: `GPIO${portNum}_${gpio.number}`,
      peripheralInstance: `GPIO${portNum}`,
      peripheralType: 'GPIO',
      instanceNumber: portNum,
      signalFunction: String(gpio.number),
    });
  }

  const lp: LogicalPin = {
    name: rawName,
    type: pinType,
    signals,
    gpioPort: gpio?.port,
    gpioNumber: gpio?.number,
    isAssignable: isAssignable && (gpio !== null || pinType === 'MonoIO'),
    isDefaultVariant: isDefault,
    variantGroup,
    physical,
  };
  physical.logicals.push(lp);
  logicalPins.push(lp);
}

/**
 * Run the same structural checks `validateMcu` does after the JSON path —
 * we re-export so call sites can use one validator regardless of source.
 */
export function validateMcuJsonResult(mcu: Mcu): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!mcu.refName) errors.push('Missing MCU refName');
  if (!mcu.package) errors.push('Missing package');
  if (mcu.logicalPins.length === 0) errors.push('No pins found');
  return { valid: errors.length === 0, errors, warnings };
}
