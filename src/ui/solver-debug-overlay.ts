import type { SolverResult, Solution } from '../types';
import type { SolverDiagnosticsReport, SolverRunRecord, AggregateReport } from '../solver/diagnostics';
import { aggregateSolverRuns } from '../solver/diagnostics';

interface DebugEntry {
  solverId: string;
  state: 'running' | 'finished' | 'timeout' | 'error' | 'aborted';
  startTime: number;
  elapsedMs: number;
  solutions: number;
  groups: number;
  minCost: number;
  avgRank: number | null;
  /** Last solver result (errors + stats) so the details modal can show them. */
  result: SolverResult | null;
}

const STATE_ICONS: Record<DebugEntry['state'], string> = {
  running: '\u23f3',   // ⏳
  finished: '\u2713',  // ✓
  timeout: '\u23f1',   // ⏱
  error: '\u2717',     // ✗
  aborted: '\u25a0',   // ■
};

const STATE_COLORS: Record<DebugEntry['state'], string> = {
  running: 'var(--accent)',
  finished: 'var(--success)',
  timeout: '#f59e0b',
  error: 'var(--error)',
  aborted: 'var(--text-secondary)',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimeStatic(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(0)}s`;
}

export class SolverDebugOverlay {
  private container: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private entries: DebugEntry[] = [];
  private diagnostics: SolverDiagnosticsReport | null = null;
  private timerId: number = 0;
  /** Persists across modal opens so re-running the solver remembers the user's choice. */
  private overviewExcludeForced = false;

  /** Pre-solve hook: stash the static diagnostics report (same for every solver). */
  setDiagnostics(report: SolverDiagnosticsReport | null): void {
    this.diagnostics = report;
  }

  startRun(solverIds: string[]): void {
    this.stopTimer();
    const now = performance.now();
    this.entries = solverIds.map(id => ({
      solverId: id,
      state: 'running' as const,
      startTime: now,
      elapsedMs: 0,
      solutions: 0,
      groups: 0,
      minCost: 0,
      avgRank: null,
      result: null,
    }));
    this.ensureContainer();
    this.startTimer();
    this.render();
  }

  solverComplete(solverId: string, result: SolverResult): void {
    const entry = this.entries.find(e => e.solverId === solverId);
    if (!entry) return;

    entry.elapsedMs = result.statistics.solveTimeMs;
    entry.solutions = result.solutions.length;
    entry.groups = this.countGroups(result.solutions);
    entry.result = result;
    entry.minCost = result.solutions.length > 0
      ? Math.min(...result.solutions.map(s => s.totalCost))
      : 0;

    const hasTimeout = result.errors.some(e =>
      e.message.toLowerCase().includes('timeout'));
    const hasError = result.errors.some(e =>
      e.type === 'error'
      && !e.message.toLowerCase().includes('timeout')
      && !e.message.toLowerCase().includes('maximum'));

    entry.state = hasError ? 'error' : hasTimeout ? 'timeout' : 'finished';
    this.render();
  }

  finalize(mergedSolutions: Solution[]): void {
    this.stopTimer();

    const ranksBySolver = new Map<string, number[]>();
    for (const sol of mergedSolutions) {
      if (!sol.solverOrigin) continue;
      const list = ranksBySolver.get(sol.solverOrigin) ?? [];
      list.push(sol.id);
      ranksBySolver.set(sol.solverOrigin, list);
    }

    for (const entry of this.entries) {
      const ranks = ranksBySolver.get(entry.solverId);
      entry.avgRank = ranks && ranks.length > 0
        ? ranks.reduce((a, b) => a + b, 0) / ranks.length
        : null;
    }
    this.render();
  }

  stopRun(): void {
    this.stopTimer();
    const now = performance.now();
    for (const entry of this.entries) {
      if (entry.state === 'running') {
        entry.elapsedMs = now - entry.startTime;
        entry.state = 'aborted';
      }
    }
    this.render();
  }

  private ensureContainer(): void {
    if (this.container) {
      this.container.style.display = '';
      return;
    }
    const div = document.createElement('div');
    div.className = 'solver-debug-overlay';
    document.body.appendChild(div);
    this.container = div;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timerId = window.setInterval(() => {
      const now = performance.now();
      for (const entry of this.entries) {
        if (entry.state === 'running') {
          entry.elapsedMs = now - entry.startTime;
        }
      }
      this.render();
    }, 100);
  }

  private stopTimer(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = 0;
    }
  }

  private render(): void {
    if (!this.container) return;

    const rows = this.entries.map(e => {
      const icon = STATE_ICONS[e.state];
      const color = STATE_COLORS[e.state];
      const time = this.formatTime(e.elapsedMs);
      const sol = e.state === 'running' ? '-' : String(e.solutions);
      const grp = e.state === 'running' ? '-' : String(e.groups);
      const cost = e.state === 'running' || e.solutions === 0
        ? '-' : e.minCost.toFixed(1);
      const rank = e.avgRank !== null ? e.avgRank.toFixed(0) : '-';

      return `<tr>
        <td class="sdo-cell-name">${e.solverId}</td>
        <td class="sdo-cell-state" style="color:${color}">${icon}</td>
        <td class="sdo-cell-num">${time}</td>
        <td class="sdo-cell-num">${sol}</td>
        <td class="sdo-cell-num">${grp}</td>
        <td class="sdo-cell-num">${cost}</td>
        <td class="sdo-cell-num">${rank}</td>
        <td class="sdo-cell-state">
          <button class="sdo-details" data-solver="${esc(e.solverId)}" title="Diagnostics for ${esc(e.solverId)}">i</button>
        </td>
      </tr>`;
    }).join('');

    this.container.innerHTML = `
      <div class="sdo-header">
        <span>Solver Debug</span>
        <span class="sdo-header-actions">
          <button class="sdo-overview" title="Aggregate bottleneck overview across all solvers">Overview</button>
          <button class="sdo-close">\u00d7</button>
        </span>
      </div>
      <table class="sdo-table">
        <thead>
          <tr>
            <th class="sdo-cell-name">Solver</th>
            <th class="sdo-cell-state"></th>
            <th class="sdo-cell-num">Time</th>
            <th class="sdo-cell-num">Sol</th>
            <th class="sdo-cell-num">Grp</th>
            <th class="sdo-cell-num">Cost</th>
            <th class="sdo-cell-num">Rank</th>
            <th class="sdo-cell-state"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    this.container.querySelector('.sdo-close')!.addEventListener('click', () => {
      if (this.container) this.container.style.display = 'none';
      this.stopTimer();
    });
    this.container.querySelector('.sdo-overview')!.addEventListener('click', () => {
      this.showOverview();
    });
    for (const btn of this.container.querySelectorAll<HTMLButtonElement>('.sdo-details')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.solver!;
        this.showDetails(id);
      });
    }
  }

  // ============================================================
  // Overview modal — aggregate bottlenecks across every solver
  // ============================================================

  private showOverview(): void {
    if (this.modal) this.closeModal();
    if (!this.diagnostics) {
      // Nothing to aggregate against; still show the modal so the user
      // gets a clear "no diagnostics" hint instead of silent inaction.
      this.openModal('<div class="sdo-modal-header"><strong>Overview</strong><button class="sdo-modal-close">×</button></div>'
        + '<div class="sdo-modal-body"><p class="sdo-modal-hint">No diagnostics report available — run a solve first.</p></div>');
      return;
    }
    this.openOverviewModal();
  }

  private openOverviewModal(): void {
    if (!this.diagnostics) return;
    if (this.modal) this.closeModal();

    const runs: SolverRunRecord[] = this.entries.map(e => ({
      solverId: e.solverId,
      state: e.state,
      result: e.result,
    }));
    const agg = aggregateSolverRuns(this.diagnostics, runs, {
      excludeForcedBinding: this.overviewExcludeForced,
    });
    this.openModal(this.renderOverview(agg));

    // Wire the "exclude forced bindings" toggle. Toggling re-renders the
    // panel in place so the rest of the modal state (scroll position,
    // open subsections) stays roughly stable.
    const toggle = this.modal?.querySelector<HTMLInputElement>('#sdo-toggle-forced');
    toggle?.addEventListener('change', () => {
      this.overviewExcludeForced = toggle.checked;
      this.openOverviewModal();
    });
  }

  private openModal(html: string): void {
    const overlay = document.createElement('div');
    overlay.className = 'sdo-modal-overlay';
    const panel = document.createElement('div');
    panel.className = 'sdo-modal';
    overlay.appendChild(panel);
    panel.innerHTML = html;
    document.body.appendChild(overlay);
    this.modal = overlay;
    panel.querySelector('.sdo-modal-close')!.addEventListener('click', () => this.closeModal());
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) this.closeModal();
    });
  }

  private renderOverview(agg: AggregateReport): string {
    const stat = agg.runStats;
    const headlines = agg.headlines.map(h => `<li>${esc(h)}</li>`).join('');

    const renderTopList = (title: string, items: AggregateReport['topPeripheralShortfalls'], header?: string): string => {
      const headerHtml = header ?? '';
      if (items.length === 0) {
        return `<div class="sdo-modal-section-head"><h4>${esc(title)}</h4>${headerHtml}</div><p class="sdo-modal-hint">none</p>`;
      }
      const rows = items.map(b => `
        <tr>
          <td><code>${esc(b.label)}</code></td>
          <td class="sdo-cell-num">${b.severity}</td>
          <td>${esc(b.detail)}</td>
        </tr>
      `).join('');
      return `
        <div class="sdo-modal-section-head"><h4>${esc(title)}</h4>${headerHtml}</div>
        <table class="sdo-modal-table">
          <thead><tr><th>Item</th><th class="sdo-cell-num">Severity</th><th>Why</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    };

    const hardChannelsToggle = `
      <label class="sdo-modal-toggle">
        <input type="checkbox" id="sdo-toggle-forced" ${this.overviewExcludeForced ? 'checked' : ''}>
        Exclude forced bindings (1 free pin)
      </label>
    `;

    const errorRows = agg.errorDigest.length > 0
      ? agg.errorDigest.slice(0, 10).map(e => `
          <tr class="${e.type === 'error' ? 'sdo-modal-shortfall' : ''}">
            <td>${esc(e.type)}</td>
            <td class="sdo-cell-num">${e.count}</td>
            <td class="sdo-modal-list"><code>${esc(e.message)}</code></td>
            <td class="sdo-modal-list">${esc(e.solvers.join(', '))}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="4" class="sdo-modal-hint">no errors reported</td></tr>';

    const min = agg.minRequirements;
    const minByTypeRows = [...min.byType.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => `<span class="sdo-modal-pill">${esc(t)}×${n}</span>`)
      .join(' ') || '<span class="sdo-modal-hint">none</span>';

    return `
      <div class="sdo-modal-header">
        <strong>Solver Overview · ${esc(agg.mcuRef)}</strong>
        <button class="sdo-modal-close">×</button>
      </div>
      <div class="sdo-modal-body">
        <section>
          <h4>Headline</h4>
          <ul>${headlines}</ul>
        </section>

        <section>
          <h4>Minimum requirements</h4>
          <table class="sdo-modal-kv">
            <tr><td>Peripheral-signal pins (non-GPIO)</td><td class="sdo-cell-num">${min.peripheralSignalPins}</td></tr>
            <tr><td>GPIO pins (IN / OUT)</td><td class="sdo-cell-num">${min.gpioPins}</td></tr>
            <tr><td>Total pins (floor)</td><td class="sdo-cell-num">${min.totalPins}</td></tr>
            <tr><td>Peripheral instances</td><td class="sdo-cell-num">${min.peripheralInstances}</td></tr>
            <tr><td>Per type</td><td>${minByTypeRows}</td></tr>
          </table>
          <p class="sdo-modal-hint">Floor counts. The solver can pack channels onto fewer pins via configuration reuse, never below these.</p>
        </section>

        <section>
          <h4>Aggregate run stats</h4>
          <table class="sdo-modal-kv">
            <tr><td>Solvers (finished / total)</td><td class="sdo-cell-num">${stat.finishedCount} / ${stat.solverCount}</td></tr>
            <tr><td>Timeouts / errors / aborted</td><td class="sdo-cell-num">${stat.timeoutCount} / ${stat.errorCount} / ${stat.abortedCount}</td></tr>
            <tr><td>Best valid solution count</td><td class="sdo-cell-num">${stat.bestValidCount}</td></tr>
            <tr><td>Total combinations evaluated</td><td class="sdo-cell-num">${stat.totalEvaluated.toLocaleString()}</td></tr>
            <tr><td>Total solve time</td><td class="sdo-cell-num">${formatTimeStatic(stat.totalSolveTimeMs)}</td></tr>
            ${stat.fastestFirstSolutionMs !== null ? `<tr><td>Fastest first solution</td><td class="sdo-cell-num">${formatTimeStatic(stat.fastestFirstSolutionMs)}</td></tr>` : ''}
          </table>
        </section>

        <section>
          ${renderTopList('Top peripheral shortfalls', agg.topPeripheralShortfalls)}
        </section>

        <section>
          ${renderTopList('Hardest channels', agg.topHardChannels, hardChannelsToggle)}
        </section>

        <section>
          ${renderTopList('Pin contention (cross-port)', agg.topContention)}
        </section>

        <section>
          <h4>Error digest (deduped, top 10)</h4>
          <table class="sdo-modal-table">
            <thead><tr><th>Type</th><th class="sdo-cell-num">Count</th><th>Message</th><th>Solvers</th></tr></thead>
            <tbody>${errorRows}</tbody>
          </table>
        </section>
      </div>
    `;
  }

  // ============================================================
  // Details modal \u2014 bottleneck breakdown, type demand, channel candidates
  // ============================================================

  private showDetails(solverId: string): void {
    const entry = this.entries.find(e => e.solverId === solverId);
    if (!entry) return;
    this.openModal(this.renderDetails(entry));
  }

  private closeModal(): void {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }

  private renderDetails(entry: DebugEntry): string {
    const failed = entry.result
      ? Math.max(0, entry.result.statistics.evaluatedCombinations - entry.result.statistics.validSolutions)
      : 0;
    const stats = entry.result?.statistics;
    const evaluated = stats?.evaluatedCombinations ?? 0;
    const totalCombos = stats?.totalCombinations ?? 0;
    const configCombos = stats?.configCombinations ?? 0;
    const ttfs = stats?.firstSolutionMs;

    const errorRows = (entry.result?.errors ?? []).map(e =>
      `<li class="sdo-modal-${e.type}">${esc(e.message)}</li>`,
    ).join('') || '<li class="sdo-modal-hint">none</li>';

    const diag = this.diagnostics;

    const summaryHtml = diag
      ? diag.summary.map(s => `<li>${esc(s)}</li>`).join('') || '<li class="sdo-modal-hint">no notable bottlenecks</li>'
      : '<li class="sdo-modal-hint">diagnostics unavailable</li>';

    const typeRows = diag
      ? diag.typeDemand.map(t => `
          <tr class="${t.shortfall ? 'sdo-modal-shortfall' : ''}">
            <td>${esc(t.type)}</td>
            <td class="sdo-cell-num">${t.totalRequired}</td>
            <td class="sdo-cell-num">${t.totalFree}</td>
            <td class="sdo-cell-num">${t.totalAvailable}</td>
            <td class="sdo-cell-num">${t.missingInstances || (t.shared ? 'shared' : '0')}</td>
            <td class="sdo-modal-list">${esc(t.portsRequesting.join(', '))}</td>
          </tr>
        `).join('') || '<tr><td colspan="6" class="sdo-modal-hint">no required peripheral types</td></tr>'
      : '';

    const portSections = diag
      ? diag.ports.map(p => this.renderPortBlock(p)).join('')
      : '<p class="sdo-modal-hint">No diagnostics report attached.</p>';

    const reservedSummary = diag && (diag.reserved.pins.length || diag.reserved.peripherals.length || diag.reserved.positions.length)
      ? `<p class="sdo-modal-hint">Reserves applied: ${diag.reserved.pins.length} pin${diag.reserved.pins.length === 1 ? '' : 's'}, ${diag.reserved.peripherals.length} peripheral${diag.reserved.peripherals.length === 1 ? '' : 's'}, ${diag.reserved.positions.length} position${diag.reserved.positions.length === 1 ? '' : 's'}.</p>`
      : '';

    const unmatchedReserves = diag?.unmatchedReserves.length
      ? `<p class="sdo-modal-warn">Unmatched reserve patterns (likely typos): ${esc(diag.unmatchedReserves.join(', '))}</p>`
      : '';

    return `
      <div class="sdo-modal-header">
        <strong>${esc(entry.solverId)} diagnostics</strong>
        <button class="sdo-modal-close">\u00d7</button>
      </div>
      <div class="sdo-modal-body">
        <section>
          <h4>Run summary</h4>
          <table class="sdo-modal-kv">
            <tr><td>Valid solutions</td><td class="sdo-cell-num">${entry.solutions}</td></tr>
            <tr><td>Failed attempts</td><td class="sdo-cell-num">${failed}</td></tr>
            <tr><td>Evaluated combinations</td><td class="sdo-cell-num">${evaluated}</td></tr>
            <tr><td>Config combinations (total / explored)</td><td class="sdo-cell-num">${configCombos} / ${totalCombos}</td></tr>
            <tr><td>Solve time</td><td class="sdo-cell-num">${formatTimeStatic(entry.elapsedMs)}</td></tr>
            ${ttfs !== undefined ? `<tr><td>First solution at</td><td class="sdo-cell-num">${formatTimeStatic(ttfs)}</td></tr>` : ''}
            <tr><td>Best cost</td><td class="sdo-cell-num">${entry.solutions > 0 ? entry.minCost.toFixed(2) : '-'}</td></tr>
            <tr><td>Distinct peripheral groups</td><td class="sdo-cell-num">${entry.groups}</td></tr>
          </table>
          <h4>Errors</h4>
          <ul class="sdo-modal-errors">${errorRows}</ul>
        </section>

        <section>
          <h4>Bottleneck summary</h4>
          <ul>${summaryHtml}</ul>
          ${reservedSummary}
          ${unmatchedReserves}
        </section>

        <section>
          <h4>Peripheral type demand vs supply</h4>
          <table class="sdo-modal-table">
            <thead>
              <tr>
                <th>Type</th>
                <th class="sdo-cell-num">Required</th>
                <th class="sdo-cell-num">Free</th>
                <th class="sdo-cell-num">Total</th>
                <th class="sdo-cell-num">Missing</th>
                <th>Ports</th>
              </tr>
            </thead>
            <tbody>${typeRows}</tbody>
          </table>
        </section>

        <section>
          <h4>Ports</h4>
          ${portSections}
        </section>
      </div>
    `;
  }

  private renderPortBlock(p: import('../solver/diagnostics').PortDiagnostics): string {
    const channelRows = p.channels.map(ch => {
      const cls = ch.candidatesFree === 0 && !ch.optional ? 'sdo-modal-shortfall' : '';
      const hint = ch.hints.length > 0
        ? `<div class="sdo-modal-hint">${esc(ch.hints.join(' '))}</div>`
        : '';
      return `
        <tr class="${cls}">
          <td>${esc(ch.channelName)}${ch.optional ? ' <span class="sdo-modal-opt">(optional)</span>' : ''}</td>
          <td>${esc(ch.configName)}</td>
          <td><code>${esc(ch.patternRaw)}</code>${hint}</td>
          <td class="sdo-cell-num">${ch.candidatesFree}/${ch.candidatesTotal}</td>
          <td class="sdo-cell-num">${ch.uniquePinsFree}</td>
          <td class="sdo-cell-num">${ch.uniqueInstancesFree}</td>
          <td class="sdo-cell-num">${ch.prunedByReserve}</td>
          <td class="sdo-cell-num">${ch.prunedByPinned}</td>
        </tr>
      `;
    }).join('');

    const demandList = [...p.peripheralDemand.entries()]
      .map(([t, n]) => `${t}\u00d7${n}`).join(', ') || '(none)';

    return `
      <div class="sdo-modal-port">
        <h5>${esc(p.portName)} <span class="sdo-modal-hint">required: ${esc(demandList)}</span></h5>
        ${p.hints.length ? `<p class="sdo-modal-warn">${esc(p.hints.join(' '))}</p>` : ''}
        <table class="sdo-modal-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Config</th>
              <th>Pattern</th>
              <th class="sdo-cell-num">Cand free/total</th>
              <th class="sdo-cell-num">Pins free</th>
              <th class="sdo-cell-num">Inst free</th>
              <th class="sdo-cell-num">\u2193reserve</th>
              <th class="sdo-cell-num">\u2193pinned</th>
            </tr>
          </thead>
          <tbody>${channelRows}</tbody>
        </table>
      </div>
    `;
  }

  private countGroups(solutions: Solution[]): number {
    const keys = new Set<string>();
    for (const sol of solutions) {
      const parts: string[] = [];
      const sortedPorts = [...sol.portPeripherals.keys()].sort();
      for (const port of sortedPorts) {
        const peripherals = [...sol.portPeripherals.get(port)!].sort();
        parts.push(`${port}:${peripherals.join(',')}`);
      }
      keys.add(parts.join('|'));
    }
    return keys.size;
  }

  private formatTime(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 1000).toFixed(0)}s`;
  }
}
