import { LayoutManager } from './core/layout-manager';
import { HorizontalSplitter, VerticalSplitter } from './core/splitter';
import { PackageViewer } from './ui/package-viewer';
import { ConstraintEditor } from './ui/constraint-editor';
import { buildPortColorMap } from './ui/port-colors';
import { SolverSolutions } from './ui/solution-table';
import { ProjectSolutions } from './ui/project-solutions';
import { compareSolutions, solutionCompareColor } from './solution-compare';
import { PeripheralSummary } from './ui/peripheral-summary';
import { parseMcuXml, validateMcu } from './parser/mcu-xml-parser';
import { getDataSource, entryPackageNames, entryVariantNames } from './datasource';
import { parseDmaXml, isDmaXml, getDmaXmlVersion } from './parser/dma-xml-parser';
import { isIocFile, parseIocFile } from './parser/ioc-parser';
import { getAllCostFunctions, setSquaredCosts } from './solver/cost-functions';
import { type AppSettings, DEFAULT_SETTINGS, applySettingsOverrides, formatSettingsBlock, upsertSettingsBlock } from './settings';
import { getSolvers } from './solver/solver-registry';
import { SolutionEditor, type EditCandidate } from './solver/solution-editor';
import { renderMarkdown } from './ui/markdown';
import docMd from '../doc.md?raw';
import { classifyProjectSolutions, type SolutionVerdict } from './solver/solution-status';
import type { Mcu, Assignment, Solution, SolverResult, SolverError, DmaData, CompatibilityResult } from './types';
import type { ProgramNode } from './parser/constraint-ast';
import { parseConstraints } from './parser/constraint-parser';
import { serializeSolution, deserializeSolution, migrateProjectData, isExportedProject, mergeImportedVersions, syncDefaults, type PendingUpdate, loadCommonErrorsLibrary, saveCommonErrorsLibrary } from './storage';
import { DEFAULT_COMMON_ERRORS_LIBRARY } from './parser/lint-common-errors';
import { primeCommonErrorsLib } from './solver/solver';
import { getKv, migrateLocalStorageToIdb } from './kv';
import type { ProjectData, ProjectVersion, SerializedSolution } from './storage';
import { mergeResults, type LabeledSolverResult } from './solver/result-merger';
import { fromWire, type WireSolverResult } from './solver/solution-transfer';
import { runPreSolveChecks, constraintsNeedDma } from './solver/solver';
import { interpolateAllComments } from './solver/comment-interpolation';
import { SolverDebugOverlay } from './ui/solver-debug-overlay';
import { analyzeSolverInputs, formatSolverSummary, type SolverDiagnosticsReport } from './solver/diagnostics';
import { filterStoredMcus, extractMcuFilters, matchesPatterns, matchesMcuFilters, writeMcuMeta, type McuFilters } from './mcu-matcher';
import { startTutorial, shouldShowTutorial } from '../ts_lib/src/tutorial';
import { initTheme, cycleThemeMode, getThemeMode, themeModeLabel, onThemeChange } from '../ts_lib/src/theme';
import { seedMacroLibrary, primeStdlibSource } from './parser/stdlib-macros';
import { seedPeripheralLibrary, primePeripheralSource } from './parser/peripheral-lib';

import { escapeHtml as escHtml, createModal, downloadBlob, mcuInfoLine } from './utils';
import { PARSE_DEBOUNCE_MS } from './ui/constraint-editor';
import { getTutorialSteps } from './ui/tutorial-steps';
import { DataManager, type DataManagerHost } from './ui/data-manager';


/** Blank result used to clear the solver panel on project switch / new. */
function emptySolverResult(): SolverResult {
  return {
    mcuRef: '', solutions: [], errors: [],
    statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
  };
}

/** Inputs of one solve run, snapshotted at start (see startSolve). */
interface SolveRunContext {
  gen: number;
  ast: ProgramNode;
  mcuList: Mcu[];
  solverTypes: string[];
}

interface UrlState {
  v: 1;
  c: string;
  m?: string;
  sol?: SerializedSolution;
}

export class App implements DataManagerHost {
  private layout!: LayoutManager;
  private packageViewer!: PackageViewer;
  constraintEditor!: ConstraintEditor;
  solverSolutions!: SolverSolutions;
  private projectSolutions!: ProjectSolutions;
  private peripheralSummary!: PeripheralSummary;
  currentMcu: Mcu | null = null;
  settings: AppSettings = this.loadSettings();
  /**
   * Settings for the run in progress: `this.settings` with any `settings:`
   * block from the constraints folded in. Reset at the start of every solve.
   */
  private solveSettings: AppSettings = this.settings;
  /** In-flight remote DMA lookup (see ensureDmaData), so Abort can cancel it. */
  private dmaFetchAbort: AbortController | null = null;
  /** refName → DMA data fetched remotely this session, to avoid refetching. */
  private remoteDmaCache = new Map<string, DmaData>();
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
  currentProjectName: string | null = null;
  /** Cache of parsed MCU objects for multi-MCU solving */
  private mcuCache = new Map<string, Mcu>();
  /** MCU refNames involved in the current solver result (for multi-MCU mode) */
  private multiMcuRefs: string[] = [];
  /**
   * Monotonic solve-run token. Bumped on every run start and every cancel
   * (abort, project switch); async continuations and worker callbacks compare
   * their captured value against it and drop stale work instead of publishing
   * results into a state that has moved on.
   */
  private solveGen = 0;
  /**
   * Per-worker results collected as they arrive during the current run.
   * On user abort, whatever completed solvers already produced is finalized
   * and shown instead of being thrown away with the killed workers.
   */
  private runHarvest: LabeledSolverResult[] = [];
  /** Snapshot context of the current run, for finalizing a harvest on abort. */
  private runCtx: SolveRunContext | null = null;
  /** True from solve start until completion/cancel — closes the re-entrancy
   *  window in the async gaps before any worker or AbortController exists. */
  private solveInFlight = false;
  /** Monotonic MCU-load token: a late loadStoredMcu/loadRemoteMcu completion
   *  must not clobber a newer MCU selection. */
  private mcuLoadSeq = 0;
  private projectSelect!: HTMLSelectElement;
  /** Data Manager modal — talks back to the app through the host interface. */
  private dataManager = new DataManager(this);

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
    this.constraintEditor.onHighlightPins((pins, color, style) => {
      this.layout.broadcastStateChange({
        type: 'highlight-pins', highlightPins: pins, highlightColor: color, highlightStyle: style,
      });
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
    this.packageViewer.setGestureMode(this.settings.touchGestures);

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
      this.restoreState().catch(err => {
        console.error('State restore failed:', err);
        this.showStatus('Failed to restore previous session state', 'error');
      });
      void this.refreshDefaultUpdates();
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
        steps: getTutorialSteps(),
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

      // Switch MCU if the solution is from a different MCU (multi-MCU mode).
      if (solution.mcuRef && (!this.currentMcu || this.currentMcu.refName !== solution.mcuRef)) {
        const cachedMcu = this.mcuCache.get(solution.mcuRef);
        if (cachedMcu) {
          this.currentMcu = cachedMcu;
          this.setMcuHeader(cachedMcu);
          this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu: cachedMcu });
        } else {
          // The cache only holds MCUs fetched during a multi-MCU solve, so it is
          // empty after a reload. Fall back to storage (then the remote source)
          // and re-render once it lands, otherwise clicking a saved solution
          // from another MCU did nothing at all.
          this.loadStoredMcu(solution.mcuRef).then(() => {
            if (this.currentSolution === solution) this.renderSolutionToPanels(solution);
          }).catch(err => console.error(`Failed to load MCU ${solution.mcuRef}:`, err));
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

      this.updateSolveButtonEnabled();

      // Show pin declarations on viewer immediately (before solving)
      this.showPinPreview(result.ast);
      // (validity badges already refreshed above, before the loading guard)
    });

    // Pin assignment popup -> constraint editor
    this.packageViewer.setConstraintsSource(() => this.constraintEditor.getText());
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
    if (this.solveInFlight || this.solverWorkers.length > 0 || this.fetchAbort || this.dmaFetchAbort) {
      this.abortSolver();
      return;
    }
    this.solveInFlight = true;
    const gen = ++this.solveGen;
    try {
      await this.startSolve(gen);
    } finally {
      // Bail-outs before worker dispatch end the run here; once workers are
      // running, onAllSolversComplete / cancelActiveSolve own the flag.
      if (gen === this.solveGen && this.solverWorkers.length === 0) this.solveInFlight = false;
    }
  }

  private async startSolve(gen: number): Promise<void> {
    this.currentSolution = null;

    const parseResult = this.constraintEditor.getParseResult();
    if (!parseResult?.ast) {
      this.showStatus('Fix constraint errors before solving', 'error');
      return;
    }

    // A `settings:` block in the constraints overrides solver settings for
    // this run only (the user's saved settings are untouched).
    const overrides = applySettingsOverrides(
      parseResult.ast, this.settings, new Set(getAllCostFunctions().map(f => f.id)),
    );
    this.solveSettings = overrides.settings;
    for (const msg of overrides.errors) {
      console.warn('[settings]', msg);
      this.showStatus(msg, 'error');
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
      if (gen !== this.solveGen) return;
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
        if (gen !== this.solveGen) return;
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
    const solverTypes = this.solveSettings.solverTypes.filter(s => {
      if (knownIds.has(s)) return true;
      console.warn(`[settings] ignoring unknown solver "${s}"`);
      return false;
    });
    if (solverTypes.length === 0) {
      this.showStatus('No solvers selected', 'error');
      return;
    }

    // Constraints using dma() need DMA data. An MCU imported from CubeMX XML
    // has none until the matching DMA XML is loaded too, so try the remote
    // catalogue (whose MCUs carry their own DMA data) before giving up.
    if (constraintsNeedDma(parseResult.ast)) {
      await this.ensureDmaData(mcuList);
      // Covers abort during the DMA lookup: abortSolver bumps the token, so
      // the run must stop here instead of proceeding to dispatch workers.
      if (gen !== this.solveGen) return;
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
        statusBar.innerHTML = this.renderStatusBarErrors(preErrors);
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

    if (this.solveSettings.solverDebugOverlay) {
      this.debugOverlay.setDiagnostics(headDiag ?? null);
      this.debugOverlay.startRun(solverTypes);
    }

    // Solve sequentially for each MCU, collecting all results. The ctx
    // snapshot (AST, MCU list, solver set) is what a dynamic-timeout retry
    // re-runs — never the live editor state, which may have changed.
    const ctx: SolveRunContext = { gen, ast: parseResult.ast!, mcuList, solverTypes };
    this.runCtx = ctx;
    this.runHarvest = [];
    const allResults: LabeledSolverResult[] = [];
    let mcuIdx = 0;

    const solveNextMcu = () => {
      if (gen !== this.solveGen) return;
      if (mcuIdx >= mcuList.length) {
        this.onAllSolversComplete(allResults, ctx);
        return;
      }

      const mcu = mcuList[mcuIdx];
      const mcuLabel = mcuList.length > 1 ? `[${mcuIdx + 1}/${mcuList.length} ${mcu.refName}] ` : '';

      if (mcuList.length > 1) {
        this.showStatus(`${mcuLabel}Solving...`, 'info');
      }

      this.solveForMcu(gen, mcu, parseResult.ast!, solverTypes, mcuLabel, (results) => {
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
    gen: number,
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

    // Bound the per-worker solution budget. Every worker's solutions live in the
    // renderer at once (they are merged, then trimmed to maxSolutions), so an
    // over-generous per-worker cap multiplies memory by the worker count — that
    // is what OOM-killed the tab on roomy packages. A modest dedup headroom is
    // enough; PER_WORKER_CEILING keeps one worker from hoarding either.
    const PER_WORKER_CEILING = 1500;
    const perWorkerMax = Math.min(
      PER_WORKER_CEILING,
      totalCount > 1
        ? Math.max(50, Math.ceil(this.solveSettings.maxSolutions / totalCount * 1.25))
        : this.solveSettings.maxSolutions,
    );

    const baseConfig = {
      maxSolutions: perWorkerMax,
      timeoutMs: this.solveSettings.solverTimeoutMs,
      costWeights: new Map(Object.entries(this.solveSettings.costWeights)),
      skipGpioMapping: this.solveSettings.skipGpioMapping,
      postOptimize: this.solveSettings.postOptimize,
      squaredCosts: this.solveSettings.squaredCosts,
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
        // Messages already queued when the run was cancelled still arrive
        // after terminateWorkers(); drop them instead of publishing stale
        // results into whatever the app is showing now.
        if (gen !== this.solveGen) {
          this.retireWorker(worker);
          return;
        }
        const receiveTime = performance.now();
        const wireData = e.data as WireSolverResult | SolverResult;
        const solverResult = '_wire' in wireData ? fromWire(wireData as WireSolverResult) : wireData as SolverResult;
        const solveMs = solverResult.statistics.solveTimeMs;
        const totalMs = receiveTime - workerStartTime;
        const transferMs = totalMs - solveMs;
        if (transferMs > 50) console.log(`[perf] ${jobLabel}: solve=${solveMs.toFixed(0)}ms, overhead≈${transferMs.toFixed(0)}ms, ${solverResult.solutions.length} solutions`);
        const labeled = { solverId: jobLabel, result: solverResult };
        results.push(labeled);
        this.runHarvest.push(labeled);
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
        // Release this worker now — holding every worker alive until the last
        // one finishes keeps N solution sets in memory simultaneously.
        this.retireWorker(worker);
        if (totalCount > 1) {
          this.showStatus(`${statusPrefix}Solving... (${completedCount}/${totalCount} complete)`, 'info');
        }
        if (completedCount === totalCount) {
          this.terminateWorkers();
          onComplete(results);
        }
      };

      worker.onerror = (err) => {
        if (gen !== this.solveGen) {
          this.retireWorker(worker);
          return;
        }
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
        const labeledErr = { solverId: jobLabel, result: errorResult };
        results.push(labeledErr);
        this.runHarvest.push(labeledErr);
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
            maxGroups: this.solveSettings.maxGroups,
            maxSolutionsPerGroup: this.solveSettings.maxSolutionsPerGroup,
          },
          randomizedConfig: { numRestarts: this.solveSettings.numRestarts },
        });
      } else {
        const solverType = job.types[0];

        worker.postMessage({
          ast, mcu,
          config: baseConfig,
          solverType,
          twoPhaseConfig: {
            maxGroups: this.solveSettings.maxGroups,
            maxSolutionsPerGroup: this.solveSettings.maxSolutionsPerGroup,
          },
          randomizedConfig: { numRestarts: this.solveSettings.numRestarts },
        });
      }
    }
  }

  /** Terminate one finished worker and drop it from the pool. */
  private retireWorker(worker: Worker): void {
    try { worker.terminate(); } catch { /* Vite module worker proxy may throw */ }
    const i = this.solverWorkers.indexOf(worker);
    if (i >= 0) this.solverWorkers.splice(i, 1);
  }

  private terminateWorkers(): void {
    for (const w of this.solverWorkers) {
      try { w.terminate(); } catch { /* Vite module worker proxy may throw */ }
    }
    this.solverWorkers = [];
  }

  private onAllSolversComplete(results: LabeledSolverResult[], ctx: SolveRunContext): void {
    this.terminateWorkers();

    const t0 = performance.now();
    const result = mergeResults(results, this.solveSettings.maxSolutions);
    const mergeMs = performance.now() - t0;
    if (mergeMs > 50) console.log(`[perf] mergeResults: ${mergeMs.toFixed(0)}ms (${result.solutions.length} solutions)`);

    // Dynamic timeout retry: if 0 solutions and multiplier > 1 and not already
    // a retry. Re-runs the ctx snapshot (AST, MCU list, solver set from the
    // original run) — the user may have edited constraints in the meantime.
    const mult = this.solveSettings.dynamicTimeoutMultiplier;
    if (result.solutions.length === 0 && mult > 1 && !this.isDynamicTimeoutRetry) {
      const savedTimeout = this.solveSettings.solverTimeoutMs;
      const boostedTimeout = savedTimeout * mult;
      this.showStatus(`No solutions found — retrying with ${boostedTimeout}ms timeout (×${mult})...`, 'info');
      this.isDynamicTimeoutRetry = true;
      this.solveSettings.solverTimeoutMs = boostedTimeout;

      if (this.solveSettings.solverDebugOverlay) {
        this.debugOverlay.startRun(ctx.solverTypes);
      }

      const allRetryResults: LabeledSolverResult[] = [];
      let mcuIdx = 0;

      const solveNextMcu = () => {
        if (ctx.gen !== this.solveGen) return;
        if (mcuIdx >= ctx.mcuList.length) {
          this.solveSettings.solverTimeoutMs = savedTimeout;
          // Keep isDynamicTimeoutRetry = true so the recursive call won't retry again
          this.onAllSolversComplete(allRetryResults, ctx);
          this.isDynamicTimeoutRetry = false;
          return;
        }
        const mcu = ctx.mcuList[mcuIdx];
        const mcuLabel = ctx.mcuList.length > 1 ? `[${mcuIdx + 1}/${ctx.mcuList.length} ${mcu.refName}] ` : '';
        this.solveForMcu(ctx.gen, mcu, ctx.ast, ctx.solverTypes, mcuLabel, (res) => {
          allRetryResults.push(...res);
          mcuIdx++;
          solveNextMcu();
        });
      };
      solveNextMcu();
      return;
    }

    this.isDynamicTimeoutRetry = false;
    this.solveInFlight = false;
    this.setSolveButtonState(false);
    this.runHarvest = [];
    this.runCtx = null;

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
        statusBar.innerHTML = this.renderStatusBarErrors(result.errors);
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
    const phase = this.dmaFetchAbort ? 'Aborted DMA lookup'
      : this.fetchAbort ? 'Aborted MCU fetch'
      : this.solveInFlight || this.solverWorkers.length > 0 ? 'Solver aborted'
      : null;
    const harvest = this.runHarvest;
    const ctx = this.runCtx;
    this.cancelActiveSolve();
    if (!phase) return;

    // A mid-solve worker can't hand anything back (it is blocked inside the
    // synchronous solver), but solvers that already finished did — show their
    // solutions instead of discarding them with the killed workers.
    const found = harvest.reduce((n, r) => n + r.result.solutions.length, 0);
    if (ctx && found > 0) {
      this.onAllSolversComplete(harvest, ctx);
      this.showStatus(
        `${phase} — showing ${found} solution(s) from ${harvest.length} completed solver run(s)`,
        'info',
      );
    } else {
      this.showStatus(phase, 'info');
    }
  }

  /**
   * Silently cancel any in-flight solve, whatever phase it is in. Bumping
   * solveGen makes every pending continuation and queued worker message a
   * no-op; called on user abort and on project switch/new so a late result
   * can never land in state it doesn't belong to.
   */
  private cancelActiveSolve(): void {
    if (!this.solveInFlight && this.solverWorkers.length === 0 && !this.fetchAbort && !this.dmaFetchAbort) return;
    this.solveGen++;
    this.solveInFlight = false;
    this.fetchAbort?.abort();
    this.fetchAbort = null;
    this.dmaFetchAbort?.abort();
    this.dmaFetchAbort = null;
    this.terminateWorkers();
    this.debugOverlay.stopRun();
    this.setSolveButtonState(false);
    this.runHarvest = [];
    this.runCtx = null;
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
        <button class="btn btn-small" id="btn-import-xml" title="Import an MCU (.xml), DMA modes (.xml), a CubeMX project (.ioc), or an exported project (.json)">Import</button>
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
    fileInput.accept = '.xml,.ioc,.json';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    header.appendChild(fileInput);

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files) {
        void this.importFiles([...fileInput.files]);
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
        steps: getTutorialSteps(),
        storageKey: 'tutorial-seen',
        onStart: () => this.loadTutorialExample(),
      });
    });

    // Docs button
    header.querySelector('#btn-docs')!.addEventListener('click', () => this.showDocs());

    // Data manager button
    header.querySelector('#btn-data-manager')!.addEventListener('click', () => this.dataManager.show());

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
        <span class="footer-hint">Drop .xml / .ioc files anywhere to load MCU data or pin assignments, or an exported project .json to import it</span>
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
        void this.importFiles(
          [...e.dataTransfer.files].filter(f => /\.(xml|ioc|json)$/i.test(f.name)),
        );
      }
    });
  }

  /**
   * Import a batch of dropped/picked files. Sequential (concurrent loaders
   * raced on IDB commit order), with DMA XML processed before MCU XML so a
   * batch containing both links them deterministically.
   */
  private async importFiles(files: Iterable<File>): Promise<void> {
    const xmlJobs: Array<{ file: File; text: string }> = [];
    for (const file of files) {
      try {
        if (file.name.endsWith('.ioc')) {
          await this.loadIocFile(file);
        } else if (file.name.endsWith('.json')) {
          await this.loadProjectFile(file);
        } else {
          xmlJobs.push({ file, text: await file.text() });
        }
      } catch (err) {
        console.error('Failed to load file:', err);
        this.showStatus(`Failed to load ${file.name}: ${err}`, 'error');
      }
    }
    const ordered = [...xmlJobs.filter(j => isDmaXml(j.text)), ...xmlJobs.filter(j => !isDmaXml(j.text))];
    for (const { file, text } of ordered) {
      try {
        if (isIocFile(text)) {
          await this.loadIocData(text, file.name);
        } else if (isDmaXml(text)) {
          await this.loadDmaXml(text, file.name);
        } else {
          await this.loadMcuXml(text, file.name);
        }
      } catch (err) {
        console.error('Failed to load file:', err);
        this.showStatus(`Failed to load ${file.name}: ${err}`, 'error');
      }
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

    // Try to attach DMA data from stored DMA XMLs. Await it — the meta tags
    // and status below depend on whether mcu.dma got filled in.
    await this.attachDmaData(mcu);

    // Persist raw XML so reloads don't need a re-import.
    try {
      await getKv().set(`mcu-xml:${mcu.refName}`, xmlString);
      const tags = ['PIN'];
      if (mcu.dma) tags.push('DMA');
      await writeMcuMeta(mcu, tags);
    } catch (err) {
      console.warn('Failed to store MCU XML:', err);
    }

    this.activateLoadedMcu(mcu);
  }

  /**
   * Common post-parse hook: store in cache, update header, broadcast,
   * enable solve. Both XML drag-drop and remote JSON fetch route here.
   */
  activateLoadedMcu(mcu: Mcu): void {
    // A synchronous commit outranks any MCU load still in flight.
    this.mcuLoadSeq++;
    this.currentMcu = mcu;
    this.mcuCache.set(mcu.refName, mcu);
    this.setMcuHeader(mcu);

    this.layout.broadcastStateChange({ type: 'mcu-loaded', mcu });

    this.updateSolveButtonEnabled();

    const dmaInfo = mcu.dma ? `, ${mcu.dma.streams.length} DMA streams` : '';
    this.showStatus(`Loaded ${mcu.refName} (${mcu.physicalPins.length} pins, ${mcu.peripherals.length} peripherals${dmaInfo})`, 'success');
    this.updateProjectSolutionValidity();
  }

  async reimportAllMcus(): Promise<void> {
    let updated = 0;
    let failed = 0;
    // MCU XMLs live in the kv store (IDB) — the localStorage originals were
    // deleted by the one-shot migration, so scanning localStorage re-imports
    // nothing on any migrated install.
    for (const key of await getKv().keysWithPrefix('mcu-xml:')) {
      const refName = key.substring('mcu-xml:'.length);
      const xml = await getKv().get(key);
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
        await writeMcuMeta(mcu, tags);
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
      await this.attachDmaData(mcu);
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
  /**
   * Fill in missing DMA data from the remote catalogue.
   *
   * A locally-imported (XML) MCU only has DMA data once the matching DMA modes
   * XML is imported as well. Remote JSON MCUs always carry theirs, so when the
   * constraints need DMA we fetch the same part remotely and borrow it rather
   * than failing with "no DMA data available".
   */
  private async ensureDmaData(mcuList: Mcu[]): Promise<void> {
    const missing = mcuList.filter(m => !m.dma);
    if (missing.length === 0) return;

    const ds = getDataSource();
    if (!ds.baseUrl()) return;   // nothing to fall back to

    this.dmaFetchAbort = new AbortController();
    this.setSolveButtonState(true);   // the lookup is abortable
    let filled = 0;
    try {
      for (const mcu of missing) {
        // Another variant of the same die already resolved? Reuse it: DMA data
        // is per-die, so one fetch covers every package of that MCU.
        const cached = this.remoteDmaCache.get(mcu.refName);
        if (cached) { mcu.dma = cached; filled++; continue; }

        this.showStatus(`Looking up DMA data for ${mcu.refName}…`, 'info');
        try {
          const remote = await ds.loadVariant(mcu.refName, this.dmaFetchAbort.signal);
          if (remote?.dma) {
            mcu.dma = remote.dma;
            this.remoteDmaCache.set(mcu.refName, remote.dma);
            filled++;
          }
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return;
          console.warn(`[dma] remote lookup failed for ${mcu.refName}:`, err);
        }
      }
    } finally {
      this.dmaFetchAbort = null;
      // solve() re-arms the button when it dispatches workers; releasing here
      // keeps a later validation bail-out from leaving it stuck on "Abort".
      this.setSolveButtonState(false);
    }

    if (filled > 0) {
      const still = mcuList.filter(m => !m.dma).length;
      console.log(`[dma] fetched DMA data for ${filled} MCU(s) from the remote catalogue${still ? `, ${still} still without` : ''}`);
    }
  }

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
      await this.loadIocData(text, file.name);
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
    this.cancelActiveSolve();
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
      solverResult: emptySolverResult(),
    });
    this.refreshProjectList();
    this.showStatus('New project', 'info');
  }

  async listProjectNames(): Promise<string[]> {
    const keys = await getKv().keysWithPrefix('project:');
    return keys.map(k => k.substring('project:'.length)).sort();
  }

  async listProjects(): Promise<{ name: string; size: number; tags: string[]; versionCount: number }[]> {
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

  /**
   * Serialize project read-modify-writes. The kv store has no transactions,
   * so two writers (Save racing Save-As, or two tabs) would silently drop the
   * loser's version history. Web Locks span tabs; browsers without the API
   * fall back to unserialized writes (same as before).
   */
  private withProjectLock<T>(fn: () => Promise<T>): Promise<T> {
    return navigator.locks
      ? navigator.locks.request('pinout-tool-projects', fn) as Promise<T>
      : fn();
  }

  /** Save project by overwriting the latest version (header Save + project list Save) */
  private async saveProject(name: string): Promise<void> {
    const version = this.buildCurrentVersion(0);

    await this.withProjectLock(async () => {
      // Load existing project data
      const existing = await this.loadProjectData(name);
      const projectData: ProjectData = existing ?? { name, versions: [] };
      projectData.name = name;

      // Overwrite latest version, or create first version
      if (projectData.versions.length > 0) {
        const latest = projectData.versions[projectData.versions.length - 1];
        version.id = latest.id;
        projectData.versions[projectData.versions.length - 1] = version;
      } else {
        projectData.versions.push(version);
      }

      await this.persistProject(name, projectData, version);
    });
  }

  /** Save As: prompt for name, append a new version */
  private async saveProjectAs(): Promise<void> {
    const name = prompt('Project name:', this.currentProjectName || '');
    if (!name?.trim()) return;
    const trimmed = name.trim();

    await this.withProjectLock(async () => {
      // Load existing project data (may or may not exist)
      const existing = await this.loadProjectData(trimmed);
      const projectData: ProjectData = existing ?? { name: trimmed, versions: [] };
      projectData.name = trimmed;

      const version = this.buildCurrentVersion(projectData.versions.length);
      projectData.versions.push(version);

      await this.persistProject(trimmed, projectData, version);
    });
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
    const projectData = await this.loadProjectData(name);
    if (!projectData) {
      this.showStatus(`Project "${name}" not found or unreadable`, 'error');
      return;
    }
    const latestVersion = projectData.versions[projectData.versions.length - 1];
    if (!latestVersion) {
      this.showStatus(`Project "${name}" has no versions`, 'error');
      return;
    }
    await this.applyProjectVersion(name, latestVersion);
  }

  async loadProjectVersion(name: string, versionId: number): Promise<void> {
    const projectData = await this.loadProjectData(name);
    if (!projectData) return;
    const version = projectData.versions.find(v => v.id === versionId);
    if (!version) {
      this.showStatus(`Version ${versionId} not found`, 'error');
      return;
    }
    await this.applyProjectVersion(name, version);
  }

  private async applyProjectVersion(name: string, version: ProjectVersion): Promise<void> {
    this.cancelActiveSolve();
    this.loadingProject = true;
    this.constraintEditor.setText(version.constraintText || '');
    this.currentProjectName = name;
    localStorage.setItem('current-project', name);

    // Clear solver results
    this.layout.broadcastStateChange({
      type: 'solver-complete',
      solverResult: emptySolverResult(),
    });
    // Drop the outgoing project's solution from the viewer, the constraint
    // viewer and the caret highlight. Without this, opening a project that has
    // no stored solution left the previous one on screen and the caret kept
    // ringing its pins.
    this.currentSolution = null;
    this.layout.broadcastStateChange({
      type: 'solution-selected',
      assignments: [],
      portColors: new Map(),
    });

    // Load MCU if version references one. Older versions were saved without an
    // mcuRef, so fall back to the one the stored solutions were solved for —
    // without an MCU the validity badges cannot be computed at all.
    const mcuRef = version.mcuRef || version.solutions?.find(s => s.mcuRef)?.mcuRef;
    if (mcuRef && (!this.currentMcu || this.currentMcu.refName !== mcuRef)) {
      this.loadStoredMcu(mcuRef).catch(err => console.error(`Failed to load MCU ${mcuRef}:`, err));
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
    // Solutions are the third input to the badges (with the MCU and the AST);
    // the other two have their own triggers, this covers "list ready last".
    this.updateProjectSolutionValidity();
    // Delay clearing the flag to outlast the 300ms debounced parse triggered by setText()
    setTimeout(() => {
      this.loadingProject = false;
      // Re-evaluate solve button now that parse has completed and loading is done
      this.updateSolveButtonEnabled();
      // MCU + parse are settled now → badge the restored solutions.
      this.updateProjectSolutionValidity();
    }, PARSE_DEBOUNCE_MS + 100);
    const solCount = version.solutions?.length ?? 0;
    this.showStatus(`Project "${name}" loaded (v${version.id}${solCount > 0 ? `, ${solCount} solutions` : ''})`, 'success');
  }

  async deleteProject(name: string): Promise<void> {
    await this.withProjectLock(() => getKv().delete(`project:${name}`));
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
    if (sols.length === 0 || !ast) {
      this.projectSolutions.setValidity(new Map());
      return;
    }
    try {
      // Classify every solution against ITS OWN MCU (session cache), not just
      // whichever MCU happens to be loaded — the classifier skips other-MCU
      // solutions, so badges used to freeze on the previously loaded MCU when
      // clicking between solutions saved for different parts.
      const byMcu = new Map<Mcu, Solution[]>();
      for (const sol of sols) {
        const mcu = sol.mcuRef
          ? this.mcuCache.get(sol.mcuRef)
            ?? (this.currentMcu?.refName === sol.mcuRef ? this.currentMcu : undefined)
          : this.currentMcu ?? undefined;   // legacy solutions without an mcuRef
        if (!mcu) continue;                 // MCU not loaded this session → no badge
        const list = byMcu.get(mcu) ?? [];
        list.push(sol);
        byMcu.set(mcu, list);
      }
      const merged = new Map<Solution, SolutionVerdict>();
      for (const [mcu, group] of byMcu) {
        for (const [sol, verdict] of classifyProjectSolutions(group, ast, mcu, this.settings.skipGpioMapping)) {
          merged.set(sol, verdict);
        }
      }
      this.projectSolutions.setValidity(merged);
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
    // Always parse current text - the cached parseResult may be stale
    // (e.g. during project load before the debounced parse fires)
    return buildPortColorMap(parseConstraints(this.constraintEditor.getText()).ast);
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

  /** One place for the header MCU summary line. */
  private setMcuHeader(mcu: Mcu): void {
    const mcuInfo = document.getElementById('mcu-info');
    if (mcuInfo) {
      mcuInfo.textContent = mcuInfoLine(mcu);
    }
  }

  /**
   * Solve is enabled ⇔ the parse is clean AND (an MCU is loaded OR `mcu:`
   * filters drive multi-MCU mode, where MCUs are resolved at solve time).
   * The single predicate — three call sites used to carry two variants, one
   * of which ignored `mcu:` mode.
   */
  private updateSolveButtonEnabled(): void {
    const solveBtn = this.constraintEditor.getSolveButton() as HTMLButtonElement | null;
    if (!solveBtn) return;
    const parseResult = this.constraintEditor.getParseResult();
    const hasErrors = !parseResult || parseResult.errors.length > 0;
    const hasMcuFilter = parseResult?.ast?.statements.some(s => s.type === 'mcu_decl') ?? false;
    solveBtn.disabled = hasErrors || (!this.currentMcu && !hasMcuFilter);
  }

  /** Load + migrate a stored project; null when missing or corrupt. */
  async loadProjectData(name: string): Promise<ProjectData | null> {
    try {
      const raw = await getKv().get(`project:${name}`);
      if (!raw) return null;
      return migrateProjectData(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Solver status-bar HTML for a list of errors ("sender: message" styled). */
  private renderStatusBarErrors(errors: Array<{ type: string; message: string }>): string {
    return errors
      .map(e => {
        const m = e.message.match(/^([A-Za-z0-9_-]+): (.*)$/);
        if (m) {
          return `<span class="st-${e.type}"><span class="st-sender">${escHtml(m[1])}:</span> ${escHtml(m[2])}</span>`;
        }
        return `<span class="st-${e.type}">${escHtml(e.message)}</span>`;
      })
      .join(' ');
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
          if (state.m) this.loadStoredMcu(state.m).catch(err => console.error(`Failed to load MCU ${state.m}:`, err));
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
      const projectData = await this.loadProjectData(this.currentProjectName);
      if (projectData) {
        try {
          const latest = projectData.versions[projectData.versions.length - 1];
          if (latest) {
            await this.applyProjectVersion(this.currentProjectName, latest);
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
                <label class="solver-checkbox" title="${escHtml(s.description)}">
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
              <label title="${escHtml(fn.description)}">${escHtml(fn.name)}</label>
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
          <div class="settings-row">
            <label title="Two fingers on a touchpad/touchscreen pan, pinch to zoom and twist to rotate in 90° steps. Off = the wheel zooms (classic mouse behaviour).">Touch gestures</label>
            <input type="checkbox" id="set-touch-gestures" ${this.settings.touchGestures ? 'checked' : ''}>
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
          <button class="btn btn-small" id="set-export" title="Write these solver settings into the constraints as a settings: block">Export to Constraints</button>
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

    // Pull every control into this.settings — shared by Apply and Export.
    const readForm = (): void => {
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
      this.settings.touchGestures = (modal.querySelector('#set-touch-gestures') as HTMLInputElement).checked;

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
    };

    modal.querySelector('#set-apply')!.addEventListener('click', () => {
      readForm();
      this.saveSettings();
      this.updateUrlHash();
      this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);
    this.packageViewer.setGestureMode(this.settings.touchGestures);
      close();
      this.showStatus('Settings saved', 'success');
    });

    modal.querySelector('#set-export')!.addEventListener('click', () => {
      // Snapshot the *current* form values first, so Export reflects what the
      // user sees rather than the last-applied settings.
      readForm();
      const text = upsertSettingsBlock(this.constraintEditor.getText(), formatSettingsBlock(this.settings));
      this.constraintEditor.setText(text);
      this.saveSettings();
      close();
      this.showStatus('Solver settings written to the constraints', 'success');
    });

    modal.querySelector('#set-reset-defaults')!.addEventListener('click', () => {
      this.settings = { ...DEFAULT_SETTINGS, costWeights: { ...DEFAULT_SETTINGS.costWeights } };
      this.saveSettings();
      close();
      this.packageViewer.setZoomLimits(this.settings.minZoom, this.settings.maxZoom, this.settings.mouseZoomGain);
    this.packageViewer.setGestureMode(this.settings.touchGestures);
      this.showStatus('Settings reset to defaults', 'success');
    });
  }

  async loadStoredMcu(refName: string): Promise<void> {
    const seq = ++this.mcuLoadSeq;
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
      await this.loadRemoteMcu(refName, seq);
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
      await this.attachDmaData(mcu);

      // A newer MCU load or import won while we were reading storage — this
      // result must not clobber it.
      if (seq !== this.mcuLoadSeq) return;

      // Common post-parse hook (header, broadcast, solve button, badges) —
      // this used to be re-implemented inline and had drifted.
      this.activateLoadedMcu(mcu);
      const dmaInfo = mcu.dma ? ` (+DMA)` : '';
      this.showStatus(`Loaded ${mcu.refName} from storage${dmaInfo}`, 'success');
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
  private async loadRemoteMcu(refName: string, seq = ++this.mcuLoadSeq): Promise<void> {
    const ds = getDataSource();
    if (!ds.baseUrl()) {
      this.showStatus(`MCU "${refName}" is not in local storage and no data source is configured`, 'error');
      return;
    }
    const controller = new AbortController();
    this.showStatus(`Fetching ${refName} from data source…`, 'info');
    try {
      const mcu = await ds.loadVariant(refName, controller.signal);
      // A newer MCU load or import won while this fetch was in flight.
      if (seq !== this.mcuLoadSeq) return;
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

  async listStoredMcus(): Promise<{ refName: string; size: number; tags: string[] }[]> {
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

  /** Bundled defaults the user has customised and that have a newer revision. */
  pendingUpdates: PendingUpdate[] = [];

  /**
   * Sync bundled libraries / export functions into storage and mark the Data
   * button when something needs a decision. Untouched items update silently;
   * only customised ones surface here.
   */
  async refreshDefaultUpdates(): Promise<void> {
    try {
      this.pendingUpdates = await syncDefaults();
    } catch {
      this.pendingUpdates = [];
    }
    await primeStdlibSource();
    await primePeripheralSource();
    const btn = document.getElementById('btn-data-manager');
    if (!btn) return;
    btn.classList.toggle('has-update', this.pendingUpdates.length > 0);
    btn.title = this.pendingUpdates.length > 0
      ? `${this.pendingUpdates.length} library/export update(s) available — open Data to review`
      : 'Manage stored MCUs, projects, exports, and the remote data source';
  }

  /** `Update` button markup for a library section, or '' when it is current. */

  async deleteProjectVersion(projectName: string, versionId: number): Promise<void> {
    let emptied = false;
    await this.withProjectLock(async () => {
      const projectData = await this.loadProjectData(projectName);
      if (!projectData) return;
      try {
        projectData.versions = projectData.versions.filter(v => v.id !== versionId);
        if (projectData.versions.length === 0) {
          emptied = true;
          return;
        }
        // Re-number version ids
        projectData.versions.forEach((v, i) => v.id = i);
        await getKv().set(`project:${projectName}`, JSON.stringify(projectData));
        this.refreshProjectList();
      } catch { /* ignore */ }
    });
    // Outside the lock — deleteProject takes it itself.
    if (emptied) await this.deleteProject(projectName);
  }

  private downloadJson(data: unknown, filename: string): void {
    downloadBlob(JSON.stringify(data, null, 2), filename, 'application/json');
  }

  exportCurrentMcu(): void {
    const mcu = this.currentMcu;
    if (!mcu) return;
    this.downloadJson(serializeMcu(mcu), `${mcu.refName}-mcu.json`);
  }

  exportCurrentDma(): void {
    const dma = this.currentMcu?.dma;
    if (!dma) return;
    this.downloadJson(serializeDma(dma), `${this.currentMcu!.refName}-dma.json`);
  }

  /** Export the current solver run's solutions (the Solver Solutions panel). */
  exportCurrentSolutions(): void {
    const result = this.solverSolutions.getSolverResult();
    if (!result || result.solutions.length === 0) return;
    const name = this.currentProjectName || 'solutions';
    this.downloadJson({
      mcuRef: result.mcuRef,
      solutionCount: result.solutions.length,
      statistics: result.statistics,
      solutions: result.solutions.map(serializeSolution),
    }, `${name}-solutions.json`);
  }

  exportCurrentAst(): void {
    const parseResult = this.constraintEditor.getParseResult();
    if (!parseResult?.ast) return;
    const name = this.currentProjectName || 'constraints';
    this.downloadJson(parseResult.ast, `${name}-ast.json`);
  }

  async exportMcuData(refName: string): Promise<void> {
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

  /**
   * Import a project exported from Data Manager → Projects → Export.
   * Asks for a name (defaulting to the one in the file); importing under an
   * existing name appends the versions, exactly like "Save As" with that name.
   */
  private async loadProjectFile(file: File): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this.showStatus(`${file.name} is not valid JSON`, 'error');
      return;
    }
    if (!isExportedProject(parsed)) {
      this.showStatus(`${file.name} is not an exported project`, 'error');
      return;
    }
    const imported = migrateProjectData(parsed);
    if (imported.versions.length === 0) {
      this.showStatus(`${file.name} contains no project versions`, 'error');
      return;
    }

    const name = prompt('Import project as:', imported.name || file.name.replace(/\.json$/i, ''));
    if (!name?.trim()) return;
    const trimmed = name.trim();

    // Merge into an existing project when the name is taken, so importing
    // twice builds up versions instead of overwriting.
    const addedCount = imported.versions.length;
    const latest = await this.withProjectLock(async () => {
      const existing = await this.loadProjectData(trimmed);
      const target: ProjectData = existing ?? { name: trimmed, versions: [] };
      target.name = trimmed;

      mergeImportedVersions(target, imported);

      const merged = target.versions[target.versions.length - 1];
      await this.persistProject(trimmed, target, merged);
      return merged;
    });
    await this.applyProjectVersion(trimmed, latest);
    this.showStatus(
      `Imported "${file.name}" as "${trimmed}" (${addedCount} version(s), now v${latest.id})`,
      'success',
    );
  }

  async exportProjectData(projectName: string): Promise<void> {
    const projectData = await this.loadProjectData(projectName);
    if (!projectData) return;
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

  showStatus(message: string, type: 'success' | 'error' | 'info'): void {
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
