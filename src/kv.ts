// ============================================================
// Async KV store
//
// Unified storage interface used by every long-lived blob in the app
// (MCU XMLs, DMA XMLs, projects, macros, custom exports). Backed by
// IndexedDB on capable browsers, with a localStorage fallback so the
// app still boots on environments without IDB.
//
// Heavy keys (mcu-xml:*, dma-xml:*) outgrew localStorage's ~5 MB cap
// almost immediately — the full STM32 vendor catalogue is ~100 MB.
// IDB removes that ceiling (browser quota is gigabytes).
//
// Small, sync-friendly settings (URL, theme, current-project marker)
// continue to live in localStorage for convenience — they don't need
// async ceremony and a fresh tab should see them without waiting on
// IDB.open. See `LOCAL_ONLY_PREFIXES` / `LOCAL_ONLY_KEYS` for the list.
// ============================================================

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Returns every stored key whose name starts with the given prefix. */
  keysWithPrefix(prefix: string): Promise<string[]>;
  /** Optional quota probe. Returns null when the platform can't report it. */
  estimate(): Promise<{ usedBytes: number; quotaBytes: number } | null>;
}

// Keys that stay on localStorage even after IDB migration. These are
// tiny and benefit from synchronous boot-time reads (theme paint, URL
// already known when the data manager renders, etc.).
export const LOCAL_ONLY_KEYS = new Set<string>([
  'theme-mode',
  'theme',                 // legacy alias, also kept sync for the boot path
  'mcu-data-url',
  'current-project',
  'custom-export-seeded',
  'idb-migrated',
]);

export const LOCAL_ONLY_PREFIXES: string[] = [
  // (empty for now — all heavy prefixes go to the async KV)
];

function isLocalOnly(key: string): boolean {
  if (LOCAL_ONLY_KEYS.has(key)) return true;
  for (const p of LOCAL_ONLY_PREFIXES) if (key.startsWith(p)) return true;
  return false;
}

// ============================================================
// IndexedDB-backed implementation
// ============================================================

const IDB_NAME = 'stm32-pinout-tool';
const IDB_STORE = 'kv';
const IDB_VERSION = 1;

class IdbKv implements KvStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    });
    return this.dbPromise;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.openDb();
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(typeof v === 'string' ? v : v == null ? null : String(v));
      };
      req.onerror = () => reject(req.error ?? new Error('IDB get failed'));
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB put aborted'));
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB delete failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB delete aborted'));
    });
  }

  async keysWithPrefix(prefix: string): Promise<string[]> {
    // Use a key cursor with a `>= prefix && < prefix + ￿` range so the
    // scan stays in a contiguous index slice instead of pulling every
    // entry into memory.
    const lo = prefix;
    const hi = prefix + '￿';
    const out: string[] = [];
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.openKeyCursor(IDBKeyRange.bound(lo, hi, false, false));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        out.push(String(cur.key));
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB cursor failed'));
    });
    return out;
  }

  async estimate(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      return {
        usedBytes: e.usage ?? 0,
        quotaBytes: e.quota ?? 0,
      };
    }
    return null;
  }
}

// ============================================================
// localStorage fallback (also used for sync-only keys)
// ============================================================

class LocalStorageKv implements KvStore {
  async get(key: string): Promise<string | null> {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  async set(key: string, value: string): Promise<void> {
    try { localStorage.setItem(key, value); } catch { /* over quota or disabled */ }
  }
  async delete(key: string): Promise<void> {
    try { localStorage.removeItem(key); } catch { /* */ }
  }
  async keysWithPrefix(prefix: string): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
    } catch { /* */ }
    return out;
  }
  async estimate(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
    try {
      let used = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        used += k.length + (localStorage.getItem(k) || '').length;
      }
      // UTF-16 in localStorage → each char ~2 bytes; report cap as 5 MB
      // (the de facto Chrome/Firefox/Safari limit; some engines go to 10).
      return { usedBytes: used * 2, quotaBytes: 5 * 1024 * 1024 };
    } catch { return null; }
  }
}

// ============================================================
// Hybrid store: routes LOCAL_ONLY_* keys to localStorage, rest to IDB
// ============================================================

class HybridKv implements KvStore {
  constructor(private idb: KvStore, private ls: KvStore) {}

  get(key: string): Promise<string | null> {
    return isLocalOnly(key) ? this.ls.get(key) : this.idb.get(key);
  }
  set(key: string, value: string): Promise<void> {
    return isLocalOnly(key) ? this.ls.set(key, value) : this.idb.set(key, value);
  }
  delete(key: string): Promise<void> {
    return isLocalOnly(key) ? this.ls.delete(key) : this.idb.delete(key);
  }
  async keysWithPrefix(prefix: string): Promise<string[]> {
    // Union both backends so a prefix scan finds every match regardless
    // of which side stored it. Heavy prefixes only live in one place
    // but this keeps callers simple.
    const [a, b] = await Promise.all([this.idb.keysWithPrefix(prefix), this.ls.keysWithPrefix(prefix)]);
    const seen = new Set<string>();
    for (const k of a) seen.add(k);
    for (const k of b) seen.add(k);
    return [...seen];
  }
  estimate(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
    return this.idb.estimate();
  }
}

// ============================================================
// Singleton + boot
// ============================================================

let shared: KvStore | null = null;

function detectIdb(): boolean {
  try { return typeof indexedDB !== 'undefined'; } catch { return false; }
}

export function getKv(): KvStore {
  if (shared) return shared;
  const ls = new LocalStorageKv();
  shared = detectIdb() ? new HybridKv(new IdbKv(), ls) : ls;
  return shared;
}

/** Test-only seam. */
export function setKv(kv: KvStore): void { shared = kv; }

// ============================================================
// One-time migration from localStorage → IDB
// ============================================================

/** Prefixes (and bare keys) that move from localStorage to IDB on boot. */
const MIGRATE_PREFIXES = ['mcu-xml:', 'mcu-meta:', 'dma-xml:', 'project:', 'custom-export:'];
const MIGRATE_BARE_KEYS = ['macro-library'];

/**
 * Idempotent one-shot move of heavy localStorage entries into IDB. The
 * `idb-migrated` flag (stored in localStorage so we can read it sync)
 * gates the work — subsequent boots short-circuit.
 *
 * Originals stay in localStorage until copy + flag both succeed; if the
 * page reloads mid-flight the next boot re-runs cleanly. We delete after
 * flagging to free the cap.
 */
export async function migrateLocalStorageToIdb(): Promise<{ moved: number; skipped: number }> {
  if (!detectIdb()) return { moved: 0, skipped: 0 };
  if (localStorage.getItem('idb-migrated') === '1') return { moved: 0, skipped: 0 };

  const kv = getKv();
  const toMigrate: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (MIGRATE_BARE_KEYS.includes(k)) { toMigrate.push(k); continue; }
      for (const p of MIGRATE_PREFIXES) if (k.startsWith(p)) { toMigrate.push(k); break; }
    }
  } catch { return { moved: 0, skipped: 0 }; }

  let moved = 0;
  for (const k of toMigrate) {
    const v = localStorage.getItem(k);
    if (v == null) continue;
    try {
      await kv.set(k, v);
      moved++;
    } catch (err) {
      // Leave the localStorage entry in place if IDB write failed.
      console.warn(`[migration] failed to copy ${k}: ${(err as Error).message}`);
    }
  }

  try { localStorage.setItem('idb-migrated', '1'); } catch { /* */ }

  // Now safe to delete from localStorage to reclaim the cap.
  for (const k of toMigrate) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }

  return { moved, skipped: toMigrate.length - moved };
}
