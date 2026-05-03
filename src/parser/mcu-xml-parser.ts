import {
  type Mcu, type Peripheral, type LogicalPin, type PhysicalPin, type PinType, type Signal,
} from '../types';

// ============================================================
// Peripheral Type Normalization (STM32-specific aliases)
// ============================================================

export const TYPE_ALIASES: Record<string, string> = {
  'UART': 'USART',
  'LPUART': 'USART',
};

// STM32 XML uses versioned TIM type names like TIM1_8, TIM6_7, TIM1_8G4, TIM1_8H7, TIM6_7H7, etc.
const TIM_TYPE_RE = /^TIM\d+_\d+/;

export function normalizePeripheralType(type: string): string {
  // Try exact match first (handles "UART" → "USART", etc.)
  if (TYPE_ALIASES[type] !== undefined) return TYPE_ALIASES[type];
  // Versioned TIM types: TIM1_8, TIM6_7, TIM1_8G4, TIM1_8H7, etc. → "TIM"
  if (TIM_TYPE_RE.test(type)) return 'TIM';
  // Handle compound types like "USART_RX", "SPI_TX" - extract base type before underscore
  if (type.includes('_')) {
    const base = type.substring(0, type.indexOf('_'));
    return TYPE_ALIASES[base] ?? base;
  }
  return type;
}

/**
 * Parse signal name into components.
 * Examples:
 *   "USART1_TX"    -> { instance: "USART1", type: "USART", number: 1, function: "TX" }
 *   "ADC1_IN0"     -> { instance: "ADC1",   type: "ADC",   number: 1, function: "IN0" }
 *   "TIM12_CH1"    -> { instance: "TIM12",  type: "TIM",   number: 12, function: "CH1" }
 *   "GPIO"         -> { instance: undefined, type: undefined, number: undefined, function: undefined }
 *   "I2S_CKIN"     -> { instance: "I2S",    type: "I2S",   number: undefined, function: "CKIN" }
 *   "DAC_OUT1"     -> { instance: "DAC",    type: "DAC",   number: undefined, function: "OUT1" }
 *   "I2S2_ext_SD"  -> { instance: "I2S2",   type: "I2S",   number: 2, function: "ext_SD" }
 */
function parseSignalName(name: string): {
  peripheralInstance?: string;
  peripheralType?: string;
  instanceNumber?: number;
  signalFunction?: string;
} {
  if (name === 'GPIO') {
    return {};
  }

  // Find the first underscore to split instance from function
  const underscoreIdx = name.indexOf('_');
  if (underscoreIdx === -1) {
    // No underscore - treat entire name as instance (e.g., rare cases)
    return { peripheralInstance: name };
  }

  const instancePart = name.substring(0, underscoreIdx);
  const functionPart = name.substring(underscoreIdx + 1);

  // Parse instance part: extract type prefix and trailing number
  // e.g., "USART1" -> type="USART", number=1
  // e.g., "I2S2" -> type="I2S", number=2
  // e.g., "I2C2" -> type="I2C", number=2
  // e.g., "DAC" -> type="DAC", number=undefined
  // Note: .*? (non-greedy) + \d+$ (greedy) correctly splits "I2C2" → "I2C" + "2"
  const instanceMatch = instancePart.match(/^(.*?)(\d+)$/);

  let peripheralType: string;
  let instanceNumber: number | undefined;

  if (instanceMatch) {
    peripheralType = normalizePeripheralType(instanceMatch[1]);
    instanceNumber = parseInt(instanceMatch[2], 10);
  } else {
    // No trailing number (e.g., "DAC", "I2S")
    peripheralType = normalizePeripheralType(instancePart);
    instanceNumber = undefined;
  }

  return {
    peripheralInstance: instancePart,
    peripheralType,
    instanceNumber,
    signalFunction: functionPart,
  };
}

/**
 * Extract base GPIO name from pin name.
 * "PA0-WKUP" -> { port: "A", number: 0, baseName: "PA0" }
 * "PC14-OSC32_IN" -> { port: "C", number: 14, baseName: "PC14" }
 * "PB8-BOOT0" -> { port: "B", number: 8, baseName: "PB8" }
 * "VDD" -> null
 * "NRST" -> null
 */
function parseGpioName(pinName: string): { port: string; number: number; baseName: string } | null {
  const match = pinName.match(/^P([A-Z])(\d+)/);
  if (!match) return null;
  return {
    port: match[1],
    number: parseInt(match[2], 10),
    baseName: `P${match[1]}${match[2]}`,
  };
}

/** Map GPIO port letter to a number (A→1, B→2, ..., I→9) */
function gpioPortNumber(portLetter: string): number {
  return portLetter.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
}

function parsePinType(typeStr: string): PinType {
  switch (typeStr) {
    case 'I/O': return 'I/O';
    case 'Power': return 'Power';
    case 'Reset': return 'Reset';
    case 'Boot': return 'Boot';
    case 'MonoIO': return 'MonoIO';
    default: return 'Power'; // fallback for unknown types
  }
}

/**
 * Split hyphenated signal names into separate signals.
 * e.g., "SYS_JTCK-SWCLK" → ["SYS_JTCK", "SYS_SWCLK"]
 * The instance prefix (before the first '_') is shared across parts.
 */
function splitHyphenatedSignal(name: string): string[] {
  if (!name.includes('-')) return [name];

  const underscoreIdx = name.indexOf('_');
  if (underscoreIdx === -1) return [name]; // no underscore, can't split meaningfully

  const prefix = name.substring(0, underscoreIdx + 1); // e.g., "SYS_"
  const rest = name.substring(underscoreIdx + 1);       // e.g., "JTCK-SWCLK"
  const parts = rest.split('-');

  return parts.map(part => prefix + part);
}

/**
 * Collapse underscores in the signal function part so the constraint parser
 * can handle them (it uses underscore as the instance/function separator).
 * e.g., "RCC_OSC_IN" → "RCC_OSCIN", "RCC_OSC32_IN" → "RCC_OSC32IN"
 * The first underscore separates instance from function; subsequent ones are removed.
 */
function collapseSignalName(name: string): string {
  const idx = name.indexOf('_');
  if (idx === -1) return name;
  const instance = name.substring(0, idx);
  const func = name.substring(idx + 1);
  return instance + '_' + func.replace(/_/g, '');
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Parse an STM32CubeMX MCU XML string into an Mcu data structure.
 */
export function parseMcuXml(xmlString: string): Mcu {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`XML parse error: ${parseError.textContent}`);
  }

  const mcuEl = doc.querySelector('Mcu');
  if (!mcuEl) {
    throw new Error('No <Mcu> element found in XML');
  }

  // Parse MCU metadata
  const refName = mcuEl.getAttribute('RefName') ?? '';
  const family = mcuEl.getAttribute('Family') ?? '';
  const line = mcuEl.getAttribute('Line') ?? '';
  const packageName = mcuEl.getAttribute('Package') ?? '';
  const hasPowerPad = mcuEl.getAttribute('HasPowerPad') === 'true';

  const getText = (tag: string): string => {
    const el = mcuEl.querySelector(tag);
    return el?.textContent?.trim() ?? '';
  };
  const getNum = (tag: string): number => {
    const text = getText(tag);
    return text ? parseFloat(text) : 0;
  };

  const cores = Array.from(mcuEl.querySelectorAll('Core')).map(el => el.textContent?.trim() ?? '').filter(Boolean);
  const frequency = getNum('Frequency');
  const flash = getNum('Flash');
  const ram = getNum('Ram');
  const ccmRamText = getText('CCMRam');
  const ccmRam = ccmRamText ? parseFloat(ccmRamText) : undefined;
  const ioCount = getNum('IONb');

  const voltageEl = mcuEl.querySelector('Voltage');
  const voltage = {
    min: parseFloat(voltageEl?.getAttribute('Min') ?? '0'),
    max: parseFloat(voltageEl?.getAttribute('Max') ?? '0'),
  };

  const tempEl = mcuEl.querySelector('Temperature');
  const temperature = {
    min: parseFloat(tempEl?.getAttribute('Min') ?? '0'),
    max: parseFloat(tempEl?.getAttribute('Max') ?? '0'),
  };

  // Parse peripherals
  const peripherals: Peripheral[] = [];
  const ipEls = mcuEl.querySelectorAll('IP');
  for (const ipEl of ipEls) {
    const instanceName = ipEl.getAttribute('InstanceName') ?? '';
    const originalType = ipEl.getAttribute('Name') ?? '';
    const version = ipEl.getAttribute('Version') ?? '';
    const clockEnable = ipEl.getAttribute('ClockEnableMode') || undefined;
    const configFile = ipEl.getAttribute('ConfigFile') || undefined;

    peripherals.push({
      instanceName,
      type: normalizePeripheralType(originalType),
      originalType,
      version,
      clockEnable: clockEnable === 'none' ? undefined : clockEnable,
      configFile,
    });
  }

  // Peripheral types that use the analog switch path (not digital AF mux)
  const ANALOG_PERIPHERAL_TYPES = new Set(['ADC', 'DAC', 'OPAMP', 'COMP']);

  // Parse pins
  // First pass: build PhysicalPin per unique Position. Each <Pin> XML row
  // becomes a LogicalPin attached to its position's PhysicalPin.
  const physicalPinByPosition = new Map<string, PhysicalPin>();
  const logicalPins: LogicalPin[] = [];
  const pinEls = mcuEl.querySelectorAll('Pin');
  for (const pinEl of pinEls) {
    const rawName = pinEl.getAttribute('Name') ?? '';
    const position = pinEl.getAttribute('Position') ?? '0';
    const type = parsePinType(pinEl.getAttribute('Type') ?? '');
    const variant = pinEl.getAttribute('Variant') ?? undefined;

    // Detect _C pins (low-impedance analog switch variants, e.g. PC2_C, PA0_C).
    // These share the same digital AF signals as the base pin but have different
    // analog (ADC) channels. Keep them as separate logical pins with only analog signals.
    const isCPin = /^P[A-Z]\d+_C$/.test(rawName);
    const gpioMatch = rawName.match(/^(P[A-Z]\d+)/);
    const name = isCPin ? rawName : (gpioMatch ? gpioMatch[1] : rawName.split('-')[0]);

    const signals: Signal[] = [];
    const signalEls = pinEl.querySelectorAll('Signal');
    for (const sigEl of signalEls) {
      const sigName = sigEl.getAttribute('Name') ?? '';
      const ioModes = sigEl.getAttribute('IOModes') || undefined;

      const expandedNames = splitHyphenatedSignal(sigName);
      for (const rawSigName of expandedNames) {
        const collapsed = collapseSignalName(rawSigName);
        const parsed = parseSignalName(collapsed);

        if (isCPin) {
          if (!parsed.peripheralType || !ANALOG_PERIPHERAL_TYPES.has(parsed.peripheralType)) {
            continue;
          }
        }

        signals.push({
          name: collapsed,
          ioModes,
          peripheralInstance: parsed.peripheralInstance,
          peripheralType: parsed.peripheralType,
          instanceNumber: parsed.instanceNumber,
          signalFunction: parsed.signalFunction,
        });
      }
    }

    const gpio = isCPin ? null : parseGpioName(name);
    if (gpio) {
      const portNum = gpioPortNumber(gpio.port);
      const gpioSignalName = `GPIO${portNum}_${gpio.number}`;
      signals.push({
        name: gpioSignalName,
        peripheralInstance: `GPIO${portNum}`,
        peripheralType: 'GPIO',
        instanceNumber: portNum,
        signalFunction: String(gpio.number),
      });
    }

    let physical = physicalPinByPosition.get(position);
    if (!physical) {
      physical = { position, logicals: [] };
      physicalPinByPosition.set(position, physical);
    }

    const logical: LogicalPin = {
      name,
      type,
      signals,
      gpioPort: gpio?.port,
      gpioNumber: gpio?.number,
      isAssignable: type === 'I/O' || type === 'MonoIO',
      isDefaultVariant: variant === undefined,
      variantGroup: variant,
      physical,
    };
    physical.logicals.push(logical);
    logicalPins.push(logical);
  }

  const physicalPins = Array.from(physicalPinByPosition.values());

  // Build derived lookup tables
  const logicalPinByName = new Map<string, LogicalPin>();
  const logicalPinsByName = new Map<string, LogicalPin[]>();
  const logicalPinByGpioName = new Map<string, LogicalPin>();
  const signalToLogicalPins = new Map<string, LogicalPin[]>();
  const peripheralByInstance = new Map<string, Peripheral>();
  const typeToInstances = new Map<string, string[]>();
  const peripheralSignals = new Map<string, Set<string>>();
  const logicalSignalSet = new Map<string, Set<string>>();

  for (const p of peripherals) {
    peripheralByInstance.set(p.instanceName, p);

    const instances = typeToInstances.get(p.type) ?? [];
    instances.push(p.instanceName);
    typeToInstances.set(p.type, instances);
  }

  const gpioInstances = new Set<string>();

  for (const lp of logicalPins) {
    if (!logicalPinByName.has(lp.name)) {
      logicalPinByName.set(lp.name, lp);
    }
    const sameName = logicalPinsByName.get(lp.name) ?? [];
    sameName.push(lp);
    logicalPinsByName.set(lp.name, sameName);

    const gpio = parseGpioName(lp.name);
    if (gpio) {
      logicalPinByGpioName.set(gpio.baseName, lp);
    }

    const sigSet = new Set<string>();
    for (const sig of lp.signals) {
      sigSet.add(sig.name);

      if (sig.name !== 'GPIO') {
        const arr = signalToLogicalPins.get(sig.name) ?? [];
        arr.push(lp);
        signalToLogicalPins.set(sig.name, arr);
      }

      if (sig.peripheralInstance) {
        const sigs = peripheralSignals.get(sig.peripheralInstance) ?? new Set();
        sigs.add(sig.name);
        peripheralSignals.set(sig.peripheralInstance, sigs);

        if (sig.peripheralType === 'GPIO') {
          gpioInstances.add(sig.peripheralInstance);
        }
      }
    }
    logicalSignalSet.set(lp.name, sigSet);
  }

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
      const instances = typeToInstances.get('GPIO') ?? [];
      instances.push(gpioInst);
      typeToInstances.set('GPIO', instances);
    }
  }

  return {
    refName,
    family,
    line,
    package: packageName,
    cores,
    frequency,
    flash,
    ram,
    ccmRam,
    ioCount,
    voltage,
    temperature,
    hasPowerPad,
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
  };
}

/**
 * Parse an MCU XML file (File object from drag-and-drop or file picker).
 */
export async function parseMcuXmlFile(file: File): Promise<Mcu> {
  const text = await file.text();
  return parseMcuXml(text);
}

/**
 * Validate a parsed MCU structure.
 */
export function validateMcu(mcu: Mcu): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!mcu.refName) errors.push('Missing MCU RefName');
  if (!mcu.package) errors.push('Missing package type');
  if (mcu.logicalPins.length === 0) errors.push('No pins found');

  // Structural checks: every logical pin's physical back-ref must round-trip.
  for (const lp of mcu.logicalPins) {
    const phys = mcu.physicalPinByPosition.get(lp.physical.position);
    if (phys !== lp.physical) {
      errors.push(`LogicalPin ${lp.name} has stale physical back-ref at position ${lp.physical.position}`);
    } else if (!phys.logicals.includes(lp)) {
      errors.push(`PhysicalPin ${phys.position} is missing logical ${lp.name}`);
    }
  }
  for (const phys of mcu.physicalPins) {
    if (phys.logicals.length === 0) {
      errors.push(`PhysicalPin ${phys.position} has no logical pins`);
    }
  }

  // Warn (deduped by instance) about signals referencing unknown peripheral instances.
  // Multi-token instance names (USB_OTG_HS, USB_DEVICE) and CubeMX placeholder
  // signals (TIMX, IR, CRS, CEC, AUDIOCLK) trigger this in volume — surface
  // each unknown once instead of per-pin.
  const seenUnknown = new Set<string>();
  for (const lp of mcu.logicalPins) {
    for (const sig of lp.signals) {
      if (sig.peripheralInstance && !mcu.peripheralByInstance.has(sig.peripheralInstance)) {
        if (seenUnknown.has(sig.peripheralInstance)) continue;
        seenUnknown.add(sig.peripheralInstance);
        warnings.push(`Signal references unknown peripheral instance: ${sig.peripheralInstance}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
