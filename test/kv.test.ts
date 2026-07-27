// ============================================================
// Tests for src/kv.ts — hybrid routing + migration idempotency
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { getKv, setKv, migrateLocalStorageToIdb, LOCAL_ONLY_KEYS } from '../src/kv';

// In-memory localStorage shim (vitest jsdom build doesn't expose a usable one).
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}
installLocalStorage();

// Per-test IDB reset. fake-indexeddb honors deleteDatabase but our
// shared singleton holds an open connection that blocks deletion, so
// we just wipe every entry instead. Simpler, idempotent.
async function freshIdb(): Promise<void> {
  setKv(null as unknown as never);     // drop singleton
  const kv = getKv();
  for (const prefix of ['mcu-xml:', 'mcu-meta:', 'dma-xml:', 'project:', 'custom-export:', 'macro-library']) {
    const keys = await kv.keysWithPrefix(prefix);
    for (const k of keys) await kv.delete(k);
  }
}

describe('KV — hybrid routing', () => {
  beforeEach(async () => {
    localStorage.clear();
    await freshIdb();
  });

  it('keys not on the LOCAL_ONLY list go to IDB', async () => {
    const kv = getKv();
    await kv.set('mcu-xml:STM32X', 'big-blob');
    // localStorage should NOT have it.
    expect(localStorage.getItem('mcu-xml:STM32X')).toBeNull();
    // But the kv read must succeed.
    expect(await kv.get('mcu-xml:STM32X')).toBe('big-blob');
  });

  it('LOCAL_ONLY keys stay on localStorage', async () => {
    const kv = getKv();
    expect(LOCAL_ONLY_KEYS.has('theme-mode')).toBe(true);
    await kv.set('theme-mode', 'dark');
    expect(localStorage.getItem('theme-mode')).toBe('dark');
    expect(await kv.get('theme-mode')).toBe('dark');
  });

  it('keysWithPrefix unions both backends', async () => {
    const kv = getKv();
    await kv.set('project:a', '1');
    await kv.set('project:b', '2');
    const keys = await kv.keysWithPrefix('project:');
    expect(keys.sort()).toEqual(['project:a', 'project:b']);
  });

  it('delete removes from the correct backend', async () => {
    const kv = getKv();
    await kv.set('mcu-xml:Z', 'gone');
    await kv.delete('mcu-xml:Z');
    expect(await kv.get('mcu-xml:Z')).toBeNull();
  });
});

describe('KV — migration', () => {
  beforeEach(async () => {
    localStorage.clear();
    await freshIdb();
  });

  it('copies migratable keys from localStorage into IDB and clears originals', async () => {
    // Seed legacy localStorage values.
    localStorage.setItem('mcu-xml:STM32A', '<xml>a</xml>');
    localStorage.setItem('mcu-meta:STM32A', '{"tags":["PIN"]}');
    localStorage.setItem('dma-xml:V1', '<dma/>');
    localStorage.setItem('project:proj1', '{"name":"proj1"}');
    localStorage.setItem('custom-export:fn1', '{"id":"fn1"}');
    localStorage.setItem('macro-library', 'macros');
    // Non-migratable keys must survive.
    localStorage.setItem('theme-mode', 'dark');
    localStorage.setItem('mcu-data-url', 'https://example/');

    const result = await migrateLocalStorageToIdb();
    expect(result.moved).toBeGreaterThanOrEqual(6);

    // Heavy keys moved to IDB → readable via kv, removed from localStorage.
    const kv = getKv();
    expect(await kv.get('mcu-xml:STM32A')).toBe('<xml>a</xml>');
    expect(localStorage.getItem('mcu-xml:STM32A')).toBeNull();

    expect(await kv.get('project:proj1')).toBe('{"name":"proj1"}');
    expect(localStorage.getItem('project:proj1')).toBeNull();

    expect(await kv.get('macro-library')).toBe('macros');
    expect(localStorage.getItem('macro-library')).toBeNull();

    // LOCAL_ONLY untouched.
    expect(localStorage.getItem('theme-mode')).toBe('dark');
    expect(localStorage.getItem('mcu-data-url')).toBe('https://example/');

    // Flag set.
    expect(localStorage.getItem('idb-migrated')).toBe('1');
  });

  it('is idempotent — second call is a no-op', async () => {
    localStorage.setItem('mcu-xml:S', 'x');
    const first = await migrateLocalStorageToIdb();
    const second = await migrateLocalStorageToIdb();
    expect(first.moved).toBe(1);
    expect(second.moved).toBe(0);
  });
});

describe('KV — quota probe', () => {
  beforeEach(async () => {
    localStorage.clear();
    await freshIdb();
  });

  it('returns null when navigator.storage.estimate is unavailable', async () => {
    // fake-indexeddb doesn't ship a navigator.storage shim. Stub it.
    const original = (navigator as unknown as { storage?: unknown }).storage;
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    try {
      const est = await getKv().estimate();
      expect(est).toBeNull();
    } finally {
      Object.defineProperty(navigator, 'storage', { value: original, configurable: true });
    }
  });

  it('returns numbers when the browser supports it', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage: 1234, quota: 999_999 }) },
      configurable: true,
    });
    const est = await getKv().estimate();
    expect(est).toEqual({ usedBytes: 1234, quotaBytes: 999_999 });
  });
});

// `vi` referenced to silence unused warning if you remove a test above.
void vi;
