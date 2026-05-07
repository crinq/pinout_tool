// ============================================================
// External MCU Data Source
//
// Fetches the unified vendor JSON catalogue (see ../mcu_data) from a URL
// the user configures in the Data Manager. Two responsibilities:
//
//   1. Index handling — pull `index.json` once, expose live filtering
//      against die metadata so the search overlay can render results
//      without fetching anything heavy.
//   2. Per-die fetch — load `mcu/<die>.json` on demand, parse via
//      `parseMcuJson`, return one or more `Mcu` records (one per
//      package variant).
//
// Cache scope is **transient** by user request — entries live until page
// reload. LRU bounded by either count (default 10) or total approx
// payload size (default 500 KB), whichever fills first. AbortController
// support so the solver's "abort" button can cancel in-flight fetches.
//
// Storage: only the URL is persisted (`localStorage['mcu-data-url']`).
// Long-term saving of fetched MCUs to localStorage is out of scope for
// the first revision.
// ============================================================

import { parseMcuJson, type McuJsonDocument } from './parser/mcu-json-parser';
import { parseMcuJsonDoc } from './parser/mcu-json-parser';
import type { Mcu } from './types';

// ============================================================
// Index schema (the slice this module consumes)
// ============================================================

export interface IndexCoreInfo {
  name: string;
  freq_max_hz?: number;
}

export interface IndexDeviceEntry {
  /** Path relative to the vendor index, e.g. `mcu/stm32c011d6.json`. */
  file: string;
  family: string;
  sub_family?: string;
  cores?: IndexCoreInfo[];
  flash_bytes?: number;
  ram_bytes?: number;
  packages?: string[];
}

export interface IndexDocument {
  schema_version?: number;
  vendor?: string;
  vendors?: Record<string, { index?: string }>;
  device_count?: number;
  devices?: Record<string, IndexDeviceEntry>;
}

// ============================================================
// Configuration + persistent storage
// ============================================================

const URL_STORAGE_KEY = 'mcu-data-url';

/**
 * Default catalogue URL. Used when the user hasn't picked one yet — saves
 * a setup step for first-run users. The user can still Clear (which
 * persists an empty string and disables the default) or Save a custom
 * URL.
 */
export const DEFAULT_DATA_URL =
  'https://raw.githubusercontent.com/crinq/mcu_data_generated/refs/heads/master/data/';

/**
 * Read the configured data source URL from localStorage.
 *
 * Three states:
 *   - storage has a non-empty string → that string (user-configured).
 *   - storage has an empty string    → null (user explicitly cleared).
 *   - storage has no key             → DEFAULT_DATA_URL (fresh install).
 */
export function getDataSourceUrl(): string | null {
  try {
    const stored = localStorage.getItem(URL_STORAGE_KEY);
    if (stored === null) return DEFAULT_DATA_URL;
    if (stored.trim() === '') return null;
    return stored;
  } catch {
    return DEFAULT_DATA_URL;
  }
}

/**
 * Persist the data source URL. An empty string is stored verbatim and
 * means "explicitly disabled" (so the default doesn't bounce back in).
 */
export function setDataSourceUrl(url: string): void {
  try {
    localStorage.setItem(URL_STORAGE_KEY, url.trim());
  } catch {
    // Non-fatal — running without storage just means user re-enters URL.
  }
}

// ============================================================
// LRU cache
// ============================================================

interface CachedEntry {
  /** Approximate byte size (string length is good enough for budgeting). */
  size: number;
  /** Parsed Mcu records produced from this die's JSON. */
  mcus: Mcu[];
  /** Raw document so we can re-emit if a future API needs it. */
  doc: McuJsonDocument;
}

const DEFAULT_MAX_ENTRIES = 10;
const DEFAULT_MAX_BYTES = 500 * 1024;

class LruCache {
  // Map iteration order = insertion order; we promote on hit by re-setting.
  private store = new Map<string, CachedEntry>();
  private bytes = 0;

  constructor(
    private maxEntries: number,
    private maxBytes: number,
  ) {}

  get(key: string): CachedEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    // Promote: delete + re-set moves it to the most-recent position.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedEntry): void {
    if (this.store.has(key)) {
      const old = this.store.get(key)!;
      this.bytes -= old.size;
      this.store.delete(key);
    }
    this.store.set(key, entry);
    this.bytes += entry.size;
    while (
      (this.store.size > this.maxEntries || this.bytes > this.maxBytes)
      && this.store.size > 0
    ) {
      const oldestKey = this.store.keys().next().value as string;
      const oldest = this.store.get(oldestKey)!;
      this.bytes -= oldest.size;
      this.store.delete(oldestKey);
    }
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
    this.bytes = 0;
  }

  /** Diagnostic accessor — kept exported only via DataSource.stats(). */
  size(): number { return this.store.size; }
  totalBytes(): number { return this.bytes; }

  /** Enumerate every cached entry in LRU order (oldest first). */
  entries(): Array<{ key: string; entry: CachedEntry }> {
    return [...this.store.entries()].map(([key, entry]) => ({ key, entry }));
  }

  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.bytes -= entry.size;
    this.store.delete(key);
    return true;
  }
}

// ============================================================
// DataSource
// ============================================================

export interface DataSourceOptions {
  /** Override storage-loaded URL for this instance. */
  url?: string;
  /** Cache size limits. Defaults: 10 entries / 500 KB. */
  maxEntries?: number;
  maxBytes?: number;
  /** Custom fetch (used by tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchProgress {
  total: number;
  completed: number;
  failed: number;
  current?: string;
}

export interface FetchManyResult {
  mcus: Mcu[];
  errors: { die: string; error: string }[];
  cancelled: boolean;
}

export class DataSource {
  private indexCache: IndexDocument | null = null;
  private cache: LruCache;
  private fetchImpl: typeof fetch;
  private explicitUrl: string | undefined;

  constructor(opts: DataSourceOptions = {}) {
    this.cache = new LruCache(
      opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
      opts.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.explicitUrl = opts.url;
  }

  /** Resolve the active base URL (instance override > storage). */
  baseUrl(): string | null {
    return this.explicitUrl ?? getDataSourceUrl();
  }

  /** Drop both index + per-die caches. Call when the URL changes. */
  clearCache(): void {
    this.indexCache = null;
    this.cache.clear();
  }

  setUrl(url: string): void {
    setDataSourceUrl(url);
    this.explicitUrl = undefined; // storage now wins
    this.clearCache();
  }

  stats(): { entries: number; bytes: number; hasIndex: boolean } {
    return {
      entries: this.cache.size(),
      bytes: this.cache.totalBytes(),
      hasIndex: this.indexCache !== null,
    };
  }

  /**
   * Snapshot of every cached die (in LRU order, oldest first). Each entry
   * holds the parsed variant `Mcu`s plus the raw byte size of the JSON
   * the cache is accounting against its budget. UI rendering walks this
   * list to surface remote-fetched MCUs alongside locally-stored ones.
   */
  listCached(): Array<{ die: string; mcus: Mcu[]; bytes: number }> {
    return this.cache.entries().map(({ key, entry }) => ({
      die: key,
      mcus: entry.mcus,
      bytes: entry.size,
    }));
  }

  /** Drop a single cached die (e.g. on user "Discard" click). */
  evict(die: string): boolean {
    return this.cache.delete(die);
  }

  /** Fetch (or return cached) vendor index. Throws if no URL configured. */
  async loadIndex(signal?: AbortSignal): Promise<IndexDocument> {
    if (this.indexCache) return this.indexCache;
    const base = this.baseUrl();
    if (!base) throw new Error('No MCU data URL configured');

    // Two-step: top-level catalogue → first vendor index.
    const topUrl = joinUrl(base, 'index.json');
    const top = await this.fetchJson<IndexDocument>(topUrl, signal);
    if (top.devices) {
      // Vendor-index file already at this URL.
      this.indexCache = top;
      return top;
    }
    if (top.vendors) {
      // Catalogue file: pick first vendor. Most data sources expose stm32.
      const vendorKey = Object.keys(top.vendors)[0];
      const rel = top.vendors[vendorKey]?.index;
      if (!rel) throw new Error(`Vendor catalogue at ${topUrl} has no usable index pointer`);
      const vendorUrl = joinUrl(base, rel);
      const vendor = await this.fetchJson<IndexDocument>(vendorUrl, signal);
      this.indexCache = vendor;
      // Stash the vendor base path so per-die fetches resolve `mcu/...`
      // against the same dir.
      (this.indexCache as IndexDocument & { __vendorBase?: string }).__vendorBase = stripFile(vendorUrl);
      return vendor;
    }
    throw new Error(`Unrecognised index format at ${topUrl}`);
  }

  /** List dies that pass a name predicate. Loads the index lazily. */
  async listDies(
    predicate: (die: string, entry: IndexDeviceEntry) => boolean,
    signal?: AbortSignal,
  ): Promise<{ die: string; entry: IndexDeviceEntry }[]> {
    const idx = await this.loadIndex(signal);
    const out: { die: string; entry: IndexDeviceEntry }[] = [];
    for (const [die, entry] of Object.entries(idx.devices ?? {})) {
      if (predicate(die, entry)) out.push({ die, entry });
    }
    return out;
  }

  /** Fetch a single die's JSON and parse into per-variant Mcu list. */
  async loadDie(die: string, signal?: AbortSignal): Promise<Mcu[]> {
    const cached = this.cache.get(die);
    if (cached) return cached.mcus;
    const idx = await this.loadIndex(signal);
    const entry = idx.devices?.[die];
    if (!entry) throw new Error(`Die ${die} not found in index`);
    const base = this.vendorBase();
    const url = joinUrl(base, entry.file);
    const text = await this.fetchText(url, signal);
    const doc = JSON.parse(text) as McuJsonDocument;
    const mcus = parseMcuJsonDoc(doc);
    this.cache.set(die, { size: text.length, mcus, doc });
    return mcus;
  }

  /**
   * Fetch many dies in parallel, reporting progress and supporting
   * cancellation. Failures are collected per-die so a single bad fetch
   * doesn't abort the whole batch.
   */
  async loadManyDies(
    dies: string[],
    opts: { signal?: AbortSignal; onProgress?: (p: FetchProgress) => void; concurrency?: number } = {},
  ): Promise<FetchManyResult> {
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const errors: { die: string; error: string }[] = [];
    const collected: Mcu[] = [];
    const total = dies.length;
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    const tick = (current?: string) => {
      opts.onProgress?.({ total, completed, failed, current });
    };
    tick();

    let next = 0;
    const worker = async () => {
      while (next < dies.length) {
        if (opts.signal?.aborted) { cancelled = true; return; }
        const idx = next++;
        const die = dies[idx];
        try {
          const mcus = await this.loadDie(die, opts.signal);
          collected.push(...mcus);
        } catch (err) {
          if (opts.signal?.aborted) { cancelled = true; return; }
          failed++;
          errors.push({ die, error: (err as Error).message });
        }
        completed++;
        tick(die);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { mcus: collected, errors, cancelled };
  }

  // --------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------

  private vendorBase(): string {
    const base = this.baseUrl();
    if (!base) throw new Error('No MCU data URL configured');
    const stashed = (this.indexCache as IndexDocument & { __vendorBase?: string } | null)?.__vendorBase;
    return stashed ?? base;
  }

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    return JSON.parse(await this.fetchText(url, signal)) as T;
  }

  private async fetchText(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }
}

// ============================================================
// URL helpers
// ============================================================

/** Append a relative path to a URL or filesystem-style base. */
function joinUrl(base: string, rel: string): string {
  if (/^https?:|^file:/.test(rel)) return rel;
  if (base.endsWith('/')) return base + rel;
  return base + '/' + rel;
}

/** Strip the file portion off a URL, leaving the directory base. */
function stripFile(url: string): string {
  const idx = url.lastIndexOf('/');
  return idx >= 0 ? url.substring(0, idx + 1) : url + '/';
}

// ============================================================
// Convenience: process-wide singleton (used by app + UI)
// ============================================================

let shared: DataSource | null = null;

/** Default app-wide DataSource instance. */
export function getDataSource(): DataSource {
  if (!shared) shared = new DataSource();
  return shared;
}

/** Replace the singleton (mostly for tests). */
export function setDataSource(ds: DataSource): void {
  shared = ds;
}

// Re-export so callers can do a one-shot parse without importing the parser.
export { parseMcuJson };
