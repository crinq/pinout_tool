// ============================================================
// CubeMX .ioc File Parser
//
// Parses STM32CubeMX .ioc project files to extract:
// - MCU reference name (Mcu.Name)
// - Pin-to-signal assignments (e.g. PA5.Signal=SPI1_SCK)
// - Shared signal resolution (SH.* entries)
// ============================================================

export interface IocPinAssignment {
  pinName: string;
  signalName: string;
  /** CubeMX GPIO_Label, if any — emitted as a trailing `# comment` on the pin line. */
  label?: string;
}

export interface IocData {
  mcuName: string;        // e.g. "STM32H755IITx"
  mcuPackage: string;     // e.g. "LQFP176"
  assignments: IocPinAssignment[];
}

/**
 * Split hyphenated signal names into separate signals.
 * e.g., "SYS_JTCK-SWCLK" → ["SYS_JTCK", "SYS_SWCLK"]
 * The instance prefix (before the first '_') is shared across parts.
 */
function splitHyphenatedSignal(name: string): string[] {
  if (!name.includes('-')) return [name];

  const underscoreIdx = name.indexOf('_');
  if (underscoreIdx === -1) return [name];

  const prefix = name.substring(0, underscoreIdx + 1);
  const rest = name.substring(underscoreIdx + 1);
  const parts = rest.split('-');

  return parts.map(part => prefix + part);
}

/**
 * Detect whether a string is a CubeMX .ioc file.
 */
export function isIocFile(text: string): boolean {
  return text.startsWith('#MicroXplorer Configuration settings');
}

/**
 * Parse a CubeMX .ioc file and extract MCU name and pin assignments.
 */
export function parseIocFile(text: string): IocData {
  const lines = text.split('\n');
  const props = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    props.set(trimmed.substring(0, eqIdx), trimmed.substring(eqIdx + 1));
  }

  const mcuName = props.get('Mcu.Name') ?? props.get('Mcu.UserName') ?? '';
  const mcuPackage = props.get('Mcu.Package') ?? '';

  // Build shared signal resolution map: "ADCx_IN4" → "ADC1_IN4"
  // From entries like: SH.ADCx_IN4.0=ADC1_IN4,IN4
  const sharedSignalMap = new Map<string, string>();
  for (const [key, value] of props) {
    if (key.startsWith('SH.') && key.endsWith('.0')) {
      const sharedName = key.slice(3, -2); // "ADCx_IN4"
      const resolved = value.split(',')[0];  // "ADC1_IN4"
      if (resolved) {
        sharedSignalMap.set(sharedName, resolved);
      }
    }
  }

  // P<port><num>, plus the STM32H7 dual-pad analog variant suffix (e.g. PA1_C).
  const pinPattern = /^P[A-K]\d+(_C)?$/;

  // Collect user pin labels (e.g. PA9.GPIO_Label=test) → trailing comments.
  const labels = new Map<string, string>();
  for (const [key, value] of props) {
    if (!key.endsWith('.GPIO_Label')) continue;
    const pinName = key.slice(0, -'.GPIO_Label'.length);
    if (pinPattern.test(pinName) && value.trim()) labels.set(pinName, value.trim());
  }

  // Extract pin assignments from Pxx.Signal entries
  const assignments: IocPinAssignment[] = [];

  for (const [key, value] of props) {
    if (!key.endsWith('.Signal')) continue;
    const rawPin = key.slice(0, -7); // remove ".Signal"
    if (!pinPattern.test(rawPin)) continue;
    // STM32H7 dual-pad analog pins (PA1_C) map to the plain pin name (PA1).
    const pinName = rawPin.replace(/_C$/, '');

    let signalName = value;

    // GPIO-only assignments become the constraint language's IN/OUT shorthand.
    if (signalName === 'GPIO_Output') {
      signalName = 'OUT';
    } else if (signalName.startsWith('GPIO_')) {
      // GPIO_Input / GPIO_Analog / GPIO_EXTI* are all input-direction pins.
      signalName = 'IN';
    } else {
      // Peripheral signal: strip the S_ shared marker, resolve SH.* shared
      // aliases (ADCx_IN4 → ADC1_IN4), and split hyphenated names to match the
      // XML parser (SYS_JTMS-SWDIO → SYS_JTMS). A pin takes one signal.
      if (signalName.startsWith('S_')) signalName = signalName.substring(2);
      const resolved = sharedSignalMap.get(value) ?? sharedSignalMap.get(signalName);
      if (resolved) signalName = resolved;
      signalName = splitHyphenatedSignal(signalName)[0];
    }

    assignments.push({ pinName, signalName, label: labels.get(rawPin) });
  }

  // Sort by pin name for consistent ordering
  assignments.sort((a, b) => a.pinName.localeCompare(b.pinName));

  return { mcuName, mcuPackage, assignments };
}
