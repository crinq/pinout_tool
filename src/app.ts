import { LayoutManager } from './core/layout-manager';
import { HorizontalSplitter, VerticalSplitter } from './core/splitter';
import { PackageViewer } from './ui/package-viewer';
import { ConstraintEditor, highlightConstraintCode } from './ui/constraint-editor';
import { SolverSolutions } from './ui/solution-table';
import { ProjectSolutions } from './ui/project-solutions';
import { compareSolutions, solutionCompareColor } from './solution-compare';
import { PeripheralSummary } from './ui/peripheral-summary';
import { parseMcuXml, validateMcu } from './parser/mcu-xml-parser';
import { getDataSource, entryPackageNames, entryVariantNames, type IndexDeviceEntry } from './datasource';
import { parseDmaXml, isDmaXml, getDmaXmlVersion } from './parser/dma-xml-parser';
import { isIocFile, parseIocFile } from './parser/ioc-parser';
import { getAllCostFunctions, setSquaredCosts } from './solver/cost-functions';
import { getSolvers } from './solver/solver-registry';
import { SolutionEditor, type EditCandidate } from './solver/solution-editor';
import { renderMarkdown } from './ui/markdown';
import docMd from '../doc.md?raw';
import { classifyProjectSolutions } from './solver/solution-status';
import type { Mcu, Assignment, Solution, SolverResult, SolverError, DmaData, CompatibilityResult } from './types';
import type { ProgramNode } from './parser/constraint-ast';
import { parseConstraints } from './parser/constraint-parser';
import { serializeSolution, deserializeSolution, migrateProjectData, seedDefaultExports, loadCustomExports, saveCustomExport, deleteCustomExport, saveMacroLibrary, loadCommonErrorsLibrary, saveCommonErrorsLibrary, savePeripheralLibrary } from './storage';
import { DEFAULT_COMMON_ERRORS_LIBRARY } from './parser/lint-common-errors';
import { primeCommonErrorsLib } from './solver/solver';
import { getKv, migrateLocalStorageToIdb } from './kv';
import type { ProjectData, ProjectVersion, SerializedSolution } from './storage';
import type { CustomExportFunction } from './types';
import { mergeResults, type LabeledSolverResult } from './solver/result-merger';
import { fromWire, type WireSolverResult } from './solver/solution-transfer';
import { runPreSolveChecks } from './solver/solver';
import { interpolateAllComments } from './solver/comment-interpolation';
import { SolverDebugOverlay } from './ui/solver-debug-overlay';
import { analyzeSolverInputs, formatSolverSummary, type SolverDiagnosticsReport } from './solver/diagnostics';
import { filterStoredMcus, extractMcuFilters, matchesPatterns, matchesMcuFilters, type McuFilters } from './mcu-matcher';
import { startTutorial, shouldShowTutorial } from '../ts_lib/src/tutorial';
import { initTheme, cycleThemeMode, getThemeMode, themeModeLabel, onThemeChange } from '../ts_lib/src/theme';
import type { TutorialStep } from '../ts_lib/src/tutorial';
import { seedMacroLibrary, getStdlibSource, primeStdlibSource, DEFAULT_MACRO_LIBRARY } from './parser/stdlib-macros';
import { seedPeripheralLibrary, getPeripheralSource, primePeripheralSource, DEFAULT_PERIPHERAL_LIBRARY } from './parser/peripheral-lib';

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

import { escapeHtml as escHtml, createModal } from './utils';

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
  postOptimize: boolean;
  squaredCosts: boolean;
  dataInspector: boolean;
  dynamicTimeoutMultiplier: number;
  solverDebugOverlay: boolean;
  urlEncoding: 'none' | 'constraints' | 'constraints-mcu' | 'full';
}

const DEFAULT_SETTINGS: AppSettings = {
  maxSolutions: 2600,
  solverTimeoutMs: 2500,
  dynamicTimeoutMultiplier: 3,
  solverTypes: ['two-phase', 'cost-guided', 'priority-backtracking', 'mrv-group', 'ratio-mrv-group', 'hybrid', 'dynamic-mrv', 'adaptive'],
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
    pin_anchor: 1,
    optional_fulfillment: 5,
  },
  minZoom: 0.5,
  maxZoom: 2,
  mouseZoomGain: 0.025,
  skipGpioMapping: true,
  postOptimize: false,
  squaredCosts: false,
  dataInspector: false,
  solverDebugOverlay: false,
  urlEncoding: 'none',
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
  /** Abort controller for the pre-solve fetch phase (remote MCU loads). */
  private fetchAbort: AbortController | null = null;
  /** Diagnostics report per MCU for the in-flight solve (cleared at end). */
  private diagnosticsByMcu = new Map<string, SolverDiagnosticsReport>();
  private isDynamicTimeoutRetry = false;
  private debugOverlay = new SolverDebugOverlay();
  /** Active solution editor (modify mode); null when not editing. */
  private editor: SolutionEditor | null = null;
  private editMenu: HTMLElement | null = null;
  private currentSolution: Solution | null = null;
  private currentProjectName: string | null = null;
  /** Cache of parsed MCU objects for multi-MCU solving */
  private mcuCache = new Map<string, Mcu>();
  /** MCU refNames involved in the current solver result (for multi-MCU mode) */
  private multiMcuRefs: string[] = [];
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
    this.peripheralSummary.onHighlightPins((pins, color) => {
      this.layout.broadcastStateChange({ type: 'highlight-pins', highlightPins: pins, highlightColor: color });
    });
    this.constraintEditor.onHighlightPins((pins, color) => {
      this.layout.broadcastStateChange({ type: 'highlight-pins', highlightPins: pins, highlightColor: color });
    });

    const bottomSplitter = HorizontalSplitter();
    bottomSplitter.add(this.solverSolutions, 1);
    bottomSplitter.add(this.projectSolutions, 1);
    bottomSplitter.add(this.peripheralSummary, 0.75);

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

    // Move heavy localStorage entries (mcu-xml, project, …) into IDB on
    // first boot. Idempotent: a one-shot flag in localStorage gates this.
    // Restore state runs after so it sees the migrated keys.
    void (async () => {
      try { await migrateLocalStorageToIdb(); } catch (err) {
        console.warn('[migration] failed:', err);
      }
      void this.restoreState();
      void seedDefaultExports();
      void seedMacroLibrary();
      void seedPeripheralLibrary();
      // Seed + prime the common-error lint library.
      const existing = await loadCommonErrorsLibrary();
      if (existing == null) await saveCommonErrorsLibrary(DEFAULT_COMMON_ERRORS_LIBRARY.trim());
      primeCommonErrorsLib((await loadCommonErrorsLibrary()) ?? DEFAULT_COMMON_ERRORS_LIBRARY.trim());
    })();

    // Show tutorial for first-time users
    if (shouldShowTutorial('tutorial-seen')) {
      requestAnimationFrame(() => startTutorial({
        steps: this.getTutorialSteps(),
        storageKey: 'tutorial-seen',
        onStart: () => this.loadTutorialExample(),
      }));
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
      if (this.editor) return; // ignore list selection while editing; Save/Discard first
      this.currentSolution = solution;
      this.refreshEditControls();

      // Switch MCU if the solution is from a different MCU (multi-MCU mode)
      if (solution.mcuRef && (!this.currentMcu || this.currentMcu.refName !== solution.mcuRef)) {
        const cachedMcu = this.mcuCache.get(solution.mcuRef);
        if (cachedMcu) {
          this.currentMcu = cachedMcu;
          // Update header
          const mcuInfo = document.getElementById('mcu-info');
          if (mcuInfo) {
            mcuInfo.textContent = `${cachedMcu.refName} | ${cachedMcu.package} | ${cachedMcu.cores.join(' + ')} @ ${cachedMcu.frequency}MHz | ${cachedMcu.flash}KB Flash | ${cachedMcu.ram}KB RAM`;
          }
          this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu: cachedMcu });
        }
      }

      const compatibility = this.renderSolutionToPanels(solution);
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

    // Multi-select from project list -> broadcast compare state (or fall
    // back to single-selection view when only one row is picked).
    this.projectSolutions.onSelectionChanged((solutions) => {
      this.handleCompareSelectionChanged(solutions);
    });

    // Focus coordination: when one list gains focus, deselect the other
    this.solverSolutions.onFocusGained(() => this.projectSolutions.deselect());
    this.projectSolutions.onFocusGained(() => this.solverSolutions.deselect());

    // Constraint editor changes -> enable/disable solve button + persist state + pin preview
    this.constraintEditor.onChange((_text, result) => {
      // Keep saved-solution validity badges in sync with the freshly-parsed
      // constraints. This must run even during a project load: setText() there
      // triggers this debounced parse, and it's the moment the AST first
      // becomes available — the MCU-load path handles the MCU-ready signal, but
      // nothing else covers "parse ready" while loadingProject is set.
      this.updateProjectSolutionValidity();
      if (this.loadingProject) return;
      this.saveStateDebounced();
      this.hasSolverResult = false;

      const solveBtn = this.constraintEditor.getSolveButton();
      if (solveBtn) {
        const hasErrors = result.errors.length > 0;
        const hasMcu = this.currentMcu !== null;
        // `mcu:` filter drives multi-MCU mode — remote fetch or stored
        // scan populates the mcu list at solve time, so no loaded MCU
        // is required.
        const hasMcuFilter = result.ast?.statements.some(s => s.type === 'mcu_decl') ?? false;
        (solveBtn as HTMLButtonElement).disabled = hasErrors || (!hasMcu && !hasMcuFilter);
      }

      // Show pin declarations on viewer immediately (before solving)
      this.showPinPreview(result.ast);
      // (validity badges already refreshed above, before the loading guard)
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

    // --- Solution editor (modify mode) ---
    this.refreshEditControls();
    this.packageViewer.onPinClick((pin, e) => {
      if (!this.editor) return;
      this.showEditMenu(e.clientX, e.clientY, this.editor.movesForPin(pin.name), `Pin ${pin.name}`);
    });
    this.peripheralSummary.onPortEdit((port, e) => {
      if (!this.editor) return;
      this.showEditMenu(e.clientX, e.clientY, this.editor.listPortSwaps(port), `Swap all of ${port}`);
    });
    this.peripheralSummary.onPeripheralEdit((port, inst, e) => {
      if (!this.editor) return;
      const cands = [
        ...this.editor.listPeripheralSwaps(port, inst),
        ...this.editor.listUnusedReplacements(port, inst),
      ];
      this.showEditMenu(e.clientX, e.clientY, cands, `${inst} on ${port}`);
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
      this.updateProjectSolutionValidity();
    });

  }

  private async runSolver(): Promise<void> {
    // If already solving (or fetching), abort instead of restarting.
    if (this.solverWorkers.length > 0 || this.fetchAbort) {
      this.abortSolver();
      return;
    }

    this.currentSolution = null;

    const parseResult = this.constraintEditor.getParseResult();
    if (!parseResult?.ast) {
      this.showStatus('Fix constraint errors before solving', 'error');
      return;
    }

    // Determine MCU list: multi-MCU from filters or single current MCU
    const filters = extractMcuFilters(parseResult.ast);
    let mcuList: Mcu[];

    if (filters) {
      // Multi-MCU mode: union (a) MCUs already in storage and (b) MCUs
      // pulled from the remote data source. Either path can be empty.
      mcuList = [];
      const seen = new Set<string>();

      const matchingRefs = await filterStoredMcus(parseResult.ast);
      for (const ref of matchingRefs) {
        let mcu = this.mcuCache.get(ref);
        if (!mcu) {
          const xml = await getKv().get(`mcu-xml:${ref}`);
          if (!xml) continue;
          try {
            mcu = parseMcuXml(xml);
            this.mcuCache.set(ref, mcu);
          } catch {
            console.warn(`Failed to parse stored MCU ${ref}`);
            continue;
          }
        }
        if (!seen.has(mcu.refName)) {
          seen.add(mcu.refName);
          mcuList.push(mcu);
        }
      }

      // Optionally augment with remote dies. The data source URL is
      // user-configured (Data Manager); when missing we silently skip
      // this path.
      if (getDataSource().baseUrl()) {
        const remote = await this.fetchRemoteMatches(filters);
        if (remote === null) {
          // Aborted by user — abortSolver already showed status.
          this.setSolveButtonState(false);
          return;
        }
        // Fetch armed the button as "Abort"; release it now. solve() re-arms it
        // below (only when it dispatches workers), so any validation step that
        // bails out between here and then leaves the button on "Solve".
        this.setSolveButtonState(false);
        for (const mcu of remote) {
          if (!seen.has(mcu.refName)) {
            seen.add(mcu.refName);
            mcuList.push(mcu);
            this.mcuCache.set(mcu.refName, mcu);
          }
        }
      }

      // (c) MCUs already loaded this session but not persisted to storage —
      // e.g. an exact `mcu:` name imported from a .ioc or fetched for a
      // project, which the remote die-index may not resolve by full name.
      for (const mcu of this.mcuCache.values()) {
        if (!seen.has(mcu.refName) && this.mcuMatchesFilters(mcu, filters)) {
          seen.add(mcu.refName);
          mcuList.push(mcu);
        }
      }

      if (mcuList.length === 0) {
        this.showStatus(
          'No MCUs match the filters. Import XML files or configure a remote data source.',
          'error'
        );
        return;
      }

      this.multiMcuRefs = mcuList.map(m => m.refName);
    } else {
      // Single MCU mode
      if (!this.currentMcu) {
        this.showStatus('No MCU loaded', 'error');
        return;
      }
      mcuList = [this.currentMcu];
      this.multiMcuRefs = [];
      // Ensure current MCU is in cache for solution switching
      this.mcuCache.set(this.currentMcu.refName, this.currentMcu);
    }

    // Drop any solver names not in the current registry — stale settings
    // (renamed or removed solvers) would otherwise send an unknown name
    // to the worker's switch-default and eat resources on backtracking.
    const knownIds = new Set(getSolvers().map(s => s.id));
    const solverTypes = this.settings.solverTypes.filter(s => {
      if (knownIds.has(s)) return true;
      console.warn(`[settings] ignoring unknown solver "${s}"`);
      return false;
    });
    if (solverTypes.length === 0) {
      this.showStatus('No solvers selected', 'error');
      return;
    }

    // Run pre-solve validation per MCU. In a multi-MCU run an MCU that fails
    // (e.g. lacks a required peripheral) is skipped — only abort the whole run
    // if EVERY candidate MCU fails. A single-MCU run keeps its original UX.
    const solvableMcus: Mcu[] = [];
    const skippedMcus: string[] = [];
    let firstFailPreErrors: SolverError[] | null = null;
    for (const m of mcuList) {
      const pe = runPreSolveChecks(parseResult.ast, m);
      if (pe.some(e => e.type === 'error')) {
        skippedMcus.push(m.refName);
        if (!firstFailPreErrors) firstFailPreErrors = pe;
      } else {
        solvableMcus.push(m);
      }
    }

    if (solvableMcus.length === 0) {
      const preErrors = firstFailPreErrors ?? [];
      const fatalErrors = preErrors.filter(e => e.type === 'error');
      const statusBar = this.constraintEditor.getSolverStatusBar();
      if (statusBar) {
        statusBar.innerHTML = preErrors
          .map((e: { type: string; message: string }) => {
            const m = e.message.match(/^([A-Za-z0-9_-]+): (.*)$/);
            if (m) {
              return `<span class="st-${e.type}"><span class="st-sender">${m[1]}:</span> ${m[2]}</span>`;
            }
            return `<span class="st-${e.type}">${e.message}</span>`;
          })
          .join(' ');
      }
      // Show error lines in minimap
      const errorLines = preErrors.filter(e => e.line != null).map(e => e.line!);
      if (errorLines.length > 0) {
        this.constraintEditor.setPreSolveErrorLines(errorLines);
      }
      this.showStatus(fatalErrors[0]?.message ?? 'No MCU passed pre-solve checks', 'error');
      return;
    }

    // Proceed with only the solvable MCUs; note any that were skipped.
    mcuList = solvableMcus;
    if (this.multiMcuRefs.length > 0) this.multiMcuRefs = mcuList.map(m => m.refName);
    if (skippedMcus.length > 0) {
      console.log(`[solver] skipped ${skippedMcus.length} MCU(s) failing pre-solve checks: ${skippedMcus.join(', ')}`);
    }

    const skipLabel = skippedMcus.length > 0 ? `, ${skippedMcus.length} skipped` : '';
    const multiLabel = mcuList.length > 1 || skippedMcus.length > 0
      ? ` across ${mcuList.length} MCUs${skipLabel}`
      : '';
    const label = solverTypes.length > 1
      ? `Solving with ${solverTypes.length} solvers${multiLabel}...`
      : `Solving${multiLabel}...`;
    this.showStatus(label, 'info');
    this.setSolveButtonState(true);

    // Compute static diagnostics once per solve. Solvers all share the
    // same input (constraint AST × MCU), so the bottleneck breakdown is
    // identical across them — the per-solver Details modal still has its
    // own runtime stats (time, evaluated, errors).
    this.diagnosticsByMcu.clear();
    for (const m of mcuList) {
      try {
        this.diagnosticsByMcu.set(m.refName, analyzeSolverInputs(parseResult.ast, m));
      } catch (err) {
        console.warn(`[diagnostics] failed for ${m.refName}:`, err);
      }
    }
    // Always log a top-level summary so users hitting "Solve" without the
    // overlay still get bottleneck hints in the console.
    const headDiag = this.diagnosticsByMcu.get(mcuList[0].refName);
    if (headDiag && headDiag.summary.length > 0) {
      console.log('[solver]', headDiag.summary.join(' '));
    }

    if (this.settings.solverDebugOverlay) {
      this.debugOverlay.setDiagnostics(headDiag ?? null);
      this.debugOverlay.startRun(solverTypes);
    }

    // Solve sequentially for each MCU, collecting all results
    const allResults: LabeledSolverResult[] = [];
    let mcuIdx = 0;

    const solveNextMcu = () => {
      if (mcuIdx >= mcuList.length) {
        this.onAllSolversComplete(allResults);
        return;
      }

      const mcu = mcuList[mcuIdx];
      const mcuLabel = mcuList.length > 1 ? `[${mcuIdx + 1}/${mcuList.length} ${mcu.refName}] ` : '';

      if (mcuList.length > 1) {
        this.showStatus(`${mcuLabel}Solving...`, 'info');
      }

      this.solveForMcu(mcu, parseResult.ast!, solverTypes, mcuLabel, (results) => {
        allResults.push(...results);
        mcuIdx++;
        solveNextMcu();
      });
    };

    solveNextMcu();
  }

  /**
   * Dispatch solver workers for a single MCU. Calls onComplete when all workers finish.
   */
  private solveForMcu(
    mcu: Mcu,
    ast: ProgramNode,
    solverTypes: string[],
    statusPrefix: string,
    onComplete: (results: LabeledSolverResult[]) => void,
  ): void {
    const results: LabeledSolverResult[] = [];
    let completedCount = 0;

    // A2: Group shared-Phase-1 solvers into one worker
    const sharedPhase1Set = new Set(['two-phase', 'diverse-instances', 'priority-two-phase', 'priority-group']);
    const sharedSolvers = solverTypes.filter(s => sharedPhase1Set.has(s));
    const individualSolvers = solverTypes.filter(s => !sharedPhase1Set.has(s));

    const workerJobs: Array<{ types: string[]; useShared: boolean }> = [];
    if (sharedSolvers.length >= 2) {
      workerJobs.push({ types: sharedSolvers, useShared: true });
      for (const st of individualSolvers) {
        workerJobs.push({ types: [st], useShared: false });
      }
    } else {
      for (const st of solverTypes) {
        workerJobs.push({ types: [st], useShared: false });
      }
    }

    const totalCount = workerJobs.length;

    // Scale per-worker solution cap so total across all workers stays bounded.
    // Each worker gets at most 2× its fair share to allow headroom for dedup.
    const perWorkerMax = totalCount > 1
      ? Math.ceil(this.settings.maxSolutions / totalCount * 2)
      : this.settings.maxSolutions;

    const baseConfig = {
      maxSolutions: perWorkerMax,
      timeoutMs: this.settings.solverTimeoutMs,
      costWeights: new Map(Object.entries(this.settings.costWeights)),
      skipGpioMapping: this.settings.skipGpioMapping,
      postOptimize: this.settings.postOptimize,
      squaredCosts: this.settings.squaredCosts,
    };

    for (const job of workerJobs) {
      const worker = new Worker(
        new URL('./solver/solver-worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.solverWorkers.push(worker);

      const jobLabel = `${mcu.refName}:${job.types.join('+')}`;

      const workerStartTime = performance.now();
      worker.onmessage = (e) => {
        const receiveTime = performance.now();
        const wireData = e.data as WireSolverResult | SolverResult;
        const solverResult = '_wire' in wireData ? fromWire(wireData as WireSolverResult) : wireData as SolverResult;
        const solveMs = solverResult.statistics.solveTimeMs;
        const totalMs = receiveTime - workerStartTime;
        const transferMs = totalMs - solveMs;
        if (transferMs > 50) console.log(`[perf] ${jobLabel}: solve=${solveMs.toFixed(0)}ms, overhead≈${transferMs.toFixed(0)}ms, ${solverResult.solutions.length} solutions`);
        results.push({ solverId: jobLabel, result: solverResult });
        const diag = this.diagnosticsByMcu.get(mcu.refName);
        for (const st of job.types) {
          this.debugOverlay.solverComplete(st, solverResult);
          if (diag) {
            console.log(formatSolverSummary(
              st, solverResult.solutions.length,
              solverResult.statistics.evaluatedCombinations,
              solverResult.statistics.solveTimeMs, diag,
            ));
          }
        }
        completedCount++;
        if (totalCount > 1) {
          this.showStatus(`${statusPrefix}Solving... (${completedCount}/${totalCount} complete)`, 'info');
        }
        if (completedCount === totalCount) {
          // Terminate workers for this MCU before proceeding
          this.terminateWorkers();
          onComplete(results);
        }
      };

      worker.onerror = (err) => {
        console.error(`Solver worker error (${jobLabel}):`, err);
        // ErrorEvent.message is often empty for cross-origin / module-load
        // failures. Piece together whatever we can so the modal shows
        // something actionable.
        const parts = [
          err.message || null,
          err.filename ? `at ${err.filename}${err.lineno ? ':' + err.lineno : ''}` : null,
          (err as ErrorEvent & { error?: Error }).error?.message || null,
        ].filter(Boolean);
        const detail = parts.length > 0 ? parts.join(' — ') : 'worker failed to load (check browser console for details)';
        const errorResult: SolverResult = {
          mcuRef: mcu.refName,
          solutions: [],
          errors: [{ type: 'error', message: `${jobLabel} crashed: ${detail}` }],
          statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
        };
        results.push({ solverId: jobLabel, result: errorResult });
        for (const st of job.types) {
          this.debugOverlay.solverComplete(st, errorResult);
        }
        completedCount++;
        if (completedCount === totalCount) {
          this.terminateWorkers();
          onComplete(results);
        }
      };

      if (job.useShared) {
        worker.postMessage({
          ast, mcu,
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

        worker.postMessage({
          ast, mcu,
          config: baseConfig,
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

    const t0 = performance.now();
    const result = mergeResults(results, this.settings.maxSolutions);
    const mergeMs = performance.now() - t0;
    if (mergeMs > 50) console.log(`[perf] mergeResults: ${mergeMs.toFixed(0)}ms (${result.solutions.length} solutions)`);

    // Dynamic timeout retry: if 0 solutions and multiplier > 1 and not already a retry
    const mult = this.settings.dynamicTimeoutMultiplier;
    if (result.solutions.length === 0 && mult > 1 && !this.isDynamicTimeoutRetry) {
      const originalTimeout = this.settings.solverTimeoutMs;
      const boostedTimeout = originalTimeout * mult;
      this.showStatus(`No solutions found — retrying with ${boostedTimeout}ms timeout (×${mult})...`, 'info');
      this.isDynamicTimeoutRetry = true;
      const savedTimeout = this.settings.solverTimeoutMs;
      this.settings.solverTimeoutMs = boostedTimeout;

      const parseResult = this.constraintEditor.getParseResult();
      if (parseResult?.ast) {
        if (this.settings.solverDebugOverlay) {
          this.debugOverlay.startRun(this.settings.solverTypes);
        }

        // Re-run solver with boosted timeout
        const mcuList = this.multiMcuRefs.length > 0
          ? this.multiMcuRefs.map(ref => this.mcuCache.get(ref)!).filter(Boolean)
          : this.currentMcu ? [this.currentMcu] : [];

        if (mcuList.length > 0) {
          const allRetryResults: LabeledSolverResult[] = [];
          let mcuIdx = 0;

          const solveNextMcu = () => {
            if (mcuIdx >= mcuList.length) {
              this.settings.solverTimeoutMs = savedTimeout;
              // Keep isDynamicTimeoutRetry = true so the recursive call won't retry again
              this.onAllSolversComplete(allRetryResults);
              this.isDynamicTimeoutRetry = false;
              return;
            }
            const mcu = mcuList[mcuIdx];
            const mcuLabel = mcuList.length > 1 ? `[${mcuIdx + 1}/${mcuList.length} ${mcu.refName}] ` : '';
            this.solveForMcu(mcu, parseResult.ast!, this.settings.solverTypes, mcuLabel, (res) => {
              allRetryResults.push(...res);
              mcuIdx++;
              solveNextMcu();
            });
          };
          solveNextMcu();
          return;
        }
        this.settings.solverTimeoutMs = savedTimeout;
      }
      this.isDynamicTimeoutRetry = false;
    }

    this.isDynamicTimeoutRetry = false;
    this.setSolveButtonState(false);

    this.debugOverlay.finalize(result.solutions);

    this.layout.broadcastStateChange({ type: 'solver-complete', solverResult: result });
    this.hasSolverResult = result.solutions.length > 0;

    // Update stats in constraint editor toolbar
    const statsEl = document.getElementById('ce-stats');
    if (statsEl) {
      const s = result.statistics;
      const solverCount = results.length;
      const mcuCount = this.multiMcuRefs.length;
      const mcuLabel = mcuCount > 1 ? `, ${mcuCount} MCUs` : '';
      statsEl.textContent = solverCount > 1
        ? `${s.validSolutions} solutions in ${s.solveTimeMs.toFixed(0)}ms (${solverCount} solvers${mcuLabel}, ${s.evaluatedCombinations} combos)`
        : `${s.validSolutions} solutions in ${s.solveTimeMs.toFixed(0)}ms${mcuLabel} (${s.evaluatedCombinations}/${s.totalCombinations} combos)`;
    }

    // Show solver errors/warnings in constraint editor status bar
    const statusBar = this.constraintEditor.getSolverStatusBar();
    if (statusBar) {
      if (result.errors.length > 0) {
        statusBar.innerHTML = result.errors
          .map((e: { type: string; message: string }) => {
            const m = e.message.match(/^([A-Za-z0-9_-]+): (.*)$/);
            if (m) {
              return `<span class="st-${e.type}"><span class="st-sender">${m[1]}:</span> ${m[2]}</span>`;
            }
            return `<span class="st-${e.type}">${e.message}</span>`;
          })
          .join(' ');
      } else {
        statusBar.textContent = '';
      }
    }

    if (result.solutions.length > 0) {
      const mcuCount = this.multiMcuRefs.length;
      const mcuSuffix = mcuCount > 1 ? ` across ${mcuCount} MCUs` : '';
      this.showStatus(
        `Found ${result.solutions.length} solutions in ${result.statistics.solveTimeMs.toFixed(0)}ms${mcuSuffix}`,
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
        const channelComments = interpolateAllComments(this.getChannelComments(), partialError.partialSolution as Assignment[]);
        this.layout.broadcastStateChange({
          type: 'solution-selected',
          assignments: partialError.partialSolution,
          portColors, channelComments,
        });
      }
    }
  }

  /**
   * Whether a concrete MCU variant passes the mcu/package/memory/freq/temp/
   * voltage/core filters. Delegates to the same predicate as the localStorage
   * path (matchesMcuFilters) so remote/cache MCUs get the full filter set —
   * notably `core:` AND-groups, which a bespoke check here previously skipped.
   */
  private mcuMatchesFilters(mcu: Mcu, filters: McuFilters): boolean {
    return matchesMcuFilters({
      refName: mcu.refName, package: mcu.package, ram: mcu.ram, flash: mcu.flash,
      frequency: mcu.frequency,
      tempMin: mcu.temperature.min, tempMax: mcu.temperature.max,
      voltageMin: mcu.voltage.min, voltageMax: mcu.voltage.max,
      cores: mcu.cores, tags: [],
    }, filters);
  }

  /**
   * Fetch MCUs that match `extractMcuFilters` output from the remote
   * data source. Two-stage filter: dies whose name matches the mcu
   * patterns are fetched, then each variant is re-checked against the
   * full filter set (mcu/package/ram/rom/freq/cores). Returns null if
   * the user aborted, otherwise the list of accepted Mcu instances.
   */
  private async fetchRemoteMatches(
    filters: McuFilters,
  ): Promise<Mcu[] | null> {
    this.fetchAbort = new AbortController();
    this.setSolveButtonState(true);

    try {
      const ds = getDataSource();
      // Pattern matches against die names (case-insensitive). With no mcu
      // pattern at all, we still allow `package:` / memory filters to
      // prune across the whole catalogue — that's an opt-in cost.
      const matchedDies = await ds.listDies((die, entry) => {
        // Match the mcu pattern against the die name, the family, or any full
        // variant name the index lists (so `mcu: STM32H755IIKx` / `stm32h755iik*`
        // resolves without fetching the die).
        if (filters.mcuPatterns.length > 0
            && !matchesPatterns(die, filters.mcuPatterns)
            && !matchesPatterns(entry.family, filters.mcuPatterns)
            && !entryVariantNames(entry).some(v => matchesPatterns(v, filters.mcuPatterns))) {
          return false;
        }
        // Cheap pre-filter on indexed metadata to avoid pointless fetches.
        if (filters.minRamBytes > 0 && entry.ram_bytes !== undefined && entry.ram_bytes < filters.minRamBytes) return false;
        if (filters.maxRamBytes > 0 && entry.ram_bytes !== undefined && entry.ram_bytes > filters.maxRamBytes) return false;
        if (filters.minRomBytes > 0 && entry.flash_bytes !== undefined && entry.flash_bytes < filters.minRomBytes) return false;
        if (filters.maxRomBytes > 0 && entry.flash_bytes !== undefined && entry.flash_bytes > filters.maxRomBytes) return false;
        const pkgs = entryPackageNames(entry);
        if (filters.packagePatterns.length > 0 && pkgs.length > 0
            && !pkgs.some(p => matchesPatterns(p, filters.packagePatterns))) {
          return false;
        }
        return true;
      }, this.fetchAbort.signal);

      if (matchedDies.length === 0) {
        this.fetchAbort = null;
        return [];
      }

      this.showStatus(`Fetching ${matchedDies.length} MCUs from data source…`, 'info');
      const result = await ds.loadManyDies(matchedDies.map(d => d.die), {
        signal: this.fetchAbort.signal,
        onProgress: (p) => {
          this.showStatus(`Fetching MCUs: ${p.completed}/${p.total}${p.failed ? ` (${p.failed} failed)` : ''}`, 'info');
        },
      });

      if (result.cancelled) {
        this.fetchAbort = null;
        return null;
      }

      // Variant-level re-filter so `mcu: STM32G474RBTx` (variant-specific)
      // works even though the index keyed by die.
      const accepted = result.mcus.filter(mcu => this.mcuMatchesFilters(mcu, filters));

      if (result.errors.length > 0) {
        console.warn('Some remote MCUs failed to load:', result.errors);
      }

      this.fetchAbort = null;
      return accepted;
    } catch (err) {
      this.fetchAbort = null;
      if ((err as Error).name === 'AbortError') return null;
      this.showStatus(`Remote MCU fetch failed: ${(err as Error).message}`, 'error');
      return [];
    }
  }

  private abortSolver(): void {
    // Two cancel paths: pre-solve remote fetch, then worker phase.
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
      this.setSolveButtonState(false);
      this.showStatus('Aborted MCU fetch', 'info');
      return;
    }
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
        <button class="btn btn-small" id="btn-import-xml" title="Import an MCU (.xml), DMA modes (.xml), or a CubeMX project (.ioc)">Import</button>
        <button class="btn btn-small" id="btn-tutorial" title="Guided walkthrough of the tool">Tutorial</button>
        <button class="btn btn-small" id="btn-docs" title="Full documentation">Docs</button>
        <button class="btn btn-small" id="btn-data-manager" title="Manage stored MCUs, projects, exports, and the remote data source">Data</button>
        <button class="btn btn-small" id="btn-settings" title="Solver options and cost-function weights">Settings</button>
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

    // Tutorial button
    header.querySelector('#btn-tutorial')!.addEventListener('click', () => {
      startTutorial({
        steps: this.getTutorialSteps(),
        storageKey: 'tutorial-seen',
        onStart: () => this.loadTutorialExample(),
      });
    });

    // Docs button
    header.querySelector('#btn-docs')!.addEventListener('click', () => this.showDocs());

    // Data manager button
    header.querySelector('#btn-data-manager')!.addEventListener('click', () => this.showDataManager());

    // Settings button
    header.querySelector('#btn-settings')!.addEventListener('click', () => this.showSettingsModal());

    // Theme toggle (light → dark → auto → light …)
    // Migrate old 'theme' key to 'theme-mode' used by ts_lib
    const oldTheme = localStorage.getItem('theme');
    if (oldTheme && !localStorage.getItem('theme-mode')) {
      localStorage.setItem('theme-mode', oldTheme);
      localStorage.removeItem('theme');
    }

    initTheme();
    const themeBtn = header.querySelector('#btn-theme-toggle')!;
    themeBtn.textContent = themeModeLabel(getThemeMode());

    onThemeChange((mode) => {
      themeBtn.textContent = themeModeLabel(mode);
      this.layout.broadcastStateChange({ type: 'theme-changed' });
    });

    themeBtn.addEventListener('click', () => {
      cycleThemeMode();
    });
  }

  /** Full documentation viewer — renders the bundled doc.md. */
  private showDocs(): void {
    const result = createModal({
      overlayClass: 'docs-overlay',
      modalClass: 'docs-modal',
      toggle: '.docs-overlay',
      modalStyle: { width: 'min(900px, 92vw)', maxHeight: '88vh' },
    });
    if (!result) return;
    const { modal, close } = result;
    const body = document.createElement('div');
    body.className = 'docs-body md-body';
    body.innerHTML = renderMarkdown(docMd);

    const header = document.createElement('div');
    header.className = 'docs-header';
    header.innerHTML = `<strong>Documentation</strong><button class="btn btn-small docs-close">Close</button>`;
    header.querySelector('.docs-close')!.addEventListener('click', close);

    modal.appendChild(header);
    modal.appendChild(body);

    // In-page anchor links (TOC) scroll within the modal instead of the page.
    body.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      const href = a?.getAttribute('href');
      if (href && href.startsWith('#')) {
        const target = body.querySelector(`#${CSS.escape(href.slice(1))}`);
        if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }
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

  private async loadMcuXml(xmlString: string, fileName: string): Promise<void> {
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

    // Persist raw XML so reloads don't need a re-import.
    try {
      await getKv().set(`mcu-xml:${mcu.refName}`, xmlString);
      const tags = ['PIN'];
      if (mcu.dma) tags.push('DMA');
      await getKv().set(`mcu-meta:${mcu.refName}`, JSON.stringify({
        tags, package: mcu.package, ram: mcu.ram, flash: mcu.flash, frequency: mcu.frequency,
      }));
    } catch (err) {
      console.warn('Failed to store MCU XML:', err);
    }

    this.activateLoadedMcu(mcu);
  }

  /**
   * Common post-parse hook: store in cache, update header, broadcast,
   * enable solve. Both XML drag-drop and remote JSON fetch route here.
   */
  private activateLoadedMcu(mcu: Mcu): void {
    this.currentMcu = mcu;
    this.mcuCache.set(mcu.refName, mcu);
    // ponytail: temporary diagnostic — remove once JSON solver path proven.
    console.log(
      `[mcu-loaded] ${mcu.refName}: ${mcu.logicalPins.length} logicals, ${mcu.peripherals.length} peripherals, `
      + `types=${[...mcu.typeToInstances.keys()].sort().join(',')}`
    );

    const mcuInfo = document.getElementById('mcu-info');
    if (mcuInfo) {
      mcuInfo.textContent = `${mcu.refName} | ${mcu.package} | ${mcu.cores.join(' + ')} @ ${mcu.frequency}MHz | ${mcu.flash}KB Flash | ${mcu.ram}KB RAM`;
    }

    this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu });

    const solveBtn = this.constraintEditor.getSolveButton();
    if (solveBtn) {
      const parseResult = this.constraintEditor.getParseResult();
      (solveBtn as HTMLButtonElement).disabled = !parseResult || parseResult.errors.length > 0;
    }

    const dmaInfo = mcu.dma ? `, ${mcu.dma.streams.length} DMA streams` : '';
    this.showStatus(`Loaded ${mcu.refName} (${mcu.physicalPins.length} pins, ${mcu.peripherals.length} peripherals${dmaInfo})`, 'success');
    this.updateProjectSolutionValidity();
  }

  private async reimportAllMcus(): Promise<void> {
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('mcu-xml:')) continue;
      const refName = key.substring('mcu-xml:'.length);
      const xml = localStorage.getItem(key);
      if (!xml) continue;
      try {
        const mcu = parseMcuXml(xml);
        // Preserve existing tags, update everything else
        let tags = ['PIN'];
        try {
          const oldMeta = await getKv().get(`mcu-meta:${refName}`);
          if (oldMeta) tags = JSON.parse(oldMeta).tags ?? ['PIN'];
        } catch { /* use default */ }
        if (mcu.dma) tags = [...new Set([...tags, 'DMA'])];
        await getKv().set(`mcu-meta:${refName}`, JSON.stringify({
          tags, package: mcu.package, ram: mcu.ram, flash: mcu.flash, frequency: mcu.frequency,
        }));
        updated++;
      } catch {
        failed++;
      }
    }
    // Clear MCU cache so stale data isn't reused
    this.mcuCache.clear();
    const msg = `Re-imported ${updated} MCU${updated !== 1 ? 's' : ''}` + (failed ? `, ${failed} failed` : '');
    this.showStatus(msg, failed ? 'error' : 'success');
  }

  private loadTutorialExample(): void {
    // Reset project selection so the dropdown doesn't show a stale project.
    this.currentProjectName = null;
    this.projectSelect.value = '';

    // The example constraints begin with an `mcu:` filter, so the MCU (and any
    // DMA data) is fetched from the remote data source at solve time — nothing
    // to preload here.
    fetch('examples/ecat_complex.txt')
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
      .then(text => { this.constraintEditor.setText(text); })
      .catch(() => { /* Example not available, tutorial continues without it */ });
  }

  private getTutorialSteps(): TutorialStep[] {
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

  private async loadDmaXml(xmlString: string, fileName: string): Promise<void> {
    const version = getDmaXmlVersion(xmlString);
    if (!version) {
      this.showStatus(`No version found in DMA XML ${fileName}`, 'error');
      return;
    }

    // Parse to validate
    const dmaData = parseDmaXml(xmlString);

    // Store the raw DMA XML keyed by version
    try {
      await getKv().set(`dma-xml:${version}`, xmlString);
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
          const metaStr = await getKv().get(`mcu-meta:${mcu.refName}`);
          const meta = metaStr ? JSON.parse(metaStr) : { tags: ['PIN'] };
          if (!meta.tags.includes('DMA')) {
            meta.tags.push('DMA');
            await getKv().set(`mcu-meta:${mcu.refName}`, JSON.stringify(meta));
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
  private async attachDmaData(mcu: Mcu): Promise<void> {
    // Find the DMA peripheral's version tag
    const dmaPeripheral = mcu.peripherals.find(p => p.type === 'DMA' || p.originalType === 'DMA');
    if (!dmaPeripheral?.version) return;

    const dmaVersion = dmaPeripheral.version;
    const dmaXml = await getKv().get(`dma-xml:${dmaVersion}`);
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

  private async loadIocData(text: string, fileName: string): Promise<void> {
    const ioc = parseIocFile(text);

    if (!ioc.mcuName) {
      this.showStatus(`No MCU name found in ${fileName}`, 'error');
      return;
    }

    // Load the referenced MCU: local storage → in-memory cache → remote source.
    if (!this.currentMcu || this.currentMcu.refName !== ioc.mcuName) {
      await this.loadStoredMcu(ioc.mcuName);
    }

    if (ioc.assignments.length === 0) {
      this.showStatus(`No pin assignments found in ${fileName}`, 'error');
      return;
    }

    // Build a fresh, self-contained constraints file: mcu/package + one pinned
    // declaration per assignment, GPIO_Label carried through as a comment.
    const lines: string[] = [`# Imported from ${fileName}`, `mcu: ${ioc.mcuName}`];
    if (ioc.mcuPackage) lines.push(`package: ${ioc.mcuPackage}`);
    lines.push('');
    for (const a of ioc.assignments) {
      lines.push(`pin ${a.pinName} = ${a.signalName}${a.label ? `  # ${a.label}` : ''}`);
    }
    this.constraintEditor.setText(lines.join('\n') + '\n');

    this.showStatus(`Imported ${ioc.assignments.length} pins from ${fileName} (${ioc.mcuName})`, 'success');
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

  private async listProjectNames(): Promise<string[]> {
    const keys = await getKv().keysWithPrefix('project:');
    return keys.map(k => k.substring('project:'.length)).sort();
  }

  private async listProjects(): Promise<{ name: string; size: number; tags: string[]; versionCount: number }[]> {
    const names = await this.listProjectNames();
    return Promise.all(names.map(async name => {
      const raw = await getKv().get(`project:${name}`);
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
    }));
  }

  /** Save project by overwriting the latest version (header Save + project list Save) */
  private async saveProject(name: string): Promise<void> {
    const version = this.buildCurrentVersion(0);

    // Load existing project data
    let projectData: ProjectData = { name, versions: [] };
    try {
      const existing = await getKv().get(`project:${name}`);
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
  private async saveProjectAs(): Promise<void> {
    const name = prompt('Project name:', this.currentProjectName || '');
    if (!name?.trim()) return;
    const trimmed = name.trim();

    // Load existing project data (may or may not exist)
    let projectData: ProjectData = { name: trimmed, versions: [] };
    try {
      const existing = await getKv().get(`project:${trimmed}`);
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

  private async persistProject(name: string, projectData: ProjectData, version: ProjectVersion): Promise<void> {
    const json = JSON.stringify(projectData);

    try {
      await getKv().set(`project:${name}`, json);
    } catch {
      // Quota exceeded - try trimming old versions (keep latest 2)
      if (projectData.versions.length > 2) {
        projectData.versions = projectData.versions.slice(-2);
        projectData.versions.forEach((v, i) => v.id = i);
        try {
          await getKv().set(`project:${name}`, JSON.stringify(projectData));
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
        await getKv().set(`project:${name}`, JSON.stringify(liteData));
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

  async loadProject(name: string): Promise<void> {
    const raw = await getKv().get(`project:${name}`);
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

  private async loadProjectVersion(name: string, versionId: number): Promise<void> {
    const raw = await getKv().get(`project:${name}`);
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

  private async applyProjectVersion(name: string, version: ProjectVersion): Promise<void> {
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
        const hasMcuFilter = parseResult?.ast?.statements.some(s => s.type === 'mcu_decl') ?? false;
        solveBtn.disabled = hasErrors || (!this.currentMcu && !hasMcuFilter);
      }
      // MCU + parse are settled now → badge the restored solutions.
      this.updateProjectSolutionValidity();
    }, 400);
    const solCount = version.solutions?.length ?? 0;
    this.showStatus(`Project "${name}" loaded (v${version.id}${solCount > 0 ? `, ${solCount} solutions` : ''})`, 'success');
  }

  async deleteProject(name: string): Promise<void> {
    await getKv().delete(`project:${name}`);
    if (this.currentProjectName === name) {
      this.currentProjectName = null;
      localStorage.removeItem('current-project');
    }
    await this.refreshProjectList();
  }

  private async refreshProjectList(): Promise<void> {
    if (!this.projectSelect) return;
    const projects = await this.listProjectNames();
    this.projectSelect.innerHTML = '<option value="">-- No project --</option>';
    for (const name of projects) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === this.currentProjectName) opt.selected = true;
      this.projectSelect.appendChild(opt);
    }
  }

  // ============================================================
  // Solution editor (modify mode)
  // ============================================================

  /** Recompute per-solution validity badges in the project list vs. current constraints. */
  private updateProjectSolutionValidity(): void {
    const sols = this.projectSolutions.getSolutions();
    const ast = this.constraintEditor.getParseResult()?.ast;
    if (sols.length === 0 || !ast || !this.currentMcu) {
      this.projectSolutions.setValidity(new Map());
      return;
    }
    try {
      this.projectSolutions.setValidity(
        classifyProjectSolutions(sols, ast, this.currentMcu, this.settings.skipGpioMapping));
    } catch (err) {
      console.warn('Solution validity check failed:', err);
      this.projectSolutions.setValidity(new Map());
    }
  }

  /** Flatten a solution and push it to the viewer + peripheral list. Returns compatibility info. */
  private renderSolutionToPanels(solution: Solution): CompatibilityResult | undefined {
    const seen = new Set<string>();
    const assignments = solution.configAssignments.flatMap(ca => ca.assignments).filter(a => {
      const key = `${a.pinName}:${a.signalName}:${a.portName}:${a.channelName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const dmaStreamAssignment = new Map<string, string>();
    for (const ca of solution.configAssignments) {
      if (ca.dmaStreamAssignment) {
        for (const [sig, stream] of ca.dmaStreamAssignment) dmaStreamAssignment.set(sig, stream);
      }
    }
    const portColors = this.getPortColors();
    const channelComments = interpolateAllComments(this.getChannelComments(), assignments);
    const compatibility = this.checkSolutionCompatibility(assignments, solution.mcuRef);
    this.layout.broadcastStateChange({
      type: 'solution-selected', assignments, portColors, channelComments,
      gpioCount: solution.gpioCount,
      dmaStreamAssignment: dmaStreamAssignment.size > 0 ? dmaStreamAssignment : undefined,
      compatibility,
    });
    return compatibility;
  }

  /** Render the modify-mode controls into the package-viewer toolbar. */
  private refreshEditControls(): void {
    const host = this.packageViewer.getEditControlsHost();
    if (!host) return; // viewer not mounted yet
    if (!this.editor) {
      host.innerHTML = this.currentSolution
        ? `<button class="btn btn-small pv-btn" data-act="enter" title="Hand-tune this solution's routing">✎ Modify</button>`
        : '';
      host.querySelector('[data-act="enter"]')?.addEventListener('click', () => this.enterModifyMode());
      return;
    }
    const ed = this.editor;
    const delta = ed.currentCost - ed.baselineCost;
    const cls = delta < -1e-9 ? 'good' : delta > 1e-9 ? 'bad' : 'neutral';
    const sign = delta < -1e-9 ? '' : delta > 1e-9 ? '+' : '±';
    host.innerHTML = `
      <span class="pv-edit-cost">cost ${ed.currentCost.toFixed(1)} <span class="pv-edit-delta ${cls}">${sign}${delta.toFixed(1)}</span></span>
      <button class="btn btn-small pv-btn pv-btn-primary" data-act="save" title="Save edited solution to project">✓ Save</button>
      <button class="btn btn-small pv-btn" data-act="discard" title="Discard edits (Ctrl+Z undoes single steps)">✕ Discard</button>`;
    host.querySelector('[data-act="save"]')?.addEventListener('click', () => this.exitModifyMode(true));
    host.querySelector('[data-act="discard"]')?.addEventListener('click', () => this.exitModifyMode(false));
  }

  private enterModifyMode(): void {
    if (this.editor) return;
    if (!this.currentSolution || !this.currentMcu) {
      this.showStatus('Select a solution first', 'error');
      return;
    }
    const ast = this.constraintEditor.getParseResult()?.ast;
    if (!ast) {
      this.showStatus('Cannot edit: constraints have errors', 'error');
      return;
    }
    const weights = new Map(Object.entries(this.settings.costWeights));
    // Modify mode costs run on the main thread (not the worker), so mirror the
    // squared-distance option here too.
    setSquaredCosts(this.settings.squaredCosts);
    // skipGpioMapping=false so IN/OUT channels are real variables the user can
    // place by hand (the solve may have skipped them; here they're editable).
    const editor = SolutionEditor.fromSolution(this.currentSolution, ast, this.currentMcu, weights, false);
    if (!editor) {
      this.showStatus('Cannot start editor for this solution', 'error');
      return;
    }
    this.editor = editor;
    this.packageViewer.setEditMode(true);
    this.peripheralSummary.setEditMode(true);
    this.refreshEditPreview();
    this.showStatus('Modify mode: click pins, ports, or peripherals to change routing', 'info');
  }

  private exitModifyMode(save: boolean): void {
    const editor = this.editor;
    this.closeEditMenu();
    this.editor = null;
    this.packageViewer.setEditMode(false);
    this.peripheralSummary.setEditMode(false);
    this.layout.broadcastStateChange({ type: 'highlight-pins', highlightPins: new Set() });

    if (save && editor) {
      const edited = editor.toSolution();
      const base = this.currentSolution;
      const suggested = (base?.name ? `${base.name} (edited)` : `Edited ${base?.id ?? ''}`).trim();
      const name = prompt('Save edited solution as:', suggested);
      if (name !== null) {
        edited.name = name.trim() || suggested;
        this.projectSolutions.addSolution(edited);
        this.currentSolution = edited;
        this.projectSolutions.setSolutions(this.projectSolutions.getSolutions());
        this.showStatus(`Saved "${edited.name}" to project`, 'success');
      }
    }
    // Restore the (possibly new) current solution in the panels.
    if (this.currentSolution) this.renderSolutionToPanels(this.currentSolution);
    this.refreshEditControls();
    this.updateProjectSolutionValidity();
  }

  private refreshEditPreview(): void {
    if (!this.editor) return;
    this.renderSolutionToPanels(this.editor.toSolution());
    this.refreshEditControls();
  }

  private closeEditMenu(): void {
    if (!this.editMenu) return;
    this.editMenu.remove();
    this.editMenu = null;
    // Stop the candidate-preview pulse the menu's hover left behind.
    this.layout.broadcastStateChange({ type: 'highlight-pins', highlightPins: new Set() });
  }

  private showEditMenu(x: number, y: number, candidates: EditCandidate[], title: string): void {
    this.closeEditMenu();
    const menu = document.createElement('div');
    menu.className = 'edit-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const head = document.createElement('div');
    head.className = 'edit-menu-title';
    head.textContent = title;
    menu.appendChild(head);

    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'edit-menu-empty';
      empty.textContent = 'No compatible options';
      menu.appendChild(empty);
    }
    for (const cand of candidates.slice(0, 60)) {
      const row = document.createElement('div');
      row.className = 'edit-menu-row';
      const d = cand.costDelta;
      const cls = d < -1e-9 ? 'good' : d > 1e-9 ? 'bad' : 'neutral';
      const sign = d < -1e-9 ? '' : d > 1e-9 ? '+' : '±';
      row.innerHTML = `<span class="edit-menu-label"></span><span class="edit-menu-delta ${cls}">${sign}${d.toFixed(1)}</span>`;
      row.querySelector('.edit-menu-label')!.textContent = cand.label;
      row.addEventListener('mouseenter', () => {
        this.layout.broadcastStateChange({ type: 'highlight-pins', highlightPins: new Set(cand.highlightPins), highlightColor: '#a78bfa' });
      });
      row.addEventListener('click', () => {
        cand.apply();
        this.closeEditMenu();
        this.refreshEditPreview();
      });
      menu.appendChild(row);
    }

    // Leaving the menu stops the preview pulse even while it stays open.
    menu.addEventListener('mouseleave', () => {
      this.layout.broadcastStateChange({ type: 'highlight-pins', highlightPins: new Set() });
    });

    document.body.appendChild(menu);
    // Keep the menu on-screen.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;

    // Close on outside click (next tick so this click doesn't immediately close it).
    setTimeout(() => {
      const onDoc = (ev: MouseEvent) => {
        if (this.editMenu && !this.editMenu.contains(ev.target as Node)) {
          this.closeEditMenu();
          document.removeEventListener('mousedown', onDoc);
        }
      };
      document.addEventListener('mousedown', onDoc);
    }, 0);
    this.editMenu = menu;
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

  private handleCompareSelectionChanged(solutions: Solution[]): void {
    // Only 0 or 1 selected -> nothing to compare; single-select flow
    // (handleSolutionSelected) already handled the render.
    if (solutions.length < 2) return;

    const cmp = compareSolutions(solutions);
    const portColors = this.getPortColors();
    const channelComments = interpolateAllComments(this.getChannelComments(), cmp.common);
    const solutionColors = solutions.map((_, i) => solutionCompareColor(i));
    this.layout.broadcastStateChange({
      type: 'compare-selected',
      solutions,
      solutionColors,
      assignments: cmp.common,
      divergentByPin: cmp.divergent,
      portColors,
      channelComments,
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

  private getChannelComments(): Map<string, string> {
    const comments = new Map<string, string>();
    const ast = parseConstraints(this.constraintEditor.getText()).ast;
    if (ast) {
      for (const stmt of ast.statements) {
        if (stmt.type === 'port_decl') {
          if (stmt.comment) {
            comments.set(stmt.name, stmt.comment);
          }
          for (const ch of stmt.channels) {
            if (ch.comment) {
              comments.set(`${stmt.name}.${ch.name}`, ch.comment);
            }
          }
        } else if (stmt.type === 'pin_decl' && stmt.comment) {
          comments.set(`pin:${stmt.pinName}`, stmt.comment);
        }
      }
    }
    return comments;
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Enter / Cmd+Enter: solve
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.runSolver();
        return;
      }

      // Solution-editor undo/redo (only while editing, and not while typing in a field).
      if (this.editor && (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        const el = e.target as HTMLElement | null;
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (typing) return;
        const redo = e.key === 'y' || e.key === 'Y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z'));
        e.preventDefault();
        if (redo ? this.editor.redo() : this.editor.undo()) this.refreshEditPreview();
        return;
      }

      // Escape: close any open modal
      if (e.key === 'Escape') {
        const overlay = document.querySelector('.settings-overlay, .ce-help-overlay, .docs-overlay, .pv-assign-popup');
        if (overlay) {
          overlay.remove();
          e.preventDefault();
        }
        return;
      }
    });
  }

  private async restoreState(): Promise<void> {
    // Restore current project name
    this.currentProjectName = localStorage.getItem('current-project') || null;
    void this.refreshProjectList();

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
      const raw = await getKv().get(`project:${this.currentProjectName}`);
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
    const result = createModal({ toggle: '.settings-overlay' });
    if (!result) return;
    const { modal, close } = result;

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
            <label title="If the first solver run finds 0 solutions, retry with timeout × this multiplier. Disabled if ≤1.">Dynamic timeout</label>
            <input type="number" class="settings-input" id="set-dynamic-timeout" min="0" max="100" step="1" value="${this.settings.dynamicTimeoutMultiplier}">
          </div>
          <div class="settings-row">
            <label title="Skip pin assignment for IN/OUT (GPIO) channels; only verify enough free pins are available">Skip GPIO mapping</label>
            <input type="checkbox" id="set-skip-gpio" ${this.settings.skipGpioMapping ? 'checked' : ''}>
          </div>
          <div class="settings-row">
            <label title="After solving, greedily relocate single-signal pins to free alternatives that lower total cost (repeats until no move improves)">Post-optimize pins</label>
            <input type="checkbox" id="set-post-optimize" ${this.settings.postOptimize ? 'checked' : ''}>
          </div>
        </section>

        <section class="settings-section">
          <h3>Cost Function Weights</h3>
          <p class="settings-hint">0 = disabled, 1 = normal, 2 = 200% impact</p>
          <div class="settings-row">
            <label title="Sum squared distances in Pin Clustering / Pin Proximity / Pin Anchor, so one far-away pin is punished much harder than several slightly-spread pins">Square distance costs</label>
            <input type="checkbox" id="set-squared-costs" ${this.settings.squaredCosts ? 'checked' : ''}>
          </div>
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
          <button class="btn btn-primary btn-small" id="set-apply">Apply</button>
        </div>
      </div>
    `;

    modal.querySelector('.settings-close')!.addEventListener('click', close);

    modal.querySelector('#solver-select-all')!.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('#set-solver-types input[type=checkbox]').forEach(cb => cb.checked = true);
    });
    modal.querySelector('#solver-select-none')!.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('#set-solver-types input[type=checkbox]').forEach(cb => cb.checked = false);
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
      this.settings.dynamicTimeoutMultiplier = parseInt((modal.querySelector('#set-dynamic-timeout') as HTMLInputElement).value) || 0;
      this.settings.minZoom = parseFloat((modal.querySelector('#set-min-zoom') as HTMLInputElement).value) || DEFAULT_SETTINGS.minZoom;
      this.settings.maxZoom = parseFloat((modal.querySelector('#set-max-zoom') as HTMLInputElement).value) || DEFAULT_SETTINGS.maxZoom;
      this.settings.mouseZoomGain = parseFloat((modal.querySelector('#set-zoom-gain') as HTMLInputElement).value) || DEFAULT_SETTINGS.mouseZoomGain;

      modal.querySelectorAll<HTMLInputElement>('[data-cost-id]').forEach(input => {
        const id = input.dataset.costId!;
        this.settings.costWeights[id] = parseFloat(input.value) || 0;
      });

      this.settings.skipGpioMapping = (modal.querySelector('#set-skip-gpio') as HTMLInputElement).checked;
      this.settings.postOptimize = (modal.querySelector('#set-post-optimize') as HTMLInputElement).checked;
      this.settings.squaredCosts = (modal.querySelector('#set-squared-costs') as HTMLInputElement).checked;
      this.settings.dataInspector = (modal.querySelector('#set-data-inspector') as HTMLInputElement).checked;
      this.settings.solverDebugOverlay = (modal.querySelector('#set-solver-debug') as HTMLInputElement).checked;
      this.settings.urlEncoding = (modal.querySelector('#set-url-encoding') as HTMLSelectElement).value as AppSettings['urlEncoding'];

      this.saveSettings();
      this.updateUrlHash();
      this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);
      close();
      this.showStatus('Settings saved', 'success');
    });

    modal.querySelector('#set-reset-defaults')!.addEventListener('click', () => {
      this.settings = { ...DEFAULT_SETTINGS, costWeights: { ...DEFAULT_SETTINGS.costWeights } };
      this.saveSettings();
      close();
      this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);
      this.showStatus('Settings reset to defaults', 'success');
    });
  }

  private async loadStoredMcu(refName: string): Promise<void> {
    const xml = await getKv().get(`mcu-xml:${refName}`);
    if (!xml) {
      // Not in local storage. Try the in-memory cache (fetched this session),
      // then fall back to the remote data source so projects referencing an
      // MCU the user never imported still open.
      const cached = this.mcuCache.get(refName);
      if (cached) {
        this.activateLoadedMcu(cached);
        return;
      }
      await this.loadRemoteMcu(refName);
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
        mcuInfo.textContent = `${mcu.refName} | ${mcu.package} | ${mcu.cores.join(' + ')} @ ${mcu.frequency}MHz | ${mcu.flash}KB Flash | ${mcu.ram}KB RAM`;
      }

      this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu });

      const solveBtn = this.constraintEditor.getSolveButton();
      if (solveBtn) {
        const parseResult = this.constraintEditor.getParseResult();
        (solveBtn as HTMLButtonElement).disabled = !parseResult || parseResult.errors.length > 0;
      }

      const dmaInfo = mcu.dma ? ` (+DMA)` : '';
      this.showStatus(`Loaded ${mcu.refName} from storage${dmaInfo}`, 'success');
      this.updateProjectSolutionValidity();
    } catch (err) {
      this.showStatus(`Failed to parse stored MCU "${refName}": ${err}`, 'error');
    }
  }

  /**
   * Fallback loader: fetch an MCU variant from the configured remote data
   * source when it is not in local storage. Remote JSON MCUs carry their own
   * DMA data, so they route straight through activateLoadedMcu (no separate
   * dma-xml attach). The result is memory-cached by activateLoadedMcu.
   */
  private async loadRemoteMcu(refName: string): Promise<void> {
    const ds = getDataSource();
    if (!ds.baseUrl()) {
      this.showStatus(`MCU "${refName}" is not in local storage and no data source is configured`, 'error');
      return;
    }
    const controller = new AbortController();
    this.showStatus(`Fetching ${refName} from data source…`, 'info');
    try {
      const mcu = await ds.loadVariant(refName, controller.signal);
      if (!mcu) {
        this.showStatus(`MCU "${refName}" not found in local storage or the data source`, 'error');
        return;
      }
      this.activateLoadedMcu(mcu);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      this.showStatus(`Failed to fetch "${refName}" from the data source: ${err}`, 'error');
    }
  }

  private async listStoredMcus(): Promise<{ refName: string; size: number; tags: string[] }[]> {
    const kv = getKv();
    const xmlKeys = await kv.keysWithPrefix('mcu-xml:');
    return Promise.all(xmlKeys.map(async key => {
      const refName = key.substring('mcu-xml:'.length);
      const xml = await kv.get(key);
      const size = xml ? xml.length : 0;
      let tags: string[] = [];
      try {
        const meta = await kv.get(`mcu-meta:${refName}`);
        if (meta) tags = JSON.parse(meta).tags ?? [];
      } catch { /* ignore */ }
      return { refName, size, tags };
    })).then(list => list.sort((a, b) => a.refName.localeCompare(b.refName)));
  }

  private showDataManager(): void {
    const result = createModal({ toggle: '.settings-overlay', modalClass: 'settings-modal dm-modal' });
    if (!result) return;
    const { modal, close } = result;

    const renderContent = async (): Promise<void> => {
      const storedMcus = await this.listStoredMcus();
      const projects = await this.listProjects();
      const customExports = await loadCustomExports();

      // Storage usage from IDB (gigabytes-scale) replaces the old
      // ~5 MB localStorage budget. The estimate is best-effort.
      const usage = await getKv().estimate();
      const usedKB = usage ? (usage.usedBytes / 1024).toFixed(0) : '?';
      const limitKB = usage && usage.quotaBytes > 0 ? (usage.quotaBytes / 1024).toFixed(0) : '?';

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
            <h3>Remote Data Source</h3>
            <p class="settings-hint">Optional. JSON catalogue served over HTTP (e.g. a GitHub Pages / raw URL pointing at the <code>data/</code> directory of an mcu_data export). Local <code>file://</code> paths work for development.</p>
            <div class="dm-row" style="gap:6px">
              <input id="dm-data-url" type="text" placeholder="https://example.com/path/to/data" value="${(getDataSource().baseUrl() ?? '').replace(/"/g, '&quot;')}" style="flex:1; padding:4px 6px; font-family:monospace; font-size:12px"/>
              <button class="btn btn-small" data-action="save-data-url">Save</button>
              <button class="btn btn-small" data-action="clear-data-url">Clear</button>
              <button class="btn btn-small" data-action="browse-mcu" title="Search the remote catalogue and load an MCU by name" ${getDataSource().baseUrl() ? '' : 'disabled'}>Browse&hellip;</button>
            </div>
            <p class="settings-hint" style="margin-top:6px">${(() => {
              const s = getDataSource().stats();
              const url = getDataSource().baseUrl();
              if (!url) return 'No URL configured.';
              return `Index ${s.hasIndex ? 'loaded' : 'not loaded yet'} &middot; cache ${s.entries} dies / ${(s.bytes / 1024).toFixed(1)} KB`;
            })()}</p>
          </section>

          <section class="settings-section">
            <h3>Cached MCUs <span class="settings-hint" style="font-weight:normal;font-size:11px;">(in-memory · cleared on reload)</span></h3>
            ${(() => {
              const cached = getDataSource().listCached();
              if (cached.length === 0) return '<p class="settings-hint">No remote MCUs fetched yet. Use Browse… or run a solve with an <code>mcu:</code> filter.</p>';
              const totalKB = cached.reduce((s, c) => s + c.bytes, 0) / 1024;
              const variantCount = cached.reduce((s, c) => s + c.mcus.length, 0);
              const rows: string[] = [];
              for (const { die, mcus, bytes } of cached) {
                // Each die may expand to multiple package variants; render
                // one row per variant so the layout matches Stored MCUs.
                // Distribute the die's byte cost evenly across variants for
                // a rough per-row size hint.
                const perVariantBytes = Math.round(bytes / Math.max(1, mcus.length));
                for (const mcu of mcus) {
                  const tags: string[] = ['REMOTE', 'PIN'];
                  if (mcu.dma) tags.push('DMA');
                  if (mcu.package) tags.push(mcu.package);
                  rows.push(`
                    <div class="dm-row" data-cached="${escHtml(mcu.refName)}">
                      <span class="dm-name">${escHtml(mcu.refName)}</span>
                      <span class="dm-tags">${tags.map(t => `<span class="dm-tag">${escHtml(t)}</span>`).join('')}</span>
                      <span class="dm-size">${(perVariantBytes / 1024).toFixed(1)}KB</span>
                      <button class="btn btn-small dm-load" data-action="load-cached" data-name="${escHtml(mcu.refName)}">Load</button>
                      <button class="btn btn-small dm-delete" data-action="evict-cached" data-die="${escHtml(die)}">Discard</button>
                    </div>
                  `);
                }
              }
              return `
                <p class="settings-hint">${variantCount} variant${variantCount === 1 ? '' : 's'} from ${cached.length} die${cached.length === 1 ? '' : 's'} · ${totalKB.toFixed(1)}KB total</p>
                <div class="dm-list">${rows.join('')}</div>
              `;
            })()}
          </section>

          <section class="settings-section">
            <h3>Stored MCUs</h3>
            ${storedMcus.length === 0 ? '<p class="settings-hint">No MCUs stored. Import XML files to store them.</p>' : `<div style="margin-bottom:6px"><button class="btn btn-small" data-action="reimport-all">Re-import All</button></div>`}
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
                if (customExports.length === 0) return '<p class="settings-hint">No custom export functions. Click "New" to create one.</p>';
                return customExports.map(fn => `
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

          <section class="settings-section">
            <h3>Common-error Lint Library</h3>
            <p class="settings-hint">Groups of signal names that are commonly swapped by mistake (miso/mosi, tx/rx, …). One group per line, tokens space-separated. Warns when a channel name and its signal pattern reference different tokens from the same group.</p>
            <div style="margin-top:6px">
              <button class="btn btn-small" data-action="edit-lint-lib">Edit</button>
              <button class="btn btn-small" data-action="reset-lint-lib">Reset to Default</button>
            </div>
          </section>

          <section class="settings-section">
            <h3>Peripheral Library</h3>
            <p class="settings-hint">Snippets offered by the editor's double-click helper. Each <code>#Name</code> block lists channel mappings and <code>require</code> lines for a peripheral.</p>
            <div style="margin-top:6px">
              <button class="btn btn-small" data-action="edit-peripheral-lib">Edit</button>
              <button class="btn btn-small" data-action="reset-peripheral-lib">Reset to Default</button>
            </div>
          </section>
        </div>
      `;

      modal.querySelector('.settings-close')!.addEventListener('click', close);

      modal.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = (btn as HTMLElement).dataset.action;
          const name = (btn as HTMLElement).dataset.name!;
          switch (action) {
            case 'load-mcu':
              await this.loadStoredMcu(name);
              close();
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
              await getKv().delete(`mcu-xml:${name}`);
              await getKv().delete(`mcu-meta:${name}`);
              void renderContent();
              break;
            case 'reimport-all':
              this.reimportAllMcus();
              void renderContent();
              break;
            case 'load-project':
              this.loadProject(name);
              close();
              break;
            case 'export-project':
              this.exportProjectData(name);
              break;
            case 'delete-project':
              this.deleteProject(name);
              void renderContent();
              break;
            case 'toggle-versions': {
              const idx = (btn as HTMLElement).dataset.idx;
              const versionList = modal.querySelector(`[data-version-list="${idx}"]`) as HTMLElement;
              if (!versionList) break;
              const arrow = btn as HTMLElement;
              if (versionList.style.display === 'none') {
                arrow.innerHTML = '&#9660;';
                this.renderVersionList(versionList, name, result.overlay, renderContent);
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
              close();
              break;
            }
            case 'new-export':
              this.showExportEditor(null, result.overlay, renderContent);
              break;
            case 'edit-export': {
              const exportId = (btn as HTMLElement).dataset.exportId!;
              const exports = await loadCustomExports();
              const fn = exports.find(e => e.id === exportId);
              if (fn) this.showExportEditor(fn, result.overlay, () => { void renderContent(); });
              break;
            }
            case 'delete-export': {
              const exportId = (btn as HTMLElement).dataset.exportId!;
              await deleteCustomExport(exportId);
              void renderContent();
              break;
            }
            case 'edit-macro-lib':
              this.showMacroLibEditor(result.overlay);
              break;
            case 'reset-macro-lib':
              await saveMacroLibrary(DEFAULT_MACRO_LIBRARY.trim());
              await primeStdlibSource();
              break;
            case 'edit-lint-lib':
              this.showLintLibEditor();
              break;
            case 'reset-lint-lib':
              await saveCommonErrorsLibrary(DEFAULT_COMMON_ERRORS_LIBRARY.trim());
              primeCommonErrorsLib(DEFAULT_COMMON_ERRORS_LIBRARY.trim());
              this.showStatus('Lint library reset to default', 'success');
              break;
            case 'edit-peripheral-lib':
              this.showPeripheralLibEditor();
              break;
            case 'reset-peripheral-lib':
              await savePeripheralLibrary(DEFAULT_PERIPHERAL_LIBRARY.trim());
              await primePeripheralSource();
              this.showStatus('Peripheral library reset to default', 'success');
              break;
            case 'save-data-url': {
              const input = modal.querySelector('#dm-data-url') as HTMLInputElement | null;
              if (input) {
                getDataSource().setUrl(input.value);
                this.showStatus(input.value ? `Data URL saved: ${input.value}` : 'Data URL cleared', 'success');
                void renderContent();
              }
              break;
            }
            case 'clear-data-url':
              getDataSource().setUrl('');
              void renderContent();
              break;
            case 'browse-mcu':
              this.showMcuBrowser(result.overlay, () => { void renderContent(); });
              break;
            case 'load-cached': {
              // Walk the cache to find the variant. Cheaper than tracking
              // a separate refName→Mcu map since the cache is bounded (~10).
              for (const { mcus } of getDataSource().listCached()) {
                const hit = mcus.find(m => m.refName === name);
                if (hit) {
                  this.activateLoadedMcu(hit);
                  close();
                  return;
                }
              }
              this.showStatus(`Cached MCU "${name}" not found (cache may have evicted)`, 'error');
              break;
            }
            case 'evict-cached': {
              const die = (btn as HTMLElement).dataset.die!;
              if (getDataSource().evict(die)) void renderContent();
              break;
            }
          }
        });
      });
    };

    void renderContent();
  }

  /**
   * Modal that lists every die in the remote index with a live filter.
   * Click a die to fetch + parse it, then pick a package variant if the
   * die has more than one. Loaded MCU becomes the current MCU.
   */
  private showMcuBrowser(_parentOverlay: HTMLElement, onClose: () => void): void {
    const browser = createModal({
      zIndex: '1100',
      modalClass: 'settings-modal dm-modal',
      modalStyle: { width: '720px', maxHeight: '80vh' },
    });
    if (!browser) return;
    const { modal, close } = browser;

    // Cancellation: closing the modal aborts any in-flight fetch.
    const ac = new AbortController();
    const closeAll = () => {
      ac.abort();
      close();
      onClose();
    };

    let dies: { die: string; entry: IndexDeviceEntry }[] = [];
    let filter = '';
    let status = 'Loading index…';

    const renderRows = (): string => {
      const q = filter.trim().toLowerCase();
      // Match the query against the die name OR any full variant name, so users
      // can search by full CPU name (e.g. "stm32h755iik").
      const matches = q
        ? dies.filter(d => d.die.includes(q)
            || entryVariantNames(d.entry).some(v => v.toLowerCase().includes(q)))
        : dies;
      const visible = matches.slice(0, 200);
      const overflow = matches.length - visible.length;
      if (visible.length === 0) {
        return '<p class="settings-hint">No matching MCUs.</p>';
      }
      const rowsHtml = visible.map(({ die, entry }) => {
        const cores = (entry.cores ?? []).map(c => c.name).join(' + ');
        const flashKB = entry.flash_bytes ? `${(entry.flash_bytes / 1024).toFixed(0)}KB` : '';
        const ramKB = entry.ram_bytes ? `${(entry.ram_bytes / 1024).toFixed(0)}KB` : '';
        const pkgs = [...new Set(entryPackageNames(entry))].slice(0, 3).join(', ');
        return `
          <div class="dm-row" data-die="${escHtml(die)}">
            <span class="dm-name" style="font-family:monospace">${escHtml(die)}</span>
            <span class="dm-tags"><span class="dm-tag">${escHtml(entry.family ?? '')}</span>${cores ? `<span class="dm-tag">${escHtml(cores)}</span>` : ''}${flashKB ? `<span class="dm-tag">${flashKB} flash</span>` : ''}${ramKB ? `<span class="dm-tag">${ramKB} ram</span>` : ''}</span>
            <span class="dm-size" style="min-width:auto">${escHtml(pkgs)}</span>
            <button class="btn btn-small dm-load" data-action="pick-die" data-die="${escHtml(die)}">Load</button>
          </div>
        `;
      }).join('');
      return rowsHtml + (overflow > 0
        ? `<p class="settings-hint">…and ${overflow} more (refine search to see them).</p>`
        : '');
    };

    const render = (): void => {
      modal.innerHTML = `
        <div class="settings-header">
          <strong>Browse MCU Catalogue</strong>
          <button class="btn btn-small settings-close">Close</button>
        </div>
        <div class="settings-body">
          <div class="dm-row" style="margin-bottom:8px">
            <input id="dm-mcu-filter" type="text" placeholder="Filter (e.g. stm32g4, stm32h755iik, STM32H755IIKx)" value="${escHtml(filter)}" style="flex:1; padding:4px 6px; font-family:monospace; font-size:12px"/>
            <span class="dm-size" style="min-width:auto;color:var(--text-secondary)">${dies.length} dies</span>
          </div>
          <p class="settings-hint" id="dm-mcu-status">${escHtml(status)}</p>
          <div class="dm-list" id="dm-mcu-rows">${dies.length ? renderRows() : ''}</div>
        </div>
      `;

      modal.querySelector('.settings-close')!.addEventListener('click', closeAll);

      const filterInput = modal.querySelector('#dm-mcu-filter') as HTMLInputElement | null;
      if (filterInput) {
        filterInput.addEventListener('input', () => {
          filter = filterInput.value;
          const rows = modal.querySelector('#dm-mcu-rows');
          if (rows) rows.innerHTML = renderRows();
          attachRowHandlers();
        });
        filterInput.focus();
      }

      attachRowHandlers();
    };

    const attachRowHandlers = (): void => {
      modal.querySelectorAll('[data-action="pick-die"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const die = (btn as HTMLElement).dataset.die!;
          await this.handlePickDie(die, ac.signal, closeAll);
        });
      });
    };

    render();

    // Kick off index load asynchronously.
    getDataSource().loadIndex(ac.signal)
      .then(idx => {
        dies = Object.entries(idx.devices ?? {})
          .map(([die, entry]) => ({ die, entry }))
          .sort((a, b) => a.die.localeCompare(b.die));
        status = `Loaded ${dies.length} dies. Type to filter.`;
        render();
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        status = `Failed to load index: ${err.message}`;
        render();
      });
  }

  /**
   * After the user picks a die in the browser modal: fetch + parse, then
   * either load directly (single variant) or open a small variant picker.
   */
  private async handlePickDie(die: string, signal: AbortSignal, closeBrowser: () => void): Promise<void> {
    try {
      this.showStatus(`Loading ${die}…`, 'info');
      const mcus = await getDataSource().loadDie(die, signal);
      if (mcus.length === 0) {
        this.showStatus(`No package variants in ${die}`, 'error');
        return;
      }
      if (mcus.length === 1) {
        this.activateLoadedMcu(mcus[0]);
        closeBrowser();
        return;
      }
      this.showVariantPicker(die, mcus, closeBrowser);
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as Error).name === 'AbortError') return;
      this.showStatus(`Failed to load ${die}: ${msg}`, 'error');
    }
  }

  /** Tiny modal listing every variant of a die so the user can pick one. */
  private showVariantPicker(die: string, mcus: Mcu[], closeBrowser: () => void): void {
    const picker = createModal({
      zIndex: '1200',
      modalClass: 'settings-modal',
      modalStyle: { width: '500px' },
    });
    if (!picker) return;
    const { modal, close } = picker;
    modal.innerHTML = `
      <div class="settings-header">
        <strong>Pick a package variant for ${escHtml(die)}</strong>
        <button class="btn btn-small settings-close">Close</button>
      </div>
      <div class="settings-body">
        <div class="dm-list">
          ${mcus.map((m, idx) => `
            <div class="dm-row">
              <span class="dm-name" style="font-family:monospace">${escHtml(m.refName)}</span>
              <span class="dm-tags"><span class="dm-tag">${escHtml(m.package)}</span></span>
              <button class="btn btn-small dm-load" data-pick="${idx}">Load</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    modal.querySelector('.settings-close')!.addEventListener('click', close);
    modal.querySelectorAll('[data-pick]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.pick || '0', 10);
        this.activateLoadedMcu(mcus[idx]);
        close();
        closeBrowser();
      });
    });
  }

  private showExportEditor(fn: CustomExportFunction | null, _parentOverlay: HTMLElement, onSave: () => void): void {
    const isNew = fn === null;
    const current: CustomExportFunction = fn ? { ...fn } : {
      id: `custom-${Date.now()}`,
      name: '',
      description: '',
      code: '',
    };

    const exportResult = createModal({ zIndex: '1100', modalStyle: { width: '600px' } });
    if (!exportResult) return;
    const { modal, close: closeExport } = exportResult;

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
              channelName, configurationName,
              portComment, channelComment, pinComment}
peripherals - Array of {instanceName, type, version}
pins        - Array of {name, position, type, gpioPort,
              gpioNumber, isAssignable, signals:[{name,
              peripheralInstance, peripheralType,
              signalFunction}]}
ports       - Array of {name, color, comment,
              channels:[{name, comment}],
              configurations:[]}
pinComments - Object {pinName: comment} from pin decls</pre>
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

      modal.querySelector('.settings-close')!.addEventListener('click', closeExport);

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
          new Function('mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', code);
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

      modal.querySelector('#export-editor-save')!.addEventListener('click', async () => {
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
        await saveCustomExport(current);
        closeExport();
        onSave();
      });
    };

    render();
  }

  private showMacroLibEditor(_parentOverlay: HTMLElement): void {
    const macroResult = createModal({ zIndex: '1100', modalStyle: { width: '600px', maxHeight: '85vh' } });
    if (!macroResult) return;
    const { modal, close: closeMacro } = macroResult;

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
      highlightEl.innerHTML = highlightConstraintCode(codeEl.value) + '\n';
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

    modal.querySelector('.settings-close')!.addEventListener('click', closeMacro);

    modal.querySelector('#macro-lib-reset')!.addEventListener('click', () => {
      codeEl.value = DEFAULT_MACRO_LIBRARY.trim();
      syncHighlight();
      syncLineNumbers();
    });

    modal.querySelector('#macro-lib-save')!.addEventListener('click', async () => {
      const source = codeEl.value;
      // Validate syntax
      const result = parseConstraints(source);
      if (result.errors.length > 0) {
        errorEl.style.display = '';
        errorEl.style.color = 'var(--error)';
        errorEl.textContent = result.errors.map(e => `Line ${e.line}: ${e.message}`).join('; ');
        return;
      }
      await saveMacroLibrary(source);
      await primeStdlibSource();
      closeMacro();
    });
  }

  private async showLintLibEditor(): Promise<void> {
    // ponytail: plain textarea, no syntax highlight. Line-based format
    // needs zero editor tooling.
    const r = createModal({ zIndex: '1100', modalStyle: { width: '600px', maxHeight: '85vh' } });
    if (!r) return;
    const { modal, close } = r;
    const current = (await loadCommonErrorsLibrary()) ?? DEFAULT_COMMON_ERRORS_LIBRARY.trim();
    modal.innerHTML = `
      <div class="settings-header">
        <strong>Common-error Lint Library</strong>
        <div style="display:flex;gap:6px">
          <button class="btn btn-small" id="lint-lib-reset">Reset</button>
          <button class="btn btn-small settings-close">Close</button>
        </div>
      </div>
      <div class="settings-body" style="display:flex;flex-direction:column;gap:8px;min-height:0;flex:1;overflow:hidden">
        <textarea id="lint-lib-code" spellcheck="false" style="flex:1;min-height:200px;font-family:monospace;font-size:12px;padding:6px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:3px">${current.replace(/</g, '&lt;')}</textarea>
        <div style="display:flex;gap:6px;justify-content:flex-end;flex-shrink:0">
          <button class="btn btn-small btn-primary" id="lint-lib-save">Save</button>
        </div>
      </div>
    `;
    const codeEl = modal.querySelector('#lint-lib-code') as HTMLTextAreaElement;
    modal.querySelector('.settings-close')!.addEventListener('click', close);
    modal.querySelector('#lint-lib-reset')!.addEventListener('click', () => {
      codeEl.value = DEFAULT_COMMON_ERRORS_LIBRARY.trim();
    });
    modal.querySelector('#lint-lib-save')!.addEventListener('click', async () => {
      const source = codeEl.value;
      await saveCommonErrorsLibrary(source);
      primeCommonErrorsLib(source);
      this.showStatus('Lint library saved', 'success');
      close();
    });
  }

  private async showPeripheralLibEditor(): Promise<void> {
    // Plain textarea — the #Name/body format needs no constraint tooling.
    const r = createModal({ zIndex: '1100', modalStyle: { width: '600px', maxHeight: '85vh' } });
    if (!r) return;
    const { modal, close } = r;
    const current = getPeripheralSource();
    modal.innerHTML = `
      <div class="settings-header">
        <strong>Peripheral Library</strong>
        <div style="display:flex;gap:6px">
          <button class="btn btn-small" id="peri-lib-reset">Reset</button>
          <button class="btn btn-small settings-close">Close</button>
        </div>
      </div>
      <div class="settings-body" style="display:flex;flex-direction:column;gap:8px;min-height:0;flex:1;overflow:hidden">
        <p class="settings-hint" style="margin:0">One block per peripheral: a <code>#Name</code> header, then channel mappings (<code>TX = USART*_TX $u</code>) and <code>require</code> lines.</p>
        <textarea id="peri-lib-code" spellcheck="false" style="flex:1;min-height:200px;font-family:monospace;font-size:12px;padding:6px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:3px">${current.replace(/</g, '&lt;')}</textarea>
        <div style="display:flex;gap:6px;justify-content:flex-end;flex-shrink:0">
          <button class="btn btn-small btn-primary" id="peri-lib-save">Save</button>
        </div>
      </div>
    `;
    const codeEl = modal.querySelector('#peri-lib-code') as HTMLTextAreaElement;
    modal.querySelector('.settings-close')!.addEventListener('click', close);
    modal.querySelector('#peri-lib-reset')!.addEventListener('click', () => {
      codeEl.value = DEFAULT_PERIPHERAL_LIBRARY.trim();
    });
    modal.querySelector('#peri-lib-save')!.addEventListener('click', async () => {
      await savePeripheralLibrary(codeEl.value);
      await primePeripheralSource();
      this.showStatus('Peripheral library saved', 'success');
      close();
    });
  }


  private async renderVersionList(container: HTMLElement, projectName: string, overlay: HTMLElement, renderContent: () => void): Promise<void> {
    try {
      const raw = await getKv().get(`project:${projectName}`);
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
        btn.addEventListener('click', async () => {
          const action = (btn as HTMLElement).dataset.action;
          const vId = parseInt((btn as HTMLElement).dataset.versionId || '0');
          if (action === 'restore-version') {
            await this.loadProjectVersion(projectName, vId);
            overlay.remove();
          } else if (action === 'delete-version') {
            await this.deleteProjectVersion(projectName, vId);
            const names = await this.listProjectNames();
            if (names.includes(projectName)) {
              await this.renderVersionList(container, projectName, overlay, renderContent);
            } else {
              void renderContent();
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

  private async deleteProjectVersion(projectName: string, versionId: number): Promise<void> {
    const raw = await getKv().get(`project:${projectName}`);
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
      await getKv().set(`project:${projectName}`, JSON.stringify(projectData));
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

  private async exportMcuData(refName: string): Promise<void> {
    const mcuXml = await getKv().get(`mcu-xml:${refName}`);
    if (!mcuXml) return;

    const metaStr = await getKv().get(`mcu-meta:${refName}`);
    const meta = metaStr ? JSON.parse(metaStr) : null;

    // Find associated DMA XML by extracting the DMA version from MCU XML
    let dmaXml: string | null = null;
    let dmaVersion: string | null = null;
    const dmaMatch = mcuXml.match(/Name="DMA"\s+Version="([^"]+)"/);
    if (dmaMatch) {
      dmaVersion = dmaMatch[1];
      dmaXml = await getKv().get(`dma-xml:${dmaVersion}`);
    }

    const exportData: Record<string, unknown> = { refName, mcuXml };
    if (meta) exportData.meta = meta;
    if (dmaVersion) exportData.dmaVersion = dmaVersion;
    if (dmaXml) exportData.dmaXml = dmaXml;

    this.downloadJson(exportData, `${refName}.json`);
  }

  private async exportProjectData(projectName: string): Promise<void> {
    const raw = await getKv().get(`project:${projectName}`);
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
      const pin = mcu.logicalPinByName.get(a.pinName);
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
    cores: mcu.cores,
    frequency: mcu.frequency,
    flash: mcu.flash,
    ram: mcu.ram,
    ccmRam: mcu.ccmRam,
    ioCount: mcu.ioCount,
    voltage: mcu.voltage,
    temperature: mcu.temperature,
    hasPowerPad: mcu.hasPowerPad,
    peripherals: mcu.peripherals,
    logicalPins: mcu.logicalPins.map(lp => ({
      name: lp.name,
      type: lp.type,
      signals: lp.signals,
      gpioPort: lp.gpioPort,
      gpioNumber: lp.gpioNumber,
      isAssignable: lp.isAssignable,
      isDefaultVariant: lp.isDefaultVariant,
      variantGroup: lp.variantGroup,
      position: lp.physical.position,
    })),
    physicalPins: mcu.physicalPins.map(pp => ({
      position: pp.position,
      logicals: pp.logicals.map(l => l.name),
    })),
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
