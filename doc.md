# STM32 Pinout Tool -- Documentation

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Constraint Language](#constraint-language)
   - [MCU Selection](#mcu-selection)
   - [Pin Reservations](#pin-reservations)
   - [Fixed Pin Assignments](#fixed-pin-assignments)
   - [Ports and Channels](#ports-and-channels)
   - [Configurations](#configurations)
   - [Signal Patterns](#signal-patterns)
   - [Mappings](#mappings)
   - [Constraints (require)](#constraints-require)
   - [Built-in Functions](#built-in-functions)
   - [Macros](#macros)
   - [Standard Library](#standard-library)
4. [Practical Examples](#practical-examples)
5. [Package Viewer](#package-viewer)
6. [Solver](#solver)
7. [Project Management](#project-management)

---

## Overview

The STM32 Pinout Tool is a browser-based application for finding optimal pin assignments on STM32 microcontrollers. You describe your hardware requirements using a constraint language -- which peripherals you need, how they relate to each other -- and a backtracking CSP solver finds all valid assignments, ranked by cost.

The tool works entirely in the browser. MCU data is loaded from STM32CubeMX XML files and stored in localStorage.

---

## Getting Started

### Loading MCU Data

The tool needs MCU pin/peripheral data from STM32CubeMX XML files:

1. Install [STM32CubeMX](https://www.st.com/en/development-tools/stm32cubemx.html)
2. Navigate to the CubeMX installation folder: `db/mcu/`
3. Find your MCU's XML file (e.g., `STM32G473C(B-E)Tx.xml`)
4. Drag and drop the file onto the app, or use **Import XML**

Imported MCUs are stored in localStorage and can be reloaded from the **Data** manager.

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
```

Glob patterns with `*` wildcard. Multiple patterns separated by `|`. This is optional -- if omitted, the currently loaded MCU is used.

### Pin Reservations

```
reserve: PH0, PH1, PA13, PA14
```

Excludes pins from the solver. Use for crystal oscillator pins, debug pins, etc.

### Fixed Pin Assignments

```
pin PA4 = DAC1_OUT1
pin PA11 = USB_DM
pin PA12 = USB_DP
```

Forces a specific signal onto a specific pin. The solver respects these and won't use those pins for other assignments.

### Ports and Channels

A **port** groups related channels. A **channel** represents one logical signal that needs a physical pin.

```
port CMD:
  channel TX
  channel RX
  channel CTS @ PA0, PA1    # optional: restrict to specific pins

port MOTOR:
  channel PWM_A
  channel PWM_B
  channel ENCODER_A
  channel ENCODER_B
```

**Pin restriction** with `@` limits which physical pins a channel can use.

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

Only one config per port is active in each solution. If a port has multiple configs, the solver evaluates all combinations.

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

**AND multi-pin** (`&`): the channel requires a SEPARATE pin for EACH sub-expression:
```
TX = USART*_TX & USART*_RX    # channel gets 2 pins
```

**Operator precedence:** `|` binds more tightly than `&`:
```
# This means: (USART*_TX | UART*_TX) & (USART*_RX | UART*_RX)
TX = USART*_TX | UART*_TX & USART*_RX | UART*_RX
```

### Constraints (require)

`require` statements add logical constraints that solutions must satisfy.

```
require same_instance(TX, RX)
require instance(TX) != instance(RX)
require type(A) == "TIM"
require gpio_port(LED) == "GPIO2"
```

#### Logical operators

| Operator | Meaning | Precedence |
|----------|---------|------------|
| `\|` | OR | lowest |
| `^` | XOR | |
| `&` | AND | |
| `==` | Equal | |
| `!=` | Not equal | |
| `!` | NOT (prefix) | highest |

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
| `type(ch)` | 1 channel | string | Normalized peripheral type (e.g., "USART") |
| `gpio_pin(ch)` | 1 channel | string | Pin name (e.g., "PA4") |
| `gpio_pin(ch, "TYPE")` | 1 channel + type | string | Pin name filtered by signal type |
| `gpio_port(ch)` | 1 channel | string | GPIO port (e.g., "GPIO1" for port A) |
| `gpio_port(ch, "TYPE")` | 1 channel + type | string | GPIO port filtered by signal type |
| `version(ch)` | 1 channel | string | Peripheral version string |

**GPIO port mapping:** A=GPIO1, B=GPIO2, C=GPIO3, D=GPIO4, etc.

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

### Standard Library

Pre-defined macros available in all projects:

| Macro | Parameters | Description |
|-------|------------|-------------|
| `uart_port(TX, RX)` | 2 channels | USART full-duplex, same instance |
| `uart_half_duplex(TX)` | 1 channel | USART TX only |
| `spi_port(MOSI, MISO, SCK)` | 3 channels | SPI master 3-wire, same instance |
| `spi_port_cs(MOSI, MISO, SCK, NSS)` | 4 channels | SPI master with chip select |
| `i2c_port(SDA, SCL)` | 2 channels | I2C, same instance |
| `encoder(A, B)` | 2 channels | Timer encoder CH1+CH2, same instance |
| `encoder_with_index(A, B, Z)` | 3 channels | Timer encoder CH1+CH2+CH3 |
| `pwm(CH)` | 1 channel | PWM on any timer channel 1-4 |
| `dac(OUT)` | 1 channel | DAC output 1-2 |
| `adc(IN)` | 1 channel | ADC input 0-15 |
| `can_port(TX, RX)` | 2 channels | CAN bus, same instance |

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
    spi_port_cs(MOSI, MISO, SCK, CS)

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

- **Zoom:** `+`/`-` buttons or mouse wheel
- **Rotate:** Rotate button (90 degrees clockwise per click)
- **Reset:** Reset zoom and rotation to defaults
- **Search:** Type signal patterns to highlight matching pins with a pulsing glow
- **Export:** Download the current view as a PNG image

### Pin Interaction

- **Hover** a pin to see its name, assigned signal, and available signals in a tooltip
- **Click** a pin to select it (orange highlight) and open the assignment popup
- **Click background** to deselect the current pin
- **Assignment popup:** Click a signal to insert a `pin` declaration in the constraint editor

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

---

## Solver

### How It Works

The solver uses constraint satisfaction with backtracking:

1. **Expand patterns** -- each channel's signal pattern is expanded to a set of candidate (pin, signal) pairs
2. **Generate config combinations** -- all permutations of configs across ports
3. **Backtracking search** -- assigns pins to channels using MRV (Minimum Remaining Values) heuristic, with eager constraint checking
4. **Cost ranking** -- valid solutions are scored and sorted

The solver runs in a **Web Worker** to keep the UI responsive. Click **Abort** to cancel a long-running solve.

### Cost Functions

Solutions are ranked by weighted cost functions (configurable in Settings):

| Function | Description |
|----------|-------------|
| **pin_count** | Fewer pins used is better |
| **port_spread** | Prefer pins clustered on fewer GPIO ports |
| **peripheral_count** | Fewer distinct peripheral instances is better |
| **debug_pin_penalty** | Penalize using debug pins (PA13/PA14/PA15/PB3/PB4) |
| **pin_clustering** | Prefer numerically adjacent pins |

Weights are configurable: `0` = disabled, `1` = normal, `2` = double impact.

### Settings

Access via the **Settings** button:

- **Max solutions** -- stop after finding this many (default: 300)
- **Timeout** -- abort after this many milliseconds (default: 5000)
- **Cost weights** -- adjust the ranking formula
- **Viewer zoom limits** -- min/max zoom and mouse sensitivity

---

## Project Management

### Saving and Loading

- **New** -- clear the editor and start fresh
- **Save** -- save to the current project name
- **Save As** -- save with a new project name
- **Project dropdown** -- switch between saved projects

Projects store the constraint text in localStorage.

### Data Manager

Access via the **Data** button. Shows:

- **Stored MCUs** -- imported MCU XML files with size, load/delete actions
- **Projects** -- saved projects with load/delete actions

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Enter** | Run solver |
| **Escape** | Close modal / clear search |
| **Ctrl+Z** | Undo in editor |
| **Ctrl+Shift+Z** | Redo in editor |
| **Tab** | Insert 2 spaces in editor |
| **Arrow Up/Down** | Navigate solution table |
