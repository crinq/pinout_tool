import type { DmaData, DmaStreamInfo, DmaRequest } from '../types';

/**
 * Parse a mode name from the DMA XML ModeLogicOperator section.
 *
 * Examples:
 *   "USART1_TX"                 → signals: ["USART1_TX"]
 *   "TIM5_CH3/UP"               → signals: ["TIM5_CH3", "TIM5_UP"]
 *   "TIM2_CH2/CH4"              → signals: ["TIM2_CH2", "TIM2_CH4"]
 *   "TIM1_CH4/TRIG/COM"         → signals: ["TIM1_CH4", "TIM1_TRIG", "TIM1_COM"]
 *   "USART3_TX:DMA_CHANNEL_7"   → signals: ["USART3_TX"]
 *   "I2S3_EXT_RX:DMA_CHANNEL_2" → signals: ["I2S3_EXTRX"]
 *   "SDIO:Conflict:SDIO_RX,..."  → null (skip)
 *   "MEMTOMEM"                   → null (skip)
 */
function parseModeName(name: string): { signalNames: string[]; peripheralInstance: string } | null {
  // Skip memory-to-memory transfers
  if (name === 'MEMTOMEM') return null;

  // Skip conflict entries
  if (name.includes(':Conflict:')) return null;

  // Strip channel override suffix (e.g., ":DMA_CHANNEL_7")
  const colonIdx = name.indexOf(':');
  const signalPart = colonIdx >= 0 ? name.substring(0, colonIdx) : name;

  // Split on "/" for multi-signal entries
  const parts = signalPart.split('/');
  const firstSignal = collapseSignalFunction(parts[0]);

  // Extract instance prefix (everything before the last underscore)
  const lastUnderscore = firstSignal.lastIndexOf('_');
  const instancePrefix = lastUnderscore >= 0 ? firstSignal.substring(0, lastUnderscore) : firstSignal;

  const signalNames = [firstSignal];
  for (let i = 1; i < parts.length; i++) {
    signalNames.push(collapseSignalFunction(instancePrefix + '_' + parts[i]));
  }

  return { signalNames, peripheralInstance: instancePrefix };
}

/**
 * Collapse extra underscores in the function part of a signal name,
 * matching the normalization applied by mcu-xml-parser's collapseSignalName.
 * "I2S3_EXT_RX" → "I2S3_EXTRX"
 */
function collapseSignalFunction(name: string): string {
  const idx = name.indexOf('_');
  if (idx === -1) return name;
  const instance = name.substring(0, idx);
  const func = name.substring(idx + 1);
  return instance + '_' + func.replace(/_/g, '');
}

/**
 * Parse a DMA XML string (STM32CubeMX DMA modes file) into DmaData.
 *
 * The relevant section is the <ModeLogicOperator> tree at the end of the file,
 * structured as:
 *   <ModeLogicOperator Name="OR">       ← root
 *     <Mode Name="DMA1">                ← controller
 *       <ModeLogicOperator Name="OR">
 *         <Mode Name="DMA1_Stream0">    ← stream
 *           <ModeLogicOperator Name="XOR">
 *             <Mode Name="USART1_TX">   ← peripheral request
 *             <Mode Name="SPI1_RX">
 *             ...
 */
export function parseDmaXml(xmlString: string): DmaData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`DMA XML parse error: ${parseError.textContent}`);
  }

  const ipEl = doc.querySelector('IP');
  if (!ipEl) {
    throw new Error('No <IP> element found in DMA XML');
  }

  const version = ipEl.getAttribute('Version') ?? '';

  const streams: DmaStreamInfo[] = [];

  // Find the root ModeLogicOperator
  const rootOperator = ipEl.querySelector(':scope > ModeLogicOperator');
  if (!rootOperator) {
    return buildDmaData(version, streams);
  }

  // Iterate DMA controllers (DMA1, DMA2, ...)
  // H7 uses "DMA1, DMA2" as a single controller group with range-based stream names
  for (const controllerMode of rootOperator.querySelectorAll(':scope > Mode')) {
    const controllerNameRaw = controllerMode.getAttribute('Name') ?? '';
    if (!controllerNameRaw.startsWith('DMA')) continue;

    const controllerOp = controllerMode.querySelector(':scope > ModeLogicOperator');
    if (!controllerOp) continue;

    // Iterate streams (DMA1_Stream0, ..., or range: "DMA1_Stream[0-7]:DMA2_Stream[0-7]")
    for (const streamMode of controllerOp.querySelectorAll(':scope > Mode')) {
      const streamNameRaw = streamMode.getAttribute('Name') ?? '';
      if (!streamNameRaw.includes('Stream')) continue;

      // Parse peripheral requests (shared across expanded streams)
      const requests: DmaRequest[] = [];
      const xorOp = streamMode.querySelector(':scope > ModeLogicOperator');
      if (!xorOp) continue;

      for (const requestMode of xorOp.querySelectorAll(':scope > Mode')) {
        const modeName = requestMode.getAttribute('Name') ?? '';
        const parsed = parseModeName(modeName);
        if (!parsed) continue;

        requests.push({
          signalNames: parsed.signalNames,
          peripheralInstance: parsed.peripheralInstance,
        });
      }

      // Expand stream name ranges (e.g., "DMA1_Stream[0-7]:DMA2_Stream[0-7]" → 16 streams)
      const expandedStreams = expandStreamRange(streamNameRaw);

      for (const { name, controller, streamNumber } of expandedStreams) {
        streams.push({ name, controller, streamNumber, requests: [...requests] });
      }
    }
  }

  return buildDmaData(version, streams);
}

/**
 * Expand a stream name that may contain ranges.
 * "DMA1_Stream0" → [{ name: "DMA1_Stream0", controller: "DMA1", streamNumber: 0 }]
 * "DMA1_Stream[0-7]:DMA2_Stream[0-7]" → 16 entries (DMA1_Stream0..7, DMA2_Stream0..7)
 */
function expandStreamRange(raw: string): Array<{ name: string; controller: string; streamNumber: number }> {
  // Split on ":" to handle multi-controller ranges
  const segments = raw.split(':');
  const result: Array<{ name: string; controller: string; streamNumber: number }> = [];

  for (const segment of segments) {
    const rangeMatch = segment.match(/^(DMA\d+)_Stream\[(\d+)-(\d+)\]$/);
    if (rangeMatch) {
      const controller = rangeMatch[1];
      const lo = parseInt(rangeMatch[2], 10);
      const hi = parseInt(rangeMatch[3], 10);
      for (let i = lo; i <= hi; i++) {
        result.push({ name: `${controller}_Stream${i}`, controller, streamNumber: i });
      }
    } else {
      const numMatch = segment.match(/^(DMA\d+)_Stream(\d+)$/);
      if (numMatch) {
        result.push({ name: segment, controller: numMatch[1], streamNumber: parseInt(numMatch[2], 10) });
      }
    }
  }

  return result;
}

function buildDmaData(version: string, streams: DmaStreamInfo[]): DmaData {
  const signalToDmaStreams = new Map<string, DmaStreamInfo[]>();
  const instanceToDmaStreams = new Map<string, DmaStreamInfo[]>();

  for (const stream of streams) {
    for (const req of stream.requests) {
      // Index by each signal name
      for (const sigName of req.signalNames) {
        const arr = signalToDmaStreams.get(sigName) ?? [];
        arr.push(stream);
        signalToDmaStreams.set(sigName, arr);
      }

      // For peripheral-level requests (no function part, e.g. "ADC1", "DAC1"),
      // also index by instance name for broader matching
      if (req.signalNames.length === 1 && !req.signalNames[0].includes('_')) {
        const arr = instanceToDmaStreams.get(req.peripheralInstance) ?? [];
        arr.push(stream);
        instanceToDmaStreams.set(req.peripheralInstance, arr);
      }
    }
  }

  return { version, streams, signalToDmaStreams, instanceToDmaStreams };
}

/**
 * Find DMA streams that can service a given signal.
 * Checks both exact signal name match and peripheral instance match.
 */
export function findDmaStreamsForSignal(
  dma: DmaData,
  signalName: string,
  peripheralInstance?: string
): DmaStreamInfo[] {
  // Try exact signal name match first
  const bySignal = dma.signalToDmaStreams.get(signalName);
  if (bySignal && bySignal.length > 0) return bySignal;

  // Fall back to peripheral instance match
  if (peripheralInstance) {
    return dma.instanceToDmaStreams.get(peripheralInstance) ?? [];
  }

  return [];
}

/**
 * Detect whether an XML string is a DMA modes file (vs. MCU pinout file).
 * DMA files have <IP IPType="service" Name="DMA" ...> as root.
 */
export function isDmaXml(xmlString: string): boolean {
  // Quick check without full parsing
  return xmlString.includes('IPType="service"') && xmlString.includes('Name="DMA"');
}

/**
 * Extract the DMA version string from a DMA XML string.
 */
export function getDmaXmlVersion(xmlString: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const ipEl = doc.querySelector('IP');
  return ipEl?.getAttribute('Version') ?? null;
}

