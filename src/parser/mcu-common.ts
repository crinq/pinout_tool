// ============================================================
// Conventions shared by the CubeMX-XML and vendor-JSON MCU parsers.
// Both must produce identical Signal shapes for the same die, so the
// convention functions live here rather than as per-parser copies.
// ============================================================

/**
 * Collapse underscores in the signal function part so the constraint parser
 * can handle them (it uses underscore as the instance/function separator).
 * e.g., "RCC_OSC_IN" → "RCC_OSCIN", "USB_OTG_HS_ULPI_STP" → "USB_OTGHSULPISTP".
 * The first underscore separates instance from function; later ones are removed.
 */
export function collapseSignalName(name: string): string {
  const idx = name.indexOf('_');
  if (idx === -1) return name;
  const instance = name.substring(0, idx);
  const func = name.substring(idx + 1);
  return instance + '_' + func.replace(/_/g, '');
}

/** Map GPIO port letter to a number (A→1, B→2, ..., I→9). */
export function gpioPortNumber(portLetter: string): number {
  return portLetter.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
}
