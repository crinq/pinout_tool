// id: kicad-labels
// name: KiCad Label Strip
// description: Channel/GPIO label pairs joined by traces, as pasteable KiCad schematic text
// param: bus bool = false | Bus per port | Group the channels of each port on a labeled bus
// param: shortbus bool = true | Compact bus ranges | Collapse numbered channels in the bus label (D0, D1, D2 -> D[0..2])
// param: alias bool = false | Bus aliases | Label each bus PORT{ALIAS}, ports with the same channels sharing one alias, plus one comment holding the bus_aliases block to paste into the .kicad_pro file
// param: sheetpin bool = false | Sheet pins | With Bus per port: put a hierarchical label (sheet pin) with the bus name on the left end of each bus
// param: nettie bool = true | Net ties | Join each channel label to its GPIO label through a NetTie_2, so ERC does not flag two labels on one net
// param: gpiolist bool = false | GPIO label list | Append a separate stack of labels for every GPIO pin, mapped and unused (to drop onto the CPU symbol)
// param: freelist bool = false | Unused GPIO list | Append a stack of labels for all unmapped GPIO pins

// One line per channel: `PORT.CHANNEL ----- PA1   SIGNALS`. A channel mapped
// to several pins repeats; an unmapped channel keeps the open trace. The
// output is a KiCad s-expression fragment — copy it and paste straight into
// the schematic canvas.
const P = 2.54, STEP = 5.08;                 // P: line spacing (grid pitch), STEP: trace length
const parts = [];
const fmt = (v) => String(Math.round(v * 100) / 100);
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const wire = (x1, y1, x2, y2) =>
  parts.push('(wire\n\t(pts\n\t\t(xy ' + fmt(x1) + ' ' + fmt(y1) + ') (xy ' + fmt(x2) + ' ' + fmt(y2) + ')\n\t)\n\t(stroke (width 0) (type default))\n)');
const busLine = (x1, y1, x2, y2) =>
  parts.push('(bus\n\t(pts\n\t\t(xy ' + fmt(x1) + ' ' + fmt(y1) + ') (xy ' + fmt(x2) + ' ' + fmt(y2) + ')\n\t)\n\t(stroke (width 0) (type default))\n)');
const busEntry = (x, y) =>
  parts.push('(bus_entry\n\t(at ' + fmt(x) + ' ' + fmt(y) + ')\n\t(size 2.54 2.54)\n\t(stroke (width 0) (type default))\n)');
const label = (t, x, y, rot, justify) =>
  parts.push('(label "' + esc(t) + '"\n\t(at ' + fmt(x) + ' ' + fmt(y) + ' ' + rot + ')\n\t(effects\n\t\t(font (size 1.27 1.27))\n\t\t(justify ' + justify + ')\n\t)\n)');
const sheetPin = (t, x, y) =>               // hierarchical label, connection point at (x, y), text to the left
  parts.push('(hierarchical_label "' + esc(t) + '"\n\t(shape bidirectional)\n\t(at ' + fmt(x) + ' ' + fmt(y) + ' 180)\n\t(effects\n\t\t(font (size 1.27 1.27))\n\t\t(justify right)\n\t)\n)');
let tieCount = 0;
const netTie = (x, y) => {                   // Device:NetTie_2, pins at x ± 2.54
  tieCount++;
  parts.push('(symbol\n\t(lib_id "Device:NetTie_2")\n\t(at ' + fmt(x) + ' ' + fmt(y) + ' 0)\n\t(unit 1)\n\t(body_style 1)\n\t(exclude_from_sim no)\n\t(in_bom no)\n\t(on_board yes)\n\t(in_pos_files yes)\n\t(dnp no)\n\t(fields_autoplaced yes)\n\t(property "Reference" "NT' + tieCount + '"\n\t\t(at ' + fmt(x) + ' ' + fmt(y - STEP) + ' 0)\n\t\t(hide yes)\n\t\t(show_name no)\n\t\t(do_not_autoplace no)\n\t\t(effects\n\t\t\t(font (size 1.27 1.27))\n\t\t)\n\t)\n)');
};
// Where a row's GPIO label goes, given where its channel trace ends. With
// net ties the trace ends on the tie's left pin and a short wire after its
// right pin carries the GPIO label — on unmapped rows too, ready for a pin.
const TIE_W = params.nettie ? 3 * P : 0;
const pinEnd = (xEnd, y) => {
  if (params.nettie) {
    netTie(xEnd + P, y);
    wire(xEnd + 2 * P, y, xEnd + TIE_W, y);
  }
  return xEnd + TIE_W;
};
const text = (t, x, y, justify = 'left bottom') =>
  parts.push('(text "' + esc(t) + '"\n\t(exclude_from_sim no)\n\t(at ' + fmt(x) + ' ' + fmt(y) + ' 0)\n\t(effects\n\t\t(font (size 1.27 1.27))\n\t\t(justify ' + justify + ')\n\t)\n)');

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
// D0, D1, D2, D5, CLK -> D[0..2], D5, CLK (one entry per range). Order
// follows first appearance; singletons keep their original spelling.
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
    out.push(...runs.map(text => ({ idx: g.idx, text })));   // stable sort keeps run order
  }
  return out.sort((a, b) => a.idx - b.idx).map(o => o.text);
}

// Layout: three side-by-side columns — all GPIO labels, unused GPIO
// labels, then the channel (or bus) list.
const X0 = 25.4, Y0 = 25.4;
let colX = X0;

// GPIO label stacks for the CPU symbol's pins, one free line between ports.
const usedPins = new Set();
for (const a of assignments) usedPins.add(a.pinName);
let bottomY = Y0;                            // lowest row used by any column
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
  bottomY = Math.max(bottomY, gy);
  colX += Math.ceil((maxLen * 1.1 + 2 * P) / P) * P;       // next column
};
const gpioPins = (pins || []).map(p => p.name).filter(n => /^P[A-Z]\d+(_C)?$/.test(n));
if (params.gpiolist) {
  // every GPIO pin plus any mapped pin the GPIO filter does not cover
  text('gpio labels', colX, Y0 - STEP);
  stack([...new Set([...usedPins, ...gpioPins])]);
}
if (params.freelist) {
  text('free gpios', colX, Y0 - STEP);
  stack([...new Set(gpioPins.filter(n => !usedPins.has(n)))]);
}

// Channel-list column.
//
// Bus aliases: ports with the same members (range copies, template instances
// that add nothing) share one alias, named after their common name stem —
// Encoder_int0, Encoder_int1 -> Encoder_int; a lone port keeps its own name.
const busMembers = (port) => {
  const names = port.chans.map(c => c.key.slice(c.key.indexOf('.') + 1));
  return params.shortbus ? compactNames(names) : names;
};
const commonStem = (names) => {
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/[\d_]+$/, '');
};
const aliases = {};                          // alias name -> members, for the .kicad_pro block
const aliasOf = new Map();                   // port name -> alias name
if (params.bus && params.alias) {
  const groups = new Map();                  // members -> port names
  for (const port of portList) {
    const key = busMembers(port).join(' ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(port);
  }
  for (const group of groups.values()) {
    const names = group.map(p => p.name);
    let name = (names.length > 1 && commonStem(names)) || names[0];
    if (name in aliases) name = names[0];
    for (let n = 2; name in aliases; n++) name = names[0] + '_' + n;
    aliases[name] = busMembers(group[0]);
    for (const pn of names) aliasOf.set(pn, name);
  }
}

const busLabel = (port) =>
  port.name + '{' + (params.alias ? aliasOf.get(port.name) : busMembers(port).join(' ')) + '}';

// Plain mode: PORT.CHANNEL labels extend left of the trace start, so indent
// the column by the longest one. Bus mode: only sheet pins extend left.
const maxKeyW = Math.max(0, ...portList.flatMap(p => p.chans.map(c => c.key.length))) * 1.1;
const maxPinW = params.sheetpin ? Math.max(0, ...portList.map(p => busLabel(p).length)) * 1.1 + P : 0;
const X1 = params.bus
  ? colX + (maxPinW > 0 ? Math.ceil((maxPinW + P) / P) * P : 0)
  : colX + Math.ceil((maxKeyW + P) / P) * P;
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
    // PORT{CH CH ...} ===== bus (KiCad bus group: space-separated members, named PORT.CH),
    // entries fan out to the channel traces. With aliases the label is
    // PORT{ALIAS} and the members go into the bus_aliases block at the end.
    const busX = X1 + 30.48;
    const busY = y;
    label(busLabel(port), X1, busY, 0, 'left bottom');
    if (params.sheetpin) sheetPin(busLabel(port), X1, busY);
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
      const px = pinEnd(wx2, ry);
      if (r.pin) label(r.pin, px, ry, 0, 'left bottom');
      if (r.sigs.length > 0) text(r.sigs.join(', '), px + 7.62, ry);
      if (r.cmt) text(r.cmt, cmtCol(rows, px + 7.62), ry);
    }
    y = busY + P + rows.length * P + STEP;
  } else {
    for (const r of rows) {
      wire(X1, y, X1 + STEP, y);
      label(r.key, X1, y, 180, 'right bottom');
      const px = pinEnd(X1 + STEP, y);
      if (r.pin) label(r.pin, px, y, 0, 'left bottom');
      if (r.sigs.length > 0) text(r.sigs.join(', '), px + 7.62, y);
      if (r.cmt) text(r.cmt, cmtCol(rows, px + 7.62), y);
      y += P;
    }
    y += P;                                  // free line between ports
  }
}

// One comment with every alias, formatted to paste into the .kicad_pro file,
// below all columns; it grows downward from its anchor.
if (Object.keys(aliases).length > 0) {
  text('"bus_aliases": ' + JSON.stringify(aliases, null, 2) + ',', X0, Math.max(bottomY, y) + STEP, 'left top');
}

return parts.join('\n');
