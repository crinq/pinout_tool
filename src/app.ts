import { LayoutManager } from './core/layout-manager';
import { HorizontalSplitter, VerticalSplitter } from './core/splitter';
import { PackageViewer } from './ui/package-viewer';
import { ConstraintEditor } from './ui/constraint-editor';
import { SolutionTable } from './ui/solution-table';
import { PeripheralSummary } from './ui/peripheral-summary';
import { parseMcuXml, validateMcu } from './parser/mcu-xml-parser';
import { getAllCostFunctions } from './solver/cost-functions';
import { getSolvers } from './solver/solver-registry';
import type { Mcu, Assignment } from './types';
import type { ProgramNode } from './parser/constraint-ast';

export interface AppSettings {
  maxSolutions: number;
  solverTimeoutMs: number;
  solverType: string;
  costWeights: Record<string, number>;
  minZoom: number;
  maxZoom: number;
  mouseZoomGain: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  maxSolutions: 300,
  solverTimeoutMs: 5000,
  solverType: 'backtracking',
  costWeights: {
    pin_count: 1,
    port_spread: 0.2,
    peripheral_count: 0.5,
    debug_pin_penalty: 1,
    pin_clustering: 0.5,
  },
  minZoom: 0.5,
  maxZoom: 2,
  mouseZoomGain: 0.05,
};

export class App {
  private layout!: LayoutManager;
  private packageViewer!: PackageViewer;
  private constraintEditor!: ConstraintEditor;
  private solutionTable!: SolutionTable;
  private peripheralSummary!: PeripheralSummary;
  currentMcu: Mcu | null = null;
  settings: AppSettings = this.loadSettings();
  private hasSolverResult = false;
  private solverWorker: Worker | null = null;
  private currentProjectName: string | null = null;
  private projectSelect!: HTMLSelectElement;

  init(): void {
    const appEl = document.getElementById('app');
    if (!appEl) {
      throw new Error('No #app element found');
    }

    // Create layout
    this.layout = new LayoutManager(appEl);

    // Create and register panels
    this.packageViewer = new PackageViewer();
    this.constraintEditor = new ConstraintEditor();
    this.solutionTable = new SolutionTable();
    this.peripheralSummary = new PeripheralSummary();

    const bottomSplitter = HorizontalSplitter();
    bottomSplitter.add(this.solutionTable, 1);
    bottomSplitter.add(this.peripheralSummary, 0.4);

    const vSplitter = VerticalSplitter();
    vSplitter.add(this.packageViewer, 1);
    vSplitter.add(bottomSplitter, 0.5);

    const hSplitter = HorizontalSplitter();
    hSplitter.add(vSplitter, 1);
    hSplitter.add(this.constraintEditor, 1);

    this.layout.body = hSplitter;

    // Set up header
    this.buildHeader();

    // Set up footer
    this.buildFooter();

    // Set up drag-and-drop on the entire app
    this.setupDragAndDrop(appEl);

    // Apply viewer settings
    this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);

    // Wire panels together
    this.wireEvents();

    // Global keyboard shortcuts
    this.setupKeyboardShortcuts();

    // Restore constraint text from URL hash or localStorage
    this.restoreState();
  }

  private wireEvents(): void {
    // Solve button (now in constraint editor)
    const solveBtn = this.constraintEditor.getSolveButton();
    if (solveBtn) {
      solveBtn.addEventListener('click', () => this.runSolver());
    }

    // Solution selection -> package viewer (all assignments across all configs)
    this.solutionTable.onSolutionSelected((solution) => {
      // Collect all unique assignments across all config combinations
      const seen = new Set<string>();
      const assignments = solution.configAssignments.flatMap(ca => ca.assignments).filter(a => {
        const key = `${a.pinName}:${a.signalName}:${a.portName}:${a.channelName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // Extract port colors from the current parse result
      const portColors = this.getPortColors();
      this.layout.broadcastStateChange({ type: 'solution-selected', assignments, portColors });
    });

    // Constraint editor changes -> enable/disable solve button + persist state + pin preview
    this.constraintEditor.onChange((_text, result) => {
      this.saveStateDebounced(_text);
      this.hasSolverResult = false;

      const solveBtn = this.constraintEditor.getSolveButton();
      if (solveBtn) {
        const hasErrors = result.errors.length > 0;
        const hasMcu = this.currentMcu !== null;
        (solveBtn as HTMLButtonElement).disabled = hasErrors || !hasMcu;
      }

      // Show pin declarations on viewer immediately (before solving)
      this.showPinPreview(result.ast);
    });

    // Pin assignment popup -> constraint editor
    this.packageViewer.setPinDeclLookup((pinName) =>
      this.constraintEditor.getPinDeclarationSignal(pinName)
    );
    this.packageViewer.onPinAssign((pinName, signalName) => {
      this.constraintEditor.insertPinDeclaration(pinName, signalName);
    });
    this.packageViewer.onPinUnassign((pinName) => {
      this.constraintEditor.removePinDeclaration(pinName);
    });
  }

  private runSolver(): void {
    // If already solving, abort
    if (this.solverWorker) {
      this.abortSolver();
      return;
    }

    if (!this.currentMcu) {
      this.showStatus('No MCU loaded', 'error');
      return;
    }

    const parseResult = this.constraintEditor.getParseResult();
    if (!parseResult?.ast) {
      this.showStatus('Fix constraint errors before solving', 'error');
      return;
    }

    this.showStatus('Solving...', 'info');
    this.setSolveButtonState(true);

    // Vite requires new Worker(new URL(...)) as a single static expression
    // to detect and bundle workers. Add new solver workers as cases here.
    const worker = new Worker(
      new URL('./solver/solver-worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.solverWorker = worker;

    worker.onmessage = (e) => {
      this.solverWorker = null;
      this.setSolveButtonState(false);

      const result = e.data;
      this.layout.broadcastStateChange({ type: 'solver-complete', solverResult: result });
      this.hasSolverResult = result.solutions.length > 0;

      // Update stats in constraint editor toolbar
      const statsEl = document.getElementById('ce-stats');
      if (statsEl) {
        const s = result.statistics;
        statsEl.textContent = `${s.validSolutions} solutions in ${s.solveTimeMs.toFixed(0)}ms (${s.evaluatedCombinations}/${s.totalCombinations} combos)`;
      }

      // Show solver errors/warnings in constraint editor status bar
      const statusBar = this.constraintEditor.getSolverStatusBar();
      if (statusBar) {
        if (result.errors.length > 0) {
          statusBar.innerHTML = result.errors
            .map((e: { type: string; message: string }) => `<span class="st-${e.type}">${e.message}</span>`)
            .join(' ');
        } else {
          statusBar.textContent = '';
        }
      }

      if (result.solutions.length > 0) {
        this.showStatus(
          `Found ${result.solutions.length} solutions in ${result.statistics.solveTimeMs.toFixed(0)}ms`,
          'success'
        );
      } else {
        const errMsg = result.errors.length > 0
          ? result.errors[0].message
          : 'No valid pin assignments found';
        this.showStatus(errMsg, 'error');

        const partialError = result.errors.find((e: { partialSolution?: unknown[] }) => e.partialSolution && e.partialSolution.length > 0);
        if (partialError?.partialSolution) {
          const portColors = this.getPortColors();
          this.layout.broadcastStateChange({
            type: 'solution-selected',
            assignments: partialError.partialSolution,
            portColors,
          });
        }
      }
    };

    worker.onerror = (err) => {
      this.solverWorker = null;
      this.setSolveButtonState(false);
      console.error('Solver worker error:', err);
      this.showStatus(`Solver error: ${err.message}`, 'error');
    };

    worker.postMessage({
      ast: parseResult.ast,
      mcu: this.currentMcu,
      config: {
        maxSolutions: this.settings.maxSolutions,
        timeoutMs: this.settings.solverTimeoutMs,
        costWeights: new Map(Object.entries(this.settings.costWeights)),
      },
    });
  }

  private abortSolver(): void {
    if (this.solverWorker) {
      this.solverWorker.terminate();
      this.solverWorker = null;
      this.setSolveButtonState(false);
      this.showStatus('Solver aborted', 'info');
    }
  }

  private setSolveButtonState(solving: boolean): void {
    const btn = this.constraintEditor.getSolveButton() as HTMLButtonElement | null;
    if (!btn) return;
    if (solving) {
      btn.textContent = 'Abort';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-abort');
    } else {
      btn.textContent = 'Solve';
      btn.classList.remove('btn-abort');
      btn.classList.add('btn-primary');
    }
  }

  private buildHeader(): void {
    const header = this.layout.getHeader();
    header.innerHTML = `
      <div class="header-left">
        <span class="app-title">STM32 Pinout Tool</span>
        <span class="mcu-info" id="mcu-info">No MCU loaded</span>
      </div>
      <div class="header-center">
        <button class="btn btn-small" id="btn-project-new" title="New empty project">New</button>
        <select class="project-select" id="project-select" title="Select project">
          <option value="">-- No project --</option>
        </select>
        <button class="btn btn-small" id="btn-project-save" title="Save current project">Save</button>
        <button class="btn btn-small" id="btn-project-save-as" title="Save as new project">Save As</button>
      </div>
      <div class="header-right">
        <button class="btn btn-small" id="btn-import-xml">Import XML</button>
        <button class="btn btn-small" id="btn-data-manager">Data</button>
        <button class="btn btn-small" id="btn-settings">Settings</button>
        <button class="btn btn-small" id="btn-theme-toggle" title="Toggle dark mode">Light</button>
      </div>
    `;

    // File import button
    const importBtn = header.querySelector('#btn-import-xml')!;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.xml';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    header.appendChild(fileInput);

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files) {
        for (const file of fileInput.files) {
          this.loadMcuFile(file);
        }
      }
      fileInput.value = '';
    });

    // Project UI
    this.projectSelect = header.querySelector('#project-select')! as HTMLSelectElement;
    this.refreshProjectList();

    header.querySelector('#btn-project-new')!.addEventListener('click', () => this.newProject());

    this.projectSelect.addEventListener('change', () => {
      const name = this.projectSelect.value;
      if (name) this.loadProject(name);
    });

    header.querySelector('#btn-project-save')!.addEventListener('click', () => {
      if (this.currentProjectName) {
        this.saveProject(this.currentProjectName);
      } else {
        this.saveProjectAs();
      }
    });

    header.querySelector('#btn-project-save-as')!.addEventListener('click', () => this.saveProjectAs());

    // Data manager button
    header.querySelector('#btn-data-manager')!.addEventListener('click', () => this.showDataManager());

    // Settings button
    header.querySelector('#btn-settings')!.addEventListener('click', () => this.showSettingsModal());

    // Theme toggle
    const themeBtn = header.querySelector('#btn-theme-toggle')!;
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    themeBtn.textContent = savedTheme === 'dark' ? 'Dark' : 'Light';

    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      themeBtn.textContent = next === 'dark' ? 'Dark' : 'Light';
      this.layout.broadcastStateChange({ type: 'theme-changed' });
    });
  }

  private buildFooter(): void {
    const footer = this.layout.getFooter();
    footer.innerHTML = `
      <div class="footer-content">
        <span class="footer-hint">Drop STM32CubeMX XML files anywhere to load MCU data</span>
      </div>
    `;
  }

  private setupDragAndDrop(element: HTMLElement): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('drag-over');
    });

    element.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');

      if (e.dataTransfer?.files) {
        for (const file of e.dataTransfer.files) {
          if (file.name.endsWith('.xml')) {
            this.loadMcuFile(file);
          }
        }
      }
    });
  }

  private async loadMcuFile(file: File): Promise<void> {
    try {
      const xmlString = await file.text();
      const mcu = parseMcuXml(xmlString);
      const validation = validateMcu(mcu);

      if (!validation.valid) {
        console.error('MCU validation errors:', validation.errors);
        this.showStatus(`Error loading ${file.name}: ${validation.errors.join(', ')}`, 'error');
        return;
      }

      if (validation.warnings.length > 0) {
        console.warn('MCU validation warnings:', validation.warnings);
      }

      this.currentMcu = mcu;

      // Store raw XML for later re-loading
      try {
        localStorage.setItem(`mcu-xml:${mcu.refName}`, xmlString);
      } catch {
        console.warn('Failed to store MCU XML (storage full?)');
      }

      // Update header
      const mcuInfo = document.getElementById('mcu-info');
      if (mcuInfo) {
        mcuInfo.textContent = `${mcu.refName} | ${mcu.package} | ${mcu.core} @ ${mcu.frequency}MHz | ${mcu.flash}KB Flash | ${mcu.ram}KB RAM`;
      }

      // Broadcast to all panels
      this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu });

      // Enable solve button if constraints are valid
      const solveBtn = this.constraintEditor.getSolveButton();
      if (solveBtn) {
        const parseResult = this.constraintEditor.getParseResult();
        (solveBtn as HTMLButtonElement).disabled = !parseResult || parseResult.errors.length > 0;
      }

      this.showStatus(`Loaded ${mcu.refName} (${mcu.pins.length} pins, ${mcu.peripherals.length} peripherals)`, 'success');

      console.log('Loaded MCU:', mcu.refName);
      console.log('  Pins:', mcu.pins.length);
      console.log('  Assignable pins:', mcu.pins.filter(p => p.isAssignable).length);
      console.log('  Peripherals:', mcu.peripherals.length);
      console.log('  Signal mappings:', mcu.signalToPins.size);
    } catch (err) {
      console.error('Failed to load MCU file:', err);
      this.showStatus(`Failed to load ${file.name}: ${err}`, 'error');
    }
  }

  // ---- Project management ----

  private newProject(): void {
    this.currentProjectName = null;
    localStorage.removeItem('current-project');
    this.constraintEditor.setText('');
    this.hasSolverResult = false;
    this.layout.broadcastStateChange({
      type: 'solution-selected',
      assignments: [],
      portColors: new Map(),
    });
    this.layout.broadcastStateChange({
      type: 'solver-complete',
      solverResult: { mcuRef: '', solutions: [], errors: [], statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 } },
    });
    this.refreshProjectList();
    this.showStatus('New project', 'info');
  }

  private listProjects(): string[] {
    const projects: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('project:')) {
        projects.push(key.substring('project:'.length));
      }
    }
    return projects.sort();
  }

  private saveProject(name: string): void {
    const text = this.constraintEditor.getText();
    localStorage.setItem(`project:${name}`, JSON.stringify({ name, constraintText: text }));
    this.currentProjectName = name;
    localStorage.setItem('current-project', name);
    this.refreshProjectList();
    this.showStatus(`Project "${name}" saved`, 'success');
  }

  private saveProjectAs(): void {
    const name = prompt('Project name:', this.currentProjectName || '');
    if (name && name.trim()) {
      this.saveProject(name.trim());
    }
  }

  loadProject(name: string): void {
    const raw = localStorage.getItem(`project:${name}`);
    if (!raw) {
      this.showStatus(`Project "${name}" not found`, 'error');
      return;
    }
    try {
      const data = JSON.parse(raw);
      this.constraintEditor.setText(data.constraintText || '');
      this.currentProjectName = name;
      localStorage.setItem('current-project', name);
      this.refreshProjectList();
      this.showStatus(`Project "${name}" loaded`, 'success');
    } catch {
      this.showStatus(`Failed to load project "${name}"`, 'error');
    }
  }

  deleteProject(name: string): void {
    localStorage.removeItem(`project:${name}`);
    if (this.currentProjectName === name) {
      this.currentProjectName = null;
      localStorage.removeItem('current-project');
    }
    this.refreshProjectList();
  }

  private refreshProjectList(): void {
    if (!this.projectSelect) return;
    const projects = this.listProjects();
    this.projectSelect.innerHTML = '<option value="">-- No project --</option>';
    for (const name of projects) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === this.currentProjectName) opt.selected = true;
      this.projectSelect.appendChild(opt);
    }
  }

  private showPinPreview(ast: ProgramNode | null): void {
    if (!ast || this.hasSolverResult) return;

    const pinAssignments: Assignment[] = [];
    for (const stmt of ast.statements) {
      if (stmt.type === 'pin_decl') {
        pinAssignments.push({
          pinName: stmt.pinName,
          signalName: stmt.signalName,
          portName: '<pinned>',
          channelName: '<pinned>',
          configurationName: '<pinned>',
        });
      }
    }

    this.layout.broadcastStateChange({
      type: 'solution-selected',
      assignments: pinAssignments,
      portColors: new Map(),
    });
  }

  private getPortColors(): Map<string, string> {
    const colors = new Map<string, string>();
    const parseResult = this.constraintEditor.getParseResult();
    if (parseResult?.ast) {
      for (const stmt of parseResult.ast.statements) {
        if (stmt.type === 'port_decl' && stmt.color) {
          colors.set(stmt.name, stmt.color);
        }
      }
    }
    return colors;
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Enter / Cmd+Enter: solve
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.runSolver();
        return;
      }

      // Escape: close any open modal
      if (e.key === 'Escape') {
        const overlay = document.querySelector('.settings-overlay, .ce-help-overlay, .pv-assign-popup');
        if (overlay) {
          overlay.remove();
          e.preventDefault();
        }
        return;
      }
    });
  }

  private restoreState(): void {
    // Restore current project name
    this.currentProjectName = localStorage.getItem('current-project') || null;
    this.refreshProjectList();

    // Try URL hash first, then localStorage
    const hash = window.location.hash.slice(1);
    if (hash) {
      try {
        const text = decodeURIComponent(atob(hash));
        this.constraintEditor.setText(text);
        return;
      } catch { /* invalid hash, ignore */ }
    }

    // If we have a current project, load it
    if (this.currentProjectName) {
      const raw = localStorage.getItem(`project:${this.currentProjectName}`);
      if (raw) {
        try {
          const data = JSON.parse(raw);
          this.constraintEditor.setText(data.constraintText || '');
          return;
        } catch { /* fallthrough */ }
      }
    }

    const saved = localStorage.getItem('constraint-text');
    if (saved) {
      this.constraintEditor.setText(saved);
    }
  }

  private saveStateDebounced = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (text: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        localStorage.setItem('constraint-text', text);
        try {
          const encoded = btoa(encodeURIComponent(text));
          history.replaceState(null, '', '#' + encoded);
        } catch { /* ignore encoding errors */ }
      }, 1000);
    };
  })();

  private loadSettings(): AppSettings {
    try {
      const raw = localStorage.getItem('app-settings');
      if (raw) {
        const saved = JSON.parse(raw);
        return { ...DEFAULT_SETTINGS, ...saved, costWeights: { ...DEFAULT_SETTINGS.costWeights, ...saved.costWeights } };
      }
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
  }

  private saveSettings(): void {
    localStorage.setItem('app-settings', JSON.stringify(this.settings));
  }

  private showSettingsModal(): void {
    const existing = document.querySelector('.settings-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const costFunctions = getAllCostFunctions();
    const solvers = getSolvers();

    modal.innerHTML = `
      <div class="settings-header">
        <strong>Settings</strong>
        <button class="btn btn-small settings-close">Close</button>
      </div>
      <div class="settings-body">
        <section class="settings-section">
          <h3>Solver</h3>
          <div class="settings-row">
            <label>Algorithm</label>
            <select class="settings-input" id="set-solver-type" style="width:auto">
              ${solvers.map(s => `<option value="${s.id}" ${s.id === this.settings.solverType ? 'selected' : ''} title="${s.description}">${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="settings-row">
            <label>Max solutions</label>
            <input type="number" class="settings-input" id="set-max-solutions" min="1" max="10000" value="${this.settings.maxSolutions}">
          </div>
          <div class="settings-row">
            <label>Timeout (ms)</label>
            <input type="number" class="settings-input" id="set-timeout" min="100" max="60000" step="100" value="${this.settings.solverTimeoutMs}">
          </div>
        </section>

        <section class="settings-section">
          <h3>Cost Function Weights</h3>
          <p class="settings-hint">0 = disabled, 1 = normal, 2 = 200% impact</p>
          ${costFunctions.map(fn => `
            <div class="settings-row">
              <label title="${fn.description}">${fn.name}</label>
              <input type="number" class="settings-input" data-cost-id="${fn.id}" min="0" max="10" step="0.1" value="${this.settings.costWeights[fn.id] ?? 1}">
            </div>
          `).join('')}
        </section>

        <section class="settings-section">
          <h3>Viewer</h3>
          <div class="settings-row">
            <label>Min zoom</label>
            <input type="number" class="settings-input" id="set-min-zoom" min="0.1" max="1" step="0.1" value="${this.settings.minZoom}">
          </div>
          <div class="settings-row">
            <label>Max zoom</label>
            <input type="number" class="settings-input" id="set-max-zoom" min="1" max="20" step="0.5" value="${this.settings.maxZoom}">
          </div>
          <div class="settings-row">
            <label>Mouse zoom gain</label>
            <input type="number" class="settings-input" id="set-zoom-gain" min="0.01" max="1" step="0.01" value="${this.settings.mouseZoomGain}">
          </div>
        </section>

        <div class="settings-actions">
          <button class="btn btn-small" id="set-reset-defaults">Reset Defaults</button>
          <button class="btn btn-primary btn-small" id="set-apply">Apply</button>
        </div>
      </div>
    `;

    modal.querySelector('.settings-close')!.addEventListener('click', () => overlay.remove());

    modal.querySelector('#set-apply')!.addEventListener('click', () => {
      this.settings.solverType = (modal.querySelector('#set-solver-type') as HTMLSelectElement).value || DEFAULT_SETTINGS.solverType;
      this.settings.maxSolutions = parseInt((modal.querySelector('#set-max-solutions') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxSolutions;
      this.settings.solverTimeoutMs = parseInt((modal.querySelector('#set-timeout') as HTMLInputElement).value) || DEFAULT_SETTINGS.solverTimeoutMs;
      this.settings.minZoom = parseFloat((modal.querySelector('#set-min-zoom') as HTMLInputElement).value) || DEFAULT_SETTINGS.minZoom;
      this.settings.maxZoom = parseFloat((modal.querySelector('#set-max-zoom') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxZoom;
      this.settings.mouseZoomGain = parseFloat((modal.querySelector('#set-zoom-gain') as HTMLInputElement).value) || DEFAULT_SETTINGS.mouseZoomGain;

      modal.querySelectorAll<HTMLInputElement>('[data-cost-id]').forEach(input => {
        const id = input.dataset.costId!;
        this.settings.costWeights[id] = parseFloat(input.value) || 0;
      });

      this.saveSettings();
      this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);
      overlay.remove();
      this.showStatus('Settings saved', 'success');
    });

    modal.querySelector('#set-reset-defaults')!.addEventListener('click', () => {
      this.settings = { ...DEFAULT_SETTINGS, costWeights: { ...DEFAULT_SETTINGS.costWeights } };
      this.saveSettings();
      overlay.remove();
      this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);
      this.showStatus('Settings reset to defaults', 'success');
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  private loadStoredMcu(refName: string): void {
    const xml = localStorage.getItem(`mcu-xml:${refName}`);
    if (!xml) {
      this.showStatus(`Stored MCU "${refName}" not found`, 'error');
      return;
    }
    try {
      const mcu = parseMcuXml(xml);
      const validation = validateMcu(mcu);
      if (!validation.valid) {
        this.showStatus(`Error loading ${refName}: ${validation.errors.join(', ')}`, 'error');
        return;
      }
      this.currentMcu = mcu;

      const mcuInfo = document.getElementById('mcu-info');
      if (mcuInfo) {
        mcuInfo.textContent = `${mcu.refName} | ${mcu.package} | ${mcu.core} @ ${mcu.frequency}MHz | ${mcu.flash}KB Flash | ${mcu.ram}KB RAM`;
      }

      this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu });

      const solveBtn = this.constraintEditor.getSolveButton();
      if (solveBtn) {
        const parseResult = this.constraintEditor.getParseResult();
        (solveBtn as HTMLButtonElement).disabled = !parseResult || parseResult.errors.length > 0;
      }

      this.showStatus(`Loaded ${mcu.refName} from storage`, 'success');
    } catch (err) {
      this.showStatus(`Failed to parse stored MCU "${refName}": ${err}`, 'error');
    }
  }

  private listStoredMcus(): { refName: string; size: number }[] {
    const mcus: { refName: string; size: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('mcu-xml:')) {
        const refName = key.substring('mcu-xml:'.length);
        const size = (localStorage.getItem(key) || '').length;
        mcus.push({ refName, size });
      }
    }
    return mcus.sort((a, b) => a.refName.localeCompare(b.refName));
  }

  private showDataManager(): void {
    const existing = document.querySelector('.settings-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const renderContent = (): void => {
      const storedMcus = this.listStoredMcus();
      const projects = this.listProjects();

      modal.innerHTML = `
        <div class="settings-header">
          <strong>Data Manager</strong>
          <button class="btn btn-small settings-close">Close</button>
        </div>
        <div class="settings-body">
          <section class="settings-section">
            <h3>Stored MCUs</h3>
            ${storedMcus.length === 0 ? '<p class="settings-hint">No MCUs stored. Import XML files to store them.</p>' : ''}
            <div class="dm-list">
              ${storedMcus.map(m => `
                <div class="dm-row" data-mcu="${m.refName}">
                  <span class="dm-name">${m.refName}</span>
                  <span class="dm-size">${(m.size / 1024).toFixed(0)}KB</span>
                  <button class="btn btn-small dm-load" data-action="load-mcu" data-name="${m.refName}">Load</button>
                  <button class="btn btn-small dm-delete" data-action="delete-mcu" data-name="${m.refName}">Delete</button>
                </div>
              `).join('')}
            </div>
          </section>

          <section class="settings-section">
            <h3>Projects</h3>
            ${projects.length === 0 ? '<p class="settings-hint">No projects saved. Use "Save As" to create one.</p>' : ''}
            <div class="dm-list">
              ${projects.map(name => {
                const raw = localStorage.getItem(`project:${name}`);
                const size = raw ? raw.length : 0;
                return `
                  <div class="dm-row" data-project="${name}">
                    <span class="dm-name">${name}${name === this.currentProjectName ? ' (active)' : ''}</span>
                    <span class="dm-size">${(size / 1024).toFixed(1)}KB</span>
                    <button class="btn btn-small dm-load" data-action="load-project" data-name="${name}">Load</button>
                    <button class="btn btn-small dm-delete" data-action="delete-project" data-name="${name}">Delete</button>
                  </div>
                `;
              }).join('')}
            </div>
          </section>
        </div>
      `;

      modal.querySelector('.settings-close')!.addEventListener('click', () => overlay.remove());

      modal.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = (btn as HTMLElement).dataset.action;
          const name = (btn as HTMLElement).dataset.name!;
          switch (action) {
            case 'load-mcu':
              this.loadStoredMcu(name);
              overlay.remove();
              break;
            case 'delete-mcu':
              localStorage.removeItem(`mcu-xml:${name}`);
              renderContent();
              break;
            case 'load-project':
              this.loadProject(name);
              overlay.remove();
              break;
            case 'delete-project':
              this.deleteProject(name);
              renderContent();
              break;
          }
        });
      });
    };

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    renderContent();
  }

  private showStatus(message: string, type: 'success' | 'error' | 'info'): void {
    const footer = this.layout.getFooter();
    const hint = footer.querySelector('.footer-hint');
    if (hint) {
      hint.textContent = message;
      hint.className = `footer-hint status-${type}`;
      // Reset after 5 seconds
      setTimeout(() => {
        if (hint.textContent === message) {
          hint.textContent = 'Drop STM32CubeMX XML files anywhere to load MCU data';
          hint.className = 'footer-hint';
        }
      }, 5000);
    }
  }
}
