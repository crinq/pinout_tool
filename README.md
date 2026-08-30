# STM32 Pinout Tool

A browser-based tool for automatic STM32 pin assignment using constraint-based solving. Define your peripheral requirements in a simple constraint language, and the solver finds optimal pin assignments across multiple MCU variants.

## Features

- **18 solver algorithms** -- backtracking, two-phase, cost-guided, AC-3, dynamic MRV, randomized restarts, diverse instances, priority backtracking, priority two-phase, priority diverse, priority group, MRV group, ratio MRV group, hybrid, conflict-directed (CBJ + dom/wdeg), CEGAR instance-refinement, LNS repair (min-conflicts), and adaptive portfolio
- **Parallel multi-solver** -- run multiple solvers simultaneously and merge results
- **Visual package viewer** -- interactive canvas with zoom, rotation, pin assignment popup, and signal search
- **Multiple package types** -- LQFP, BGA, and WLCSP support with correct ball/pin rendering
- **Logical / physical pin model** -- handles PINREMAP variants on C0/F0/G0/U0, multi-bond pads on UFQFPN20 / WLCSP, and `_C` analog-switch siblings on H7. The solver locks every co-bonded sibling when one is assigned, so cross-port pinouts never collide on a shared package pad.
- **Reserve by GPIO name OR package position** -- `reserve: PA0`, `reserve: 11`, `reserve: A1` are all valid; position-based reservations lock every logical bonded to that pad.
- **Remote MCU catalogue** -- point the Data Manager at a hosted vendor JSON catalogue (`index.json` + per-die files); browse with a live filter overlay, or let `mcu:` filters auto-fetch matching dies during solve. Fetches are cancellable via the solver Abort button. Cache is in-memory (10 dies / 500 KB), cleared on reload.
- **Cost-optimized solutions** -- ranked by pin count, port spread, clustering, proximity, and more
- **Multi-MCU search** -- solve across multiple MCU variants with `mcu:`, `package:`, `ram:`, `rom:` filters
- **Grouped solution browser** -- solutions grouped by peripheral assignment, keyboard-navigable
- **Pin group highlighting** -- hover/click port names or peripheral instances to highlight pins on the viewer
- **Project management** -- save/load projects, store MCU data in browser localStorage
- **DMA stream assignment** -- `dma()` constraints with automatic stream exclusivity checking (STM32F4 fixed mapping + STM32H7 DMAMUX)
- **CubeMX .ioc import** -- import pin assignments from STM32CubeMX project files
- **Editable macro library** -- customize and extend the standard library macros via Data Manager
- **Common-error lint** -- editable library of "confusable" signal names (miso/mosi, tx/rx, ch1..4) that flags likely name swaps directly in the editor with yellow squiggles + minimap markers
- **Compare solutions** -- Ctrl/Cmd-click multiple project solutions to overlay them in the package viewer; matching pins render normally, divergent pins pulse through one color per solution and expose per-solution mappings in the tooltip
- **Custom export functions** -- user-defined JavaScript export functions for any output format
- **Interactive tutorial** -- guided tour for first-time users
- **Dark mode** -- full light/dark theme support

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Loading MCU Data

1. Download MCU XML files from [STM32CubeMX](https://www.st.com/en/development-tools/stm32cubemx.html) (found in the `db/mcu/` folder of the CubeMX installation)
2. Drag and drop the `.xml` or `.ioc` file onto the app, or click **Import**

### Writing Constraints

Enter constraints in the editor panel. A minimal example:

```
port CMD:
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)
```

Press **Ctrl+Enter** or click **Solve** to find pin assignments.

### Signal Search

Use the search field in the package viewer toolbar to find pins by signal pattern:
- `TIM*_CH1` -- all timer channel 1 pins
- `ADC*_IN[1-4]` -- ADC inputs 1-4
- `PA0` -- specific pin
- `SPI` -- substring match on any SPI signal

### Exporting

Click **Export** in the viewer toolbar to choose a format:
- **PNG** -- raster image of the current canvas view
- **SVG** -- vector graphic, ideal for documentation and scaling
- **Text** -- copy pin assignment table to clipboard
- **JSON** -- structured pin assignment data
- **Custom** -- user-defined JavaScript export functions (manage via Data Manager)

### Skill
You can use this [skill](https://github.com/crinq/skills/tree/master/pinout-constraints) to generate constraints from porject description and user feedback.

## Documentation

See [doc.md](doc.md) for the full constraint language reference, practical examples, and detailed feature documentation.

## Tech Stack

- TypeScript, Vite
- Canvas 2D rendering
- Web Workers for parallel solver execution
- Zero runtime dependencies

## Build

```bash
npm run build    # production build to dist/
npm run dev      # development server with HMR
```

## Known Limitations
### Data quality (working on it)
Some data in the remote repo is parsed from datasheets and not imported from official ST XML files. There will be bugs.

### Constraints syntax (it's a feature not a bug, won't fix)
The constraints language was build around some personal ideas about embedded design (e.g. peripheral instances are exclusive per port). It can't express all possible requirements.

### Vendor lock-in (maybe later)
Right now only cpu data for the STM32 lineup is available, but most of the code base is vendor agnostic.
The [data format specification](https://github.com/crinq/mcu_data_generated/blob/master/format-spec.md) is available and the remote url is configurable. The format might change in the future to support new features or other vendors.

### Vendor specific quirks (working on some)
Some special cases are not known or ignored by the solvers. 
- STM32H7 direct pins can be connected to the corresponding base pin via an analog switch. Currently the solver will not assing any alternate function to a direct pin.
- Some STM32 peripherals allow pinswaping (e.g. UART_TX <-> UART_RX) or simmilar features (e.g. half duplex TX/RX on the same pin). This is not represented in the data.
- Some STM32 peripherals need a combination of pin mappings to work, e.g. the H7 SPI needs a mapped clock pin to work in any mode.

### CubeMX export (won't fix for now)
CubeMX .ioc files need more information to be valid (e.g. peripheral and clock settings). This data is currently not available.