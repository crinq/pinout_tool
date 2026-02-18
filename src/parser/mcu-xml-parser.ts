import {
  type Mcu, type Peripheral, type Pin, type PinType, type Signal,
  normalizePeripheralType,
} from '../types';

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

  const core = getText('Core');
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

  // Parse pins
  const pins: Pin[] = [];
  const pinEls = mcuEl.querySelectorAll('Pin');
  for (const pinEl of pinEls) {
    const rawName = pinEl.getAttribute('Name') ?? '';
    const gpioMatch = rawName.match(/^(P[A-Z]\d+)/);
    const name = gpioMatch ? gpioMatch[1] : rawName.split('-')[0];
    const position = pinEl.getAttribute('Position') ?? '0';
    const type = parsePinType(pinEl.getAttribute('Type') ?? '');

    const signals: Signal[] = [];
    const signalEls = pinEl.querySelectorAll('Signal');
    for (const sigEl of signalEls) {
      const sigName = sigEl.getAttribute('Name') ?? '';
      const ioModes = sigEl.getAttribute('IOModes') || undefined;

      // Split hyphenated signal names (e.g., SYS_JTCK-SWCLK → SYS_JTCK + SYS_SWCLK)
      // Then collapse extra underscores in function part (RCC_OSC_IN → RCC_OSCIN)
      const expandedNames = splitHyphenatedSignal(sigName);
      for (const rawName of expandedNames) {
        const collapsed = collapseSignalName(rawName);
        const parsed = parseSignalName(collapsed);
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

    const gpio = parseGpioName(name);

    // Add synthetic GPIO signal (e.g., PA3 → GPIO1_3)
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

    pins.push({
      name,
      position,
      type,
      signals,
      gpioPort: gpio?.port,
      gpioNumber: gpio?.number,
      isAssignable: type === 'I/O' || type === 'MonoIO',
    });
  }

  // Build derived lookup tables
  const pinByName = new Map<string, Pin>();
  const pinByPosition = new Map<string, Pin>();
  const pinByGpioName = new Map<string, Pin>();
  const signalToPins = new Map<string, Pin[]>();
  const peripheralByInstance = new Map<string, Peripheral>();
  const typeToInstances = new Map<string, string[]>();
  const peripheralSignals = new Map<string, Set<string>>();
  const pinSignalSet = new Map<string, Set<string>>();

  for (const p of peripherals) {
    peripheralByInstance.set(p.instanceName, p);

    const instances = typeToInstances.get(p.type) ?? [];
    instances.push(p.instanceName);
    typeToInstances.set(p.type, instances);
  }

  // Track GPIO port instances discovered from pins
  const gpioInstances = new Set<string>();

  for (const pin of pins) {
    pinByName.set(pin.name, pin);

    // Only store first occurrence for duplicate names (power pins like VDD)
    if (!pinByPosition.has(pin.position)) {
      pinByPosition.set(pin.position, pin);
    }

    // Map base GPIO name to pin
    const gpio = parseGpioName(pin.name);
    if (gpio) {
      pinByGpioName.set(gpio.baseName, pin);
    }

    const sigSet = new Set<string>();
    for (const sig of pin.signals) {
      sigSet.add(sig.name);

      if (sig.name !== 'GPIO') {
        const arr = signalToPins.get(sig.name) ?? [];
        arr.push(pin);
        signalToPins.set(sig.name, arr);
      }

      if (sig.peripheralInstance) {
        const sigs = peripheralSignals.get(sig.peripheralInstance) ?? new Set();
        sigs.add(sig.name);
        peripheralSignals.set(sig.peripheralInstance, sigs);

        // Track GPIO instances for peripheral registration
        if (sig.peripheralType === 'GPIO') {
          gpioInstances.add(sig.peripheralInstance);
        }
      }
    }
    pinSignalSet.set(pin.name, sigSet);
  }

  // Register synthetic GPIO peripherals
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
    core,
    frequency,
    flash,
    ram,
    ccmRam,
    ioCount,
    voltage,
    temperature,
    hasPowerPad,
    peripherals,
    pins,
    pinByName,
    pinByPosition,
    pinByGpioName,
    peripheralByInstance,
    signalToPins,
    typeToInstances,
    peripheralSignals,
    pinSignalSet,
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
  if (mcu.pins.length === 0) errors.push('No pins found');

  // Check for duplicate positions among assignable pins
  const positionCounts = new Map<string, number>();
  for (const pin of mcu.pins) {
    if (pin.isAssignable) {
      positionCounts.set(pin.position, (positionCounts.get(pin.position) ?? 0) + 1);
    }
  }
  for (const [pos, count] of positionCounts) {
    if (count > 1) {
      errors.push(`Duplicate position ${pos} among assignable pins`);
    }
  }

  // Warn about signals referencing unknown peripheral instances
  for (const pin of mcu.pins) {
    for (const sig of pin.signals) {
      if (sig.peripheralInstance && !mcu.peripheralByInstance.has(sig.peripheralInstance)) {
        // This is common for some signals; just warn
        warnings.push(`Signal ${sig.name} on pin ${pin.name} references unknown peripheral ${sig.peripheralInstance}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
