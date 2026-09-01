### Structure

```
# MCU selection (glob patterns, searches stored MCUs)
mcu: STM32F405*
mcu: STM32G4*VE | STM32F4*VG

# Filter by package, RAM/ROM/freq/temp/voltage
package: LQFP[100,144] | BGA*
ram: 256K          # minimum 256KB
rom: < 2M          # maximum 2MB
freq: 100 < 480    # between 100 and 480 MHz
temp: -40 < 85     # operating temperature range
voltage: 1.8 < 3.3  # operating voltage range (V suffix optional)
core: M4           # MCU must have Cortex-M4
core: M4 + M7      # dual-core (both required)

# Reserve pins and peripherals from solving
reserve: PH0, PH1, ADC*, SPI[1,3]

# Allow peripheral instance sharing across ports
shared: ADC*

# Fix a pin to a specific signal
pin PA4 = DAC1_OUT1
```

### Shared Peripherals

By default, a peripheral instance (e.g., ADC1) is exclusive to one port. Use `shared` to allow multiple ports to use the same instance (individual signals remain exclusive):

```
# Exact instance
shared: ADC1

# Wildcard (all ADC instances)
shared: ADC*

# Range
shared: ADC[1,2], TIM[1-4]
```

### Ports, Groups, Channels & Configs

```
# Inline config (single config ports):
port CMD:
  channel TX = USART*_TX
  channel RX @ PA3 = USART*_RX  # pin-restricted
  require same_instance(TX, RX)

# Explicit configs (multiple alternatives):
port CMD:
  channel TX
  channel RX

  config "UART full duplex":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)

  config "UART half duplex":
    TX = USART*_TX

port PWR:
  group "rail_3v3": @ ~NW
    channel EN     = OUT
    channel PGOOD  = IN
    channel SNS    = ADC*_IN[0-15]

  group "rail_1v8": @ ~SE
    channel EN2    = OUT
    channel PGOOD2 = IN
```

For single-config ports, write mappings on the `channel` line with `=` (creates an implicit config named after the port). For multiple alternatives, use explicit `config` blocks — the solver tries all combinations. A port body also takes `color` and `group` blocks. Inline `#` comments on port, channel, and pin lines are available in custom export functions.

### Solver Settings

```
settings:
  timeout: 3s              # or 3000ms
  solvers: "mrv-group", "hybrid"
  skip_gpio_mapping: 0     # 0/1 or true/false
  pin_proximity: 5         # any cost-function weight

# start from a preset, then override
settings from "complex":
  timeout: 30s
```

Overrides solver settings for this run only — your saved Settings are untouched. Keys: `timeout`, `dynamic_timeout`, `solvers`, `max_solutions`, `max_groups`, `max_solutions_per_group`, `num_restarts`, `skip_gpio_mapping`, `post_optimize`, `squared_costs`, plus any cost-function id (`pin_count`, `pin_proximity`, `pin_anchor`, `pin_group_clustering`, …). Presets: `"default"`, `"complex"`.

### Placement (`@`)

```
# Hard: restrict a channel to specific pins
channel TX @ PA1, PB2    # the TX channel must connect to PA1 and PB2
channel TX @ !PA1        # exclude a pin
channel TX @ PA1, !PB2   # required and excluded can be mixed

# Soft: nudge toward a pin / position / compass region
channel TX @ ~PA1        # near pin PA1
channel TX @ ~1          # near package position 1 (or ~A1 on BGA)
channel TX @ ~NW         # near the north-west of the package

# Port / group / config placement (after the colon)
port CMD: @ PA1          # some channel must use PA1 (hard)
port CMD: @ !PB1         # no channel may use PB1 (hard)
port CMD: @ ~NW          # pull every channel toward NW (soft)
config "UART": @ ~NW     # only the channels in this config
```

Bare pins (`@ PA1`) filter candidates; `!pin` removes a pin from them. A `~` anchor is soft — it only biases ranking via the **Pin Anchor** cost weight. Compass letters `N/S/E/W/C` combine (`NW`, `NNW`, `NC`) and rotate with the package as drawn.

### Port Color

Use `color` to visually distinguish ports in the package viewer:

```
port CMD:
  color "red"
  channel TX
  channel RX
  ...
```

Any CSS color value works (`"#ff0000"`, `"orange"`, `"rgb(0,128,255)"`).

### Signal Patterns

| Pattern | Matches |
|---|---|
| `USART1_TX` | Exact match |
| `USART*_TX` | Any USART instance, TX |
| `TIM[1-3]_CH1` | TIM1, TIM2, or TIM3, CH1 |
| `ADC*_IN[0-7]` | Any ADC, inputs 0-7 |
| `*_TX` | Any peripheral, TX signal |
| `OUT` / `IN` | Any GPIO pin (simple I/O) |

### Operators in Mappings

`|` (alternatives): channel matches ANY of the patterns

`+` (multi-pin): channel gets a separate pin for EACH expression

Evaluation: `A | B + C | D` means `(A | B) + (C | D)`

```
# Channel accepts SPI or I2C (alternatives):
COMM = SPI*_MOSI | I2C*_SDA

# Channel gets an SPI pin AND an extra GPIO pin:
MOSI = SPI*_MOSI + GPIO[1-2]_*
```

To restrict a channel to a specific GPIO port without extra pins, use `require`:

```
require gpio_port(MOSI) == "GPIO1"  # port A only
```

### Built-in Functions

| Function | Meaning |
|---|---|
| `same_instance(A, B)` | Same peripheral instance |
| `same_instance(A, B, "TIM")` | Same instance, filtered by type |
| `diff_instance(A, B)` | Different instances |
| `instance(A)` | Get instance name |
| `instance(A, "TIM")` | Get instance name, filtered by type |
| `type(A)` | Get peripheral type |
| `type(A, "TIM")` | Get peripheral type, filtered by type |
| `gpio_port(A)` | Get GPIO port (e.g., "GPIO1") |
| `gpio_port(A, "SPI")` | Get GPIO port, filtered by type |
| `gpio_pin(A)` | Get pin name (e.g., "PA4") |
| `gpio_pin(A, "SPI")` | Get pin name, filtered by type |
| `pin_number(A)` | Physical pin number (integer) |
| `channel_number(A)` | Peripheral channel/input number |
| `channel_signal(A)` | Signal function name (e.g., "TX", "CH3") |
| `instance_number(A)` | Peripheral instance number |
| `pin_row(A)` | BGA row / LQFP y-component |
| `pin_col(A)` | BGA column / LQFP x-component |
| `pin_distance(A, B)` | Physical distance between pins |
| `dma(A)` | DMA stream available for channel |
| `dma(A, "USART")` | DMA check filtered by type |
| `flag(A, "5V_tolerant", true)` | Every pin of the channel carries that vendor pin flag with that value (a missing flag fails) |

Numeric functions support comparison: `<`, `>`, `<=`, `>=`, `+`, `-`

```
require channel_number(A) < channel_number(B)
require pin_number(A) - pin_number(B) < 5
require dma(TX)
```

### Variable Assignment ($)

Use `$name` after a mapping to assign the resolved value to a variable. Variables map positionally to wildcards (instance first, then function). Channels sharing the same `$name` must resolve to the same value. Scoped to the port (across all configs).

```
# Instance wildcard: $u → same_instance(TX, RX)
TX = USART*_TX $u
RX = USART*_RX $u

# Function wildcard: $ch → channel_signal(A) == channel_signal(B)
A = TIM1_CH* $ch
B = TIM1_CH* $ch

# Both: $t → same_instance, $ch → channel_signal ==
A = TIM*_CH* $t $ch
B = TIM*_CH* $t $ch
```

### Optional Mappings and Requires

Use `?=` for optional mappings — assigned if possible, skipped without error if not. Any `require` referencing an unassigned optional channel is automatically skipped (vacuous truth).

```
port CMD:
  channel TX
  channel RX
  channel CTS
  channel RTS

  config "UART":
    TX = USART*_TX $u
    RX = USART*_RX $u
    CTS ?= USART*_CTS $u
    RTS ?= USART*_RTS $u
```

Use `require?` for soft constraints — ignored if they evaluate to false:

```
require? gpio_port(TX) == gpio_port(RX)
```

### Port Templates

Define a port once, instantiate multiple times with `from`:

```
port encoder_port:
  channel A
  channel B
  config "quadrature":
    encoder(A, B)

port ENC0 from encoder_port color "orange"
port ENC1 from encoder_port color "green"

# Override specific configs:
port ENC2 from encoder_port color "red":
  config "quadrature":
    A = TIM[1-3]_CH1
    B = TIM[1-3]_CH2
```

Templates chain — a port declared with `from X` can itself be used as a template by another port. Cycles are detected and reported as errors. Derived ports inherit the template's `group` blocks; redeclaring a group of the same name replaces it.

### Common-Error Lint

The editor warns when a channel name and its signal pattern reference different tokens from the same "confusable" group — e.g. a channel called `miso` mapped to `SPI*_MOSI`.

Warning lines get a yellow wavy underline and a matching marker in the minimap; details appear in the status panel below the editor. Edit the swap-group library via **Data Manager > Common-error Lint Library**.

```
# Library format: one group per line, tokens separated by spaces.
# The lint flags any mapping where channel + signal contain
# different tokens from the same group.
miso mosi
tx rx
cts rts
ch1 ch2 ch3 ch4
```

### Standard Library Macros

Pre-defined macros for common peripherals. Edit via **Data Manager > Macro Library**.

| Macro | Expands to |
|---|---|
| `uart_port(TX, RX)` | USART full-duplex (same instance) |
| `uart_half_duplex(TX)` | USART TX only |
| `spi_port(MOSI, MISO, SCK)` | SPI master 3-wire |
| `spi_port(MOSI, MISO, SCK, NSS)` | SPI master with chip select |
| `i2c_port(SDA, SCL)` | I2C port |
| `encoder(A, B)` | Timer encoder (CH1+CH2) |
| `encoder(A, B, Z)` | Encoder + index (CH1+CH2+CH3/4) |
| `pwm(CH)` | PWM on any timer channel |
| `dac(OUT)` | DAC output |
| `adc(IN)` | ADC input |
| `can_port(TX, RX)` | CAN bus |

```
# Usage in a config:
config "UART":
  uart_port(TX, RX)
```

### Simple I/O Pins

Use `OUT` and `IN` for simple GPIO pins (LEDs, buttons, etc.):

```
port STATUS:
  channel LED
  channel BTN

  config "GPIO":
    LED = OUT
    BTN = IN
```

Both match any assignable GPIO pin. The distinction is semantic.

### GPIO Port Constraints

Use `gpio_port(CH)` in require to restrict a channel to a GPIO port.

Port mapping: A=GPIO1, B=GPIO2, C=GPIO3, D=GPIO4, ...

```
# USART TX must be on port A:
require gpio_port(TX) == "GPIO1"

# LED must be on port B:
require gpio_port(LED) == "GPIO2"

# TX and RX on the same GPIO port:
require gpio_port(TX) == gpio_port(RX)
```

GPIO signals are also available for multi-pin mappings: `GPIO1_*`, `GPIO[1-2]_*`

### Comment Interpolation

Channel comments are included in exports. Use `\${expr}` for dynamic values:

```
port CMD:
  channel TX  # \${instance(TX)}_TX on pin \${gpio_pin(TX)}
  channel RX  # \${instance(RX)}_RX on pin \${gpio_pin(RX)}
```

Supported expressions: `\${instance(CH)}`, `\${gpio_pin(CH)}`, `\${type(CH)}`, or any channel name `\${CH}` (resolves to signal name). If evaluation fails, `?` is substituted.

### Full Example

```
reserve: PH0, PH1, PA13, PA14
pin PA4 = DAC1_OUT1

port CMD:
  color "#2563eb"
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)

port FB:
  color "#16a34a"
  channel A
  channel B

  config "Encoder":
    encoder(A, B)

port SENSOR:
  channel MOSI
  channel MISO
  channel SCK

  config "SPI":
    spi_port(MOSI, MISO, SCK)
```
