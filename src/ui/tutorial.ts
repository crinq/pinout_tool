// ============================================================
// First-Time User Tutorial
//
// A step-by-step guided tour of the app. Each step highlights
// a region of the UI with a spotlight cutout and shows an
// explanation tooltip. Steps advance with Next/Back/Skip.
//
// Shown automatically on first visit (no MCU data in storage).
// Can be re-triggered from the Help button.
// ============================================================

interface TutorialStep {
  /** CSS selector or callback returning the target element */
  target: string | (() => HTMLElement | null);
  /** Tooltip title */
  title: string;
  /** Tooltip body (HTML) */
  body: string;
  /** Preferred tooltip placement relative to target */
  placement: 'top' | 'bottom' | 'left' | 'right';
}

function findPanel(id: string): HTMLElement | null {
  return document.querySelector(`[data-panel-id="${id}"]`) as HTMLElement | null;
}

const STEPS: TutorialStep[] = [
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
      Pin declarations (<code>pin PA5 = SPI1_SCK</code>) lock specific pins. Click the <b>Help</b> button for the full syntax reference.`,
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
      Project solutions persist across solver runs and are included when you save the project.`,
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
    target: '#project-select',
    title: 'Projects',
    body: `Your work is organized into projects. Use the dropdown to switch between projects.<br><br>
      <b>New</b> &mdash; start an empty project<br>
      <b>Save</b> &mdash; save constraints, MCU, and project solutions<br>
      <b>Save As</b> &mdash; save under a new name, or as a new version with the old name<br><br>
      Each save as creates a <b>version</b>, so you can go back to previous states.
      Projects are stored in your browser's local storage.`,
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
    body: `Configure solver algorithms, timeouts, cost function weights, and display options.<br><br>
      You can also replay this tutorial from here.`,
    placement: 'bottom',
  },
  {
    target: () => document.querySelector('.app-header') as HTMLElement,
    title: 'Ready!',
    body: `That's everything. Import an MCU XML to get started.<br><br>
      You can replay this tutorial anytime from <b>Settings</b>.`,
    placement: 'bottom',
  },
];

let overlay: HTMLElement | null = null;
let currentStep = 0;

function getTargetElement(step: TutorialStep): HTMLElement | null {
  if (typeof step.target === 'function') return step.target();
  return document.querySelector(step.target) as HTMLElement | null;
}

function positionTooltip(
  tooltip: HTMLElement,
  target: HTMLElement,
  placement: TutorialStep['placement'],
): void {
  const tr = target.getBoundingClientRect();
  const gap = 12;

  // Reset for measurement
  tooltip.style.left = '0';
  tooltip.style.top = '0';
  const tt = tooltip.getBoundingClientRect();

  let left: number;
  let top: number;

  switch (placement) {
    case 'bottom':
      left = tr.left + tr.width / 2 - tt.width / 2;
      top = tr.bottom + gap;
      break;
    case 'top':
      left = tr.left + tr.width / 2 - tt.width / 2;
      top = tr.top - tt.height - gap;
      break;
    case 'right':
      left = tr.right + gap;
      top = tr.top + tr.height / 2 - tt.height / 2;
      break;
    case 'left':
      left = tr.left - tt.width - gap;
      top = tr.top + tr.height / 2 - tt.height / 2;
      break;
  }

  // Clamp to viewport
  const pad = 8;
  left = Math.max(pad, Math.min(left, window.innerWidth - tt.width - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - tt.height - pad));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function renderStep(): void {
  if (!overlay) return;

  const step = STEPS[currentStep];
  const target = getTargetElement(step);

  // Spotlight mask via clip-path
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 4;
    const x1 = r.left - pad, y1 = r.top - pad;
    const x2 = r.right + pad, y2 = r.bottom + pad;
    // Polygon with a rectangular hole
    overlay.style.clipPath = `polygon(
      0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
      ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px
    )`;
  } else {
    overlay.style.clipPath = '';
  }

  // Remove old tooltip
  const old = document.querySelector('.tutorial-tooltip');
  if (old) old.remove();

  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'tutorial-tooltip';
  tooltip.innerHTML = `
    <div class="tutorial-tooltip-title">${step.title}</div>
    <div class="tutorial-tooltip-body">${step.body}</div>
    <div class="tutorial-tooltip-nav">
      <span class="tutorial-tooltip-progress">${currentStep + 1} / ${STEPS.length}</span>
      <div class="tutorial-tooltip-buttons">
        ${currentStep > 0 ? '<button class="btn btn-small tutorial-btn-back">Back</button>' : ''}
        <button class="btn btn-small tutorial-btn-skip">Skip</button>
        ${currentStep < STEPS.length - 1
          ? '<button class="btn btn-small btn-primary tutorial-btn-next">Next</button>'
          : '<button class="btn btn-small btn-primary tutorial-btn-next">Done</button>'}
      </div>
    </div>
  `;

  document.body.appendChild(tooltip);

  // Position relative to target
  if (target) {
    positionTooltip(tooltip, target, step.placement);
  } else {
    // Center on screen
    const tt = tooltip.getBoundingClientRect();
    tooltip.style.left = `${(window.innerWidth - tt.width) / 2}px`;
    tooltip.style.top = `${(window.innerHeight - tt.height) / 2}px`;
  }

  // Button handlers
  tooltip.querySelector('.tutorial-btn-next')?.addEventListener('click', () => {
    if (currentStep < STEPS.length - 1) {
      currentStep++;
      renderStep();
    } else {
      closeTutorial();
    }
  });
  tooltip.querySelector('.tutorial-btn-back')?.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep--;
      renderStep();
    }
  });
  tooltip.querySelector('.tutorial-btn-skip')?.addEventListener('click', closeTutorial);
}

function closeTutorial(): void {
  overlay?.remove();
  overlay = null;
  document.querySelector('.tutorial-tooltip')?.remove();
  localStorage.setItem('tutorial-seen', '1');
}

export function startTutorial(onStart?: () => void): void {
  // Clean up any existing
  closeTutorial();

  // Load example data if provided
  if (onStart) onStart();

  currentStep = 0;

  overlay = document.createElement('div');
  overlay.className = 'tutorial-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      // Click on backdrop advances to next step (or closes on last)
      if (currentStep < STEPS.length - 1) {
        currentStep++;
        renderStep();
      } else {
        closeTutorial();
      }
    }
  });

  document.body.appendChild(overlay);

  // Handle window resize
  const onResize = () => { if (overlay) renderStep(); };
  window.addEventListener('resize', onResize);

  // Clean up resize listener when tutorial closes
  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay!)) {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  // Escape to close
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeTutorial();
      document.removeEventListener('keydown', onKey);
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      if (currentStep < STEPS.length - 1) { currentStep++; renderStep(); }
      else closeTutorial();
    } else if (e.key === 'ArrowLeft') {
      if (currentStep > 0) { currentStep--; renderStep(); }
    }
  };
  document.addEventListener('keydown', onKey);

  renderStep();
}

/**
 * Returns true if the tutorial has never been completed.
 */
export function shouldShowTutorial(): boolean {
  return localStorage.getItem('tutorial-seen') === null;
}
