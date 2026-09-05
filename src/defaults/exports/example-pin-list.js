// id: example-pin-list
// name: Pin List
// description: List of used pins with port/signal mapping
// param: sortby enum(pin,port) = pin | Sort rows by | Order rows by package pin name or by port.channel
// param: header bool = true | Header row | Include the MCU name and column header lines
const lines = [];
if (params.header) {
  lines.push(mcuName + '  ' + mcuPackage, '');
}

// Group signals per pin
const pinMap = new Map();
for (const a of assignments) {
  const key = a.pinName + '\0' + a.portName + '.' + a.channelName;
  if (!pinMap.has(key)) pinMap.set(key, { pin: a.pinName, port: a.portName + '.' + a.channelName, signals: new Set() });
  pinMap.get(key).signals.add(a.signalName);
}

const rows = [...pinMap.values()].sort((a, b) => params.sortby === 'port'
  ? a.port.localeCompare(b.port) || a.pin.localeCompare(b.pin, undefined, { numeric: true })
  : a.pin.localeCompare(b.pin, undefined, { numeric: true }));

// Find column widths
const hdr = ['Pin', 'Port.Channel', 'Signal'];
const w = hdr.map((h, i) => Math.max(h.length, ...rows.map(r => [r.pin, r.port, [...r.signals].join(', ')][i].length)));

if (params.header) {
  lines.push(hdr.map((h, i) => h.padEnd(w[i])).join('  '));
  lines.push(w.map(n => '-'.repeat(n)).join('  '));
}
for (const r of rows) {
  lines.push([r.pin.padEnd(w[0]), r.port.padEnd(w[1]), [...r.signals].join(', ')].join('  '));
}

// Channels declared in the constraints that got no pin (e.g. skipped GPIO)
const mapped = new Set(assignments.map(a => a.portName + '.' + a.channelName));
const unmapped = [];
for (const port of (ports || [])) {
  for (const ch of (port.channels || [])) {
    if (!mapped.has(port.name + '.' + ch.name)) unmapped.push(port.name + '.' + ch.name);
  }
}
if (unmapped.length > 0) {
  lines.push('', 'Unmapped channels:');
  for (const ch of unmapped) lines.push('  ' + ch);
}

return lines.join('\n');
