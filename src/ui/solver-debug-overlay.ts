import type { SolverResult, Solution } from '../types';

interface DebugEntry {
  solverId: string;
  state: 'running' | 'finished' | 'timeout' | 'error' | 'aborted';
  startTime: number;
  elapsedMs: number;
  solutions: number;
  groups: number;
  minCost: number;
  avgRank: number | null;
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

export class SolverDebugOverlay {
  private container: HTMLDivElement | null = null;
  private entries: DebugEntry[] = [];
  private timerId: number = 0;

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
      </tr>`;
    }).join('');

    this.container.innerHTML = `
      <div class="sdo-header">
        <span>Solver Debug</span>
        <button class="sdo-close">\u00d7</button>
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
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    this.container.querySelector('.sdo-close')!.addEventListener('click', () => {
      if (this.container) this.container.style.display = 'none';
      this.stopTimer();
    });
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
