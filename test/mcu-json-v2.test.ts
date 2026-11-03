import { it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuJsonDoc, type McuJsonDocument } from '../src/parser/mcu-json-parser';

// Schema v2 (mcu_data ai/format-spec.md §4.7): gpios[*].functions replaces
// alternate_functions + additional_functions. Converting the v1 fixture to v2
// must import to the same pins/signals; routings that need non-default
// register state (`requires` ≠ 0: pin swap, F1 remap) are not imported.
const v1 = JSON.parse(readFileSync(join(__dirname, 'fixtures/stm32f103vb.json'), 'utf-8'));

type V1Gpio = { name: string; alternate_functions?: Record<string, string | string[]>; additional_functions?: string[] };
const toV2 = (doc: { gpios: V1Gpio[] }) => ({
  ...doc,
  schema: 2,
  gpios: doc.gpios.map(({ alternate_functions, additional_functions, ...g }) => ({
    ...g,
    functions: [
      ...Object.entries(alternate_functions ?? {}).flatMap(([af, v]) =>
        (Array.isArray(v) ? v : [v]).map(signal => ({ signal, af: Number(af) }))),
      ...(additional_functions ?? []).map(signal => ({ signal, ...(/ADC/.test(signal) && { analog: true }) })),
    ],
  })),
});

const signalsByPin = (doc: unknown) => {
  const mcu = parseMcuJsonDoc(doc as McuJsonDocument)[0];
  return new Map(mcu.logicalPins.map(p => [p.name, p.signals.map(s => `${s.name}@${s.ioModes ?? ''}`).sort()]));
};

it('imports schema v2 functions like the v1 lists', () => {
  expect(signalsByPin(toV2(v1))).toEqual(signalsByPin(v1));
});

it('skips routings that need non-default register state', () => {
  const v2 = toV2(v1);
  const pa2 = v2.gpios.find((g: { name: string }) => g.name === 'PA2')!;
  pa2.functions.push(
    { signal: 'USART2_RX', af: 7, requires: { 'USART2.CR2.SWAP': 1 } },   // swapped: not imported
    { signal: 'USART2_TX', af: 7, requires: { 'USART2.CR2.SWAP': 0 } },   // default routing: imported once
    { signal: 'TIM9_CH1', requires: { 'AFIO.MAPR2.TIM9_REMAP': 1 } },    // remap: not imported
  );
  const pins = signalsByPin(v2);
  expect(pins.get('PA2')).toEqual(signalsByPin(v1).get('PA2'));
});
