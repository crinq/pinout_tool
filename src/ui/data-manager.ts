// ============================================================
// Data Manager modal — MCU storage browser, remote catalogue browser,
// library editors (macro / lint / peripheral / custom exports) and the
// project version list. Extracted from app.ts; everything it needs from
// the app goes through the DataManagerHost interface.
// ============================================================

import type { Mcu, CustomExportFunction } from '../types';
import type { ProjectData, ProjectVersion } from '../storage';
import type { AppSettings } from '../settings';
import { escapeHtml as escHtml, createModal } from '../utils';
import { getKv } from '../kv';
import { getDataSource, entryPackageNames, entryVariantNames, type IndexDeviceEntry } from '../datasource';
import { createCodeEditor } from './code-editor';
import { highlightJs } from './highlight-js';
import { ConstraintEditor, highlightConstraintCode } from './constraint-editor';
import type { SolverSolutions } from './solution-table';
import {
  applyDefaultUpdate, markSyncedWithDefault, type PendingUpdate,
  loadCustomExports, saveCustomExport, deleteCustomExport,
  saveMacroLibrary, loadCommonErrorsLibrary, saveCommonErrorsLibrary, savePeripheralLibrary,
} from '../storage';
import { getStdlibSource, primeStdlibSource, DEFAULT_MACRO_LIBRARY } from '../parser/stdlib-macros';
import { getPeripheralSource, primePeripheralSource, DEFAULT_PERIPHERAL_LIBRARY } from '../parser/peripheral-lib';
import { DEFAULT_COMMON_ERRORS_LIBRARY } from '../parser/lint-common-errors';
import { primeCommonErrorsLib } from '../solver/solver';
import { parseConstraints } from '../parser/constraint-parser';

export interface DataManagerHost {
  currentMcu: Mcu | null;
  currentProjectName: string | null;
  settings: AppSettings;
  solverSolutions: SolverSolutions;
  constraintEditor: ConstraintEditor;
  pendingUpdates: PendingUpdate[];
  showStatus(message: string, type: 'success' | 'error' | 'info'): void;
  refreshDefaultUpdates(): Promise<void>;
  activateLoadedMcu(mcu: Mcu): void;
  loadStoredMcu(refName: string): Promise<void>;
  loadProject(name: string): Promise<void>;
  loadProjectVersion(name: string, versionId: number): Promise<void>;
  loadProjectData(name: string): Promise<ProjectData | null>;
  listStoredMcus(): Promise<Array<{ refName: string; size: number; tags: string[] }>>;
  listProjects(): Promise<Array<{ name: string; size: number; tags: string[]; versionCount: number }>>;
  listProjectNames(): Promise<string[]>;
  deleteProject(name: string): Promise<void>;
  deleteProjectVersion(projectName: string, versionId: number): Promise<void>;
  reimportAllMcus(): Promise<void>;
  exportProjectData(projectName: string): Promise<void>;
  exportMcuData(refName: string): Promise<void>;
  exportCurrentSolutions(): void;
  exportCurrentMcu(): void;
  exportCurrentDma(): void;
  exportCurrentAst(): void;
}

export class DataManager {
  constructor(private host: DataManagerHost) {}

  private updateButton(id: string): string {
    const p = this.host.pendingUpdates.find(u => u.id === id);
    return p ? `<button class="btn btn-small btn-update" data-action="update-default" data-id="${id}">Update</button>` : '';
  }

  show(): void {
    const result = createModal({ toggle: '.settings-overlay', modalClass: 'settings-modal dm-modal' });
    if (!result) return;
    const { modal, close } = result;

    const renderContent = async (): Promise<void> => {
      const storedMcus = await this.host.listStoredMcus();
      const projects = await this.host.listProjects();
      const customExports = await loadCustomExports();

      // Storage usage from IDB (gigabytes-scale) replaces the old
      // ~5 MB localStorage budget. The estimate is best-effort.
      const usage = await getKv().estimate();
      const usedKB = usage ? (usage.usedBytes / 1024).toFixed(0) : '?';
      const limitKB = usage && usage.quotaBytes > 0 ? (usage.quotaBytes / 1024).toFixed(0) : '?';

      const hasMcu = this.host.currentMcu !== null;
      const hasDma = this.host.currentMcu?.dma !== undefined;
      const parseResult = this.host.constraintEditor.getParseResult();
      const hasAst = parseResult?.ast !== null && parseResult?.ast !== undefined;
      const solverSolutionCount = this.host.solverSolutions.getSolverResult()?.solutions.length ?? 0;

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
                <span class="dm-name">MCU: ${hasMcu ? this.host.currentMcu!.refName : '(none)'}</span>
                <button class="btn btn-small" data-action="export-current-mcu" ${hasMcu ? '' : 'disabled'}>Export MCU</button>
                <button class="btn btn-small" data-action="export-current-dma" ${hasDma ? '' : 'disabled'}>Export DMA</button>
                <button class="btn btn-small" data-action="export-current-ast" ${hasAst ? '' : 'disabled'}>Export AST</button>
              </div>
              <div class="dm-row">
                <span class="dm-name">Solver solutions: ${solverSolutionCount}</span>
                <button class="btn btn-small" data-action="export-current-solutions" ${solverSolutionCount > 0 ? '' : 'disabled'}>Export Solutions</button>
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
                <div class="dm-row" data-project="${escHtml(p.name)}">
                  <span class="dm-expand-btn" data-action="toggle-versions" data-name="${escHtml(p.name)}" data-idx="${idx}">${p.versionCount > 0 ? '&#9654;' : ''}</span>
                  <span class="dm-name">${escHtml(p.name)}${p.name === this.host.currentProjectName ? ' (active)' : ''}</span>
                  <span class="dm-tags">${p.tags.map(t => `<span class="dm-tag">${t}</span>`).join('')}${p.versionCount > 0 ? `<span class="dm-tag">v${p.versionCount}</span>` : ''}</span>
                  <span class="dm-size">${(p.size / 1024).toFixed(1)}KB</span>
                  <button class="btn btn-small dm-load" data-action="load-project" data-name="${escHtml(p.name)}">Load</button>
                  <button class="btn btn-small" data-action="export-project" data-name="${escHtml(p.name)}">Export</button>
                  <button class="btn btn-small dm-delete" data-action="delete-project" data-name="${escHtml(p.name)}">Delete</button>
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
                    <span class="dm-name">${escHtml(fn.name)}</span>
                    <span class="dm-size" style="min-width:auto">${escHtml(fn.description)}</span>
                    <button class="btn btn-small" data-action="edit-export" data-export-id="${fn.id}">Edit</button>
                    ${this.updateButton(fn.id)}
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
              ${this.updateButton('macro-library')}
            </div>
          </section>

          <section class="settings-section">
            <h3>Common-error Lint Library</h3>
            <p class="settings-hint">Groups of signal names that are commonly swapped by mistake (miso/mosi, tx/rx, …). One group per line, tokens space-separated. Warns when a channel name and its signal pattern reference different tokens from the same group.</p>
            <div style="margin-top:6px">
              <button class="btn btn-small" data-action="edit-lint-lib">Edit</button>
              <button class="btn btn-small" data-action="reset-lint-lib">Reset to Default</button>
              ${this.updateButton('common-errors-library')}
            </div>
          </section>

          <section class="settings-section">
            <h3>Peripheral Library</h3>
            <p class="settings-hint">Snippets offered by the editor's double-click helper. Each <code>#Name</code> block lists channel mappings and <code>require</code> lines for a peripheral.</p>
            <div style="margin-top:6px">
              <button class="btn btn-small" data-action="edit-peripheral-lib">Edit</button>
              <button class="btn btn-small" data-action="reset-peripheral-lib">Reset to Default</button>
              ${this.updateButton('peripheral-library')}
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
              await this.host.loadStoredMcu(name);
              close();
              break;
            case 'export-mcu':
              this.host.exportMcuData(name);
              break;
            case 'export-current-mcu':
              this.host.exportCurrentMcu();
              break;
            case 'export-current-dma':
              this.host.exportCurrentDma();
              break;
            case 'export-current-ast':
              this.host.exportCurrentAst();
              break;
            case 'export-current-solutions':
              this.host.exportCurrentSolutions();
              break;
            case 'delete-mcu':
              await getKv().delete(`mcu-xml:${name}`);
              await getKv().delete(`mcu-meta:${name}`);
              void renderContent();
              break;
            case 'reimport-all':
              this.host.reimportAllMcus();
              void renderContent();
              break;
            case 'load-project':
              this.host.loadProject(name);
              close();
              break;
            case 'export-project':
              this.host.exportProjectData(name);
              break;
            case 'delete-project':
              this.host.deleteProject(name);
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
              this.host.loadProjectVersion(name, versionId);
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
            case 'update-default': {
              const id = (btn as HTMLElement).dataset.id;
              const pending = this.host.pendingUpdates.find(u => u.id === id);
              if (!pending) break;
              if (!confirm(`Update "${pending.label}" to the shipped version?\n\nYour changes to it will be replaced.`)) break;
              await applyDefaultUpdate(pending);
              await this.host.refreshDefaultUpdates();
              this.host.showStatus(`${pending.label} updated`, 'success');
              void renderContent();
              break;
            }
            case 'reset-macro-lib':
              await saveMacroLibrary(DEFAULT_MACRO_LIBRARY.trim());
              await markSyncedWithDefault('macro-library', DEFAULT_MACRO_LIBRARY.trim());
              await primeStdlibSource();
              await this.host.refreshDefaultUpdates();
              break;
            case 'edit-lint-lib':
              this.showLintLibEditor();
              break;
            case 'reset-lint-lib':
              await saveCommonErrorsLibrary(DEFAULT_COMMON_ERRORS_LIBRARY.trim());
              await markSyncedWithDefault('common-errors-library', DEFAULT_COMMON_ERRORS_LIBRARY.trim());
              primeCommonErrorsLib(DEFAULT_COMMON_ERRORS_LIBRARY.trim());
              await this.host.refreshDefaultUpdates();
              this.host.showStatus('Lint library reset to default', 'success');
              break;
            case 'edit-peripheral-lib':
              this.showPeripheralLibEditor();
              break;
            case 'reset-peripheral-lib':
              await savePeripheralLibrary(DEFAULT_PERIPHERAL_LIBRARY.trim());
              await markSyncedWithDefault('peripheral-library', DEFAULT_PERIPHERAL_LIBRARY.trim());
              await primePeripheralSource();
              await this.host.refreshDefaultUpdates();
              this.host.showStatus('Peripheral library reset to default', 'success');
              break;
            case 'save-data-url': {
              const input = modal.querySelector('#dm-data-url') as HTMLInputElement | null;
              if (input) {
                getDataSource().setUrl(input.value);
                this.host.showStatus(input.value ? `Data URL saved: ${input.value}` : 'Data URL cleared', 'success');
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
                  this.host.activateLoadedMcu(hit);
                  close();
                  return;
                }
              }
              this.host.showStatus(`Cached MCU "${name}" not found (cache may have evicted)`, 'error');
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
      this.host.showStatus(`Loading ${die}…`, 'info');
      const mcus = await getDataSource().loadDie(die, signal);
      if (mcus.length === 0) {
        this.host.showStatus(`No package variants in ${die}`, 'error');
        return;
      }
      if (mcus.length === 1) {
        this.host.activateLoadedMcu(mcus[0]);
        closeBrowser();
        return;
      }
      this.showVariantPicker(die, mcus, closeBrowser);
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as Error).name === 'AbortError') return;
      this.host.showStatus(`Failed to load ${die}: ${msg}`, 'error');
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
        this.host.activateLoadedMcu(mcus[idx]);
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
          <div id="export-editor-host" class="code-editor-wrap"></div>
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
pinComments - Object {pinName: comment} from pin decls
params      - Object {key: value} of your declared parameters
docs        - {datasheet, refmanual, errata} URLs or null
constraintsHeader - leading # comment block of the constraints</pre>
            <strong>Parameters:</strong> declare with comment lines; the user
            gets an input dialog before the export runs (last values are remembered):
            <pre>// param: &lt;key&gt; &lt;bool|string|int|float&gt; = &lt;default&gt; | &lt;Label&gt; | &lt;doc&gt;
// param: fmt enum(csv,tsv,md) = csv | Format | Output format</pre>
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

      const editor = createCodeEditor({ highlighter: highlightJs });
      const codeEl = editor.textarea;
      codeEl.value = current.code;
      editor.refresh();
      modal.querySelector('#export-editor-host')!.appendChild(editor.wrapper);

      modal.querySelector('#export-editor-help')!.addEventListener('click', () => {
        const panel = modal.querySelector('#export-editor-help-panel') as HTMLElement;
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
      });

      modal.querySelector('#export-editor-test')!.addEventListener('click', () => {
        const errorEl = modal.querySelector('#export-editor-error') as HTMLElement;
        try {
          const code = codeEl.value;
          new Function('mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params', 'docs', 'constraintsHeader', code);
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
        const codeVal = codeEl.value;
        const errorEl = modal.querySelector('#export-editor-error') as HTMLElement;

        if (!nameVal) {
          errorEl.style.display = '';
          errorEl.style.color = 'var(--error)';
          errorEl.textContent = 'Name is required';
          return;
        }

        try {
          new Function('mcuName', 'mcuPackage', 'assignments', 'peripherals', 'pins', 'ports', 'pinComments', 'params', 'docs', 'constraintsHeader', codeVal);
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
        <div id="macro-lib-host" style="flex:1;min-height:200px;display:flex"></div>
        <div class="export-error" id="macro-lib-error" style="display:none"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end;flex-shrink:0">
          <button class="btn btn-small btn-primary" id="macro-lib-save">Save</button>
        </div>
      </div>
    `;

    const editor = createCodeEditor({ highlighter: highlightConstraintCode });
    const codeEl = editor.textarea;
    codeEl.value = currentSource;
    editor.refresh();
    const host = modal.querySelector('#macro-lib-host')!;
    host.appendChild(editor.wrapper);
    editor.wrapper.style.flex = '1';
    editor.wrapper.style.border = '1px solid var(--border)';
    editor.wrapper.style.borderRadius = '3px';
    const errorEl = modal.querySelector('#macro-lib-error') as HTMLElement;

    modal.querySelector('.settings-close')!.addEventListener('click', closeMacro);

    modal.querySelector('#macro-lib-reset')!.addEventListener('click', () => {
      codeEl.value = DEFAULT_MACRO_LIBRARY.trim();
      editor.refresh();
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
      this.host.showStatus('Lint library saved', 'success');
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
      this.host.showStatus('Peripheral library saved', 'success');
      close();
    });
  }


  private async renderVersionList(container: HTMLElement, projectName: string, overlay: HTMLElement, renderContent: () => void): Promise<void> {
    try {
      const projectData = await this.host.loadProjectData(projectName);
      if (!projectData) return;
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
          ${this.host.settings.dataInspector ? `<button class="btn btn-small" data-action="inspect-version" data-version-id="${v.id}">Inspect</button>` : ''}
          <button class="btn btn-small dm-delete" data-action="delete-version" data-version-id="${v.id}">Delete</button>
        </div>
        ${this.host.settings.dataInspector ? `<div class="dm-inspect-panel" data-inspect-version="${v.id}" style="display:none"></div>` : ''}`;
      }).join('');

      container.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = (btn as HTMLElement).dataset.action;
          const vId = parseInt((btn as HTMLElement).dataset.versionId || '0');
          if (action === 'restore-version') {
            await this.host.loadProjectVersion(projectName, vId);
            overlay.remove();
          } else if (action === 'delete-version') {
            await this.host.deleteProjectVersion(projectName, vId);
            const names = await this.host.listProjectNames();
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
}
