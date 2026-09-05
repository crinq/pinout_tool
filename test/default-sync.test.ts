import { describe, it, expect, beforeEach } from 'vitest';
import { setKv, type KvStore } from '../src/kv';
import { syncDefaults, applyDefaultUpdate, markSyncedWithDefault, loadCustomExports } from '../src/storage';
import { DEFAULT_LIBRARIES, DEFAULT_EXPORTS, contentHash, parseExportFile } from '../src/defaults';

/** In-memory KvStore so each test starts from a known state. */
class MemKv implements KvStore {
  map = new Map<string, string>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async set(k: string, v: string) { this.map.set(k, v); }
  async delete(k: string) { this.map.delete(k); }
  async keysWithPrefix(p: string) { return [...this.map.keys()].filter(k => k.startsWith(p)); }
  async estimate() { return null; }
}

let kv: MemKv;
beforeEach(() => { kv = new MemKv(); setKv(kv); });

const MACRO = DEFAULT_LIBRARIES.find(l => l.id === 'macro-library')!;

describe('bundled defaults', () => {
  it('ship all three libraries and at least one export', () => {
    expect(DEFAULT_LIBRARIES.map(l => l.id).sort())
      .toEqual(['common-errors-library', 'macro-library', 'peripheral-library']);
    expect(DEFAULT_EXPORTS.length).toBeGreaterThan(0);
    for (const l of DEFAULT_LIBRARIES) expect(l.text.length).toBeGreaterThan(0);
  });

  it('parses id/name/description out of an export file header', () => {
    const fn = parseExportFile('// id: my-id\n// name: My Name\n// description: does a thing\nreturn 1;\n', 'fallback');
    expect(fn).toEqual({ id: 'my-id', name: 'My Name', description: 'does a thing', code: 'return 1;' });
  });

  it('falls back to the filename when the header is missing', () => {
    expect(parseExportFile('return 1;', 'from-file').id).toBe('from-file');
  });

  it('hashes content, and only content', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('syncDefaults', () => {
  it('seeds a fresh install with no pending updates', async () => {
    expect(await syncDefaults()).toEqual([]);
    expect(await kv.get('macro-library')).toBe(MACRO.text);
    // loadCustomExports sorts by display name, DEFAULT_EXPORTS by id — compare as sets.
    expect((await loadCustomExports()).map(f => f.id).sort()).toEqual(DEFAULT_EXPORTS.map(f => f.id).sort());
  });

  it('is idempotent', async () => {
    await syncDefaults();
    const before = new Map(kv.map);
    expect(await syncDefaults()).toEqual([]);
    expect(kv.map).toEqual(before);
  });

  it('updates an untouched library in place when the default changes', async () => {
    await syncDefaults();
    // Simulate an older revision: same text, stale baseline hash.
    await kv.set('default-base:macro-library', contentHash('older revision'));
    await kv.set('macro-library', 'older revision');
    expect(await syncDefaults()).toEqual([]);           // nothing to ask about
    expect(await kv.get('macro-library')).toBe(MACRO.text);
  });

  it('reports — and preserves — a customised library', async () => {
    await syncDefaults();
    await kv.set('macro-library', '# my own macros');   // user edits
    await kv.set('default-base:macro-library', contentHash('older revision'));
    const pending = await syncDefaults();
    expect(pending.map(p => p.id)).toEqual(['macro-library']);
    expect(pending[0].kind).toBe('library');
    expect(await kv.get('macro-library')).toBe('# my own macros');   // untouched
  });

  it('keeps reporting until the user acts, then stops', async () => {
    await syncDefaults();
    await kv.set('macro-library', '# mine');
    await kv.set('default-base:macro-library', contentHash('older'));
    expect((await syncDefaults()).length).toBe(1);
    expect((await syncDefaults()).length).toBe(1);      // still pending
    await applyDefaultUpdate({ kind: 'library', id: 'macro-library', label: 'Macro Library' });
    expect(await syncDefaults()).toEqual([]);
    expect(await kv.get('macro-library')).toBe(MACRO.text);
  });

  it('a Reset clears the pending update too', async () => {
    await syncDefaults();
    await kv.set('macro-library', '# mine');
    await kv.set('default-base:macro-library', contentHash('older'));
    expect((await syncDefaults()).length).toBe(1);
    await kv.set('macro-library', MACRO.text);
    await markSyncedWithDefault('macro-library', MACRO.text);
    expect(await syncDefaults()).toEqual([]);
  });

  it('adds a newly shipped export without touching the user\'s own', async () => {
    await syncDefaults();
    const mine = { id: 'mine', name: 'Mine', description: '', code: 'return "x";' };
    await kv.set('custom-export:mine', JSON.stringify(mine));
    // Drop a built-in as if it had just been added to the bundle.
    await kv.delete('custom-export:' + DEFAULT_EXPORTS[0].id);
    await kv.delete('default-base:' + DEFAULT_EXPORTS[0].id);
    expect(await syncDefaults()).toEqual([]);
    const ids = (await loadCustomExports()).map(f => f.id).sort();
    expect(ids).toContain('mine');
    expect(ids).toContain(DEFAULT_EXPORTS[0].id);
  });

  it('reports a customised export function', async () => {
    await syncDefaults();
    const fn = DEFAULT_EXPORTS[0];
    await kv.set('custom-export:' + fn.id, JSON.stringify({ ...fn, code: 'return "edited";' }));
    await kv.set('default-base:' + fn.id, contentHash('older code'));
    const pending = await syncDefaults();
    expect(pending.map(p => p.id)).toEqual([fn.id]);
    expect(pending[0].kind).toBe('export');
    const stored = (await loadCustomExports()).find(f => f.id === fn.id)!;
    expect(stored.code).toBe('return "edited";');       // preserved
  });

  it('survives a corrupt stored export', async () => {
    await syncDefaults();
    await kv.set('custom-export:' + DEFAULT_EXPORTS[0].id, 'not json');
    await expect(syncDefaults()).resolves.toBeDefined();
  });
});
