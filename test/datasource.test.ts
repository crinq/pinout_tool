// ============================================================
// DataSource tests
// (LRU cache eviction, AbortController, index resolution)
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataSource } from '../src/datasource';

// jsdom in this vitest setup doesn't ship a working localStorage, so we
// install a tiny in-memory polyfill before the DataSource sees it.
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VENDOR_INDEX = {
  schema_version: 1,
  vendor: 'stm32',
  device_count: 3,
  devices: {
    stm32a: {
      file: 'mcu/stm32a.json',
      family: 'stm32a', cores: [{ name: 'cm0', freq_max_hz: 48_000_000 }],
      flash_bytes: 32_768, ram_bytes: 6_144, packages: ['LQFP32'],
    },
    stm32b: {
      file: 'mcu/stm32b.json',
      family: 'stm32b', cores: [{ name: 'cm0', freq_max_hz: 48_000_000 }],
      flash_bytes: 16_384, ram_bytes: 4_096, packages: ['LQFP32'],
    },
    stm32c: {
      file: 'mcu/stm32c.json',
      family: 'stm32c', cores: [{ name: 'cm4', freq_max_hz: 168_000_000 }],
      flash_bytes: 1_048_576, ram_bytes: 131_072, packages: ['LQFP100'],
    },
  },
};

function dieDoc(name: string, variant: string, pkg = 'LQFP32') {
  return {
    schema: 1,
    name,
    family: 'stm32a',
    line: 'STM32Test',
    cores: [{ name: 'cm0', freq_max_hz: 48_000_000 }],
    voltage: { min_v: 1.7, max_v: 3.6 },
    temperature: { min_c: -40, max_c: 85 },
    memory: [
      { kind: 'flash', size: 32 * 1024 } as { kind: string; size: number; name?: string },
      { kind: 'ram', size: 6 * 1024, name: 'SRAM' },
    ],
    packages: [{
      name: pkg,
      variant,
      pins: [{ position: '1', name: 'PA0', alt_names: [] }],
    }],
    peripherals: [{
      name: 'USART1', kind: 'usart', version: 'v1',
      pins: [{ pin: 'PA0', signal: 'TX', af: 1 }],
    }],
  };
}

describe('DataSource', () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory storage so URL persistence doesn't leak.
    localStorage.clear();
  });

  // --------------------------------------------------------------
  // URL persistence
  // --------------------------------------------------------------

  it('persists configured URL across instances via localStorage', () => {
    const ds1 = new DataSource();
    ds1.setUrl('https://example.com/data');
    expect(ds1.baseUrl()).toBe('https://example.com/data');
    const ds2 = new DataSource();
    expect(ds2.baseUrl()).toBe('https://example.com/data');
  });

  // --------------------------------------------------------------
  // Index loading
  // --------------------------------------------------------------

  it('loads vendor index from a base URL whose root file is the vendor index', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      throw new Error(`Unexpected fetch ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const idx = await ds.loadIndex();
    expect(idx.devices && Object.keys(idx.devices)).toEqual(['stm32a', 'stm32b', 'stm32c']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows two-step catalogue → vendor index when needed', async () => {
    const top = {
      vendors: { stm32: { index: 'stm32/index.json' } },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://x.test/data/index.json') return jsonResponse(top);
      if (url === 'https://x.test/data/stm32/index.json') return jsonResponse(VENDOR_INDEX);
      throw new Error(`Unexpected fetch ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const idx = await ds.loadIndex();
    expect(idx.device_count).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------
  // Per-die fetch + parse
  // --------------------------------------------------------------

  it('fetches a die and parses to one Mcu per variant', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(dieDoc('stm32a', 'STM32A_LQFP32x'));
      throw new Error(`Unexpected fetch ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const mcus = await ds.loadDie('stm32a');
    expect(mcus).toHaveLength(1);
    expect(mcus[0].refName).toBe('STM32A_LQFP32x');
    expect(mcus[0].package).toBe('LQFP32');
  });

  // --------------------------------------------------------------
  // LRU cache
  // --------------------------------------------------------------

  it('serves cached die without refetching', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(dieDoc('stm32a', 'STM32A_LQFP32x'));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    await ds.loadDie('stm32a');
    await ds.loadDie('stm32a');
    // Index fetch + one die fetch — second loadDie hits the LRU.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entry when entry count limit exceeded', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(dieDoc('stm32a', 'STM32A_LQFP32x'));
      if (url.endsWith('/mcu/stm32b.json')) return jsonResponse(dieDoc('stm32b', 'STM32B_LQFP32x'));
      if (url.endsWith('/mcu/stm32c.json')) return jsonResponse(dieDoc('stm32c', 'STM32C_LQFP100x', 'LQFP100'));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl, maxEntries: 2 });
    await ds.loadDie('stm32a');
    await ds.loadDie('stm32b');
    expect(ds.stats().entries).toBe(2);
    await ds.loadDie('stm32c');           // evicts stm32a
    expect(ds.stats().entries).toBe(2);
    await ds.loadDie('stm32a');           // refetch — should hit network again
    // index(1) + a(1) + b(1) + c(1) + a-refetch(1) = 5
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('evicts when total bytes exceed budget', async () => {
    // Make each doc huge (50 KB filler) so a 60 KB cap holds at most one.
    const filler = 'x'.repeat(50 * 1024);
    const big = (variant: string) => ({ ...dieDoc('stm32a', variant), filler });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(big('STM32A_LQFP32x'));
      if (url.endsWith('/mcu/stm32b.json')) return jsonResponse(big('STM32B_LQFP32x'));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({
      url: 'https://x.test/data', fetchImpl,
      maxEntries: 100, maxBytes: 60 * 1024,
    });
    await ds.loadDie('stm32a');
    await ds.loadDie('stm32b');
    expect(ds.stats().entries).toBe(1);
    expect(ds.stats().bytes).toBeLessThan(60 * 1024);
  });

  // --------------------------------------------------------------
  // Batch + cancellation
  // --------------------------------------------------------------

  it('loads many dies in parallel, reports progress', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      const m = url.match(/mcu\/(stm32[abc])\.json$/);
      if (m) return jsonResponse(dieDoc(m[1], `${m[1].toUpperCase()}_LQFP32x`));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const updates: number[] = [];
    const result = await ds.loadManyDies(['stm32a', 'stm32b', 'stm32c'], {
      onProgress: (p) => updates.push(p.completed),
      concurrency: 2,
    });
    expect(result.cancelled).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.mcus.map(m => m.refName).sort()).toEqual(
      ['STM32A_LQFP32x', 'STM32B_LQFP32x', 'STM32C_LQFP32x']
    );
    // Initial 0 + 3 ticks for each completion.
    expect(updates[updates.length - 1]).toBe(3);
  });

  it('aborts mid-batch when AbortController fires', async () => {
    let pending: ((value: Response) => void) | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(dieDoc('stm32a', 'STM32A_LQFP32x'));
      // Hold stm32b until aborted.
      return new Promise<Response>((resolve, reject) => {
        pending = resolve;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const ac = new AbortController();
    const promise = ds.loadManyDies(['stm32a', 'stm32b'], { signal: ac.signal, concurrency: 1 });
    // Let stm32a complete, then abort while stm32b is in flight.
    await new Promise(r => setTimeout(r, 0));
    ac.abort();
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.mcus.map(m => m.refName)).toEqual(['STM32A_LQFP32x']);
    // pending intentionally left to prove the test exits cleanly.
    void pending;
  });

  it('collects per-die errors without aborting the batch', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32b.json')) return new Response('not found', { status: 404 });
      const m = url.match(/mcu\/(stm32[ac])\.json$/);
      if (m) return jsonResponse(dieDoc(m[1], `${m[1].toUpperCase()}_LQFP32x`));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const result = await ds.loadManyDies(['stm32a', 'stm32b', 'stm32c']);
    expect(result.cancelled).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].die).toBe('stm32b');
    expect(result.mcus.map(m => m.refName).sort()).toEqual(
      ['STM32A_LQFP32x', 'STM32C_LQFP32x']
    );
  });

  it('listCached enumerates fetched dies with their parsed Mcu list', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(dieDoc('stm32a', 'STM32A_LQFP32x'));
      if (url.endsWith('/mcu/stm32b.json')) return jsonResponse(dieDoc('stm32b', 'STM32B_LQFP32x'));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    expect(ds.listCached()).toEqual([]);
    await ds.loadDie('stm32a');
    await ds.loadDie('stm32b');
    const cached = ds.listCached();
    expect(cached.map(c => c.die)).toEqual(['stm32a', 'stm32b']);
    expect(cached[0].mcus.map(m => m.refName)).toEqual(['STM32A_LQFP32x']);
    expect(cached[0].bytes).toBeGreaterThan(0);
  });

  it('evict removes a single cached die', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      if (url.endsWith('/mcu/stm32a.json')) return jsonResponse(dieDoc('stm32a', 'STM32A_LQFP32x'));
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    await ds.loadDie('stm32a');
    expect(ds.stats().entries).toBe(1);
    expect(ds.evict('stm32a')).toBe(true);
    expect(ds.stats().entries).toBe(0);
    expect(ds.evict('not-there')).toBe(false);
    // Re-fetch must hit the network again now that the entry's gone.
    await ds.loadDie('stm32a');
    expect(fetchImpl).toHaveBeenCalledTimes(3); // index + 2× die
  });

  it('lists dies via predicate without fetching any', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/index.json')) return jsonResponse(VENDOR_INDEX);
      throw new Error(`Unexpected ${url}`);
    });
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });
    const list = await ds.listDies(die => die.startsWith('stm32a') || die.startsWith('stm32b'));
    expect(list.map(x => x.die).sort()).toEqual(['stm32a', 'stm32b']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
