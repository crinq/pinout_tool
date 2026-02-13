> [!WARNING]
> AI-coded and untested!<br>
> Syntax will change in the future!

# STM32 Pinout Tool

A browser-based tool for automatic STM32 pin assignment using constraint-based solving. Define your peripheral requirements in a simple constraint language, and the solver finds optimal pin assignments across multiple MCU variants.

## Features

- **Constraint-based solver** -- declare what peripherals you need, not which pins to use
- **Visual package viewer** -- interactive canvas with zoom, rotation, pin assignment popup, and signal search
- **Multiple package types** -- LQFP, BGA, and WLCSP support with correct ball/pin rendering
- **Cost-optimized solutions** -- ranked by pin count, port spread, clustering, and more
- **Project management** -- save/load projects, store MCU data in browser localStorage
- **Dark mode** -- full light/dark theme support

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Loading MCU Data

1. Download MCU XML files from [STM32CubeMX](https://www.st.com/en/development-tools/stm32cubemx.html) (found in the `db/mcu/` folder of the CubeMX installation)
2. Drag and drop the `.xml` file onto the app, or click **Import XML**

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

Click **Export** in the viewer toolbar to download a PNG of the current view.

## Documentation

See [doc.md](doc.md) for the full constraint language reference, practical examples, and detailed feature documentation.

## Tech Stack

- TypeScript, Vite
- Canvas 2D rendering
- Web Worker for non-blocking solver execution
- Zero runtime dependencies

## Build

```bash
npm run build    # production build to dist/
npm run dev      # development server with HMR
```
