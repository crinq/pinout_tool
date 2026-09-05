// One-off generator: H755IIKx KiCad export sample for manual comparison with
// the hand-tuned reference sheet. Run via esbuild bundle (see kicad docs work).
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseExportParams, defaultParamValues } from '../src/export-params';

const dom = new JSDOM('');
(globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;

const xml = readFileSync(join(process.cwd(), 'test/h755i/STM32H755IIKx.xml'), 'utf-8');
const mcu = parseMcuXml(xml);
const fnSource = readFileSync(join(process.cwd(), 'src/defaults/exports/kicad-schematic.js'), 'utf-8');
const params = parseExportParams(fnSource);

const exec = new Function(
  'mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params',
  'docs', 'constraintsHeader', 'mcuInfo',
  fnSource,
);
const pins = mcu.logicalPins.map(p => ({
  name: p.name, position: p.physical.position, type: p.type,
  gpioPort: p.gpioPort, gpioNumber: p.gpioNumber, isAssignable: p.isAssignable,
  signals: p.signals.map(s => ({ name: s.name })),
}));
const oscIn = mcu.logicalPins.find(p => p.signals.some(s => /RCC_OSC_IN|RCC_OSCIN/.test(s.name)));
const oscOut = mcu.logicalPins.find(p => p.signals.some(s => /RCC_OSC_OUT|RCC_OSCOUT/.test(s.name)));
const assignments = [
  { pinName: 'PA9', signalName: 'USART1_TX', portName: 'CMD', channelName: 'TX', configurationName: 'c', channelComment: 'to host' },
  { pinName: 'PA10', signalName: 'USART1_RX', portName: 'CMD', channelName: 'RX', configurationName: 'c', channelComment: null },
];
if (oscIn && oscOut) {
  assignments.push(
    { pinName: oscIn.name, signalName: oscIn.signals.find(s => /OSC_?IN/.test(s.name))!.name, portName: 'clock', channelName: 'IN', configurationName: 'c', channelComment: null } as never,
    { pinName: oscOut.name, signalName: oscOut.signals.find(s => /OSC_?OUT/.test(s.name))!.name, portName: 'clock', channelName: 'OUT', configurationName: 'c', channelComment: null } as never,
  );
}
const out = exec(mcu.refName, mcu.package, assignments, mcu.peripherals, pins, [], {},
  defaultParamValues(params), null, 'test header', `${mcu.refName} | ${mcu.package} | 480MHz`);
writeFileSync(join(process.cwd(), 'node_modules/.cache/h755-sample.kicad_sch'), out.content);
console.log('written', out.filename, out.content.length, 'osc:', oscIn?.name, oscOut?.name);
