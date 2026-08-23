# STM32 Pinout Tool -- Documentation

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Constraint Language](#constraint-language)
   - [MCU Selection](#mcu-selection)
   - [Package Filter](#package-filter)
   - [Memory Filters](#memory-filters)
   - [Frequency Filter](#frequency-filter)
   - [Temperature Filter](#temperature-filter)
   - [Voltage Filter](#voltage-filter)
   - [Core Filter](#core-filter)
   - [Pin Reservations](#pin-reservations)
   - [Fixed Pin Assignments](#fixed-pin-assignments)
   - [Shared Peripherals](#shared-peripherals)
   - [Ports and Channels](#ports-and-channels)
   - [Configurations](#configurations)
   - [Pin Placement (@)](#pin-placement)
   - [Solver Settings](#solver-settings-settings)
   - [Signal Patterns](#signal-patterns)
   - [Mappings](#mappings)
   - [Variable Assignment ($)](#variable-assignment)
   - [Optional Mappings and Requires](#optional-mappings-and-requires)
   - [Constraints (require)](#constraints-require)
   - [Built-in Functions](#built-in-functions)
   - [Macros](#macros)
   - [Port Templates](#port-templates)
   - [Standard Library](#standard-library)
   - [Common-Error Lint](#common-error-lint)
4. [Practical Examples](#practical-examples)
5. [Package Viewer](#package-viewer)
   - [Comparing Solutions](#comparing-solutions)
6. [Solver](#solver)
7. [Solution Browser](#solution-browser)
   - [Solution Validity Badges](#solution-validity-badges)
   - [Editing a Solution (Modify Mode)](#editing-a-solution-modify-mode)
8. [Project Management](#project-management)

---

## Overview

The STM32 Pinout Tool is a browser-based application for finding optimal pin assignments on STM32 microcontrollers. You describe your hardware requirements using a constraint language -- which peripherals you need, how they relate to each other -- and the solver finds all valid assignments, ranked by cost.

18 solver algorithms are available, ranging from simple single-phase backtracking, through two- and three-phase solvers with instance permutation, to conflict-directed search, CEGAR instance-refinement, local-search repair, and an adaptive portfolio for very hard problems. Multiple solvers can run in parallel using separate Web Workers, with results automatically merged, deduplicated, and ranked.

The tool works entirely in the browser. MCU data is loaded from STM32CubeMX XML files and stored in localStorage, or fetched on demand from a remote catalogue.

You can open this documentation any time with the **Docs** button in the header; the constraint editor's **Syntax Help** button opens a focused language reference.

---

## Getting Started

### Loading MCU Data: remote catalogue (optional)

If you have a hosted vendor JSON catalogue (the layout produced by the
companion `mcu_data` project — `index.json` plus per-die files under
`mcu/<die>.json`), open the **Data Manager**, paste the URL into the
**Remote Data Source** field, and click **Save**. Local `file://` paths
work for testing, GitHub raw / Pages URLs work for production.

- **Browse…** opens a search overlay listing every die in the index.
  Type to filter by name. Click a die to fetch + parse it. Multi-package
  dies present a variant picker before loading.
- The fetched MCU becomes the **current MCU** and is held in an
  in-memory cache (10 dies / 500 KB, whichever fills first). This remote
  cache is transient — cleared on page reload. (MCUs you **Import** from
  XML are stored persistently; see [Loading MCU Data](#loading-mcu-data).)
  Opening a saved project whose MCU isn't stored locally will also
  auto-fetch it from this remote source — see
  [Project Management](#saving-and-loading).

### Multi-MCU Solving with `mcu:` filters

When a constraint contains an `mcu:` filter (or `package:` / `ram:` /
`rom:` / `freq:` filter), the solver iterates every MCU that matches.
Sources are unioned:

1. MCUs already imported via XML drag-drop (live in `localStorage`).
2. MCUs fetched from the remote data source. The index is filtered by
   die name and package, then matching dies are fetched in parallel,
   parsed, and re-filtered at the variant level. Progress shows in the
   status bar; the **Abort** button cancels in-flight fetches.

If neither source produces any matches, the solver reports an error so
you can adjust the filter or import data.

### Loading MCU Data

The tool needs MCU pin/peripheral data from STM32CubeMX XML files:

1. Install [STM32CubeMX](https://www.st.com/en/development-tools/stm32cubemx.html)
2. Navigate to the CubeMX installation folder: `db/mcu/`
3. Find your MCU's XML file (e.g., `STM32G473C(B-E)Tx.xml`)
4. Drag and drop the file onto the app, or click **Import**

Imported MCUs are stored in localStorage and can be reloaded from the **Data** manager.

### Importing CubeMX .ioc Projects (optional)

You can import `.ioc` project files from STM32CubeMX. The tool extracts the MCU name and pin-to-signal assignments, adding them as `pin` declarations to the constraint editor. This lets you use an existing CubeMX project as a starting point. Drag and drop the `.ioc` file or use the **Import** button.

### Loading DMA Data (optional)

To enable DMA stream constraints, load the corresponding DMA modes XML file:

1. In the CubeMX installation folder, navigate to `db/mcu/IP/`
2. Find the DMA file matching your MCU family (e.g., `DMA-STM32F417_dma_v2_0_Modes.xml`)
3. Drag and drop the DMA file onto the app (it will be auto-detected)

The tool matches DMA files to MCUs automatically via the DMA IP version tag. Once loaded, a **DMA** tag appears in the Data manager next to the MCU. DMA data persists in localStorage alongside MCU data.

### First Constraint

After loading an MCU, type constraints in the editor:

```
port CMD:
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)
```

Press **Ctrl+Enter** to solve. The solver finds all valid pin combinations where TX and RX use the same USART instance.

---

## Constraint Language

The constraint language uses indentation-based nesting (2 spaces per level), `#` comments, and keyword-based blocks.

### MCU Selection

```
mcu: STM32G473*
mcu: STM32F405* | STM32F407*
mcu: STM32F[405,407]
```

Glob patterns with `*` wildcard. Multiple patterns separated by `|`. Bracket alternatives with `[a,b]`. Case-insensitive with implicit `*` at end (e.g., `stm32f4` matches `STM32F405VGTx`).

When `mcu:` is present, the solver searches **all matching MCUs stored in the browser** instead of just the currently loaded one. Solutions from all matching MCUs are merged into a single result set. Selecting a solution from a different MCU automatically switches the package viewer.

If omitted, the currently loaded MCU is used.

### Package Filter

```
package: LQFP100
package: LQFP[100,144] | BGA*
package: *176
```

Filter MCUs by package type. Same glob syntax as `mcu:`. Can be combined with `mcu:` or used alone (searches all stored MCUs).

### Memory Filters

```
ram: 256K           # minimum 256KB
ram: < 1M           # maximum 1MB
ram: 128K < 512K    # between 128KB and 512KB
rom: 512K
rom: 256K < 2M
```

Specify RAM and ROM (flash) requirements. Supports suffixes: `K`/`KB` (×1024), `M`/`MB` (×1024²). Without a suffix, the value is in bytes. Use `<` for upper bounds or ranges.

### Frequency Filter

```
freq: 200           # minimum 200 MHz
freq: < 480         # maximum 480 MHz
freq: 100 < 480     # between 100 and 480 MHz
```

Specify CPU frequency requirements in MHz. Use `<` for upper bounds or ranges.

### Temperature Filter

```
temp: -40           # -40°C must be a valid working point (tempMin ≤ -40 ≤ tempMax)
temp: 130           # 130°C must be a valid working point (excludes a 125°C part)
temp: < 125         # 125°C must be a valid working point (same as bare, both ends)
temp: -40 < 85      # the whole -40..85°C range must fit inside the MCU's range
```

Filters MCUs by operating temperature. The value or range specifies **working
point(s) that must lie inside the MCU's `[tempMin, tempMax]` range**. A single
value (with or without `<`) must satisfy `tempMin ≤ value ≤ tempMax`; a range
`lo < hi` must satisfy `tempMin ≤ lo` and `hi ≤ tempMax`.

### Voltage Filter

```
voltage: 3.3        # 3.3V must be a valid working point (voltageMin ≤ 3.3 ≤ voltageMax)
voltage: < 2.5      # 2.5V must be a valid working point (same as bare, both ends)
voltage: 1.8 < 3.6  # the whole 1.8..3.6V range must fit inside the MCU's range
voltage: 3.3V       # optional V suffix ignored
```

Filters MCUs by operating voltage using the same working-point semantics as
temperature: a single value (with or without `<`) must satisfy
`voltageMin ≤ value ≤ voltageMax`, and a range `lo < hi` must satisfy
`voltageMin ≤ lo` and `hi ≤ voltageMax`. Supports decimal values; an optional
`V` unit suffix is accepted and ignored.

### Core Filter

```
core: M4            # MCU must have a Cortex-M4 core
core: M4 | M7      # MCU must have M4 OR M7
core: M4 + M7      # MCU must have both M4 AND M7 (dual-core)
```

Filters MCUs by CPU core type. The pattern is matched case-insensitively against core names (e.g., "M4" matches "Arm Cortex-M4"). Use `|` for alternatives and `+` for requiring multiple cores.

### Pin Reservations

```
reserve: PH0, PH1, PA13, PA14   # by GPIO name
reserve: 11, 42                 # by package position (LQFP)
reserve: A1, B12                # by package position (BGA / WLCSP)
reserve: ADC*, SPI[1,3]         # patterns also match peripheral instances
```

Excludes pins from the solver. Use for crystal oscillator pins, debug pins,
non-routed package pads, etc.

Reserving by **position** locks the package pad — every logical pin bonded
to it (PINREMAP variants on small C0/G0 parts, multi-bond pads on
UFQFPN20/WLCSP, `_C` analog-switch siblings on H7) becomes unavailable as
well. Use this when you need to keep a physical pin clear of any
peripheral signal regardless of which alternate the chip would otherwise
expose.

### Fixed Pin Assignments

```
pin PA4 = DAC1_OUT1
pin PA11 = USB_DM
pin PA12 = USB_DP
```

Forces a specific signal onto a specific pin. The solver respects these and won't use those pins for other assignments.

### Shared Peripherals

By default, a peripheral instance (e.g., ADC1) is exclusive to one port. Use `shared` to allow multiple ports to use the same instance (individual signals remain exclusive):

```
# Exact instance
shared: ADC1

# Wildcard (all ADC instances)
shared: ADC*

# Range and multiple patterns
shared: ADC[1,2], TIM[1-4]
```

This is useful when multiple ports need channels on the same ADC or timer, such as multiple analog sensor groups sharing ADC1.

### Ports and Channels

A **port** groups related channels. A **channel** represents one logical signal that needs a physical pin.

**Exclusivity rules** — the solver enforces these when assigning:

- **Pins, peripheral instances, and signals are exclusive to a port.** No two ports may use the same physical pin, the same peripheral instance (e.g. `USART1`), or the same signal — unless the resource is declared [shared](#shared-peripherals).
- **Pins are exclusive to a channel.** Within a port, two channels cannot land on the same pin.
- **Configs within a port share the port's instances and signals.** The different [configs](#configurations) of one port are alternative wirings of the *same* peripherals, so they may reuse the same instances and signals.
- **Only one config per port is active at a time.** All configs of a port are routed on the PCB, but exactly one is active at runtime — and **which one is active can change at runtime** (the CPU reconfigures the pins). This is why configs may overlap: they never conflict because they never run simultaneously.

```
port CMD:
  channel TX
  channel RX
  channel CTS @ PA0, PA1    # pin-restricted to PA0/PA1
  channel RTS

port MOTOR:
  channel PWM_A
  channel PWM_B
  channel ENCODER_A
  channel ENCODER_B
```

**Pin restriction** with `@` limits which physical pins a channel can use. See
[Pin Placement (`@`)](#pin-placement) below for the full syntax, including soft
proximity anchors (`@ ~PA1`, `@ ~NW`) and port/config-level placement.

**Port colors** add visual distinction in the package viewer:

```
port CMD color "#2563eb":
  channel TX
  channel RX
```

Any CSS color value works: `"red"`, `"#ff0000"`, `"rgb(0,128,255)"`.

### Configurations

Configurations define alternative peripheral mappings for a port. The solver tries all config combinations across all ports.

```
port CMD:
  channel TX
  channel RX

  config "UART full duplex":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)

  config "UART half duplex":
    TX = USART*_TX
```

Only one config per port can be active at the same time. If a port has multiple configs, the solver evaluates all combinations.

**Inline config shorthand**: For ports with only one config, you can write mappings directly on the channel line and requires/macro calls in the port body, omitting the `config` block. The parser creates an implicit config named after the port.

```
port debug:
  color "green"
  channel SWDIO = *_SWDIO
  channel SWCLK = *_SWCLK
  require same_instance(SWDIO, SWCLK)
```

This is equivalent to:

```
port debug:
  color "green"
  channel SWDIO
  channel SWCLK

  config "debug":
    SWDIO = *_SWDIO
    SWCLK = *_SWCLK
    require same_instance(SWDIO, SWCLK)
```

Pin restrictions work with inline mappings: `channel TX @ PA9, PA2 = USART*_TX`

You cannot mix inline mappings with explicit `config` blocks in the same port.

### Pin Placement (`@`)

The `@` clause controls *where* a channel's pin ends up. It has **hard** forms
(a fixed pin list or a `!` exclusion, which filter the candidate pins) and
**soft** forms (a `~` anchor, which only nudges the
[cost ranking](#cost-functions) — it never removes a candidate).

```
channel TX @ PA1              # hard: TX must use PA1
channel TX @ PA1, PB2         # hard: TX must use PA1 or PB2
channel TX @ !PA1             # hard: TX must NOT use PA1
channel TX @ PA1, PB2, !PB2   # required and excluded pins can be mixed
channel TX @ ~PA1             # soft: prefer pins near PA1
channel TX @ ~1               # soft: prefer pins near package position 1 (or ~A1 on BGA)
channel TX @ ~NW              # soft: prefer pins in the north-west of the package
```

**Excluding pins** with `!` removes them from the channel's candidate pins
before the search starts. Combine exclusions freely with required pins in one
comma-separated list.

**Soft anchor targets:**

| Form | Meaning |
|------|---------|
| `~PA1` | proximity to a specific pin |
| `~1` / `~A1` | proximity to a package position (LQFP number or BGA cell) |
| `~NW` | proximity to a compass region of the package |

**Compass regions** use the package as drawn (north = top, west = left, so the
compass rotates with the package). Letters `N`, `S`, `E`, `W`, and `C` (center,
useful on BGAs) combine: `NW` is the top-left corner, `NNW` leans north with a
slight west bias, `NC` is halfway between the north edge and the center. The
target is the point a ray from the center hits the package boundary in that
direction; `C` pulls it back toward the center.

**On ports and configs.** The same clause after the `:` applies to a whole port
or config:

```
port CMD: @ PA1          # hard: some channel of the port must use PA1
port CMD: @ !PB1         # hard: no channel of the port may use PB1
port CMD: @ PA1, !PB1    # both at once
port CMD: @ ~NW          # soft: pull every channel of the port toward the NW
config "UART": @ !PB1    # hard: no channel mapped in this config may use PB1
config "UART": @ ~NW     # soft: applies only to channels mapped in this config
```

A hard `@ PA1` on a port/config requires *some* channel to land on that pin
(each pin in a list must be covered); solutions that don't are discarded. A hard
`@ !PB1` bars the pin from *every* channel of the port (or, on a config, from
every channel mapped in it). A soft `@ ~...` applies to every affected channel.

Exclusions compose: a channel may not use the union of its own, its port's, and
its active config's excluded pins.

Ports from [templates](#port-templates) inherit the template's placement clause
unless they declare their own, which overrides it:

```
port enc1 from enc0: @ ~NW    # overrides enc0's placement, keeps its channels
```

The soft-anchor pull is weighted by the **Pin Anchor** [cost function](#cost-functions);
set its weight to 0 in Settings to ignore anchors entirely.

### Solver Settings (`settings:`)

A `settings:` block overrides solver settings **for that solve only** — your
saved Settings are left untouched. Handy for committing a hard board's tuning
alongside its constraints.

```
settings:
  timeout: 3s                     # or 3000ms
  solvers: "mrv-group", "hybrid"
  skip_gpio_mapping: 0            # 0/1 or true/false
  pin_proximity: 5                # any cost-function weight
```

**Keys**

| Key | Meaning |
|-----|---------|
| `timeout` / `solver_timeout` | Solver timeout. Accepts `ms` / `s` units (`3s` = `3000ms`) |
| `dynamic_timeout` | Retry multiplier when a run finds nothing (≤1 disables) |
| `solvers` | Which solvers to run, as quoted names |
| `max_solutions` | Stop after this many solutions |
| `max_groups`, `max_solutions_per_group` | Two-phase search limits |
| `num_restarts` | Restarts for the randomized solvers |
| `skip_gpio_mapping`, `post_optimize`, `squared_costs` | Booleans (`0`/`1` or `true`/`false`) |
| *any cost-function id* | Sets that weight — `pin_count`, `port_spread`, `peripheral_count`, `debug_pin_penalty`, `pin_clustering`, `pin_proximity`, `pin_anchor`, `optional_fulfillment` |

**Presets.** `settings from "<name>":` restarts from a named preset instead of
your current settings, then applies the block on top:

```
settings from "default":     # factory defaults, then override
  timeout: 5s

settings from "complex":     # tuned for hard problems; body is optional
```

Available presets are `"default"` (the factory configuration) and `"complex"`
(longer timeout, the heavier solver set, larger group limits). Edit them in
`src/settings.ts` → `SETTINGS_PRESETS`.

Several blocks may appear; later ones fold onto earlier ones. Unknown keys,
unknown presets and wrong value types are reported in the status bar and
otherwise ignored.

### Signal Patterns

Signal patterns match against MCU signal names (e.g., `USART1_TX`, `TIM3_CH2`, `ADC1_IN5`).

| Pattern | Matches |
|---------|---------|
| `USART1_TX` | Exact: only USART1_TX |
| `USART*_TX` | Any USART/UART/LPUART instance, TX signal |
| `TIM[1-3]_CH1` | TIM1_CH1, TIM2_CH1, or TIM3_CH1 |
| `TIM[1,3,8]_CH1` | TIM1_CH1, TIM3_CH1, or TIM8_CH1 |
| `ADC*_IN[0-7]` | Any ADC instance, inputs 0 through 7 |
| `*_TX` | Any peripheral, TX signal |
| `SPI[1-3]_*` | SPI1/2/3, any signal |
| `OUT` | Any GPIO pin (output mode) |
| `IN` | Any GPIO pin (input mode) |

#### Pattern rules

- `*` in the instance part matches any instance of the normalized type
- `*` in the function part matches any signal function
- `[n-m]` matches an inclusive numeric range
- `[n,m,k]` matches explicit values
- `[n,m-p,q]` mixes explicit values and ranges
- Peripheral types are **normalized**: `UART` and `LPUART` match `USART*`, all timer variants match `TIM*`

### Mappings

Mappings bind channels to signal patterns.

**Simple mapping:**
```
TX = USART*_TX
```

**OR alternatives** (`|`): the channel accepts ANY of the listed patterns:
```
COMM = SPI*_MOSI | I2C*_SDA
```

**Multi-pin** (`+`): the channel requires a SEPARATE pin for EACH sub-expression:
```
TX = USART*_TX + USART*_RX    # channel gets 2 pins
```

**Operator precedence:** `|` binds more tightly than `+`:
```
# This means: (USART*_TX | UART*_TX) + (USART*_RX | UART*_RX)
TX = USART*_TX | UART*_TX + USART*_RX | UART*_RX
```

### Variable Assignment ($)

Use `$name` after a mapping to assign the resolved value to a variable. All channels sharing the same `$name` are constrained to resolve to the same value. Variables map positionally to wildcards in the pattern — instance wildcards first, then function wildcards:

```
config "UART":
  TX = USART*_TX $u
  RX = USART*_RX $u
  CTS ?= USART*_CTS $u
```

Here `$u` maps to the instance wildcard (`USART*`), equivalent to:
```
config "UART":
  TX = USART*_TX
  RX = USART*_RX
  CTS ?= USART*_CTS
  require same_instance(TX, RX, CTS)
```

When a variable maps to a function wildcard, it constrains the signal function instead:
```
config "quadrature":
  A = TIM1_CH* $ch
  B = TIM1_CH* $ch
  # $ch maps to CH* → require channel_signal(A) == channel_signal(B)
```

Both wildcard types can be combined with multiple variables:
```
config "quadrature":
  A = TIM*_CH* $t $ch
  B = TIM*_CH* $t $ch
  # $t → same_instance(A, B)
  # $ch → channel_signal(A) == channel_signal(B)
```

It is an error to use more variables than there are wildcards in the pattern.

**Scoping:** Variables are scoped to the port, collected across all configs. If two configs in the same port both use `$u`, they share the same constraint group. Different `$name`s are independent. Variables from different ports do not interact — use cross-port references (`require instance(PORTA.TX) == instance(PORTB.TX)`) to relate ports. Use `diff_instance()` explicitly if two groups must use different instances.

### Optional Mappings and Requires

Use `?=` for optional mappings — assigned if possible, skipped if no valid pin exists:

```
config "UART full":
  TX = USART*_TX
  RX = USART*_RX
  CTS ?= USART*_CTS
  RTS ?= USART*_RTS
  require same_instance(TX, RX)
  require same_instance(TX, CTS)
  require dma(CTS)
```

**`?=` semantics:** The channel is assigned if possible, skipped without error if not. Any `require` statement that references an unassigned `?=` channel is automatically skipped (vacuous truth). This applies to both `require` and `require?`.

**`require?` semantics:** A soft constraint — if it evaluates to false, it is ignored (no error). This is independent of `?=`. Use `require?` for "nice to have" constraints that shouldn't block solutions.

### String Interpolation in Comments

Comments on channels can include `${expr}` expressions that are evaluated per-solution during export:

```
port CMD:
  channel TX    # ${instance(TX)}_TX on pin ${gpio_pin(TX)}
  channel RX    # ${instance(RX)}_RX on pin ${gpio_pin(RX)}
```

After solving, these become e.g. `USART1_TX on pin PA9`. Supported functions: `instance()`, `gpio_pin()`, `type()`, or any channel name (resolves to signal name). If evaluation fails, `?` is substituted.

### Constraints (require)

`require` statements add logical constraints that solutions must satisfy.

```
require same_instance(TX, RX)
require instance(TX) != instance(RX)
require type(A) == "TIM"
require gpio_port(LED) == "GPIO2"
```

#### Operators

| Operator | Meaning | Precedence |
|----------|---------|------------|
| `\|` | OR | lowest |
| `^` | XOR | |
| `&` | AND | |
| `==` `!=` | Equality | |
| `<` `>` `<=` `>=` | Comparison | |
| `+` `-` | Arithmetic | highest (binary) |
| `!` | NOT (prefix) | highest (unary) |

Parentheses override precedence: `(A | B) & C`.

#### Cross-port references

Use dot notation to reference channels from other ports:

```
port CMD:
  channel TX
  ...

port DEBUG:
  channel TX
  config "UART":
    TX = USART*_TX
    require instance(TX) != instance(CMD.TX)  # different USART than CMD
```

### Built-in Functions

| Function | Args | Returns | Description |
|----------|------|---------|-------------|
| `same_instance(ch, ...)` | 2+ channels | boolean | All channels use the same peripheral instance |
| `same_instance(ch, ..., "TYPE")` | 2+ channels + type | boolean | Same instance, only considering signals of given type |
| `diff_instance(ch, ...)` | 2+ channels | boolean | All channels use different peripheral instances |
| `instance(ch)` | 1 channel | string | Peripheral instance name (e.g., "USART1") |
| `instance(ch, "TYPE")` | 1 channel + type | string | Instance name filtered by signal type |
| `type(ch)` | 1 channel | string | Normalized peripheral type (e.g., "USART") |
| `type(ch, "TYPE")` | 1 channel + type | string | Peripheral type filtered by signal type |
| `gpio_pin(ch)` | 1 channel | string | Pin name (e.g., "PA4") |
| `gpio_pin(ch, "TYPE")` | 1 channel + type | string | Pin name filtered by signal type |
| `gpio_port(ch)` | 1 channel | string | GPIO port (e.g., "GPIO1" for port A) |
| `gpio_port(ch, "TYPE")` | 1 channel + type | string | GPIO port filtered by signal type |
| `flag(ch, "name", value)` | 1 channel + name + value | boolean | Every pin the channel uses carries that vendor pin flag with that value |
| `dma(ch)` | 1 channel | boolean | Channel's signal has a DMA stream available |
| `dma(ch, "TYPE")` or `dma(ch, "TYPE_REQUEST")` | 1 channel + filter | boolean | DMA check filtered by peripheral type, or type + specific request (e.g. `"USART_TX"`) |
| `pin_number(ch)` | 1 channel | number | Physical pin number (position) |
| `pin_row(ch)` | 1 channel | number | BGA: row (A=1, B=2, ...). LQFP: y-component |
| `pin_col(ch)` | 1 channel | number | BGA: column number. LQFP: x-component |
| `pin_distance(a, b)` | 2 channels | number | Distance between two pins (Euclidean for BGA, circular for LQFP) |
| `channel_number(ch)` | 1 channel | number | Peripheral channel/input number (e.g., 3 for IN3) |
| `channel_signal(ch)` | 1 channel | string | Signal function name (e.g., "TX" for USART1_TX, "CH3" for TIM1_CH3) |
| `instance_number(ch)` | 1 channel | number | Peripheral instance number (e.g., 2 for SPI2) |

**GPIO port mapping:** A=GPIO1, B=GPIO2, C=GPIO3, D=GPIO4, etc.

#### Numeric expressions

Numeric functions can be used with comparison and arithmetic operators:

```
require channel_number(V_SENSE) < channel_number(I_SENSE)
require instance_number(ENC0.mosi) < instance_number(ENC1.mosi)
require pin_number(A) - pin_number(B) < 5
require channel_number(IA) != channel_number(IB)
require pin_row(TX) == pin_row(RX)
require pin_distance(MOSI, MISO) < 5
```

#### Pin flags

Vendor JSON data may attach per-pin flags (e.g. 5 V tolerance). `flag()` requires
**every pin the channel occupies** to carry that flag with that value:

```
channel TX = USART*_TX
require flag(TX, "5V_tolerant", true)
```

The value may be `true`/`false`, a number, or a quoted string. A pin whose data
does not carry the flag at all **fails** the condition — so a channel is only
accepted when the data explicitly says so. For a multi-pin channel
(`CH = A + B`) every pin must match.

Flags come from the remote JSON catalogue's optional `flags` dict per GPIO:

```json
{ "name": "PA9", "flags": { "5V_tolerant": true } }
```

CubeMX XML carries no flags, so `flag()` never holds for XML-imported MCUs.

#### DMA constraints

The `dma()` function checks that the signal assigned to a channel has a DMA stream available on the MCU. This requires loading both the MCU XML and its corresponding DMA modes XML file.

```
require dma(TX)                  # TX signal must have a DMA stream
require dma(RX, "USART")         # RX must have DMA, only considering USART signals
require dma(TX, "USART_TX")      # ...and only the USART TX DMA request specifically
```

**Filter string** — the optional second argument narrows which DMA request is considered:

- `"TYPE"` (e.g. `"SPI"`, `"TIM"`, `"ADC"`) — restrict to the peripheral type; the DMA stream is resolved from the instance (e.g. `ADC1`), falling back to the channel's signal name.
- `"TYPE_FUNCTION"` (e.g. `"USART_TX"`, `"SPI_RX"`) — restrict to a specific DMA request built as `<instance>_<FUNCTION>` (e.g. `USART1_TX`). The part before the first `_` is the peripheral type, the rest is the request/trigger name.

Without a filter, `dma()` uses the channel's assigned signal name directly.

**DMA stream exclusivity rules:**
- A DMA stream is exclusive to one port (no two ports can share a stream)
- Within a configuration, each channel requires its own DMA stream
- Different configurations of the same port may reuse a stream (since configs are mutually exclusive)

The solver automatically verifies that a consistent DMA stream assignment exists across all channels that require DMA.

**Note:** Using `dma()` requires DMA data for the MCU. For XML-imported MCUs
that means also importing the matching DMA modes XML (separate from the pinout
XML). If it is missing and a [remote data source](#loading-mcu-data-remote-catalogue-optional)
is configured, the tool looks the same MCU up there and borrows its DMA data
automatically — remote JSON MCUs always carry it. Only when neither is available
does the solver report an error and stop.

### Macros

Macros allow reusable constraint templates.

#### Defining macros

```
macro uart_port(TX, RX):
  TX = USART*_TX
  RX = USART*_RX
  require same_instance(TX, RX)

macro spi_master(MOSI, MISO, SCK):
  MOSI = SPI*_MOSI
  MISO = SPI*_MISO
  SCK = SPI*_SCK
  require same_instance(MOSI, MISO)
  require same_instance(MOSI, SCK)
```

#### Using macros

```
port CMD:
  channel TX
  channel RX

  config "UART":
    uart_port(TX, RX)
```

Parameters are textually substituted. Macros expand before constraint evaluation.

#### Macro overloading

Macros can be overloaded by argument count. The correct version is selected based on the number of arguments at each call site:

```
macro spi_port(MOSI, MISO, SCK):
  MOSI = SPI*_MOSI
  MISO = SPI*_MISO
  SCK = SPI*_SCK
  require same_instance(MOSI, MISO, SCK, "SPI")

macro spi_port(MOSI, MISO, SCK, NSS):
  spi_port(MOSI, MISO, SCK)        # calls 3-arg version
  NSS = SPI*_NSS
  require same_instance(MOSI, NSS, "SPI")
```

### Port Templates

Define a port once, instantiate it multiple times with `from`. This avoids repeating identical channel/config blocks:

```
port encoder_port:
  channel A
  channel B
  config "quadrature":
    encoder(A, B)

port ENC0 from encoder_port color "orange"
port ENC1 from encoder_port color "green"
port ENC2 from encoder_port color "red"
```

**Override semantics:** If the derived port re-declares a config with the same name, it replaces the template's version. Additional channels/configs are appended:

```
port ENC3 from encoder_port color "blue":
  channel Z                          # added channel
  config "quadrature":               # replaces template's "quadrature"
    A = TIM[1-3]_CH1
    B = TIM[1-3]_CH2
  config "with_index":               # new config
    encoder(A, B, Z)
```

Body-less ports (no colon, no body) simply clone the template as-is:
```
port ENC0 from encoder_port color "orange"
```

**Chained templates:** A derived port can itself be used as a template. Cycles
are detected and reported as errors.

```
port encoder_port:
  channel A
  channel B

port encoder_z from encoder_port:
  channel Z

# encoder_z was declared from encoder_port and is now used as a template.
port ENC0 from encoder_z color "orange"
```

### Standard Library

Pre-defined macros available in all projects. The macro library can be edited via the **Data Manager** (click Edit under "Macro Library"). Changes apply to all projects. Use Reset to restore the defaults.

| Macro | Parameters | Description |
|-------|------------|-------------|
| `uart_port(TX, RX)` | 2 channels | USART full-duplex, same instance |
| `uart_half_duplex(TX)` | 1 channel | USART TX only |
| `spi_port(MOSI, MISO, SCK)` | 3 channels | SPI master 3-wire, same instance |
| `spi_port(MOSI, MISO, SCK, NSS)` | 4 channels | SPI master with chip select (overload) |
| `i2c_port(SDA, SCL)` | 2 channels | I2C, same instance |
| `encoder(A, B)` | 2 channels | Timer encoder CH1+CH2, same instance |
| `encoder(A, B, Z)` | 3 channels | Timer encoder with index CH3/4 (overload) |
| `pwm(CH)` | 1 channel | PWM on any timer channel 1-4 |
| `dac(OUT)` | 1 channel | DAC output 1-2 |
| `adc(IN)` | 1 channel | ADC input 0-15 |
| `can_port(TX, RX)` | 2 channels | CAN bus, same instance |

### Common-Error Lint

The editor runs a lint pass over the parsed AST that warns when a channel name and its
signal pattern reference different tokens from the same "confusable" group. Classic case:
a channel called `miso` mapped to `SPI*_MOSI`.

- Warning lines get a yellow wavy underline and a matching marker in the editor minimap.
- Details show below the editor alongside parser errors (parser errors have priority
  when both appear on the same line).
- The library is empty by default until seeded from **Data Manager > Common-error Lint
  Library**; use **Reset** to restore the shipped defaults.

Library syntax: one group per line, tokens space-separated, `#` for comments. Every pair
of tokens in a group is treated as a "swap": if a channel name contains token A and the
signal pattern contains token B (or vice versa), a warning is raised.

```
# Groups of signal names commonly swapped by mistake.
miso mosi
tx rx
cts rts
ch1 ch2 ch3 ch4
```

Token matching is case-insensitive with word-boundary matching (a token surrounded by
non-alphanumerics or the string edge), so `enc_miso` matches `miso` but `context` does
not match `tx`.

---

## Practical Examples

### Motor Controller

A motor controller with UART command interface, SPI sensor, quadrature encoder, and PWM outputs:

```
reserve: PA13, PA14          # keep SWD debug

port CMD color "#2563eb":
  channel TX
  channel RX

  config "UART":
    uart_port(TX, RX)

port SENSOR color "#dc2626":
  channel MOSI
  channel MISO
  channel SCK
  channel CS

  config "SPI":
    spi_port(MOSI, MISO, SCK, CS)

port ENCODER color "#16a34a":
  channel A
  channel B

  config "Timer encoder":
    encoder(A, B)

port PWM color "#d97706":
  channel HIGH_A
  channel HIGH_B
  channel LOW_A
  channel LOW_B

  config "Complementary PWM":
    HIGH_A = TIM1_CH1
    HIGH_B = TIM1_CH2
    LOW_A = TIM1_CH1N
    LOW_B = TIM1_CH2N
    require same_instance(HIGH_A, HIGH_B)
    require same_instance(HIGH_A, LOW_A)
```

### Multi-ADC Sensor Board

Three ADC channels on the same ADC instance, plus I2C for a digital sensor:

```
port ANALOG color "#7c3aed":
  channel V_SENSE
  channel I_SENSE
  channel TEMP

  config "Multi-channel ADC":
    V_SENSE = ADC[1-3]_IN[0-7]
    I_SENSE = ADC[1-3]_IN[0-7]
    TEMP = ADC[1-3]_IN[0-7]
    require same_instance(V_SENSE, I_SENSE, TEMP)

port I2C_BUS color "#059669":
  channel SDA
  channel SCL

  config "I2C":
    i2c_port(SDA, SCL)
```

### LED Status with GPIO Constraints

Simple GPIO outputs restricted to a specific port:

```
port STATUS color "#f59e0b":
  channel LED_R
  channel LED_G
  channel LED_B

  config "GPIO":
    LED_R = OUT
    LED_G = OUT
    LED_B = OUT
    require gpio_port(LED_R) == gpio_port(LED_G)
    require gpio_port(LED_G) == gpio_port(LED_B)
```

### UART with DMA

A UART port requiring DMA support for both TX and RX. Requires the DMA modes XML to be loaded alongside the MCU XML.

```
port CMD color "#2563eb":
  channel TX
  channel RX

  config "UART with DMA":
    uart_port(TX, RX)
    require dma(TX)
    require dma(RX)
```

The solver will only select USART instances whose TX and RX signals have available DMA streams, and ensures the two channels get different DMA streams.

### Multiple UARTs on Different Instances

```
port CMD color "#2563eb":
  channel TX
  channel RX

  config "UART":
    uart_port(TX, RX)

port DEBUG color "#6b7280":
  channel TX
  channel RX

  config "UART":
    uart_port(TX, RX)
    require instance(TX) != instance(CMD.TX)
```

---

## Package Viewer

The package viewer renders the MCU package with interactive pin display.

### Controls

- **Zoom:** `+`/`-` buttons, pinch, or the mouse wheel (see Touch gestures below)
- **Pan:** two-finger scroll / drag
- **Rotate:** Rotate buttons (90° per click), or twist with two fingers — rotation snaps to 90° steps
- **Reset:** Reset zoom, rotation and pan to defaults

**Touch gestures** (Settings → Viewer, on by default): two fingers on a touchpad
or touchscreen pan, pinch to zoom (anchored on the cursor/pinch centre) and
twist to rotate in 90° steps. Turn the setting off to restore the classic mouse
behaviour, where the wheel zooms. Trackpad rotation needs gesture events, so it
is available in Safari and on touchscreens; pan and pinch-zoom work in every
browser.
- **Search:** Type signal patterns to highlight matching pins with a pulsing glow
- **Export:** Click to open the export modal with format options:
  - **PNG** -- raster image of the current canvas view
  - **SVG** -- vector graphic, ideal for documentation and scaling
  - **Text** -- copy pin assignment table to clipboard (grouped by pin)
  - **JSON** -- structured pin assignment data
  - **Custom** -- any registered custom export functions

### Pin Interaction

- **Hover** a pin to see its name, assigned signal, and available signals in a tooltip
- **Click** a pin to select it (orange highlight) and open the assignment popup
- **Click background** to deselect the current pin
- **Assignment popup:** Click a signal to insert a `pin` declaration in the constraint editor

#### Shared / variant package pins

Some package pads bond more than one die-side GPIO net to the same solder
point. The viewer renders these as a single cell with a `+N` suffix on the
label (e.g. `PA9+1` means PA9 plus one bonded sibling) and the tooltip
lists every logical pin and its signals separately. Three common cases:

- **PINREMAP variants** on small C0/F0/G0/U0 parts (e.g. `PA9 [PA11]`):
  the chip can present either GPIO at the pad, controlled by a register.
- **Multi-bond pads** on UFQFPN20 / WLCSP packages: multiple GPIOs are
  permanently tied together inside the package — only one can drive the pad
  at runtime.
- **`_C` analog-switch siblings** on H7 (`PC2` / `PC2_C`): one logical
  carries the digital AF set, the other a low-impedance analog path.

The solver enforces mutual exclusion: assigning a signal to one logical
locks the physical and every co-bonded sibling for other ports. The
assignment popup groups signals by logical pin so you can pick the variant
explicitly.

### Pin Colors

- **Gray** -- unassigned
- **Blue** -- assigned by solver or `pin` declaration
- **Port color** -- uses the color defined in the constraint (`color "..."`)
- **Orange** -- selected pin
- **Yellow** -- hovered pin
- **Red** -- conflict (pin assigned to multiple signals)

### Signal Search

The search field accepts the same pattern syntax as constraint signal patterns:

- `TIM*_CH1` -- signal pattern matching
- `PA0` -- exact pin name
- `SPI` -- substring fallback (matches any signal containing "SPI")

Matching pins pulse with an amber glow animation. Press **Escape** to clear the search.

### Comparing Solutions

Ctrl/Cmd-click multiple rows in the **Project Solutions** list to switch the package
viewer into compare mode. It highlights how the selected solutions differ:

- Pins with an identical mapping in every selected solution render normally (port
  color).
- Pins that differ pulse through one solution color per cycle (~1.2 s per solution).
  Each selected solution gets a distinct color assigned by selection order.
- A grey slice in the cycle means that solution doesn't assign the pin at all,
  making "assigned in some, empty in others" visually obvious.
- Hovering a divergent pin shows a **Compare** section in the tooltip with one row
  per selected solution: a colored dot, the solution name, and its mapping
  (or `—` when unassigned).

Compare mode is exclusive with normal peripheral / hover / search highlights, which
temporarily override the compare pulse on the pins they touch. Click a single row
(no modifier) to leave compare mode.

---

## Solver

### How It Works

All solvers share the same preprocessing pipeline:

1. **Validate** -- pre-solve checks verify peripheral availability, DMA data, and constraint consistency
2. **Expand patterns** -- each channel's signal pattern is expanded to a set of candidate (pin, signal) pairs
3. **Generate config combinations** -- all permutations of configs across ports
4. **Search** -- each solver applies its own strategy to find valid pin assignments
5. **Cost ranking** -- valid solutions are scored and sorted

Each solver runs in a separate **Web Worker** to keep the UI responsive. Multiple solvers can run in parallel. Click **Abort** to cancel all running solvers.

### Pre-Solve Validation

Before starting any solver, the tool runs validation checks on the constraints and MCU data. If any check fails (error), solver workers are not started and the error is displayed immediately.

| Check | Type | Description |
|-------|------|-------------|
| **Type filter mismatch** | Error | A `require` function's type filter can never match the channel's mapped signal type (e.g., `require same_instance(TX, MOSI, "USART")` where MOSI is mapped to `SPI*_MOSI`). |
| **Peripheral availability** | Error | More peripheral instances of a type are needed than the MCU provides (e.g., 3 ports need SPI but only 2 SPI instances exist). |
| **DMA data missing** | Error | Constraints use `dma()` but no DMA modes XML is loaded for the MCU. |
| **DMA stream count** | Error | More DMA channels are needed across all ports than the MCU has DMA streams. |
| **Unknown channel reference** | Warning | A `require` expression references a channel name that has no mapping in the port. |

Error messages include the sender (solver name) to identify which component produced them.

### Solver Algorithms

| Solver | Description |
|--------|-------------|
| **Two-Phase** | First assigns peripheral instances, then solves pin mappings per group. Good general-purpose solver. |
| **Backtracking CSP** | Classic constraint satisfaction with MRV (Minimum Remaining Values) heuristic and eager pruning. |
| **Randomized Restarts** | Runs backtracking N times with shuffled candidate orderings for diverse solutions. |
| **Cost-Guided** | Backtracking with candidates sorted by estimated cost (proximity, spread, debug penalty). Tends to find low-cost solutions first. |
| **Diverse Instances** | Two-phase solver with multi-round shuffled instance exploration for diverse peripheral groupings. |
| **AC-3 Forward Checking** | Backtracking with forward checking -- propagates pin/instance exclusivity to prune domains early. |
| **Dynamic MRV** | Dynamically picks the most constrained variable at each step with forward checking. |
| **Priority Backtracking** | Backtracking that maps constrained peripherals first (fewer available pins = higher priority). |
| **Priority Two-Phase** | Two-phase solver that maps constrained peripherals first in both phases. |
| **Priority Diverse** | Priority ordering round 0 (fast initial solve) + shuffled MRV rounds for diversity. |
| **Priority Group** | Three-phase: diverse instance discovery + instance permutation + priority-ordered pin assignment. |
| **MRV Group** | Three-phase with dynamic MRV + forward checking in Phase 2. Most robust for complex problems. |
| **Ratio MRV Group** | MRV Group with normalized priority (candidates per signal ratio instead of raw pin count). |
| **Hybrid** | Runs priority-backtracking, extracts instance groups from solutions, permutes symmetric ports, then runs Phase 2. Best when two-phase Phase 1 finds infeasible groups but single-phase solvers succeed. |
| **Conflict-Directed** | Single-phase search with conflict-directed backjumping and weighted-degree (dom/wdeg) variable ordering plus Luby restarts. Fast first solution on heavily-constrained problems where late, blocking constraints defeat static ordering. |
| **CEGAR Instance-Refinement** | Closed-loop two-phase: a bipartite-matching oracle rejects unroutable instance groups instantly, and pin-level failures become learned instance "nogoods" that steer discovery toward routable groups. Strong structural diversity on very hard problems. |
| **LNS Repair** | Local search (min-conflicts) over complete assignments with destroy/repair. Fastest time-to-first-solution on very large problems; the destroy operator also doubles as a diversity engine. Incomplete — pair with a systematic solver. |
| **Adaptive Portfolio** | Races LNS and Conflict-Directed for a fast first solution, then feeds their instance groups into CEGAR for diversity. Best default for unknown/hard problems; easy problems fall through to Two-Phase. |

The last four target **very complex problems** (many mutually-blocking peripheral constraints) where the classic solvers time out or collapse to a single group. See `ai_docs/complex_solvers.md` for the design rationale.

### Parallel Multi-Solver

Select multiple solvers in Settings to run them in parallel. Each solver runs in its own Web Worker with a scaled solution budget (total budget is distributed across workers to limit peak memory). When all solvers complete, their results are merged:

1. Solutions are tagged with their solver origin
2. All solutions are concatenated and sorted by cost
3. Duplicate solutions (same pin assignments) are removed
4. The result is trimmed to the configured max solutions limit

The solution browser shows which solver found each solution in the Name column.

### Cost Functions

Solutions are ranked by weighted cost functions (configurable in Settings):

| Function | Description |
|----------|-------------|
| **pin_count** | Fewer pins used is better |
| **port_spread** | Prefer pins clustered on fewer GPIO ports |
| **peripheral_count** | Fewer distinct peripheral instances is better |
| **debug_pin_penalty** | Penalize using debug pins (PA13/PA14/PA15/PB3/PB4) |
| **pin_clustering** | Prefer numerically adjacent pins |
| **pin_proximity** | Prefer pins that are physically close on the package |
| **pin_anchor** | Pull each pin toward its `@ ~...` placement hint (see [Pin Placement](#pin-placement)) |
| **optional_fulfillment** | Prefer solutions with more optional mappings (`?=`) and requires (`require?`) satisfied |

Weights are configurable: `0` = disabled, `1` = normal, higher values = more impact.

**Square distance costs** (Settings) changes how the three distance-based
functions — **pin_clustering**, **pin_proximity** and **pin_anchor** — accumulate:
they sum *squared* distances instead of raw ones. A single far-away pin is then
punished much harder than several slightly-spread pins, which is usually what
matters for routing. Off by default.

```
port pin distances 1, 1, 10
  linear   →   1 +  1 +  10 =  12
  squared  →   1 +  1 + 100 = 102     ← the outlier dominates
```

### Settings

Access via the **Settings** button:

- **Solvers** -- checkbox list to select which solvers to run (with All/None quick-toggle). Default: two-phase, cost-guided, priority-backtracking, mrv-group, ratio-mrv-group, hybrid
- **Max solutions** -- stop after finding this many (default: 5000)
- **Max groups** -- limit the number of solution groups (default: 500)
- **Max solutions per group** -- limit solutions within each group (default: 100)
- **Num restarts** -- number of restarts for randomized-restarts solver (default: 150)
- **Timeout** -- abort after this many milliseconds (default: 2500)
- **Dynamic timeout** -- if the first solver run finds 0 solutions, retry with timeout × this multiplier. Disabled if ≤1 (default: 5)
- **Skip GPIO mapping** -- skip pin assignment for IN/OUT channels and only verify enough free pins remain (much faster when there are many GPIO channels; default: on)
- **Post-optimize pins** -- after solving, greedily relocate single-signal pins to free alternatives that lower total cost, repeating until no move improves. Off by default
- **Square distance costs** -- sum squared distances in pin_clustering / pin_proximity / pin_anchor so single outliers are punished harder (default: off)
- **Cost weights** -- adjust the ranking formula for all cost functions
- **Viewer zoom limits** -- min/max zoom and mouse sensitivity
- **Touch gestures** -- two-finger pan/pinch/rotate in the package viewer; off = the wheel zooms (default: on)

---

## Solution Browser

Solutions are displayed in a grouped table. Solutions with the same peripheral-to-port mapping are grouped together. When solving across multiple MCUs, groups are MCU-specific and the group header shows the MCU name.

### Peripheral Summary

The Peripherals panel shows the port-to-peripheral mapping for the currently selected solution, along with the total number of used pins and peripherals.

**Pin group highlighting:** Hover over a port name or peripheral instance to highlight the corresponding pins on the package viewer with a pulsating glow. Click to toggle a persistent highlight that stays active until clicked again or a different solution is selected.

### Navigation

| Key | Action |
|-----|--------|
| **Arrow Up/Down** | Navigate to previous/next item in the visible list |
| **Arrow Right** | Expand the current group |
| **Arrow Left** | Collapse the current group |
| **Enter** | Save the selected solution to the project |
| **Click group header** | Toggle expand/collapse and preview the group's best solution |
| **Click solution row** | Select and preview the solution |

When groups are collapsed, Up/Down moves between group headers. When expanded, it moves through individual solutions within the group.

After a solver run, the solution list is automatically focused for immediate keyboard navigation. The first group is selected and its best solution is previewed in the package viewer.

### Columns

| Column | Description |
|--------|-------------|
| **#** | Solution ID |
| **MCU** | MCU variant (only shown in multi-MCU mode) |
| **Cost** | Total weighted cost score |
| **Pins** | Number of MCU pins used |
| **Peripherals** | Number of peripheral instances used |
| **Name** | User-defined name, or the solver that found the solution |

All columns except Name are sortable (click header to toggle ascending/descending).

### Solution Validity Badges

Each row in the **project** solution list carries a small badge showing whether
that saved solution still fits the **current** constraint text (recomputed as
you edit the constraints, change MCU, or load a project):

| Badge | Meaning |
|-------|---------|
| ✓ green | **Valid** -- every required channel is assigned and all constraints (pin/instance exclusivity, `require`, DMA) are satisfied |
| ● blue | **Valid, with extras** -- satisfies the current constraints, but also carries assignments for channels no longer present in the constraint text (harmless leftovers from an earlier version) |
| ✕ red | **Invalid** -- a required channel is unassigned (e.g. a new/renamed port) or a constraint is now violated |

Badges make it easy to see which stored solutions are still usable after editing
the constraints. Solutions for a different MCU than the one loaded show no badge.

### Editing a Solution (Modify Mode)

To hand-tune a solution's routing for your board -- optimizing for things the
cost function can't see, such as connector placement -- select it and click
**✎ Modify** in the package-viewer toolbar. This edits a copy; the live cost and
its delta are shown next to the button. In modify mode:

- **Click a pin** -- move its signal to another free pin, bring a signal here
  from another pin, or place an unmapped IN/OUT signal.
- **Click a port** in the Peripheral Summary -- swap all of its peripherals with
  a compatible port (e.g. exchange two encoders).
- **Click a peripheral** -- swap it with the same-type peripheral on another
  port, or replace it with a compatible unused instance.

Each option lists its **cost change** and highlights the pins it would move when
you hover it. **Ctrl+Z** / **Ctrl+Shift+Z** undo/redo. **Save** adds the edited
solution to the project; **Discard** exits without keeping changes.

---

## Project Management

### Saving and Loading

- **New** -- clear the editor and start fresh
- **Save** -- save to the current project name
- **Save As** -- prompt for a name. A **new** name creates a new project; entering an
  **existing** name (e.g. the current project's own name) appends a new **version** to
  that project rather than overwriting it.
- **Project dropdown** -- switch between saved projects
- **Import a project** -- drag & drop a project `.json` (from Data Manager → Projects → **Export**) anywhere, or pick it with the **Import** button. You are asked for a name, defaulting to the one stored in the file; importing under an existing project's name appends its versions instead of overwriting, exactly like **Save As** with that name

Each project keeps a history of versions (constraint text + MCU + saved solutions per
version), so re-saving under the same name never loses earlier work. Projects store the
constraint text, the referenced MCU, and any saved solutions in localStorage. When you open a project whose MCU isn't in local storage, the
tool automatically fetches it from the configured
[remote data source](#loading-mcu-data-remote-catalogue-optional) (if one is set)
so the project opens without a manual re-import.

### Data Manager

Access via the **Data** button. Shows:

- **Stored MCUs** -- imported MCU XML files with size, load/delete actions
- **Projects** -- saved projects with load/delete actions
- **Custom Export Functions** -- user-defined JavaScript export functions (create, edit, delete)
- **Macro Library** -- edit shared macros available in all constraints (edit, reset to default)
- **Common-error Lint Library** -- edit the swap-group library that powers the
  editor's yellow-squiggle lint (see [Common-Error Lint](#common-error-lint))

### Custom Export Functions

Create custom export functions via the Data Manager to generate any output format from your solution data. Each function is written in JavaScript and has access to:

- `mcuName`, `mcuPackage` -- MCU identification
- `assignments` -- array of `{pinName, signalName, portName, channelName, configurationName, portComment, channelComment, pinComment}`
- `peripherals` -- array of `{instanceName, type, version}`
- `pins` -- array with pin details and all available signals
- `ports` -- array of `{name, color, comment, channels: [{name, comment}], configurations}`
- `pinComments` -- object `{pinName: comment}` from `pin` declarations

Inline `#` comments on `port`, `channel`, and `pin` declarations are forwarded to the export function:

```
port SWD:              # Debug interface
  channel DIO          # Serial Wire Debug Data
  channel CLK          # Serial Wire Debug Clock

pin PA4 = DAC1_OUT1    # Audio output
```

Access via `ports[i].comment`, `ports[i].channels[j].comment`, and `pinComments["PA4"]`. The `comment` field is `null` if no comment is present.

Return a string to copy to clipboard, or `{filename, content, mimeType}` to trigger a file download. Custom exports appear in the Export modal alongside the built-in formats.

### Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| **Ctrl+Enter** | Editor | Run solver |
| **Escape** | Global | Close modal / clear search |
| **Ctrl+Z** | Editor | Undo |
| **Ctrl+Shift+Z** | Editor | Redo |
| **Tab** | Editor | Insert 2 spaces |
| **Arrow Up/Down** | Solution list | Navigate items |
| **Arrow Right** | Solution list | Expand group |
| **Arrow Left** | Solution list | Collapse group |
| **Enter** | Solution list | Save selected solution |
