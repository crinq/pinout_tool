// id: kicad-schematic
// name: KiCad Schematic
// description: STM32 schematic sheet with decoupling, power symbols and crystal (.kicad_sch)
// param: power bool = true | Power symbols | Place GND / VDD / VDDA power symbols on the supply pins
// param: caps bool = true | Decoupling caps | Place the decoupling / VCAP / NRST / BOOT0 support bank
// param: crystal bool = true | Crystal | Place crystal with load caps and series resistor when OSC pins are mapped
// param: gnd string = GND | GND net | Power symbol name used for ground
// param: v33 string = +3.3V | VDD net | Power symbol name used for VDD / VBAT
// param: v33a string = +3.3VA | VDDA net | Power symbol name used for VDDA
// param: loadcap string = 12pF | Load caps | Crystal load capacitor value
// param: rseries string = 1k | Crystal series R | Series resistor value between crystal and OSC_OUT
// param: hier bool = false | Hierarchical labels | Sheet-interface column left of the CPU: hierarchical label + short trace + net label for every channel
// param: nc bool = true | No-connects | Mark unused GPIO / misc pins with a no-connect cross
// param: footprint string = | Footprint | KiCad footprint override (empty = derive from package name)

// ---------------------------------------------------------------
// Stock KiCad library symbol definitions (verbatim eeschema dumps)
// ---------------------------------------------------------------
const LIB_C = `		(symbol "Device:C"
			(pin_numbers
				(hide yes)
			)
			(pin_names
				(offset 0.254)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(in_pos_files yes)
			(duplicate_pin_numbers_are_jumpers no)
			(property "Reference" "C"
				(at 0.635 2.54 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
					(justify left)
				)
			)
			(property "Value" "C"
				(at 0.635 -2.54 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
					(justify left)
				)
			)
			(property "Footprint" ""
				(at 0.9652 -3.81 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Description" "Unpolarized capacitor"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_keywords" "cap capacitor"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_fp_filters" "C_*"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(symbol "C_0_1"
				(polyline
					(pts
						(xy -2.032 0.762) (xy 2.032 0.762)
					)
					(stroke
						(width 0.508)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy -2.032 -0.762) (xy 2.032 -0.762)
					)
					(stroke
						(width 0.508)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "C_1_1"
				(pin passive line
					(at 0 3.81 270)
					(length 2.794)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
				(pin passive line
					(at 0 -3.81 90)
					(length 2.794)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "2"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;
const LIB_CRYSTAL = `		(symbol "Device:Crystal_GND24_Small"
			(pin_names
				(offset 1.016)
				(hide yes)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(in_pos_files yes)
			(duplicate_pin_numbers_are_jumpers no)
			(property "Reference" "Y"
				(at 1.27 4.445 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
					(justify left)
				)
			)
			(property "Value" "Crystal_GND24_Small"
				(at 1.27 2.54 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
					(justify left)
				)
			)
			(property "Footprint" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Description" "Four pin crystal, GND on pins 2 and 4, small symbol"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property private "KLC_S3.3" "The rectangle is not a symbol body but a graphical element"
				(at 0 -10.16 0)
				(show_name yes)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property private "KLC_S4.1" "Some pins are on 50mil grid to make the symbol small"
				(at 0 -12.7 0)
				(show_name yes)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_keywords" "quartz ceramic resonator oscillator"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_fp_filters" "Crystal*"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(symbol "Crystal_GND24_Small_0_1"
				(polyline
					(pts
						(xy -1.27 1.27) (xy -1.27 1.905) (xy 1.27 1.905) (xy 1.27 1.27)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy -1.27 -0.762) (xy -1.27 0.762)
					)
					(stroke
						(width 0.381)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy -1.27 -1.27) (xy -1.27 -1.905) (xy 1.27 -1.905) (xy 1.27 -1.27)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(rectangle
					(start -0.762 -1.524)
					(end 0.762 1.524)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy 1.27 -0.762) (xy 1.27 0.762)
					)
					(stroke
						(width 0.381)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "Crystal_GND24_Small_1_1"
				(pin passive line
					(at -2.54 0 0)
					(length 1.27)
					(name "1"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 0.762 0.762)
							)
						)
					)
				)
				(pin passive line
					(at 0 -2.54 90)
					(length 0.635)
					(name "G"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "2"
						(effects
							(font
								(size 0.762 0.762)
							)
						)
					)
				)
				(pin passive line
					(at 2.54 0 180)
					(length 1.27)
					(name "3"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "3"
						(effects
							(font
								(size 0.762 0.762)
							)
						)
					)
				)
				(pin passive line
					(at 0 -2.54 90)
					(length 0.635)
					(hide yes)
					(name "G"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "4"
						(effects
							(font
								(size 0.762 0.762)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;
const LIB_R = `		(symbol "Device:R"
			(pin_numbers
				(hide yes)
			)
			(pin_names
				(offset 0)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(in_pos_files yes)
			(duplicate_pin_numbers_are_jumpers no)
			(property "Reference" "R"
				(at 2.032 0 90)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Value" "R"
				(at 0 0 90)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Footprint" ""
				(at -1.778 0 90)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Description" "Resistor"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_keywords" "R res resistor"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_fp_filters" "R_*"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(symbol "R_0_1"
				(rectangle
					(start -1.016 -2.54)
					(end 1.016 2.54)
					(stroke
						(width 0.254)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "R_1_1"
				(pin passive line
					(at 0 3.81 270)
					(length 1.27)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
				(pin passive line
					(at 0 -3.81 90)
					(length 1.27)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "2"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;
const LIB_P33V = `		(symbol "power:+3.3V"
			(power global)
			(pin_numbers
				(hide yes)
			)
			(pin_names
				(offset 0)
				(hide yes)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(in_pos_files yes)
			(duplicate_pin_numbers_are_jumpers no)
			(property "Reference" "#PWR"
				(at 0 -3.81 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Value" "+3.3V"
				(at 0 3.556 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Footprint" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Description" "Power symbol creates a global label with name \\"+3.3V\\""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_keywords" "global power"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(symbol "+3.3V_0_1"
				(polyline
					(pts
						(xy -0.762 1.27) (xy 0 2.54)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy 0 2.54) (xy 0.762 1.27)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy 0 0) (xy 0 2.54)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "+3.3V_1_1"
				(pin power_in line
					(at 0 0 90)
					(length 0)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;
const LIB_P33VA = `		(symbol "power:+3.3VA"
			(power global)
			(pin_numbers
				(hide yes)
			)
			(pin_names
				(offset 0)
				(hide yes)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(in_pos_files yes)
			(duplicate_pin_numbers_are_jumpers no)
			(property "Reference" "#PWR"
				(at 0 -3.81 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Value" "+3.3VA"
				(at 0 3.556 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Footprint" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Description" "Power symbol creates a global label with name \\"+3.3VA\\""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_keywords" "global power"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(symbol "+3.3VA_0_1"
				(polyline
					(pts
						(xy -0.762 1.27) (xy 0 2.54)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy 0 2.54) (xy 0.762 1.27)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
				(polyline
					(pts
						(xy 0 0) (xy 0 2.54)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "+3.3VA_1_1"
				(pin power_in line
					(at 0 0 90)
					(length 0)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;
const LIB_GND = `		(symbol "power:GND"
			(power global)
			(pin_numbers
				(hide yes)
			)
			(pin_names
				(offset 0)
				(hide yes)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(in_pos_files yes)
			(duplicate_pin_numbers_are_jumpers no)
			(property "Reference" "#PWR"
				(at 0 -6.35 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Value" "GND"
				(at 0 -3.81 0)
				(show_name no)
				(do_not_autoplace no)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Footprint" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Description" "Power symbol creates a global label with name \\"GND\\" , ground"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "ki_keywords" "global power"
				(at 0 0 0)
				(show_name no)
				(do_not_autoplace no)
				(hide yes)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(symbol "GND_0_1"
				(polyline
					(pts
						(xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)
					)
					(stroke
						(width 0)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "GND_1_1"
				(pin power_in line
					(at 0 0 270)
					(length 0)
					(name ""
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 1.27 1.27)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const mm = (v) => Math.round(v * 100) / 100;

// Rename a stock power-symbol definition when the user overrides the net name.
function powerDef(def, stockName, userName) {
  if (userName === stockName) return def;
  return def.split('power:' + stockName).join('power:' + userName)
            .split('"' + stockName + '"').join('"' + esc(userName) + '"')
            .split('"' + stockName + '_0_1"').join('"' + esc(userName) + '_0_1"')
            .split('"' + stockName + '_1_1"').join('"' + esc(userName) + '_1_1"')
            .split('\\"' + stockName + '\\"').join('\\"' + esc(userName) + '\\"');
}

// Best-effort KiCad footprint from the vendor package name (stock lib names;
// the "footprint" param overrides). BGA counts follow ST's "+25" convention
// where the KiCad layout includes the extra center balls.
function kicadFootprint(pkg) {
  const m = /^LQFP(\d+)$/.exec(pkg);
  if (m) {
    const sizes = { 32: ['7x7', '0.8'], 44: ['10x10', '0.8'], 48: ['7x7', '0.5'], 64: ['10x10', '0.5'], 80: ['12x12', '0.5'], 100: ['14x14', '0.5'], 144: ['20x20', '0.5'], 176: ['24x24', '0.5'], 208: ['28x28', '0.5'] };
    const s = sizes[m[1]];
    if (s) return 'Package_QFP:LQFP-' + m[1] + '_' + s[0] + 'mm_P' + s[1] + 'mm';
  }
  const table = {
    UFQFPN32: 'Package_DFN_QFN:UFQFPN-32-1EP_5x5mm_P0.5mm_EP3.5x3.5mm',
    UFQFPN48: 'Package_DFN_QFN:UFQFPN-48-1EP_7x7mm_P0.5mm_EP5.6x5.6mm',
    UFBGA64: 'Package_BGA:UFBGA-64_5x5mm_Layout8x8_P0.5mm',
    UFBGA100: 'Package_BGA:UFBGA-100_7x7mm_Layout12x12_P0.5mm',
    UFBGA132: 'Package_BGA:UFBGA-132_7x7mm_Layout12x12_P0.5mm',
    UFBGA144: 'Package_BGA:UFBGA-144_7x7mm_Layout12x12_P0.5mm',
    UFBGA169: 'Package_BGA:UFBGA-169_7x7mm_Layout13x13_P0.5mm',
    UFBGA176: 'Package_BGA:UFBGA-201_10x10mm_Layout15x15_P0.65mm',
    TFBGA64: 'Package_BGA:TFBGA-64_5x5mm_Layout8x8_P0.5mm',
    TFBGA100: 'Package_BGA:TFBGA-100_8x8mm_Layout10x10_P0.8mm',
    TFBGA216: 'Package_BGA:TFBGA-216_13x13mm_Layout15x15_P0.8mm',
    TFBGA240: 'Package_BGA:TFBGA-265_14x14mm_Layout17x17_P0.8mm',
  };
  return table[pkg] || '';
}

// ---------------------------------------------------------------
// Pin model: merge bonded logical pins per physical pad, classify.
// ---------------------------------------------------------------
const assignByPin = new Map();      // logical pin name -> assignment
for (const a of assignments) {
  if (!assignByPin.has(a.pinName)) assignByPin.set(a.pinName, a);
}

const pads = new Map();             // position -> { number, names[], signals Map, types Set }
for (const p of pins) {
  let pad = pads.get(p.position);
  if (!pad) { pad = { number: p.position, names: [], signals: new Map(), types: new Set() }; pads.set(p.position, pad); }
  pad.names.push(p.name);
  pad.types.add(p.type);
  for (const s of p.signals || []) if (s.name && s.name !== 'GPIO') pad.signals.set(s.name, true);
}

const isGpioName = (n) => /^P[A-Z]\d+(_C)?$/.test(n);
// Only the classic supply pins get power symbols / decoupling; every other
// power-ish pin ("pwrx": VDDLDO, VDD33_USB, VLXSMPS, PDR_ON, ...) is drawn on
// the top edge but left unconnected for manual wiring.
const cls = (pad) => {
  const n = pad.names[0];
  if (/^VSS/.test(n) || /^VREF-$|^VREFM$/.test(n)) return 'gnd';
  if (/^VDDA/.test(n) || /^VREF\+$|^VREFP$/.test(n)) return 'vdda';
  if (/^VCAP/.test(n)) return 'vcap';
  if (/^VDD\d*$/.test(n) || n === 'VBAT') return 'vdd';
  if (pad.types.has('Reset') || /^NRST|^RST/.test(n)) return 'reset';
  if (pad.types.has('Boot') || /^BOOT/.test(n)) return 'boot';
  if (pad.names.some(isGpioName)) return 'gpio';
  if (pad.types.has('Power') || /^V[A-Z0-9]+/.test(n)) return 'pwrx';
  return 'misc';
};

const groups = { gnd: [], vdd: [], vdda: [], vcap: [], reset: [], boot: [], gpio: [], pwrx: [], misc: [] };
for (const pad of pads.values()) groups[cls(pad)].push(pad);

// GPIO: sort by port letter, then number; keep ports contiguous per edge.
const gpioKey = (pad) => {
  const m = /^P([A-Z])(\d+)/.exec(pad.names.find(isGpioName) || pad.names[0]);
  return m ? [m[1], parseInt(m[2], 10)] : ['Z', 999];
};
groups.gpio.sort((a, b) => {
  const ka = gpioKey(a), kb = gpioKey(b);
  return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] - kb[1];
});
for (const k of ['gnd', 'vdd', 'vdda', 'vcap', 'reset', 'boot', 'pwrx', 'misc']) {
  groups[k].sort((a, b) => a.names[0].localeCompare(b.names[0], undefined, { numeric: true }));
}

// Merge identically-named VDD / VSS pads: the first pad keeps a visible pin,
// the rest stack hidden at the same spot (KiCad stacked-pin convention), so a
// single power symbol drives them all.
const splitStack = (list, name) => {
  const same = list.filter(p => p.names.length === 1 && p.names[0] === name);
  const rest = list.filter(p => !same.includes(p));
  return { vis: same[0] || null, hidden: same.slice(1), rest };
};
const vddSplit = splitStack(groups.vdd.filter(p => p.names[0] !== 'VBAT'), 'VDD');
const vbatPads = groups.vdd.filter(p => p.names[0] === 'VBAT');
const vssSplit = splitStack(groups.gnd, 'VSS');

// Top edge groups (a free pitch between them; two before the manual-wiring
// block). Bottom edge: VSS stack, then the analog grounds.
const topGroups = [
  [...vbatPads, ...(vddSplit.vis ? [vddSplit.vis] : []), ...vddSplit.rest],
  groups.vdda,
  groups.vcap,
].filter(g => g.length > 0);
if (groups.pwrx.length > 0) topGroups.push(null, groups.pwrx);  // extra gap before the manual block
const botGroups = [
  vssSplit.vis ? [vssSplit.vis] : [],
  vssSplit.rest,
].filter(g => g.length > 0);

// Split GPIO ports between right (PA0 top right) and left edge, whole ports.
const byPort = new Map();
for (const pad of groups.gpio) {
  const port = gpioKey(pad)[0];
  if (!byPort.has(port)) byPort.set(port, []);
  byPort.get(port).push(pad);
}
const leftHeader = [...groups.reset, ...groups.boot, ...groups.misc];
const rightPorts = [];
const leftPorts = [];
const rowsOf = (ports) => ports.reduce((n, p) => n + p.length, 0) + Math.max(0, ports.length - 1);
for (const [, list] of byPort) {
  if (rowsOf(rightPorts) <= leftHeader.length + 3 + rowsOf(leftPorts)) rightPorts.push(list);
  else leftPorts.push(list);
}

// ---------------------------------------------------------------
// MCU library symbol
// ---------------------------------------------------------------
const P = 2.54;                              // grid pitch
const PIN_LEN = 5.08;
const slotCount = (gs) => gs.reduce((n, g) => n + (g === null ? 1 : g.length), 0) + Math.max(0, gs.length - 1);
const topSlots = slotCount(topGroups);
const botSlots = slotCount(botGroups);
// Vertical clearance under the top/bottom edges so the vertical pin names
// don't collide with the side pin names in the corners.
const edgeNames = (gs) => gs.flatMap(g => g || []).map(p => p.names.join('/').length);
const vMargin = (gs) => Math.max(2 * P, Math.ceil((Math.max(0, ...edgeNames(gs)) * 1.1 + P) / P) * P);
const marginTop = vMargin(topGroups);
const marginBot = vMargin(botGroups);
const sideRowsR = rowsOf(rightPorts);
const sideRowsL = leftHeader.length + 3 + rowsOf(leftPorts);
const sideRows = Math.max(sideRowsR, sideRowsL);
const halfW = Math.max(40.64, Math.ceil(((Math.max(topSlots, botSlots) + 4) * P) / 2 / P) * P);
const bodyTop = Math.ceil(((sideRows - 1) * P + marginTop + marginBot) / 2 / P) * P;
const sideY0 = bodyTop - marginTop;          // first side-pin row
const bodyBot = sideY0 - (sideRows - 1) * P - marginBot;

const pinDefs = [];                          // lib-symbol pin s-exprs
const pinSheet = new Map();                  // pad.number -> {x, y, edge} connection point (lib coords)
function libPin(pad, x, y, rot, etype, hidden) {
  const name = pad.names.join('/');
  const alts = [...pad.signals.keys()].filter(s => s !== name).sort();
  pinDefs.push('\t\t\t\t(pin ' + etype + ' line\n'
    + '\t\t\t\t\t(at ' + mm(x) + ' ' + mm(y) + ' ' + rot + ')\n'
    + '\t\t\t\t\t(length ' + PIN_LEN + ')\n'
    + (hidden ? '\t\t\t\t\t(hide yes)\n' : '')
    + '\t\t\t\t\t(name "' + esc(name) + '"\n\t\t\t\t\t\t(effects\n\t\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n'
    + '\t\t\t\t\t(number "' + esc(pad.number) + '"\n\t\t\t\t\t\t(effects\n\t\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n'
    + alts.map(a2 => '\t\t\t\t\t(alternate "' + esc(a2) + '" ' + etype + ' line)\n').join('')
    + '\t\t\t\t)');
  // connection point in lib coords (pin base sits on the body edge, "at" IS the endpoint)
  pinSheet.set(pad.number, { x, y, edge: rot });
}

let y = sideY0;
for (const list of rightPorts) {
  for (const pad of list) { libPin(pad, halfW + PIN_LEN, y, 180, 'bidirectional'); y -= P; }
  y -= P;                                    // free pitch between ports
}
y = sideY0;
for (const pad of leftHeader) { libPin(pad, -halfW - PIN_LEN, y, 0, 'input'); y -= P; }
y -= 3 * P;
for (const list of leftPorts) {
  for (const pad of list) { libPin(pad, -halfW - PIN_LEN, y, 0, 'bidirectional'); y -= P; }
  y -= P;
}
// stack maps: hidden pads emitted at the visible pin's spot
const stackAt = new Map();                   // hidden pad -> visible pad
for (const h of vddSplit.hidden) stackAt.set(h, vddSplit.vis);
for (const h of vssSplit.hidden) stackAt.set(h, vssSplit.vis);
let x = -halfW + 2 * P;
for (const g of topGroups) {
  if (g === null) { x += P; continue; }
  for (const pad of g) { libPin(pad, x, bodyTop + PIN_LEN, 270, 'power_in'); x += P; }
  x += P;
}
x = -halfW + 2 * P;
for (const g of botGroups) {
  for (const pad of g) { libPin(pad, x, bodyBot - PIN_LEN, 90, 'power_in'); x += P; }
  x += P;
}
for (const [h, vis] of stackAt) {
  const at = pinSheet.get(vis.number);
  libPin(h, at.x, at.y, at.edge, 'power_in', true);
}

const mcuLibId = 'pinout_tool:' + mcuName;
const datasheet = (typeof docs === 'object' && docs && docs.datasheet) ? docs.datasheet : '';
// MCU summary line (as shown in the app header); constraints doc header as fallback.
const description = (typeof mcuInfo === 'string' && mcuInfo)
  ? mcuInfo
  : ((typeof constraintsHeader === 'string' ? constraintsHeader : '').split('\n')[0] || '');
const fpProp = params.footprint || kicadFootprint(mcuPackage);

const prop = (name, value, px, py, hide) =>
  '\t\t\t(property "' + esc(name) + '" "' + esc(value) + '"\n'
  + '\t\t\t\t(at ' + mm(px) + ' ' + mm(py) + ' 0)\n'
  + '\t\t\t\t(show_name no)\n\t\t\t\t(do_not_autoplace no)\n'
  + (hide ? '\t\t\t\t(hide yes)\n' : '')
  + '\t\t\t\t(effects\n\t\t\t\t\t(font\n\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t)\n\t\t\t\t\t(justify left)\n\t\t\t\t)\n\t\t\t)';

const LIB_MCU = '\t\t(symbol "' + mcuLibId + '"\n'
  + '\t\t\t(exclude_from_sim no)\n\t\t\t(in_bom yes)\n\t\t\t(on_board yes)\n\t\t\t(in_pos_files yes)\n\t\t\t(duplicate_pin_numbers_are_jumpers no)\n'
  + prop('Reference', 'U', -halfW, bodyTop + 2 * P, false) + '\n'
  + prop('Value', mcuName, halfW / 2, bodyTop + 2 * P, false) + '\n'
  + prop('Footprint', fpProp, -halfW, bodyBot - 2 * P, true) + '\n'
  + prop('Datasheet', datasheet, 0, 0, true) + '\n'
  + prop('Description', description, 0, 0, true) + '\n'
  + '\t\t\t(symbol "' + esc(mcuName) + '_0_1"\n'
  + '\t\t\t\t(rectangle\n\t\t\t\t\t(start ' + mm(-halfW) + ' ' + mm(bodyBot) + ')\n\t\t\t\t\t(end ' + mm(halfW) + ' ' + mm(bodyTop) + ')\n'
  + '\t\t\t\t\t(stroke\n\t\t\t\t\t\t(width 0.254)\n\t\t\t\t\t\t(type default)\n\t\t\t\t\t)\n\t\t\t\t\t(fill\n\t\t\t\t\t\t(type background)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t)\n'
  + '\t\t\t(symbol "' + esc(mcuName) + '_1_1"\n'
  + pinDefs.join('\n') + '\n'
  + '\t\t\t)\n\t\t)';

// ---------------------------------------------------------------
// Sheet: placed symbols, labels, wires
// ---------------------------------------------------------------
const rootUuid = uuid();
const project = mcuName;
const sym = [];        // placed symbol s-exprs
const graphics = [];   // wires / labels / text
let refC = 0, refR = 0, refPwr = 0;

const instBlock = (ref) =>
  '\t\t(instances\n\t\t\t(project "' + esc(project) + '"\n\t\t\t\t(path "/' + rootUuid + '"\n\t\t\t\t\t(reference "' + esc(ref) + '")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)\n\t\t\t)\n\t\t)';

const iprop = (name, value, px, py, hide, rot) =>
  '\t\t(property "' + esc(name) + '" "' + esc(value) + '"\n'
  + '\t\t\t(at ' + mm(px) + ' ' + mm(py) + ' ' + (rot || 0) + ')\n'
  + (hide ? '\t\t\t(hide yes)\n' : '')
  + '\t\t\t(show_name no)\n\t\t\t(do_not_autoplace no)\n'
  + '\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t)\n\t\t)';

function placeSymbol(libId, ref, value, x, y, pinNums, opts) {
  const o = opts || {};
  const refAt = o.refAt || [x + 2.54, y - 1.27, 0];
  const valAt = o.valAt || [x + 2.54, y + 1.27, 0];
  const pinLines = pinNums.map(n => {
    const alt = o.pinAlt && o.pinAlt.get(String(n));
    return '\t\t(pin "' + esc(String(n)) + '"\n\t\t\t(uuid "' + uuid() + '")\n' + (alt ? '\t\t\t(alternate "' + esc(alt) + '")\n' : '') + '\t\t)';
  }).join('\n');
  sym.push('\t(symbol\n\t\t(lib_id "' + esc(libId) + '")\n\t\t(at ' + mm(x) + ' ' + mm(y) + ' ' + (o.rot || 0) + ')\n'
    + '\t\t(unit 1)\n\t\t(body_style 1)\n\t\t(exclude_from_sim no)\n\t\t(in_bom yes)\n\t\t(on_board yes)\n\t\t(in_pos_files yes)\n\t\t(dnp no)\n'
    + '\t\t(uuid "' + uuid() + '")\n'
    + iprop('Reference', ref, refAt[0], refAt[1], ref.startsWith('#'), refAt[2]) + '\n'
    + iprop('Value', value, valAt[0], valAt[1], false, valAt[2]) + '\n'
    + iprop('Footprint', o.footprint || '', x, y, true) + '\n'
    + iprop('Datasheet', o.datasheet || '', x, y, true) + '\n'
    + iprop('Description', o.description || '', x, y, false) + '\n'
    + pinLines + '\n'
    + instBlock(ref) + '\n\t)');
}

const wire = (x1, y1, x2, y2) =>
  graphics.push('\t(wire\n\t\t(pts\n\t\t\t(xy ' + mm(x1) + ' ' + mm(y1) + ') (xy ' + mm(x2) + ' ' + mm(y2) + ')\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid "' + uuid() + '")\n\t)');

const label = (text, x, y, rot, justify) =>
  graphics.push('\t(label "' + esc(text) + '"\n\t\t(at ' + mm(x) + ' ' + mm(y) + ' ' + rot + ')\n'
    + '\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.27 1.27)\n\t\t\t)\n\t\t\t(justify ' + justify + ')\n\t\t)\n\t\t(uuid "' + uuid() + '")\n\t)');

const note = (text, x, y, justify) =>
  graphics.push('\t(text "' + esc(text) + '"\n\t\t(exclude_from_sim no)\n\t\t(at ' + mm(x) + ' ' + mm(y) + ' 0)\n'
    + '\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.27 1.27)\n\t\t\t\t(italic yes)\n\t\t\t)\n\t\t\t(justify ' + justify + ')\n\t\t)\n\t\t(uuid "' + uuid() + '")\n\t)');

const junction = (x, y) =>
  graphics.push('\t(junction\n\t\t(at ' + mm(x) + ' ' + mm(y) + ')\n\t\t(diameter 0)\n\t\t(color 0 0 0 0)\n\t\t(uuid "' + uuid() + '")\n\t)');

const hlabel = (text, x, y) =>
  graphics.push('\t(hierarchical_label "' + esc(text) + '"\n\t\t(shape bidirectional)\n\t\t(at ' + mm(x) + ' ' + mm(y) + ' 180)\n'
    + '\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.27 1.27)\n\t\t\t)\n\t\t\t(justify right)\n\t\t)\n\t\t(uuid "' + uuid() + '")\n\t)');

const noConnect = (x, y) =>
  graphics.push('\t(no_connect\n\t\t(at ' + mm(x) + ' ' + mm(y) + ')\n\t\t(uuid "' + uuid() + '")\n\t)');

// Power symbol whose connection point sits exactly at (x, y). The value text
// is tucked to the free side depending on where the symbol sits.
const PWR_VAL_AT = {
  top:       (x, y) => [x, y - 6.096, 90],   // row above the MCU
  bottom:    (x, y) => [x, y + 4.826, 90],   // row below the MCU
  rowTop:    (x, y) => [x, y - 4.28, 0],     // above a support-bank part
  rowBottom: (x, y) => [x, y + 4.102, 0],    // below a support-bank part
};
function placePower(net, x, y, style) {
  refPwr++;
  placeSymbol('power:' + net, '#PWR' + String(refPwr).padStart(2, '0'), net, x, y, [1],
    { valAt: PWR_VAL_AT[style || 'rowBottom'](x, y) });
}

// --- MCU instance ------------------------------------------------
// Left label column at x = 170.18 like the reference sheet; everything stays
// on the 1.27 mm grid.
const MX = mm(177.8 + halfW);
const MY = mm(63.5 + bodyTop);
const pinAlt = new Map();                    // pin number -> selected alternate
const padByLogical = new Map();
for (const pad of pads.values()) for (const n of pad.names) padByLogical.set(n, pad);
for (const [pinName, a] of assignByPin) {
  const pad = padByLogical.get(pinName);
  if (pad && pad.signals.has(a.signalName) && a.signalName !== pad.names.join('/')) {
    pinAlt.set(String(pad.number), a.signalName);
  }
}
placeSymbol(mcuLibId, 'U1', mcuName, MX, MY, [...pads.values()].map(p => p.number),
  { pinAlt, footprint: fpProp, datasheet, description });

// sheet-coordinate connection point of a pad (lib y flips)
const padXY = (pad) => {
  const p = pinSheet.get(pad.number);
  return { x: MX + p.x, y: MY - p.y, edge: p.edge };
};
const textW = (s) => s.length * 1.1;         // rough text extent at 1.27 font

// A short stub wire out of a pin with a net label at its end.
const usedPads = new Set();                  // pads with a label / symbol attached
function pinLabel(pad, text) {
  usedPads.add(pad.number);
  const c = padXY(pad);
  if (c.edge === 180) {           // right edge
    wire(c.x, c.y, c.x + P, c.y);
    label(text, c.x + P, c.y, 0, 'left bottom');
  } else if (c.edge === 0) {      // left edge
    wire(c.x, c.y, c.x - P, c.y);
    label(text, c.x - P, c.y, 180, 'right bottom');
  } else if (c.edge === 270) {    // top edge
    wire(c.x, c.y, c.x, c.y - P);
    label(text, c.x, c.y - P, 90, 'left bottom');
  } else {                        // bottom edge
    wire(c.x, c.y, c.x, c.y + P);
    label(text, c.x, c.y + P, 270, 'right bottom');
  }
  return c;
}

// --- labels + comments on mapped pins ---------------------------
const labelFor = (a) => a.portName === '<pinned>' ? a.signalName : a.portName + '.' + a.channelName;
for (const [pinName, a] of assignByPin) {
  const pad = padByLogical.get(pinName);
  if (!pad) continue;
  const text = labelFor(a);
  const c = pinLabel(pad, text);
  if (!a.channelComment) continue;
  if (c.edge === 180) note(a.channelComment, c.x + P + textW(text) + P, c.y, 'left bottom');
  else if (c.edge === 0) note(a.channelComment, c.x - P - textW(text) - P, c.y, 'right bottom');
}

// --- channel column left of the CPU --------------------------------
// With `hier` on: every channel (grouped by port, one free row between
// ports) gets a hierarchical label, a short trace and a matching net label —
// the sheet interface. With `hier` off, only channels that got no pin (e.g.
// skipped GPIO in/out) are placed as dangling net labels to drag onto pins.
const mappedCh = new Set();
for (const a of assignments) if (a.portName !== '<pinned>') mappedCh.add(a.portName + '.' + a.channelName);
const columnCh = [];
for (const port of (ports || [])) {
  for (const ch of (port.channels || [])) {
    const key = port.name + '.' + ch.name;
    if (params.hier || !mappedCh.has(key)) {
      columnCh.push({ key, comment: mappedCh.has(key) ? null : (ch.comment || null), port: port.name });
    }
  }
}
if (columnCh.length > 0) {
  // clear of the left-edge pin labels and their comments
  let leftExtent = MX - halfW - PIN_LEN - P;
  for (const [pinName, a] of assignByPin) {
    const pad = padByLogical.get(pinName);
    if (!pad || pinSheet.get(pad.number).edge !== 0) continue;
    let e = MX - halfW - PIN_LEN - P - textW(labelFor(a));
    if (a.channelComment) e -= 2 * P + textW(a.channelComment);
    if (e < leftExtent) leftExtent = e;
  }
  const maxW = Math.max(...columnCh.map(u => textW(u.key)));
  // hier rows: hlabel — 2.54 trace — net label (text runs right, keep it clear)
  const colX = mm(Math.floor((leftExtent - 2 * P - (params.hier ? maxW + P : 0)) / 1.27) * 1.27);
  let ly = MY - bodyTop + 12.7;
  let prevPort = null;
  for (const u of columnCh) {
    if (prevPort !== null && u.port !== prevPort) ly += P;   // gap between ports
    prevPort = u.port;
    if (params.hier) {
      hlabel(u.key, colX, mm(ly));
      wire(colX, mm(ly), colX + P, mm(ly));
      label(u.key, colX + P, mm(ly), 0, 'left bottom');
      if (u.comment) note(u.comment, colX - 2 * P, mm(ly), 'right bottom');
    } else {
      label(u.key, colX, mm(ly), 180, 'right bottom');
      if (u.comment) note(u.comment, colX - textW(u.key) - 2 * P, mm(ly), 'right bottom');
    }
    ly += P;
  }
  // With the interface column in place, the unmapped channels still need
  // free (unconnected) labels to drag onto pins — a second block below it.
  if (params.hier) {
    const unmapped = columnCh.filter(u => !mappedCh.has(u.key));
    prevPort = null;
    ly += P;
    for (const u of unmapped) {
      if (prevPort !== null && u.port !== prevPort) ly += P;
      prevPort = u.port;
      label(u.key, colX, mm(ly), 180, 'right bottom');
      ly += P;
    }
  }
}

// --- power pins --------------------------------------------------
// Only the visible pin of a VDD / VSS stack gets a symbol; hidden stacked
// pins connect through it.
if (params.power) {
  const gndVis = [...(vssSplit.vis ? [vssSplit.vis] : []), ...vssSplit.rest];
  for (const pad of gndVis) {
    const c = padXY(pad);
    wire(c.x, c.y, c.x, c.y + P);
    placePower(params.gnd, c.x, c.y + P, 'bottom');
  }
  for (const pad of [...vbatPads, ...(vddSplit.vis ? [vddSplit.vis] : []), ...vddSplit.rest]) {
    const c = padXY(pad);
    wire(c.x, c.y, c.x, c.y - P);
    placePower(params.v33, c.x, c.y - P, 'top');
  }
  for (const pad of groups.vdda) {
    const c = padXY(pad);
    wire(c.x, c.y, c.x, c.y - P);
    placePower(params.v33a, c.x, c.y - P, 'top');
  }
}
// VCAP pins connect to their caps by net label, always.
for (const pad of groups.vcap) pinLabel(pad, pad.names[0]);

// --- support bank: decoupling / VCAP / NRST / BOOT0 --------------
// Parts are arranged in rows to the right of the MCU (clear of the right-edge
// labels and comments): net on top, part, GND below, everything joined by
// short stub wires on the grid.
let rightExtent = MX + halfW + PIN_LEN + P;
for (const [pinName, a] of assignByPin) {
  const pad = padByLogical.get(pinName);
  if (!pad || pinSheet.get(pad.number).edge !== 180) continue;
  let e = MX + halfW + PIN_LEN + P + textW(labelFor(a));
  if (a.channelComment) e += 2 * P + textW(a.channelComment);
  if (e > rightExtent) rightExtent = e;
}
const bankX0 = mm(Math.ceil((rightExtent + 2 * P) / 1.27) * 1.27);
const row0Y = mm(MY - bodyTop + 12.7);       // first row starts at the MCU's top edge
const ROW_DY = 31.75, COL_DX = 10.16, MAX_COLS = 8;
let col = 0, row = 0;
const nextCol = () => {
  if (col >= MAX_COLS) { col = 0; row++; }
  return { x: mm(bankX0 + col++ * COL_DX), y: mm(row0Y + row * ROW_DY) };
};
const newRow = () => { if (col > 0) { col = 0; row++; } };
const groupGap = () => { col++; };
function capColumn(topNet, value, kind) {
  refC++;
  const c = nextCol();
  if (kind === 'label') { label(topNet, c.x, c.y - 6.35, 90, 'left bottom'); }
  else placePower(topNet, c.x, c.y - 6.35, 'rowTop');
  wire(c.x, c.y - 6.35, c.x, c.y - 3.81);
  placeSymbol('Device:C', 'C' + refC, value, c.x, c.y, [1, 2],
    { refAt: [c.x + 3.048, c.y - 2.286, 0], valAt: [c.x + 3.302, c.y + 2.032, 0] });
  wire(c.x, c.y + 3.81, c.x, c.y + 6.35);
  placePower(params.gnd, c.x, c.y + 6.35, 'rowBottom');
}
function resColumn(topNet, value) {
  refR++;
  const c = nextCol();
  label(topNet, c.x, c.y - 6.35, 90, 'left bottom');
  wire(c.x, c.y - 6.35, c.x, c.y - 3.81);
  placeSymbol('Device:R', 'R' + refR, value, c.x, c.y, [1, 2],
    { refAt: [c.x - 2.032, c.y, 90], valAt: [c.x, c.y, 90] });
  wire(c.x, c.y + 3.81, c.x, c.y + 6.35);
  placePower(params.gnd, c.x, c.y + 6.35, 'rowBottom');
}
if (params.caps) {
  // 100nF per physical VDD / VBAT pad (stacked pads included) + one bulk cap
  const n100 = vbatPads.length + (vddSplit.vis ? 1 : 0) + vddSplit.hidden.length + vddSplit.rest.length;
  for (let i = 0; i < n100; i++) capColumn(params.v33, '100nF', 'v33');
  capColumn(params.v33, '1uF', 'v33');
  newRow();
  if (groups.vdda.length > 0) { capColumn(params.v33a, '100nF', 'v33a'); capColumn(params.v33a, '1uF', 'v33a'); groupGap(); }
  for (const pad of groups.vcap) capColumn(pad.names[0], '2.2uF', 'label');
  if (groups.vcap.length > 0) groupGap();
  if (groups.reset.length > 0) capColumn(groups.reset[0].names.join('/'), '100nF', 'label');
  if (groups.boot.length > 0) { groupGap(); resColumn(groups.boot[0].names.join('/'), '10k'); }
  // NRST / BOOT0 pins need matching labels at the MCU so the nets connect.
  for (const pad of [...groups.reset, ...groups.boot]) {
    if (assignByPin.has(pad.names[0])) continue;   // already labeled as a mapped pin
    pinLabel(pad, pad.names.join('/'));
  }
}

// --- crystal -----------------------------------------------------
// Same layout as the reference sheet: OSC_IN drops onto the crystal's pin 1
// with its load cap; OSC_OUT runs through the series R into pin 3 with the
// second load cap; the GND24 shield pins go straight down to ground.
const oscIn = assignments.find(a => /_OSCIN$|_OSC_IN$/.test(a.signalName));
const oscOut = assignments.find(a => /_OSCOUT$|_OSC_OUT$/.test(a.signalName));
if (params.crystal && oscIn && oscOut) {
  newRow();
  const qx = mm(bankX0 + 7.62), qy = mm(row0Y + row * ROW_DY + 12.7);
  placeSymbol('Device:Crystal_GND24_Small', 'Y1', 'Crystal', qx, qy, [1, 2, 3, 4],
    { refAt: [qx, qy - 3.048, 0], valAt: [qx + 3.556, qy + 3.302, 0] });
  wire(qx, qy + 2.54, qx, qy + 12.7);              // shield to GND
  placePower(params.gnd, qx, qy + 12.7, 'rowBottom');
  // left leg: OSC_IN + load cap
  label(labelFor(oscIn), qx - 7.62, qy - 2.54, 90, 'left bottom');
  wire(qx - 7.62, qy - 2.54, qx - 7.62, qy);
  wire(qx - 7.62, qy, qx - 2.54, qy);
  junction(qx - 7.62, qy);
  wire(qx - 7.62, qy, qx - 7.62, qy + 2.54);
  refC++;
  placeSymbol('Device:C', 'C' + refC, params.loadcap, qx - 7.62, qy + 6.35, [1, 2],
    { refAt: [qx - 7.62 + 3.048, qy + 6.35 - 2.286, 0], valAt: [qx - 7.62 + 3.302, qy + 6.35 + 2.032, 0] });
  wire(qx - 7.62, qy + 10.16, qx - 7.62, qy + 12.7);
  placePower(params.gnd, qx - 7.62, qy + 12.7, 'rowBottom');
  // right leg: series R from OSC_OUT down to pin 3 + load cap
  label(labelFor(oscOut), qx + 7.62, qy - 12.7, 90, 'left bottom');
  wire(qx + 7.62, qy - 12.7, qx + 7.62, qy - 10.16);
  refR++;
  placeSymbol('Device:R', 'R' + refR, params.rseries, qx + 7.62, qy - 6.35, [1, 2],
    { rot: 180, refAt: [qx + 7.62 - 2.032, qy - 6.35, 90], valAt: [qx + 7.62, qy - 6.35, 90] });
  wire(qx + 7.62, qy - 2.54, qx + 7.62, qy);
  wire(qx + 2.54, qy, qx + 7.62, qy);
  junction(qx + 7.62, qy);
  wire(qx + 7.62, qy, qx + 7.62, qy + 2.54);
  refC++;
  placeSymbol('Device:C', 'C' + refC, params.loadcap, qx + 7.62, qy + 6.35, [1, 2],
    { refAt: [qx + 7.62 + 3.048, qy + 6.35 - 2.286, 0], valAt: [qx + 7.62 + 3.302, qy + 6.35 + 2.032, 0] });
  wire(qx + 7.62, qy + 10.16, qx + 7.62, qy + 12.7);
  placePower(params.gnd, qx + 7.62, qy + 12.7, 'rowBottom');
}

// --- no-connect crosses on unused I/O pins -------------------------
// Placed last so every labeled pin is known. Only side-edge pins (GPIO /
// misc / reset / boot) — power pins that still need manual wiring keep
// their ERC reminder instead.
if (params.nc) {
  for (const pad of [...groups.gpio, ...groups.misc, ...groups.reset, ...groups.boot]) {
    if (usedPads.has(pad.number)) continue;
    const c = padXY(pad);
    noConnect(c.x, c.y);
  }
}

// ---------------------------------------------------------------
// Assemble the document
// ---------------------------------------------------------------
const libSymbols = [
  LIB_C,
  LIB_CRYSTAL,
  LIB_R,
  powerDef(LIB_P33V, '+3.3V', params.v33),
  powerDef(LIB_P33VA, '+3.3VA', params.v33a),
  powerDef(LIB_GND, 'GND', params.gnd),
  LIB_MCU,
].filter(Boolean).join('\n');

const content = '(kicad_sch\n'
  + '\t(version 20260306)\n'
  + '\t(generator "pinout_tool")\n'
  + '\t(generator_version "1.0")\n'
  + '\t(uuid "' + rootUuid + '")\n'
  + '\t(paper "A2")\n'
  + '\t(lib_symbols\n' + libSymbols + '\n\t)\n'
  + graphics.join('\n') + '\n'
  + sym.join('\n') + '\n'
  + '\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n'
  + '\t(embedded_fonts no)\n'
  + ')\n';

return { filename: mcuName + '.kicad_sch', content, mimeType: 'application/x-kicad-schematic' };
