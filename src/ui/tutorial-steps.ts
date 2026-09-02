// ============================================================
// Guided-tour step definitions (pure data; selectors resolve lazily)
// ============================================================

import type { TutorialStep } from '../../ts_lib/src/tutorial';

export function getTutorialSteps(): TutorialStep[] {
    const findPanel = (id: string) => document.querySelector(`[data-panel-id="${id}"]`) as HTMLElement | null;
    return [
      {
        target: () => document.querySelector('.app-header') as HTMLElement,
        title: 'Welcome',
        body: `This tool helps you assign STM32 peripheral signals to MCU pins using constraint-based solving.<br><br>
          Let's walk through the basics.`,
        placement: 'bottom',
      },
      {
        target: '#btn-import-xml',
        title: 'Import MCU Data',
        body: `Start by importing an MCU XML file from your STM32CubeMX installation
          (<code>db/mcu/</code> folder). You can also drag & drop <code>.xml</code> or <code>.ioc</code> files anywhere.<br><br>
          The XML defines which pins and peripheral signals are available.
          Importing a <code>.ioc</code> file adds its pin assignments as <code>pin</code> declarations to your constraints.`,
        placement: 'bottom',
      },
      {
        target: () => findPanel('package-viewer'),
        title: 'Package Viewer',
        body: `Once an MCU is loaded, its package appears here. Scroll to zoom, drag to pan, and click pins to see available signals.<br><br>
          Use the search field to highlight pins by signal pattern (e.g. <code>SPI*_SCK</code>).
          Click <b>Export</b> to save your pinout as PNG, SVG, text, JSON, or a custom format.`,
        placement: 'right',
      },
      {
        target: () => findPanel('constraint-editor'),
        title: 'Write Constraints',
        body: `Define your peripheral requirements here. A minimal example:<br>
          <pre style="margin:8px 0;padding:6px 8px;background:var(--bg-secondary);border-radius:3px;font-size:11px;line-height:1.4">port CMD:
  channel TX
  channel RX

  config "UART":
    TX = USART*_TX
    RX = USART*_RX
    require same_instance(TX, RX)</pre>
          Pin declarations (<code>pin PA5 = SPI1_SCK</code>) lock specific pins. Click <b>Syntax Help</b> for the language reference, or <b>Docs</b> (top bar) for the full documentation.<br><br>
          Syntax errors show a red squiggle; suspected signal-name swaps (e.g. a
          <code>miso</code> channel mapped to <code>SPI*_MOSI</code>) show a yellow
          squiggle. Both list in the status panel below. Edit the swap-group library via
          <b>Data Manager &gt; Common-error Lint Library</b>.`,
        placement: 'left',
      },
      {
        target: '#btn-solve',
        title: 'Solve',
        body: `Press <b>Ctrl+Enter</b> or click <b>Solve</b> to find valid pin assignments.
          Multiple solvers run in parallel and results are merged.`,
        placement: 'left',
      },
      {
        target: () => findPanel('solver-solutions'),
        title: 'Solver Solutions',
        body: `Solutions appear here, grouped by peripheral instance assignment.
          Use <b>arrow keys</b> to navigate between groups and solutions.<br><br>
          Each group represents a different combination of peripheral instances (e.g. SPI1+UART2 vs SPI3+UART5).
          Selecting a solution highlights the assigned pins on the package viewer.`,
        placement: 'top',
      },
      {
        target: () => findPanel('project-solutions'),
        title: 'Project Solutions',
        body: `Save interesting solutions here for later comparison.
          Select a solver solution and press <b>Enter</b> to add it to the project.<br><br>
          Project solutions persist across solver runs and are included when you save the project.<br><br>
          A <b>validity badge</b> on each row shows whether it still fits the <i>current</i> constraints:
          <b style="color:#22c55e">✓</b> valid, <b style="color:#3b82f6">●</b> valid but with assignments
          the constraints no longer require, <b style="color:#ef4444">✕</b> invalid. It updates live as you
          edit the constraint text &mdash; handy for spotting which saved solutions survived a change.<br><br>
          <b>Compare mode:</b> Ctrl/Cmd-click multiple rows to compare them in the
          package viewer &mdash; matching pins render normally, differing pins pulse
          through one color per selected solution, and their tooltip lists every
          per-solution mapping.`,
        placement: 'top',
      },
      {
        target: () => findPanel('peripheral-summary'),
        title: 'Peripheral Summary',
        body: `Shows which peripheral instances are used by the selected solution and how they map to ports.<br><br>
          Helps you quickly compare solutions to see which peripherals are consumed and which remain free.`,
        placement: 'top',
      },
      {
        target: () => {
          const el = document.querySelector('.pv-edit-controls') as HTMLElement | null;
          return el && el.childElementCount > 0 ? el : null;
        },
        title: 'Modify a Solution',
        body: `With a solution selected, click <b>✎ Modify</b> in the package-viewer toolbar to hand-tune
          the routing for your board &mdash; no re-solving needed. In modify mode:<br><br>
          &bull; click a <b>pin</b> to move its signal to another free pin, or place an unmapped IN/OUT signal<br>
          &bull; click a <b>port</b> in the peripheral summary to swap all its peripherals with a compatible port<br>
          &bull; click a <b>peripheral</b> to swap it with another port's, or with an unused instance<br><br>
          Every option shows its <b>cost change</b> and glows the pins it moves when you hover it.
          <b>Ctrl+Z / Ctrl+Shift+Z</b> undo/redo; <b>Save</b> adds the edited solution to the project,
          <b>Discard</b> exits without keeping changes.`,
        placement: 'bottom',
      },
      {
        target: '#project-select',
        title: 'Projects',
        body: `Your work is organized into projects. Use the dropdown to switch between projects.<br><br>
          <b>New</b> &mdash; start an empty project<br>
          <b>Save</b> &mdash; save constraints, MCU, and project solutions<br>
          <b>Save As</b> &mdash; save under a new name, or as a new version with the old name<br><br>
          Each save as creates a <b>version</b>, so you can go back to previous states.
          Projects are stored in your browser's local storage. If a project's MCU isn't stored
          locally, it's fetched automatically from the configured remote data source on open.`,
        placement: 'bottom',
      },
      {
        target: '#btn-data-manager',
        title: 'Data Manager',
        body: `View and manage stored MCU data, DMA files, projects, custom export functions, and the macro library.
          You can edit the shared macro library to add or modify macros available in all constraints.`,
        placement: 'bottom',
      },
      {
        target: '#btn-settings',
        title: 'Settings',
        body: `Configure which of the 18 solver algorithms run, timeouts, cost-function weights, and display options.<br><br>
          Two options worth knowing: <b>Skip GPIO mapping</b> (faster when there are many IN/OUT channels)
          and <b>Post-optimize pins</b> (after solving, greedily relocate pins to lower the cost).`,
        placement: 'bottom',
      },
      {
        target: () => document.querySelector('.app-header') as HTMLElement,
        title: 'Ready!',
        body: `That's everything. Import an MCU XML to get started.<br><br>
          You can replay this tutorial anytime from the <b>Tutorial</b> button in the header.`,
        placement: 'bottom',
      },
    ];
  }
