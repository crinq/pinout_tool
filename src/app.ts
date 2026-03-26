import { LayoutManager } from './core/layout-manager';
import { HorizontalSplitter, VerticalSplitter } from './core/splitter';
import { PackageViewer } from './ui/package-viewer';
import { ConstraintEditor } from './ui/constraint-editor';
import { SolverSolutions } from './ui/solution-table';
import { ProjectSolutions } from './ui/project-solutions';
import { PeripheralSummary } from './ui/peripheral-summary';
import { parseMcuXml, validateMcu } from './parser/mcu-xml-parser';
import { parseDmaXml, isDmaXml, getDmaXmlVersion } from './parser/dma-xml-parser';
import { isIocFile, parseIocFile } from './parser/ioc-parser';
import { getAllCostFunctions } from './solver/cost-functions';
import { getSolvers } from './solver/solver-registry';
import type { Mcu, Assignment, Solution, SolverResult, DmaData, CompatibilityResult } from './types';
import type { ProgramNode } from './parser/constraint-ast';
import { parseConstraints } from './parser/constraint-parser';
import { serializeSolution, deserializeSolution, migrateProjectData, seedDefaultExports, loadCustomExports, saveCustomExport, deleteCustomExport, saveMacroLibrary } from './storage';
import type { ProjectData, ProjectVersion, SerializedSolution } from './storage';
import type { CustomExportFunction } from './types';
import { mergeResults, type LabeledSolverResult } from './solver/result-merger';
import { SolverDebugOverlay } from './ui/solver-debug-overlay';
import { startTutorial, shouldShowTutorial } from './ui/tutorial';
import { seedMacroLibrary, getStdlibSource, invalidateStdlibCache, DEFAULT_MACRO_LIBRARY, getStdlibMacroNames } from './parser/stdlib-macros';

// ============================================================
// Simple JS syntax highlighter for the export function editor
// ============================================================

const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'switch',
  'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'true', 'false', 'null', 'undefined', 'this',
]);

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightJs(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];

    // Line comment
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const slice = end === -1 ? code.substring(i) : code.substring(i, end);
      out.push(`<span class="hl-comment">${escHtml(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // Block comment
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const slice = end === -1 ? code.substring(i) : code.substring(i, end + 2);
      out.push(`<span class="hl-comment">${escHtml(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // String (single, double, backtick)
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && code[j] !== ch) {
        if (code[j] === '\\') j++; // skip escaped char
        j++;
      }
      if (j < n) j++; // include closing quote
      const slice = code.substring(i, j);
      out.push(`<span class="hl-string">${escHtml(slice)}</span>`);
      i = j;
      continue;
    }

    // Number
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      let j = i;
      if (ch === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(code[j])) j++;
      } else {
        while (j < n && ((code[j] >= '0' && code[j] <= '9') || code[j] === '.')) j++;
      }
      out.push(`<span class="hl-number">${escHtml(code.substring(i, j))}</span>`);
      i = j;
      continue;
    }

    // Word (identifier or keyword)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let j = i + 1;
      while (j < n && ((code[j] >= 'a' && code[j] <= 'z') || (code[j] >= 'A' && code[j] <= 'Z') || (code[j] >= '0' && code[j] <= '9') || code[j] === '_' || code[j] === '$')) j++;
      const word = code.substring(i, j);
      if (JS_KEYWORDS.has(word)) {
        out.push(`<span class="hl-keyword">${escHtml(word)}</span>`);
      } else {
        out.push(escHtml(word));
      }
      i = j;
      continue;
    }

    // Default: single character
    out.push(escHtml(ch));
    i++;
  }

  return out.join('');
}

export interface AppSettings {
  maxSolutions: number;
  solverTimeoutMs: number;
  solverTypes: string[];
  maxGroups: number;
  maxSolutionsPerGroup: number;
  numRestarts: number;
  costWeights: Record<string, number>;
  minZoom: number;
  maxZoom: number;
  mouseZoomGain: number;
  skipGpioMapping: boolean;
  dataInspector: boolean;
  solverDebugOverlay: boolean;
  urlEncoding: 'none' | 'constraints' | 'constraints-mcu' | 'full';
}

const DEFAULT_SETTINGS: AppSettings = {
  maxSolutions: 5000,
  solverTimeoutMs: 2500,
  solverTypes: ['two-phase', 'cost-guided', 'priority-backtracking', 'mrv-group', 'ratio-mrv-group', 'hybrid'],
  maxGroups: 500,
  maxSolutionsPerGroup: 100,
  numRestarts: 150,
  costWeights: {
    pin_count: 1,
    port_spread: 0.2,
    peripheral_count: 0.5,
    debug_pin_penalty: 0.0,
    pin_clustering: 0.0,
    pin_proximity: 1,
  },
  minZoom: 0.5,
  maxZoom: 2,
  mouseZoomGain: 0.025,
  skipGpioMapping: true,
  dataInspector: false,
  solverDebugOverlay: false,
  urlEncoding: 'full',
};

interface UrlState {
  v: 1;
  c: string;
  m?: string;
  sol?: SerializedSolution;
}

export class App {
  private layout!: LayoutManager;
  private packageViewer!: PackageViewer;
  private constraintEditor!: ConstraintEditor;
  private solverSolutions!: SolverSolutions;
  private projectSolutions!: ProjectSolutions;
  private peripheralSummary!: PeripheralSummary;
  currentMcu: Mcu | null = null;
  settings: AppSettings = this.loadSettings();
  private hasSolverResult = false;
  private loadingProject = false;
  private solverWorkers: Worker[] = [];
  private debugOverlay = new SolverDebugOverlay();
  private currentSolution: Solution | null = null;
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
    this.solverSolutions = new SolverSolutions();
    this.projectSolutions = new ProjectSolutions();
    this.peripheralSummary = new PeripheralSummary();

    const bottomSplitter = HorizontalSplitter();
    bottomSplitter.add(this.solverSolutions, 1);
    bottomSplitter.add(this.projectSolutions, 1);
    bottomSplitter.add(this.peripheralSummary, 0.5);

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

    // Seed defaults
    seedDefaultExports();
    seedMacroLibrary();

    // Show tutorial for first-time users
    if (shouldShowTutorial()) {
      requestAnimationFrame(() => startTutorial(() => this.loadTutorialExample()));
    }
  }

  private wireEvents(): void {
    // Solve button (now in constraint editor)
    const solveBtn = this.constraintEditor.getSolveButton();
    if (solveBtn) {
      solveBtn.addEventListener('click', () => this.runSolver());
    }

    // Solution selection -> package viewer (shared by both lists)
    const handleSolutionSelected = (solution: Solution) => {
      this.currentSolution = solution;
      const seen = new Set<string>();
      const assignments = solution.configAssignments.flatMap(ca => ca.assignments).filter(a => {
        const key = `${a.pinName}:${a.signalName}:${a.portName}:${a.channelName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // Merge DMA stream assignments from all config combinations
      const dmaStreamAssignment = new Map<string, string>();
      for (const ca of solution.configAssignments) {
        if (ca.dmaStreamAssignment) {
          for (const [sig, stream] of ca.dmaStreamAssignment) {
            dmaStreamAssignment.set(sig, stream);
          }
        }
      }
      const portColors = this.getPortColors();
      const compatibility = this.checkSolutionCompatibility(assignments, solution.mcuRef);
      this.layout.broadcastStateChange({
        type: 'solution-selected', assignments, portColors,
        gpioCount: solution.gpioCount,
        dmaStreamAssignment: dmaStreamAssignment.size > 0 ? dmaStreamAssignment : undefined,
        compatibility,
      });
      if (compatibility && compatibility.isCrossMcu) {
        if (compatibility.isCompatible) {
          this.showStatus(`Cross-MCU: all ${compatibility.totalCount} assignments compatible with ${this.currentMcu!.refName}`, 'success');
        } else {
          const missing = compatibility.missingPins.size;
          const badSignals = compatibility.missingSignals.size;
          const parts: string[] = [];
          if (missing > 0) parts.push(`${missing} missing pin${missing > 1 ? 's' : ''}`);
          if (badSignals > 0) parts.push(`${badSignals} unavailable signal${badSignals > 1 ? 's' : ''}`);
          this.showStatus(`Cross-MCU: ${compatibility.validCount}/${compatibility.totalCount} assignments compatible (${parts.join(', ')})`, 'error');
        }
      }
      if (this.settings.urlEncoding === 'full') this.updateUrlHash();
    };

    this.solverSolutions.onSolutionSelected(handleSolutionSelected);
    this.projectSolutions.onSolutionSelected(handleSolutionSelected);

    // Focus coordination: when one list gains focus, deselect the other
    this.solverSolutions.onFocusGained(() => this.projectSolutions.deselect());
    this.projectSolutions.onFocusGained(() => this.solverSolutions.deselect());

    // Constraint editor changes -> enable/disable solve button + persist state + pin preview
    this.constraintEditor.onChange((_text, result) => {
      if (this.loadingProject) return;
      this.saveStateDebounced();
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

    // Enter in solver list -> add to project solutions
    this.solverSolutions.onSaveRequested((solution) => {
      const solName = prompt('Solution name:', solution.name || `Solution ${solution.id}`);
      if (solName === null) return;
      const clone: Solution = {
        ...solution,
        name: solName.trim() || undefined,
        configAssignments: [...solution.configAssignments],
        portPeripherals: new Map(solution.portPeripherals),
        costs: new Map(solution.costs),
      };
      this.projectSolutions.addSolution(clone);
    });

  }

  private runSolver(): void {
    // If already solving, abort
    if (this.solverWorkers.length > 0) {
      this.abortSolver();
      return;
    }

    this.currentSolution = null;

    if (!this.currentMcu) {
      this.showStatus('No MCU loaded', 'error');
      return;
    }

    const parseResult = this.constraintEditor.getParseResult();
    if (!parseResult?.ast) {
      this.showStatus('Fix constraint errors before solving', 'error');
      return;
    }

    const solverTypes = this.settings.solverTypes;
    if (solverTypes.length === 0) {
      this.showStatus('No solvers selected', 'error');
      return;
    }

    const label = solverTypes.length > 1
      ? `Solving with ${solverTypes.length} solvers...`
      : 'Solving...';
    this.showStatus(label, 'info');
    this.setSolveButtonState(true);

    const twoPhaseTypes = new Set(['two-phase', 'diverse-instances', 'priority-group', 'mrv-group', 'ratio-mrv-group']);
    const results: LabeledSolverResult[] = [];
    let completedCount = 0;

    if (this.settings.solverDebugOverlay) {
      this.debugOverlay.startRun(solverTypes);
    }

    // A2: Group shared-Phase-1 solvers into one worker
    const sharedPhase1Set = new Set(['two-phase', 'diverse-instances', 'priority-two-phase', 'priority-group']);
    const sharedSolvers = solverTypes.filter(s => sharedPhase1Set.has(s));
    const individualSolvers = solverTypes.filter(s => !sharedPhase1Set.has(s));

    // Workers: one for shared Phase 1 group (if ≥2), plus one per individual solver
    const workerJobs: Array<{ types: string[]; useShared: boolean }> = [];
    if (sharedSolvers.length >= 2) {
      workerJobs.push({ types: sharedSolvers, useShared: true });
      for (const st of individualSolvers) {
        workerJobs.push({ types: [st], useShared: false });
      }
    } else {
      // Not enough to share - run all individually
      for (const st of solverTypes) {
        workerJobs.push({ types: [st], useShared: false });
      }
    }

    const totalCount = workerJobs.length;

    const baseConfig = {
      maxSolutions: this.settings.maxSolutions,
      timeoutMs: this.settings.solverTimeoutMs,
      costWeights: new Map(Object.entries(this.settings.costWeights)),
      skipGpioMapping: this.settings.skipGpioMapping,
    };

    for (const job of workerJobs) {
      const worker = new Worker(
        new URL('./solver/solver-worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.solverWorkers.push(worker);

      const jobLabel = job.types.join('+');

      worker.onmessage = (e) => {
        const solverResult = e.data as SolverResult;
        results.push({ solverId: jobLabel, result: solverResult });
        for (const st of job.types) {
          this.debugOverlay.solverComplete(st, solverResult);
        }
        completedCount++;
        if (totalCount > 1) {
          this.showStatus(`Solving... (${completedCount}/${totalCount} complete)`, 'info');
        }
        if (completedCount === totalCount) {
          this.onAllSolversComplete(results);
        }
      };

      worker.onerror = (err) => {
        console.error(`Solver worker error (${jobLabel}):`, err);
        const errorResult: SolverResult = {
          mcuRef: this.currentMcu?.refName ?? '',
          solutions: [],
          errors: [{ type: 'error', message: `${jobLabel} crashed: ${err.message}` }],
          statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
        };
        results.push({ solverId: jobLabel, result: errorResult });
        for (const st of job.types) {
          this.debugOverlay.solverComplete(st, errorResult);
        }
        completedCount++;
        if (completedCount === totalCount) {
          this.onAllSolversComplete(results);
        }
      };

      if (job.useShared) {
        // A2: Send multiple solver types to one worker for shared Phase 1
        worker.postMessage({
          ast: parseResult.ast,
          mcu: this.currentMcu,
          config: baseConfig,
          solverTypes: job.types,
          twoPhaseConfig: {
            maxGroups: this.settings.maxGroups,
            maxSolutionsPerGroup: this.settings.maxSolutionsPerGroup,
          },
          randomizedConfig: { numRestarts: this.settings.numRestarts },
        });
      } else {
        const solverType = job.types[0];
        const effectiveMaxSolutions = twoPhaseTypes.has(solverType)
          ? this.settings.maxSolutions
          : this.settings.maxGroups * this.settings.maxSolutionsPerGroup;

        worker.postMessage({
          ast: parseResult.ast,
          mcu: this.currentMcu,
          config: { ...baseConfig, maxSolutions: effectiveMaxSolutions },
          solverType,
          twoPhaseConfig: {
            maxGroups: this.settings.maxGroups,
            maxSolutionsPerGroup: this.settings.maxSolutionsPerGroup,
          },
          randomizedConfig: { numRestarts: this.settings.numRestarts },
        });
      }
    }
  }

  private terminateWorkers(): void {
    for (const w of this.solverWorkers) {
      try { w.terminate(); } catch { /* Vite module worker proxy may throw */ }
    }
    this.solverWorkers = [];
  }

  private onAllSolversComplete(results: LabeledSolverResult[]): void {
    this.terminateWorkers();
    this.setSolveButtonState(false);

    const result = mergeResults(results, this.settings.maxSolutions);
    this.debugOverlay.finalize(result.solutions);

    this.layout.broadcastStateChange({ type: 'solver-complete', solverResult: result });
    this.hasSolverResult = result.solutions.length > 0;

    // Update stats in constraint editor toolbar
    const statsEl = document.getElementById('ce-stats');
    if (statsEl) {
      const s = result.statistics;
      const solverCount = results.length;
      statsEl.textContent = solverCount > 1
        ? `${s.validSolutions} solutions in ${s.solveTimeMs.toFixed(0)}ms (${solverCount} solvers, ${s.evaluatedCombinations} combos)`
        : `${s.validSolutions} solutions in ${s.solveTimeMs.toFixed(0)}ms (${s.evaluatedCombinations}/${s.totalCombinations} combos)`;
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
  }

  private abortSolver(): void {
    if (this.solverWorkers.length > 0) {
      this.terminateWorkers();
      this.setSolveButtonState(false);
      this.debugOverlay.stopRun();
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
        <button class="btn btn-small" id="btn-import-xml">Import</button>
        <button class="btn btn-small" id="btn-data-manager">Data</button>
        <button class="btn btn-small" id="btn-settings">Settings</button>
        <button class="btn btn-small" id="btn-theme-toggle" title="Toggle dark mode">Light</button>
      </div>
    `;

    // File import button
    const importBtn = header.querySelector('#btn-import-xml')!;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.xml,.ioc';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    header.appendChild(fileInput);

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files) {
        for (const file of fileInput.files) {
          if (file.name.endsWith('.ioc')) {
            this.loadIocFile(file);
          } else {
            this.loadXmlFile(file);
          }
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
        <span class="footer-hint">Drop STM32CubeMX XML or .ioc files anywhere to load MCU data or import pin assignments</span>
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
            this.loadXmlFile(file);
          } else if (file.name.endsWith('.ioc')) {
            this.loadIocFile(file);
          }
        }
      }
    });
  }

  private async loadXmlFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      if (isIocFile(text)) {
        this.loadIocData(text, file.name);
      } else if (isDmaXml(text)) {
        this.loadDmaXml(text, file.name);
      } else {
        this.loadMcuXml(text, file.name);
      }
    } catch (err) {
      console.error('Failed to load file:', err);
      this.showStatus(`Failed to load ${file.name}: ${err}`, 'error');
    }
  }

  private loadMcuXml(xmlString: string, fileName: string): void {
    const mcu = parseMcuXml(xmlString);
    const validation = validateMcu(mcu);

    if (!validation.valid) {
      console.error('MCU validation errors:', validation.errors);
      this.showStatus(`Error loading ${fileName}: ${validation.errors.join(', ')}`, 'error');
      return;
    }

    if (validation.warnings.length > 0) {
      console.warn('MCU validation warnings:', validation.warnings);
    }

    // Try to attach DMA data from stored DMA XMLs
    this.attachDmaData(mcu);

    this.currentMcu = mcu;

    // Build tag list based on available data
    const tags = ['PIN'];
    if (mcu.dma) tags.push('DMA');

    // Store raw XML and metadata for later re-loading
    try {
      localStorage.setItem(`mcu-xml:${mcu.refName}`, xmlString);
      localStorage.setItem(`mcu-meta:${mcu.refName}`, JSON.stringify({ tags }));
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

    const dmaInfo = mcu.dma ? `, ${mcu.dma.streams.length} DMA streams` : '';
    this.showStatus(`Loaded ${mcu.refName} (${mcu.pins.length} pins, ${mcu.peripherals.length} peripherals${dmaInfo})`, 'success');

    console.log('Loaded MCU:', mcu.refName);
    console.log('  Pins:', mcu.pins.length);
    console.log('  Assignable pins:', mcu.pins.filter(p => p.isAssignable).length);
    console.log('  Peripherals:', mcu.peripherals.length);
    console.log('  Signal mappings:', mcu.signalToPins.size);
    if (mcu.dma) {
      console.log('  DMA streams:', mcu.dma.streams.length);
      console.log('  DMA signal mappings:', mcu.dma.signalToDmaStreams.size);
    }
  }

  private loadTutorialExample(): void {
    // Try loading MCU from localStorage first, then fetch
    const storedXml = localStorage.getItem('mcu-xml:STM32H755IIKx');
    if (storedXml) {
      this.loadMcuXml(storedXml, 'STM32H755IIKx.xml');
      this.fetchTutorialConstraints();
    } else {
      fetch('examples/STM32H755IIKx.xml')
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
        .then(xml => {
          this.loadMcuXml(xml, 'STM32H755IIKx.xml');
          this.fetchTutorialConstraints();
        })
        .catch(() => { /* Example not available, tutorial continues without data */ });
    }
  }

  private fetchTutorialConstraints(): void {
    fetch('examples/ecat_complex.txt')
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
      .then(text => {
        this.constraintEditor.setText(text);
      })
      .catch(() => { /* Example not available */ });
  }

  private loadDmaXml(xmlString: string, fileName: string): void {
    const version = getDmaXmlVersion(xmlString);
    if (!version) {
      this.showStatus(`No version found in DMA XML ${fileName}`, 'error');
      return;
    }

    // Parse to validate
    const dmaData = parseDmaXml(xmlString);

    // Store the raw DMA XML keyed by version
    try {
      localStorage.setItem(`dma-xml:${version}`, xmlString);
    } catch {
      console.warn('Failed to store DMA XML (storage full?)');
    }

    this.showStatus(`Loaded DMA data: ${version} (${dmaData.streams.length} streams)`, 'success');
    console.log('Loaded DMA:', version);
    console.log('  Streams:', dmaData.streams.length);
    console.log('  Signal mappings:', dmaData.signalToDmaStreams.size);

    // If we have a current MCU, try to attach DMA data to it
    if (this.currentMcu && !this.currentMcu.dma) {
      const mcu = this.currentMcu;
      this.attachDmaData(mcu);
      if (mcu.dma) {
        // Update the stored MCU metadata tags
        try {
          const metaStr = localStorage.getItem(`mcu-meta:${mcu.refName}`);
          const meta = metaStr ? JSON.parse(metaStr) : { tags: ['PIN'] };
          if (!meta.tags.includes('DMA')) {
            meta.tags.push('DMA');
            localStorage.setItem(`mcu-meta:${mcu.refName}`, JSON.stringify(meta));
          }
        } catch { /* ignore */ }

        this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu });
        this.showStatus(`Attached DMA data to ${mcu.refName} (${mcu.dma.streams.length} streams)`, 'success');
      }
    }
  }

  /**
   * Find the DMA IP version in the MCU's peripherals and try to load
   * matching DMA XML from localStorage.
   */
  private attachDmaData(mcu: Mcu): void {
    // Find the DMA peripheral's version tag
    const dmaPeripheral = mcu.peripherals.find(p => p.type === 'DMA' || p.originalType === 'DMA');
    if (!dmaPeripheral?.version) return;

    const dmaVersion = dmaPeripheral.version;
    const dmaXml = localStorage.getItem(`dma-xml:${dmaVersion}`);
    if (!dmaXml) return;

    try {
      mcu.dma = parseDmaXml(dmaXml);
    } catch (err) {
      console.warn(`Failed to parse stored DMA XML for version ${dmaVersion}:`, err);
    }
  }

  // ---- CubeMX .ioc import ----

  private async loadIocFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      this.loadIocData(text, file.name);
    } catch (err) {
      console.error('Failed to load .ioc file:', err);
      this.showStatus(`Failed to load ${file.name}: ${err}`, 'error');
    }
  }

  private loadIocData(text: string, fileName: string): void {
    const ioc = parseIocFile(text);

    if (!ioc.mcuName) {
      this.showStatus(`No MCU name found in ${fileName}`, 'error');
      return;
    }

    // Try to load matching MCU from localStorage
    if (!this.currentMcu || this.currentMcu.refName !== ioc.mcuName) {
      const storedXml = localStorage.getItem(`mcu-xml:${ioc.mcuName}`);
      if (storedXml) {
        this.loadMcuXml(storedXml, `${ioc.mcuName} (from storage)`);
      } else {
        this.showStatus(`MCU ${ioc.mcuName} not found in storage. Import the MCU XML first, then re-import the .ioc file.`, 'error');
        return;
      }
    }

    if (ioc.assignments.length === 0) {
      this.showStatus(`No pin assignments found in ${fileName}`, 'error');
      return;
    }

    // Generate pin declaration lines
    const pinLines = ioc.assignments.map(a => `pin ${a.pinName} = ${a.signalName}`);

    // Append to existing constraint text
    const existing = this.constraintEditor.getText().trimEnd();
    const separator = existing ? '\n\n# Imported from ' + fileName + '\n' : '# Imported from ' + fileName + '\n';
    this.constraintEditor.setText(existing + separator + pinLines.join('\n') + '\n');

    this.showStatus(`Added ${ioc.assignments.length} pin assignments from ${fileName} (${ioc.mcuName})`, 'success');
  }

  // ---- Project management ----

  private newProject(): void {
    this.currentProjectName = null;
    this.currentSolution = null;
    localStorage.removeItem('current-project');
    this.constraintEditor.setText('');
    this.hasSolverResult = false;

    this.projectSolutions.clear();
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

  private listProjectNames(): string[] {
    const projects: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('project:')) {
        projects.push(key.substring('project:'.length));
      }
    }
    return projects.sort();
  }

  private listProjects(): { name: string; size: number; tags: string[]; versionCount: number }[] {
    return this.listProjectNames().map(name => {
      const raw = localStorage.getItem(`project:${name}`);
      const size = raw ? raw.length : 0;
      const tags: string[] = [];
      let versionCount = 0;
      try {
        if (raw) {
          const projectData = migrateProjectData(JSON.parse(raw));
          versionCount = projectData.versions.length;
          const latest = projectData.versions[projectData.versions.length - 1];
          if (latest) {
            if (latest.constraintText && latest.constraintText.trim()) tags.push('CON');
            if (latest.solutions && latest.solutions.length > 0) tags.push('SOL');
          }
        }
      } catch { /* ignore */ }
      return { name, size, tags, versionCount };
    });
  }

  /** Save project by overwriting the latest version (header Save + project list Save) */
  private saveProject(name: string): void {
    const version = this.buildCurrentVersion(0);

    // Load existing project data
    let projectData: ProjectData = { name, versions: [] };
    try {
      const existing = localStorage.getItem(`project:${name}`);
      if (existing) {
        projectData = migrateProjectData(JSON.parse(existing));
        projectData.name = name;
      }
    } catch { /* start fresh */ }

    // Overwrite latest version, or create first version
    if (projectData.versions.length > 0) {
      const latest = projectData.versions[projectData.versions.length - 1];
      version.id = latest.id;
      projectData.versions[projectData.versions.length - 1] = version;
    } else {
      projectData.versions.push(version);
    }

    this.persistProject(name, projectData, version);
  }

  /** Save As: prompt for name, append a new version */
  private saveProjectAs(): void {
    const name = prompt('Project name:', this.currentProjectName || '');
    if (!name?.trim()) return;
    const trimmed = name.trim();

    // Load existing project data (may or may not exist)
    let projectData: ProjectData = { name: trimmed, versions: [] };
    try {
      const existing = localStorage.getItem(`project:${trimmed}`);
      if (existing) {
        projectData = migrateProjectData(JSON.parse(existing));
        projectData.name = trimmed;
      }
    } catch { /* start fresh */ }

    const version = this.buildCurrentVersion(projectData.versions.length);
    projectData.versions.push(version);

    this.persistProject(trimmed, projectData, version);
  }

  private buildCurrentVersion(id: number): ProjectVersion {
    const text = this.constraintEditor.getText();
    const mcuRef = this.currentMcu?.refName ?? '';
    const solutions = this.projectSolutions.getSolutions().map(serializeSolution);
    solutions.forEach((s, i) => s.id = i + 1);
    return { id, timestamp: Date.now(), constraintText: text, mcuRef, solutions };
  }

  private persistProject(name: string, projectData: ProjectData, version: ProjectVersion): void {
    const json = JSON.stringify(projectData);

    try {
      localStorage.setItem(`project:${name}`, json);
    } catch {
      // Quota exceeded - try trimming old versions (keep latest 2)
      if (projectData.versions.length > 2) {
        projectData.versions = projectData.versions.slice(-2);
        projectData.versions.forEach((v, i) => v.id = i);
        try {
          localStorage.setItem(`project:${name}`, JSON.stringify(projectData));
          this.showStatus(`Project "${name}" saved (trimmed old versions to fit)`, 'success');
          this.currentProjectName = name;
          localStorage.setItem('current-project', name);
          this.refreshProjectList();
          return;
        } catch { /* still too large */ }
      }

      // Still too large - save without solutions
      const liteVersion: ProjectVersion = { ...version, solutions: [] };
      const liteData: ProjectData = { name, versions: [liteVersion] };
      try {
        localStorage.setItem(`project:${name}`, JSON.stringify(liteData));
        this.showStatus(`Storage full - saved without solutions (${(json.length / 1024).toFixed(0)}KB needed)`, 'error');
        this.currentProjectName = name;
        localStorage.setItem('current-project', name);
        this.refreshProjectList();
        return;
      } catch {
        this.showStatus(`Storage full - cannot save (${(json.length / 1024).toFixed(0)}KB needed). Free space in Data Manager.`, 'error');
        return;
      }
    }

    this.currentProjectName = name;
    localStorage.setItem('current-project', name);
    this.refreshProjectList();

    const solCount = version.solutions.length;
    this.showStatus(`Project "${name}" saved (v${version.id}, ${solCount} solutions)`, 'success');
  }

  loadProject(name: string): void {
    const raw = localStorage.getItem(`project:${name}`);
    if (!raw) {
      this.showStatus(`Project "${name}" not found`, 'error');
      return;
    }
    try {
      const projectData = migrateProjectData(JSON.parse(raw));
      const latestVersion = projectData.versions[projectData.versions.length - 1];
      if (!latestVersion) {
        this.showStatus(`Project "${name}" has no versions`, 'error');
        return;
      }
      this.applyProjectVersion(name, latestVersion);
    } catch {
      this.showStatus(`Failed to load project "${name}"`, 'error');
    }
  }

  private loadProjectVersion(name: string, versionId: number): void {
    const raw = localStorage.getItem(`project:${name}`);
    if (!raw) return;
    try {
      const projectData = migrateProjectData(JSON.parse(raw));
      const version = projectData.versions.find(v => v.id === versionId);
      if (!version) {
        this.showStatus(`Version ${versionId} not found`, 'error');
        return;
      }
      this.applyProjectVersion(name, version);
    } catch {
      this.showStatus(`Failed to load version`, 'error');
    }
  }

  private applyProjectVersion(name: string, version: ProjectVersion): void {
    this.loadingProject = true;
    this.constraintEditor.setText(version.constraintText || '');
    this.currentProjectName = name;
    localStorage.setItem('current-project', name);

    // Clear solver results
    this.layout.broadcastStateChange({
      type: 'solver-complete',
      solverResult: { mcuRef: '', solutions: [], errors: [], statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 } },
    });

    // Load MCU if version references one
    if (version.mcuRef && (!this.currentMcu || this.currentMcu.refName !== version.mcuRef)) {
      this.loadStoredMcu(version.mcuRef);
    }

    // Restore solutions into the project list (not the solver list)
    if (version.solutions && version.solutions.length > 0) {
      const solutions = version.solutions.map(deserializeSolution);
      this.projectSolutions.setSolutions(solutions);
      this.hasSolverResult = false;
    } else {
      this.projectSolutions.clear();
      this.hasSolverResult = false;
    }

    this.refreshProjectList();
    // Delay clearing the flag to outlast the 300ms debounced parse triggered by setText()
    setTimeout(() => {
      this.loadingProject = false;
      // Re-evaluate solve button now that parse has completed and loading is done
      const solveBtn = this.constraintEditor.getSolveButton() as HTMLButtonElement | null;
      if (solveBtn) {
        const parseResult = this.constraintEditor.getParseResult();
        const hasErrors = !parseResult || parseResult.errors.length > 0;
        solveBtn.disabled = hasErrors || !this.currentMcu;
      }
    }, 400);
    const solCount = version.solutions?.length ?? 0;
    this.showStatus(`Project "${name}" loaded (v${version.id}${solCount > 0 ? `, ${solCount} solutions` : ''})`, 'success');
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
    const projects = this.listProjectNames();
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
    // Always parse current text - the cached parseResult may be stale
    // (e.g. during project load before the debounced parse fires)
    const ast = parseConstraints(this.constraintEditor.getText()).ast;
    if (ast) {
      for (const stmt of ast.statements) {
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
      if (hash.startsWith('v1:')) {
        // New structured format
        try {
          const json = decodeURIComponent(atob(hash.slice(3)));
          const state: UrlState = JSON.parse(json);
          this.constraintEditor.setText(state.c || '');
          if (state.m) this.loadStoredMcu(state.m);
          if (state.sol) {
            const solution = deserializeSolution(state.sol);
            const solverResult: SolverResult = {
              mcuRef: state.m || '',
              solutions: [solution],
              errors: [],
              statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 1, solveTimeMs: 0, configCombinations: 0 },
            };
            this.hasSolverResult = true;
            this.layout.broadcastStateChange({ type: 'solver-complete', solverResult });
          }
          return;
        } catch { /* invalid structured hash, fall through */ }
      }
      // Legacy format: plain base64 constraint text
      try {
        const text = decodeURIComponent(atob(hash));
        this.constraintEditor.setText(text);
        return;
      } catch { /* invalid hash, ignore */ }
    }

    // If we have a current project, load it (with versioned format)
    if (this.currentProjectName) {
      const raw = localStorage.getItem(`project:${this.currentProjectName}`);
      if (raw) {
        try {
          const projectData = migrateProjectData(JSON.parse(raw));
          const latest = projectData.versions[projectData.versions.length - 1];
          if (latest) {
            this.applyProjectVersion(this.currentProjectName, latest);
            return;
          }
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
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        localStorage.setItem('constraint-text', this.constraintEditor.getText());
        this.updateUrlHash();
      }, 1000);
    };
  })();

  private updateUrlHash(): void {
    const mode = this.settings.urlEncoding;
    if (mode === 'none') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }

    try {
      const text = this.constraintEditor.getText();
      if (mode === 'constraints') {
        // Legacy format for simplicity and smaller URLs
        const encoded = btoa(encodeURIComponent(text));
        history.replaceState(null, '', '#' + encoded);
      } else {
        // Structured format
        const state: UrlState = { v: 1, c: text };
        if (this.currentMcu) state.m = this.currentMcu.refName;
        if (mode === 'full' && this.currentSolution) {
          state.sol = serializeSolution(this.currentSolution);
        }
        const json = JSON.stringify(state);
        const encoded = btoa(encodeURIComponent(json));
        history.replaceState(null, '', '#v1:' + encoded);
      }
    } catch { /* ignore encoding errors */ }
  }

  private loadSettings(): AppSettings {
    try {
      const raw = localStorage.getItem('app-settings');
      if (raw) {
        const saved = JSON.parse(raw);
        // Migrate old single solverType to array
        if (saved.solverType && !saved.solverTypes) {
          saved.solverTypes = [saved.solverType];
          delete saved.solverType;
        }
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
          <div class="settings-row settings-row-vertical">
            <label>Algorithms
              <span class="solver-preset-btns">
                <button class="btn btn-tiny" id="solver-select-all">All</button>
                <button class="btn btn-tiny" id="solver-select-none">None</button>
              </span>
            </label>
            <div class="solver-checkbox-list" id="set-solver-types">
              ${solvers.map(s => `
                <label class="solver-checkbox" title="${s.description}">
                  <input type="checkbox" value="${s.id}" ${this.settings.solverTypes.includes(s.id) ? 'checked' : ''}>
                  ${s.name}
                </label>
              `).join('')}
            </div>
          </div>
          <div class="settings-row">
            <label>Max solutions</label>
            <input type="number" class="settings-input" id="set-max-solutions" min="1" max="10000" value="${this.settings.maxSolutions}">
          </div>
          <div class="settings-row">
            <label>Max groups</label>
            <input type="number" class="settings-input" id="set-max-groups" min="1" max="1000" value="${this.settings.maxGroups}">
          </div>
          <div class="settings-row">
            <label>Max solutions/group</label>
            <input type="number" class="settings-input" id="set-max-per-group" min="1" max="1000" value="${this.settings.maxSolutionsPerGroup}">
          </div>
          <div class="settings-row">
            <label>Restarts</label>
            <input type="number" class="settings-input" id="set-num-restarts" min="1" max="50" value="${this.settings.numRestarts}">
          </div>
          <div class="settings-row">
            <label>Timeout (ms)</label>
            <input type="number" class="settings-input" id="set-timeout" min="100" max="60000" step="100" value="${this.settings.solverTimeoutMs}">
          </div>
          <div class="settings-row">
            <label title="Skip pin assignment for IN/OUT (GPIO) channels; only verify enough free pins are available">Skip GPIO mapping</label>
            <input type="checkbox" id="set-skip-gpio" ${this.settings.skipGpioMapping ? 'checked' : ''}>
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

        <section class="settings-section">
          <h3>URL Sharing</h3>
          <div class="settings-row">
            <label>Encode in URL</label>
            <select class="settings-input" id="set-url-encoding">
              <option value="none"${this.settings.urlEncoding === 'none' ? ' selected' : ''}>Nothing</option>
              <option value="constraints"${this.settings.urlEncoding === 'constraints' ? ' selected' : ''}>Constraints</option>
              <option value="constraints-mcu"${this.settings.urlEncoding === 'constraints-mcu' ? ' selected' : ''}>Constraints + MCU</option>
              <option value="full"${this.settings.urlEncoding === 'full' ? ' selected' : ''}>Constraints + MCU + Solution</option>
            </select>
          </div>
        </section>

        <section class="settings-section">
          <h3>Debug</h3>
          <div class="settings-row">
            <label>Data inspector</label>
            <input type="checkbox" id="set-data-inspector" ${this.settings.dataInspector ? 'checked' : ''}>
          </div>
          <div class="settings-row">
            <label>Solver debug overlay</label>
            <input type="checkbox" id="set-solver-debug" ${this.settings.solverDebugOverlay ? 'checked' : ''}>
          </div>
        </section>

        <div class="settings-actions">
          <button class="btn btn-small" id="set-reset-defaults">Reset Defaults</button>
          <button class="btn btn-small" id="set-show-tutorial">Tutorial</button>
          <button class="btn btn-primary btn-small" id="set-apply">Apply</button>
        </div>
      </div>
    `;

    modal.querySelector('.settings-close')!.addEventListener('click', () => overlay.remove());

    modal.querySelector('#solver-select-all')!.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('#set-solver-types input[type=checkbox]').forEach(cb => cb.checked = true);
    });
    modal.querySelector('#solver-select-none')!.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('#set-solver-types input[type=checkbox]').forEach(cb => cb.checked = false);
    });

    modal.querySelector('#set-show-tutorial')!.addEventListener('click', () => {
      overlay.remove();
      startTutorial(() => this.loadTutorialExample());
    });

    modal.querySelector('#set-apply')!.addEventListener('click', () => {
      const checkedSolvers = [...modal.querySelectorAll<HTMLInputElement>('#set-solver-types input[type=checkbox]:checked')]
        .map(cb => cb.value);
      this.settings.solverTypes = checkedSolvers.length > 0 ? checkedSolvers : [...DEFAULT_SETTINGS.solverTypes];
      this.settings.maxSolutions = parseInt((modal.querySelector('#set-max-solutions') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxSolutions;
      this.settings.maxGroups = parseInt((modal.querySelector('#set-max-groups') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxGroups;
      this.settings.maxSolutionsPerGroup = parseInt((modal.querySelector('#set-max-per-group') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxSolutionsPerGroup;
      this.settings.numRestarts = parseInt((modal.querySelector('#set-num-restarts') as HTMLInputElement).value) || DEFAULT_SETTINGS.numRestarts;
      this.settings.solverTimeoutMs = parseInt((modal.querySelector('#set-timeout') as HTMLInputElement).value) || DEFAULT_SETTINGS.solverTimeoutMs;
      this.settings.minZoom = parseFloat((modal.querySelector('#set-min-zoom') as HTMLInputElement).value) || DEFAULT_SETTINGS.minZoom;
      this.settings.maxZoom = parseFloat((modal.querySelector('#set-max-zoom') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxZoom;
      this.settings.mouseZoomGain = parseFloat((modal.querySelector('#set-zoom-gain') as HTMLInputElement).value) || DEFAULT_SETTINGS.mouseZoomGain;

      modal.querySelectorAll<HTMLInputElement>('[data-cost-id]').forEach(input => {
        const id = input.dataset.costId!;
        this.settings.costWeights[id] = parseFloat(input.value) || 0;
      });

      this.settings.skipGpioMapping = (modal.querySelector('#set-skip-gpio') as HTMLInputElement).checked;
      this.settings.dataInspector = (modal.querySelector('#set-data-inspector') as HTMLInputElement).checked;
      this.settings.solverDebugOverlay = (modal.querySelector('#set-solver-debug') as HTMLInputElement).checked;
      this.settings.urlEncoding = (modal.querySelector('#set-url-encoding') as HTMLSelectElement).value as AppSettings['urlEncoding'];

      this.saveSettings();
      this.updateUrlHash();
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

      // Attach DMA data if available
      this.attachDmaData(mcu);

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

      const dmaInfo = mcu.dma ? ` (+DMA)` : '';
      this.showStatus(`Loaded ${mcu.refName} from storage${dmaInfo}`, 'success');
    } catch (err) {
      this.showStatus(`Failed to parse stored MCU "${refName}": ${err}`, 'error');
    }
  }

  private listStoredMcus(): { refName: string; size: number; tags: string[] }[] {
    const mcus: { refName: string; size: number; tags: string[] }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('mcu-xml:')) {
        const refName = key.substring('mcu-xml:'.length);
        const size = (localStorage.getItem(key) || '').length;
        let tags: string[] = [];
        try {
          const meta = localStorage.getItem(`mcu-meta:${refName}`);
          if (meta) tags = JSON.parse(meta).tags ?? [];
        } catch { /* ignore */ }
        mcus.push({ refName, size, tags });
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
    modal.className = 'settings-modal dm-modal';

    const renderContent = (): void => {
      const storedMcus = this.listStoredMcus();
      const projects = this.listProjects();

      // Calculate total localStorage usage
      let totalChars = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) totalChars += key.length + (localStorage.getItem(key) || '').length;
      }
      const usedKB = (totalChars / 1024).toFixed(0);
      const limitKB = 5120; // ~10MB UTF-16 = ~5M chars

      const hasMcu = this.currentMcu !== null;
      const hasDma = this.currentMcu?.dma !== undefined;
      const parseResult = this.constraintEditor.getParseResult();
      const hasAst = parseResult?.ast !== null && parseResult?.ast !== undefined;

      modal.innerHTML = `
        <div class="settings-header">
          <strong>Data Manager</strong>
          <span class="dm-storage-info">${usedKB}KB / ${limitKB}KB</span>
          <button class="btn btn-small settings-close">Close</button>
        </div>
        <div class="settings-body">
          <section class="settings-section">
            <h3>Current Session</h3>
            <div class="dm-list">
              <div class="dm-row">
                <span class="dm-name">MCU: ${hasMcu ? this.currentMcu!.refName : '(none)'}</span>
                <button class="btn btn-small" data-action="export-current-mcu" ${hasMcu ? '' : 'disabled'}>Export MCU</button>
                <button class="btn btn-small" data-action="export-current-dma" ${hasDma ? '' : 'disabled'}>Export DMA</button>
                <button class="btn btn-small" data-action="export-current-ast" ${hasAst ? '' : 'disabled'}>Export AST</button>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3>Stored MCUs</h3>
            ${storedMcus.length === 0 ? '<p class="settings-hint">No MCUs stored. Import XML files to store them.</p>' : ''}
            <div class="dm-list">
              ${storedMcus.map(m => `
                <div class="dm-row" data-mcu="${m.refName}">
                  <span class="dm-name">${m.refName}</span>
                  <span class="dm-tags">${m.tags.map(t => `<span class="dm-tag">${t}</span>`).join('')}</span>
                  <span class="dm-size">${(m.size / 1024).toFixed(0)}KB</span>
                  <button class="btn btn-small dm-load" data-action="load-mcu" data-name="${m.refName}">Load</button>
                  <button class="btn btn-small" data-action="export-mcu" data-name="${m.refName}">Export</button>
                  <button class="btn btn-small dm-delete" data-action="delete-mcu" data-name="${m.refName}">Delete</button>
                </div>
              `).join('')}
            </div>
          </section>

          <section class="settings-section">
            <h3>Projects</h3>
            ${projects.length === 0 ? '<p class="settings-hint">No projects saved. Use "Save As" to create one.</p>' : ''}
            <div class="dm-list">
              ${projects.map((p, idx) => `
                <div class="dm-row" data-project="${p.name}">
                  <span class="dm-expand-btn" data-action="toggle-versions" data-name="${p.name}" data-idx="${idx}">${p.versionCount > 0 ? '&#9654;' : ''}</span>
                  <span class="dm-name">${p.name}${p.name === this.currentProjectName ? ' (active)' : ''}</span>
                  <span class="dm-tags">${p.tags.map(t => `<span class="dm-tag">${t}</span>`).join('')}${p.versionCount > 0 ? `<span class="dm-tag">v${p.versionCount}</span>` : ''}</span>
                  <span class="dm-size">${(p.size / 1024).toFixed(1)}KB</span>
                  <button class="btn btn-small dm-load" data-action="load-project" data-name="${p.name}">Load</button>
                  <button class="btn btn-small" data-action="export-project" data-name="${p.name}">Export</button>
                  <button class="btn btn-small dm-delete" data-action="delete-project" data-name="${p.name}">Delete</button>
                </div>
                <div class="dm-version-list" data-version-list="${idx}" style="display:none"></div>
              `).join('')}
            </div>
          </section>

          <section class="settings-section">
            <h3>Custom Export Functions</h3>
            <div class="dm-list">
              ${(() => {
                const exports = loadCustomExports();
                if (exports.length === 0) return '<p class="settings-hint">No custom export functions. Click "New" to create one.</p>';
                return exports.map(fn => `
                  <div class="dm-row">
                    <span class="dm-name">${fn.name}</span>
                    <span class="dm-size" style="min-width:auto">${fn.description}</span>
                    <button class="btn btn-small" data-action="edit-export" data-export-id="${fn.id}">Edit</button>
                    <button class="btn btn-small dm-delete" data-action="delete-export" data-export-id="${fn.id}">Delete</button>
                  </div>
                `).join('');
              })()}
            </div>
            <div style="margin-top:6px"><button class="btn btn-small" data-action="new-export">New</button></div>
          </section>

          <section class="settings-section">
            <h3>Macro Library</h3>
            <p class="settings-hint">Shared macros available in all constraints. Uses the same syntax as the constraint editor.</p>
            <div style="margin-top:6px">
              <button class="btn btn-small" data-action="edit-macro-lib">Edit</button>
              <button class="btn btn-small" data-action="reset-macro-lib">Reset to Default</button>
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
            case 'export-mcu':
              this.exportMcuData(name);
              break;
            case 'export-current-mcu':
              this.exportCurrentMcu();
              break;
            case 'export-current-dma':
              this.exportCurrentDma();
              break;
            case 'export-current-ast':
              this.exportCurrentAst();
              break;
            case 'delete-mcu':
              localStorage.removeItem(`mcu-xml:${name}`);
              localStorage.removeItem(`mcu-meta:${name}`);
              renderContent();
              break;
            case 'load-project':
              this.loadProject(name);
              overlay.remove();
              break;
            case 'export-project':
              this.exportProjectData(name);
              break;
            case 'delete-project':
              this.deleteProject(name);
              renderContent();
              break;
            case 'toggle-versions': {
              const idx = (btn as HTMLElement).dataset.idx;
              const versionList = modal.querySelector(`[data-version-list="${idx}"]`) as HTMLElement;
              if (!versionList) break;
              const arrow = btn as HTMLElement;
              if (versionList.style.display === 'none') {
                arrow.innerHTML = '&#9660;';
                this.renderVersionList(versionList, name, overlay, renderContent);
                versionList.style.display = '';
              } else {
                arrow.innerHTML = '&#9654;';
                versionList.style.display = 'none';
              }
              break;
            }
            case 'restore-version': {
              const versionId = parseInt((btn as HTMLElement).dataset.versionId || '0');
              this.loadProjectVersion(name, versionId);
              overlay.remove();
              break;
            }
            case 'new-export':
              this.showExportEditor(null, overlay, renderContent);
              break;
            case 'edit-export': {
              const exportId = (btn as HTMLElement).dataset.exportId!;
              const exports = loadCustomExports();
              const fn = exports.find(e => e.id === exportId);
              if (fn) this.showExportEditor(fn, overlay, renderContent);
              break;
            }
            case 'delete-export': {
              const exportId = (btn as HTMLElement).dataset.exportId!;
              deleteCustomExport(exportId);
              renderContent();
              break;
            }
            case 'edit-macro-lib':
              this.showMacroLibEditor(overlay);
              break;
            case 'reset-macro-lib':
              saveMacroLibrary(DEFAULT_MACRO_LIBRARY.trim());
              invalidateStdlibCache();
              break;
          }
        });
      });
    };

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    renderContent();
  }

  private showExportEditor(fn: CustomExportFunction | null, _parentOverlay: HTMLElement, onSave: () => void): void {
    const isNew = fn === null;
    const current: CustomExportFunction = fn ? { ...fn } : {
      id: `custom-${Date.now()}`,
      name: '',
      description: '',
      code: '',
    };

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '1100';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';
    modal.style.width = '600px';

    const render = (): void => {
      modal.innerHTML = `
        <div class="settings-header">
          <strong>${isNew ? 'New' : 'Edit'} Export Function</strong>
          <div style="display:flex;gap:6px">
            <button class="btn btn-small" id="export-editor-help">Help</button>
            <button class="btn btn-small settings-close">Close</button>
          </div>
        </div>
        <div class="settings-body">
          <div class="settings-row" style="margin-bottom:8px">
            <label>Name</label>
            <input class="settings-input" style="width:200px" id="export-editor-name" value="${current.name.replace(/"/g, '&quot;')}">
          </div>
          <div class="settings-row" style="margin-bottom:8px">
            <label>Description</label>
            <input class="settings-input" style="width:300px" id="export-editor-desc" value="${current.description.replace(/"/g, '&quot;')}">
          </div>
          <div style="margin-bottom:4px;font-size:11px;color:var(--text-secondary)">JavaScript code (return a string to copy to clipboard, or {filename, content, mimeType} to download):</div>
          <div class="code-editor-wrap">
            <pre class="code-editor-highlight" id="export-editor-highlight" aria-hidden="true"></pre>
            <textarea class="export-code-editor" id="export-editor-code" spellcheck="false">${current.code.replace(/</g, '&lt;')}</textarea>
          </div>
          <div class="export-error" id="export-editor-error" style="display:none"></div>
          <div class="export-help" id="export-editor-help-panel" style="display:none">
            <strong>Available variables:</strong>
            <pre>mcuName     - MCU reference name (e.g. "STM32H755XIHx")
mcuPackage  - Package type (e.g. "TFBGA240")
assignments - Array of {pinName, signalName, portName,
              channelName, configurationName}
peripherals - Array of {instanceName, type, version}
pins        - Array of {name, position, type, gpioPort,
              gpioNumber, isAssignable, signals:[{name,
              peripheralInstance, peripheralType,
              signalFunction}]}
ports       - Array of {name, color, channels:[],
              configurations:[]}</pre>
            <strong>Return value:</strong>
            <pre>return "text"  → copies to clipboard
return {filename:"f.csv", content:"...", mimeType:"text/csv"}
               → downloads as file</pre>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end">
            <button class="btn btn-small" id="export-editor-test">Test</button>
            <button class="btn btn-small btn-primary" id="export-editor-save">Save</button>
          </div>
        </div>
      `;

      modal.querySelector('.settings-close')!.addEventListener('click', () => overlay.remove());

      const codeEl = modal.querySelector('#export-editor-code') as HTMLTextAreaElement;
      const highlightEl = modal.querySelector('#export-editor-highlight') as HTMLPreElement;

      const syncHighlight = (): void => {
        highlightEl.innerHTML = highlightJs(codeEl.value) + '\n';
      };
      const syncScroll = (): void => {
        highlightEl.scrollTop = codeEl.scrollTop;
        highlightEl.scrollLeft = codeEl.scrollLeft;
      };
      codeEl.addEventListener('input', syncHighlight);
      codeEl.addEventListener('scroll', syncScroll);
      syncHighlight();

      codeEl.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = codeEl.selectionStart;
          const end = codeEl.selectionEnd;
          codeEl.value = codeEl.value.substring(0, start) + '  ' + codeEl.value.substring(end);
          codeEl.selectionStart = codeEl.selectionEnd = start + 2;
          syncHighlight();
        }
      });

      modal.querySelector('#export-editor-help')!.addEventListener('click', () => {
        const panel = modal.querySelector('#export-editor-help-panel') as HTMLElement;
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
      });

      modal.querySelector('#export-editor-test')!.addEventListener('click', () => {
        const errorEl = modal.querySelector('#export-editor-error') as HTMLElement;
        try {
          const code = (modal.querySelector('#export-editor-code') as HTMLTextAreaElement).value;
          new Function('mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', code);
          errorEl.style.display = '';
          errorEl.style.color = 'var(--success)';
          errorEl.textContent = 'Syntax OK';
          setTimeout(() => { errorEl.style.display = 'none'; }, 2000);
        } catch (err) {
          errorEl.style.display = '';
          errorEl.style.color = 'var(--error)';
          errorEl.textContent = (err as Error).message;
        }
      });

      modal.querySelector('#export-editor-save')!.addEventListener('click', () => {
        const nameVal = (modal.querySelector('#export-editor-name') as HTMLInputElement).value.trim();
        const descVal = (modal.querySelector('#export-editor-desc') as HTMLInputElement).value.trim();
        const codeVal = (modal.querySelector('#export-editor-code') as HTMLTextAreaElement).value;
        const errorEl = modal.querySelector('#export-editor-error') as HTMLElement;

        if (!nameVal) {
          errorEl.style.display = '';
          errorEl.style.color = 'var(--error)';
          errorEl.textContent = 'Name is required';
          return;
        }

        try {
          new Function('mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', codeVal);
        } catch (err) {
          errorEl.style.display = '';
          errorEl.style.color = 'var(--error)';
          errorEl.textContent = (err as Error).message;
          return;
        }

        current.name = nameVal;
        current.description = descVal;
        current.code = codeVal;
        saveCustomExport(current);
        overlay.remove();
        onSave();
      });
    };

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    render();
  }

  private showMacroLibEditor(_parentOverlay: HTMLElement): void {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '1100';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';
    modal.style.width = '600px';
    modal.style.maxHeight = '85vh';

    const currentSource = getStdlibSource();

    modal.innerHTML = `
      <div class="settings-header">
        <strong>Macro Library</strong>
        <div style="display:flex;gap:6px">
          <button class="btn btn-small" id="macro-lib-reset">Reset</button>
          <button class="btn btn-small settings-close">Close</button>
        </div>
      </div>
      <div class="settings-body" style="display:flex;flex-direction:column;gap:8px;min-height:0;flex:1;overflow:hidden">
        <div class="ce-editor-wrapper" style="flex:1;min-height:200px;border:1px solid var(--border);border-radius:3px">
          <div class="ce-line-numbers" id="macro-lib-lines">1</div>
          <div class="ce-code-area">
            <textarea class="ce-textarea" id="macro-lib-code" spellcheck="false">${currentSource.replace(/</g, '&lt;')}</textarea>
            <pre class="ce-highlight" id="macro-lib-highlight"></pre>
          </div>
        </div>
        <div class="export-error" id="macro-lib-error" style="display:none"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end;flex-shrink:0">
          <button class="btn btn-small btn-primary" id="macro-lib-save">Save</button>
        </div>
      </div>
    `;

    const codeEl = modal.querySelector('#macro-lib-code') as HTMLTextAreaElement;
    const highlightEl = modal.querySelector('#macro-lib-highlight') as HTMLPreElement;
    const lineNumEl = modal.querySelector('#macro-lib-lines') as HTMLElement;
    const errorEl = modal.querySelector('#macro-lib-error') as HTMLElement;

    const syncHighlight = (): void => {
      highlightEl.innerHTML = this.highlightConstraintCode(codeEl.value) + '\n';
    };
    const syncLineNumbers = (): void => {
      const lines = codeEl.value.split('\n');
      lineNumEl.innerHTML = lines.map((_, i) => `<div class="ce-line-num">${i + 1}</div>`).join('');
    };
    const syncScroll = (): void => {
      highlightEl.scrollTop = codeEl.scrollTop;
      highlightEl.scrollLeft = codeEl.scrollLeft;
      lineNumEl.scrollTop = codeEl.scrollTop;
    };

    codeEl.addEventListener('input', () => { syncHighlight(); syncLineNumbers(); });
    codeEl.addEventListener('scroll', syncScroll);
    syncHighlight();
    syncLineNumbers();

    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = codeEl.selectionStart;
        const end = codeEl.selectionEnd;
        codeEl.value = codeEl.value.substring(0, start) + '  ' + codeEl.value.substring(end);
        codeEl.selectionStart = codeEl.selectionEnd = start + 2;
        syncHighlight();
      }
    });

    modal.querySelector('.settings-close')!.addEventListener('click', () => overlay.remove());

    modal.querySelector('#macro-lib-reset')!.addEventListener('click', () => {
      codeEl.value = DEFAULT_MACRO_LIBRARY.trim();
      syncHighlight();
      syncLineNumbers();
    });

    modal.querySelector('#macro-lib-save')!.addEventListener('click', () => {
      const source = codeEl.value;
      // Validate syntax
      const result = parseConstraints(source);
      if (result.errors.length > 0) {
        errorEl.style.display = '';
        errorEl.style.color = 'var(--error)';
        errorEl.textContent = result.errors.map(e => `Line ${e.line}: ${e.message}`).join('; ');
        return;
      }
      saveMacroLibrary(source);
      invalidateStdlibCache();
      overlay.remove();
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  /** Constraint-style syntax highlighting (shared with macro lib editor) */
  private highlightConstraintCode(code: string): string {
    const KWORDS = ['mcu', 'reserve', 'shared', 'pin', 'port', 'channel', 'config', 'require', 'macro', 'color'];
    const BLTS = new Set(['same_instance', 'diff_instance', 'instance', 'type', 'gpio_pin', 'gpio_port', 'version', 'IN', 'OUT']);

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return code.split('\n').map(line => {
      const commentIdx = line.indexOf('#');
      let src = line, comment = '';
      if (commentIdx >= 0) {
        src = line.substring(0, commentIdx);
        comment = line.substring(commentIdx);
      }

      let result = '';
      let i = 0;
      while (i < src.length) {
        if (src[i] === '"') {
          const start = i; i++;
          while (i < src.length && src[i] !== '"') i++;
          if (i < src.length) i++;
          result += `<span class="ce-string">${esc(src.substring(start, i))}</span>`;
          continue;
        }
        if (/[a-zA-Z_]/.test(src[i])) {
          const start = i;
          while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
          const word = src.substring(start, i);
          if (KWORDS.includes(word)) {
            result += `<span class="ce-keyword">${esc(word)}</span>`;
          } else if (BLTS.has(word) || getStdlibMacroNames().has(word)) {
            result += `<span class="ce-builtin">${esc(word)}</span>`;
          } else {
            result += esc(word);
          }
          continue;
        }
        if (/[0-9]/.test(src[i])) {
          const start = i;
          while (i < src.length && /[0-9]/.test(src[i])) i++;
          result += `<span class="ce-number">${esc(src.substring(start, i))}</span>`;
          continue;
        }
        if ('=!&|^*@'.includes(src[i])) {
          result += `<span class="ce-operator">${esc(src[i])}</span>`;
          i++; continue;
        }
        result += esc(src[i]); i++;
      }
      if (comment) result += `<span class="ce-comment">${esc(comment)}</span>`;
      return result;
    }).join('\n');
  }

  private renderVersionList(container: HTMLElement, projectName: string, overlay: HTMLElement, renderContent: () => void): void {
    try {
      const raw = localStorage.getItem(`project:${projectName}`);
      if (!raw) return;
      const projectData = migrateProjectData(JSON.parse(raw));
      const versions = projectData.versions;

      container.innerHTML = versions.map(v => {
        const date = v.timestamp ? new Date(v.timestamp).toLocaleString() : 'initial';
        const versionJson = JSON.stringify(v);
        const sizeKB = (versionJson.length / 1024).toFixed(1);
        const tags: string[] = [];
        if (v.constraintText && v.constraintText.trim()) tags.push('CON');
        if (v.solutions && v.solutions.length > 0) tags.push(`${v.solutions.length} sol`);
        return `<div class="dm-version-row">
          <span class="dm-version-id">v${v.id}</span>
          <span class="dm-version-date">${date}</span>
          <span class="dm-tags">${tags.map(t => `<span class="dm-tag">${t}</span>`).join('')}</span>
          <span class="dm-size">${sizeKB}KB</span>
          <button class="btn btn-small" data-action="restore-version" data-version-id="${v.id}">Restore</button>
          ${this.settings.dataInspector ? `<button class="btn btn-small" data-action="inspect-version" data-version-id="${v.id}">Inspect</button>` : ''}
          <button class="btn btn-small dm-delete" data-action="delete-version" data-version-id="${v.id}">Delete</button>
        </div>
        ${this.settings.dataInspector ? `<div class="dm-inspect-panel" data-inspect-version="${v.id}" style="display:none"></div>` : ''}`;
      }).join('');

      container.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = (btn as HTMLElement).dataset.action;
          const vId = parseInt((btn as HTMLElement).dataset.versionId || '0');
          if (action === 'restore-version') {
            this.loadProjectVersion(projectName, vId);
            overlay.remove();
          } else if (action === 'delete-version') {
            this.deleteProjectVersion(projectName, vId);
            if (this.listProjectNames().includes(projectName)) {
              this.renderVersionList(container, projectName, overlay, renderContent);
            } else {
              renderContent();
            }
          } else if (action === 'inspect-version') {
            const panel = container.querySelector(`[data-inspect-version="${vId}"]`) as HTMLElement;
            if (!panel) return;
            if (panel.style.display === 'none') {
              const version = versions.find(v => v.id === vId);
              if (version) this.renderInspectPanel(panel, version);
              panel.style.display = '';
            } else {
              panel.style.display = 'none';
            }
          }
        });
      });
    } catch { /* ignore */ }
  }

  private renderInspectPanel(panel: HTMLElement, version: ProjectVersion): void {
    const sz = (val: unknown): number => JSON.stringify(val).length;
    const fmtKB = (chars: number): string => chars < 1024 ? `${chars}B` : `${(chars / 1024).toFixed(1)}KB`;
    const pct = (part: number, total: number): string => total > 0 ? `${(part / total * 100).toFixed(0)}%` : '0%';

    const totalSize = sz(version);
    const constraintSize = sz(version.constraintText);
    const configsSize = sz(version.mcuRef) + sz(version.id) + sz(version.timestamp);
    const allSolutionsSize = sz(version.solutions);

    const rows: string[] = [];
    rows.push(`<div class="dm-inspect-row dm-inspect-header">
      <span class="dm-inspect-key">Version v${version.id}</span>
      <span class="dm-inspect-size">${fmtKB(totalSize)}</span>
      <span class="dm-inspect-bar-cell"></span>
    </div>`);
    rows.push(this.inspectRow('constraintText', constraintSize, totalSize));
    rows.push(this.inspectRow('metadata (id, mcuRef, timestamp)', configsSize, totalSize));
    rows.push(this.inspectRow(`solutions (${version.solutions.length})`, allSolutionsSize, totalSize));

    // Per-solution breakdown
    if (version.solutions.length > 0) {
      for (const sol of version.solutions) {
        const solSize = sz(sol);
        const assignmentsData = sol.assignments ?? [];
        const legacyData = sol.configAssignments;
        const assignSize = sz(assignmentsData) + (legacyData ? sz(legacyData) : 0);
        const periphSize = sz(sol.portPeripherals);
        const costsSize = sz(sol.costs);
        const assignCount = assignmentsData.length;
        const format = sol.assignments ? 'compact' : 'legacy';

        rows.push(`<div class="dm-inspect-row dm-inspect-sub">
          <span class="dm-inspect-key">solution #${sol.id}${sol.name ? ` - ${sol.name}` : ''}</span>
          <span class="dm-inspect-size">${fmtKB(solSize)}</span>
          <span class="dm-inspect-bar-cell">${pct(solSize, totalSize)}</span>
        </div>`);
        rows.push(`<div class="dm-inspect-row dm-inspect-detail">
          <span class="dm-inspect-key">assignments (${assignCount} entries, ${format})</span>
          <span class="dm-inspect-size">${fmtKB(assignSize)}</span>
          <span class="dm-inspect-bar-cell"><span class="dm-inspect-bar" style="width:${pct(assignSize, totalSize)}"></span></span>
        </div>`);
        rows.push(`<div class="dm-inspect-row dm-inspect-detail">
          <span class="dm-inspect-key">portPeripherals</span>
          <span class="dm-inspect-size">${fmtKB(periphSize)}</span>
          <span class="dm-inspect-bar-cell"><span class="dm-inspect-bar" style="width:${pct(periphSize, totalSize)}"></span></span>
        </div>`);
        rows.push(`<div class="dm-inspect-row dm-inspect-detail">
          <span class="dm-inspect-key">costs</span>
          <span class="dm-inspect-size">${fmtKB(costsSize)}</span>
          <span class="dm-inspect-bar-cell"><span class="dm-inspect-bar" style="width:${pct(costsSize, totalSize)}"></span></span>
        </div>`);
      }
    }

    panel.innerHTML = rows.join('');
  }

  private inspectRow(label: string, size: number, total: number): string {
    const fmtKB = (chars: number): string => chars < 1024 ? `${chars}B` : `${(chars / 1024).toFixed(1)}KB`;
    const pct = (part: number, t: number): string => t > 0 ? `${(part / t * 100).toFixed(0)}%` : '0%';
    return `<div class="dm-inspect-row">
      <span class="dm-inspect-key">${label}</span>
      <span class="dm-inspect-size">${fmtKB(size)}</span>
      <span class="dm-inspect-bar-cell"><span class="dm-inspect-bar" style="width:${pct(size, total)}"></span></span>
    </div>`;
  }

  private deleteProjectVersion(projectName: string, versionId: number): void {
    const raw = localStorage.getItem(`project:${projectName}`);
    if (!raw) return;
    try {
      const projectData = migrateProjectData(JSON.parse(raw));
      projectData.versions = projectData.versions.filter(v => v.id !== versionId);
      if (projectData.versions.length === 0) {
        this.deleteProject(projectName);
        return;
      }
      // Re-number version ids
      projectData.versions.forEach((v, i) => v.id = i);
      localStorage.setItem(`project:${projectName}`, JSON.stringify(projectData));
      this.refreshProjectList();
    } catch { /* ignore */ }
  }

  private downloadJson(data: unknown, filename: string): void {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private exportCurrentMcu(): void {
    const mcu = this.currentMcu;
    if (!mcu) return;
    this.downloadJson(serializeMcu(mcu), `${mcu.refName}-mcu.json`);
  }

  private exportCurrentDma(): void {
    const dma = this.currentMcu?.dma;
    if (!dma) return;
    this.downloadJson(serializeDma(dma), `${this.currentMcu!.refName}-dma.json`);
  }

  private exportCurrentAst(): void {
    const parseResult = this.constraintEditor.getParseResult();
    if (!parseResult?.ast) return;
    const name = this.currentProjectName || 'constraints';
    this.downloadJson(parseResult.ast, `${name}-ast.json`);
  }

  private exportMcuData(refName: string): void {
    const mcuXml = localStorage.getItem(`mcu-xml:${refName}`);
    if (!mcuXml) return;

    const metaStr = localStorage.getItem(`mcu-meta:${refName}`);
    const meta = metaStr ? JSON.parse(metaStr) : null;

    // Find associated DMA XML by extracting the DMA version from MCU XML
    let dmaXml: string | null = null;
    let dmaVersion: string | null = null;
    const dmaMatch = mcuXml.match(/Name="DMA"\s+Version="([^"]+)"/);
    if (dmaMatch) {
      dmaVersion = dmaMatch[1];
      dmaXml = localStorage.getItem(`dma-xml:${dmaVersion}`);
    }

    const exportData: Record<string, unknown> = { refName, mcuXml };
    if (meta) exportData.meta = meta;
    if (dmaVersion) exportData.dmaVersion = dmaVersion;
    if (dmaXml) exportData.dmaXml = dmaXml;

    this.downloadJson(exportData, `${refName}.json`);
  }

  private exportProjectData(projectName: string): void {
    const raw = localStorage.getItem(`project:${projectName}`);
    if (!raw) return;
    const projectData = migrateProjectData(JSON.parse(raw));
    this.downloadJson(projectData, `${projectName}.json`);
  }

  private checkSolutionCompatibility(assignments: Assignment[], solutionMcuRef: string): CompatibilityResult | undefined {
    const mcu = this.currentMcu;
    if (!mcu) return undefined;
    const isCrossMcu = solutionMcuRef !== mcu.refName;
    if (!isCrossMcu) return undefined;

    const missingPins = new Set<string>();
    const missingSignals = new Map<string, string>();
    let validCount = 0;

    for (const a of assignments) {
      const pin = mcu.pinByName.get(a.pinName);
      if (!pin) {
        missingPins.add(a.pinName);
        continue;
      }
      if (!pin.signals.some(s => s.name === a.signalName)) {
        missingSignals.set(a.pinName, a.signalName);
        continue;
      }
      validCount++;
    }

    return {
      isCompatible: missingPins.size === 0 && missingSignals.size === 0,
      isCrossMcu: true,
      missingPins,
      missingSignals,
      validCount,
      totalCount: assignments.length,
    };
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

function mapToObj<V>(m: Map<string, V>): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const [k, v] of m) obj[k] = v;
  return obj;
}

function serializeMcu(mcu: Mcu): Record<string, unknown> {
  return {
    refName: mcu.refName,
    family: mcu.family,
    line: mcu.line,
    package: mcu.package,
    core: mcu.core,
    frequency: mcu.frequency,
    flash: mcu.flash,
    ram: mcu.ram,
    ccmRam: mcu.ccmRam,
    ioCount: mcu.ioCount,
    voltage: mcu.voltage,
    temperature: mcu.temperature,
    hasPowerPad: mcu.hasPowerPad,
    peripherals: mcu.peripherals,
    pins: mcu.pins,
    typeToInstances: mapToObj(mcu.typeToInstances),
    peripheralSignals: Object.fromEntries(
      [...mcu.peripheralSignals].map(([k, v]) => [k, [...v]])
    ),
  };
}

function serializeDma(dma: DmaData): Record<string, unknown> {
  return {
    version: dma.version,
    streams: dma.streams,
    signalToDmaStreams: mapToObj(dma.signalToDmaStreams),
    instanceToDmaStreams: mapToObj(dma.instanceToDmaStreams),
  };
}
