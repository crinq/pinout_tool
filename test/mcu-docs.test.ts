import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMcuJson } from '../src/parser/mcu-json-parser';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { PackageViewer } from '../src/ui/package-viewer';
import type { Mcu } from '../src/types';

/** Minimal canvas/observer stubs so the viewer can run under jsdom. */
function stubDom() {
  const noop = () => {};
  const store: Record<string, unknown> = {};
  const ctx = new Proxy(store, {
    get(t, p: string) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (p in t) return t[p];
      return noop;
    },
    set(t, p: string, v) { t[p] = v; return true; },
  });
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} };
}

const json: Mcu = parseMcuJson(readFileSync(join(__dirname, 'fixtures/stm32h723ve.json'), 'utf-8'))[0];
const xml: Mcu = parseMcuXml(readFileSync(join(__dirname, 'h755i/STM32H755IIKx.xml'), 'utf-8'));

describe('MCU documentation links', () => {
  it('are read from the JSON catalogue', () => {
    expect(json.docs?.datasheet).toMatch(/\/datasheet\/.*\.pdf$/);
    expect(json.docs?.refmanual).toMatch(/\/reference_manual\/.*\.pdf$/);
    expect(json.docs?.errata).toMatch(/\/errata_sheet\/.*\.pdf$/);
  });

  it('are upgraded to https (the vendor data still uses http)', () => {
    for (const u of Object.values(json.docs ?? {})) expect(u).toMatch(/^https:\/\//);
  });

  it('picks the errata out of the mixed `other` list, not an app note', () => {
    expect(json.docs?.errata).not.toMatch(/application_note/);
  });

  it('CubeMX XML carries none', () => {
    expect(xml.docs).toBeUndefined();
  });
});

describe('package viewer DATA / MAN / ERR buttons', () => {
  beforeAll(stubDom);

  const mount = (mcu: Mcu | null) => {
    const v = new PackageViewer();
    const host = document.createElement('div');
    document.body.appendChild(host);
    v.createView(host);
    if (mcu) v.onStateChange({ type: 'mcu-loaded', mcu } as unknown as Record<string, unknown>);
    return [...host.querySelectorAll<HTMLButtonElement>('.pv-doc-btn')];
  };

  it('renders exactly the three buttons, in order', () => {
    expect(mount(null).map(b => b.textContent)).toEqual(['DATA', 'MAN', 'ERR']);
  });

  it('are disabled with no MCU loaded', () => {
    expect(mount(null).every(b => b.disabled)).toBe(true);
  });

  it('are enabled for an MCU that has the links', () => {
    const btns = mount(json);
    expect(btns.map(b => b.disabled)).toEqual([false, false, false]);
    for (const b of btns) expect(b.title).toMatch(/Open the .* in a new tab/);
  });

  it('are greyed out for an MCU without links (XML source)', () => {
    const btns = mount(xml);
    expect(btns.map(b => b.disabled)).toEqual([true, true, true]);
    for (const b of btns) expect(b.title).toMatch(/No .* link in the data/);
  });

  it('greys out only the missing one when the data is partial', () => {
    const partial: Mcu = { ...json, docs: { refmanual: json.docs!.refmanual } };
    expect(mount(partial).map(b => b.disabled)).toEqual([true, false, true]);
  });
});
