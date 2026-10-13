// id: kicad-labels
// name: KiCad Label Strip
// description: Channel/GPIO label pairs joined by traces, as pasteable KiCad schematic text
// param: bus bool = false | Bus per port | Group the channels of each port on a labeled bus
// param: shortbus bool = true | Compact bus ranges | Collapse numbered channels in the bus label (D0, D1, D2 -> D[0..2])
// param: gpiolist bool = false | GPIO label list | Append a separate stack of all mapped GPIO labels (to drop onto the CPU symbol)
// param: freelist bool = false | Unused GPIO list | Append a stack of labels for all unmapped GPIO pins

// One line per channel: `PORT.CHANNEL ----- PA1   SIGNALS`. A channel mapped
// to several pins repeats; an unmapped channel keeps the open trace. The
// output is a KiCad s-expression fragment — copy it and paste straight into
// the schematic canvas.
const P = 2.54, STEP = 5.08;                 // P: line spacing (grid pitch), STEP: trace length
const parts = [];
const fmt = (v) => String(Math.round(v * 100) / 100);
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const wire = (x1, y1, x2, y2) =>
  parts.push('(wire\n\t(pts\n\t\t(xy ' + fmt(x1) + ' ' + fmt(y1) + ') (xy ' + fmt(x2) + ' ' + fmt(y2) + ')\n\t)\n\t(stroke (width 0) (type default))\n)');
const busLine = (x1, y1, x2, y2) =>
  parts.push('(bus\n\t(pts\n\t\t(xy ' + fmt(x1) + ' ' + fmt(y1) + ') (xy ' + fmt(x2) + ' ' + fmt(y2) + ')\n\t)\n\t(stroke (width 0) (type default))\n)');
const busEntry = (x, y) =>
  parts.push('(bus_entry\n\t(at ' + fmt(x) + ' ' + fmt(y) + ')\n\t(size 2.54 2.54)\n\t(stroke (width 0) (type default))\n)');
const label = (t, x, y, rot, justify) =>
  parts.push('(label "' + esc(t) + '"\n\t(at ' + fmt(x) + ' ' + fmt(y) + ' ' + rot + ')\n\t(effects\n\t\t(font (size 1.27 1.27))\n\t\t(justify ' + justify + ')\n\t)\n)');
const text = (t, x, y) =>
  parts.push('(text "' + esc(t) + '"\n\t(exclude_from_sim no)\n\t(at ' + fmt(x) + ' ' + fmt(y) + ' 0)\n\t(effects\n\t\t(font (size 1.27 1.27))\n\t\t(justify left bottom)\n\t)\n)');

// channel key -> pin -> signals (one row per pin; several configs on the
// same pin merge into one comment list, e.g. "USART1_TX, TIM1_CH2")
const byChannel = new Map();
for (const a of assignments) {
  if (a.portName === '<pinned>') continue;
  const key = a.portName + '.' + a.channelName;
  let pinsM = byChannel.get(key);
  if (!pinsM) { pinsM = new Map(); byChannel.set(key, pinsM); }
  let sigs = pinsM.get(a.pinName);
  if (!sigs) { sigs = new Set(); pinsM.set(a.pinName, sigs); }
  sigs.add(a.signalName);
}

// Ports in declaration order (the context includes unmapped channels);
// any assignment whose channel is not declared is appended at the end.
const portList = [];
const seenCh = new Set();
for (const port of (ports || [])) {
  const chans = (port.channels || []).map(ch => ({ key: port.name + '.' + ch.name, fns: ch.functions || [], cmt: ch.comment || null }));
  if (chans.length > 0) {
    portList.push({ name: port.name, chans });
    for (const c of chans) seenCh.add(c.key);
  }
}
for (const key of byChannel.keys()) {
  if (seenCh.has(key)) continue;
  const pname = key.slice(0, key.indexOf('.'));
  let entry = portList.find(e => e.name === pname && e.extra);
  if (!entry) { entry = { name: pname, chans: [], extra: true }; portList.push(entry); }
  entry.chans.push({ key, fns: [], cmt: null });
}

// Collapse numbered channel names sharing a prefix into KiCad bus ranges:
// D0, D1, D2, D5, CLK -> D[0..2], D5, CLK. Order follows first appearance;
// singletons keep their original spelling.
function compactNames(names) {
  const plain = [];                          // {idx, text}
  const groups = new Map();                  // prefix -> {idx, entries: [{num, name}]}
  names.forEach((name, idx) => {
    const m = /^(.*?)(\d+)$/.exec(name);
    if (!m) { plain.push({ idx, text: name }); return; }
    let g = groups.get(m[1]);
    if (!g) { g = { idx, entries: [] }; groups.set(m[1], g); }
    g.entries.push({ num: parseInt(m[2], 10), name });
  });
  const out = [...plain];
  for (const [prefix, g] of groups) {
    if (g.entries.length < 2) {
      out.push({ idx: g.idx, text: g.entries[0].name });
      continue;
    }
    const nums = [...new Set(g.entries.map(e => e.num))].sort((a, b) => a - b);
    const runs = [];
    let s = nums[0], e = nums[0];
    for (let i = 1; i <= nums.length; i++) {
      if (i < nums.length && nums[i] === e + 1) { e = nums[i]; continue; }
      runs.push(s === e ? prefix + s : prefix + '[' + s + '..' + e + ']');
      if (i < nums.length) s = e = nums[i];
    }
    out.push({ idx: g.idx, text: runs.join(', ') });
  }
  return out.sort((a, b) => a.idx - b.idx).map(o => o.text);
}

// Layout: three side-by-side columns — mapped GPIO labels, unused GPIO
// labels, then the channel (or bus) list.
const X0 = 25.4, Y0 = 25.4;
let colX = X0;

// GPIO label stacks for the CPU symbol's pins, one free line between ports.
const usedPins = new Set();
for (const a of assignments) usedPins.add(a.pinName);
const stack = (names) => {
  let gy = Y0, prevPort = null, maxLen = 4;
  for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const port = (/^P([A-Z])/.exec(n) || [])[1] || '';
    if (prevPort !== null && port !== prevPort) gy += P;   // free line between port groups
    prevPort = port;
    label(n, colX, gy, 0, 'left bottom');
    gy += P;
    if (n.length > maxLen) maxLen = n.length;
  }
  colX += Math.ceil((maxLen * 1.1 + 2 * P) / P) * P;       // next column
};
if (params.gpiolist) {
  text('gpio labels', colX, Y0 - STEP);
  stack([...usedPins]);
}
if (params.freelist) {
  const free = (pins || [])
    .map(p => p.name)
    .filter(n => /^P[A-Z]\d+(_C)?$/.test(n) && !usedPins.has(n));
  text('free gpios', colX, Y0 - STEP);
  stack([...new Set(free)]);
}

// Channel-list column. In plain mode the PORT.CHANNEL labels extend left of
// the trace start, so indent the column by the longest one.
const maxKeyW = Math.max(0, ...portList.flatMap(p => p.chans.map(c => c.key.length))) * 1.1;
const X1 = params.bus ? colX : colX + Math.ceil((maxKeyW + P) / P) * P;
if (portList.length > 0) text('gpio mapping', colX, Y0 - STEP);
let y = Y0;

for (const port of portList) {
  const rows = [];
  for (const c of port.chans) {
    const pinsM = byChannel.get(c.key);
    if (pinsM && pinsM.size > 0) {
      for (const [pin, sigs] of pinsM) rows.push({ key: c.key, pin, sigs: [...sigs], cmt: c.cmt });
    } else {
      rows.push({ key: c.key, pin: null, sigs: c.fns, cmt: c.cmt });
    }
  }
  if (rows.length === 0) continue;

  // second comment column: the channel's line comment from the constraints,
  // aligned past the widest signal/function comment of this block
  const cmtCol = (rows2, x0) =>
    x0 + Math.ceil((Math.max(0, ...rows2.map(r => r.sigs.join(', ').length)) * 1.1 + 2 * P) / P) * P;

  if (params.bus) {
    // PORT(CH, ...) ===== bus, entries fan out to the channel traces
    const busX = X1 + 30.48;
    const busY = y;
    const chNames = port.chans.map(c => c.key.slice(c.key.indexOf('.') + 1));
    const shown = params.shortbus ? compactNames(chNames) : chNames;
    label(port.name + '(' + shown.join(', ') + ')', X1, busY, 0, 'left bottom');
    busLine(X1, busY, busX, busY);
    const lastEntryY = busY + (rows.length - 1) * P;
    if (lastEntryY > busY) busLine(busX, busY, busX, lastEntryY);
    const wx1 = busX + P;                    // bus entry lands one pitch right & down
    // Trace long enough for the port's longest channel label (it sits on the
    // wire, right-justified 2.54 in from the end) — one length per bus.
    const maxKey = Math.max(...rows.map(r => r.key.length));
    const wx2 = wx1 + Math.max(15.24, Math.ceil((maxKey * 1.1 + 2 * P) / P) * P);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ry = busY + i * P + P;
      busEntry(busX, busY + i * P);
      wire(wx1, ry, wx2, ry);
      label(r.key, wx2 - P, ry, 180, 'right bottom');
      if (r.pin) label(r.pin, wx2, ry, 0, 'left bottom');
      if (r.sigs.length > 0) text(r.sigs.join(', '), wx2 + 7.62, ry);
      if (r.cmt) text(r.cmt, cmtCol(rows, wx2 + 7.62), ry);
    }
    y = busY + P + rows.length * P + STEP;
  } else {
    for (const r of rows) {
      wire(X1, y, X1 + STEP, y);
      label(r.key, X1, y, 180, 'right bottom');
      if (r.pin) label(r.pin, X1 + STEP, y, 0, 'left bottom');
      if (r.sigs.length > 0) text(r.sigs.join(', '), X1 + STEP + 7.62, y);
      if (r.cmt) text(r.cmt, cmtCol(rows, X1 + STEP + 7.62), y);
      y += P;
    }
    y += P;                                  // free line between ports
  }
}

return parts.join('\n');
