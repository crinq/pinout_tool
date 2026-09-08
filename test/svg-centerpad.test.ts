// QFN exposed center pad: rendered when the data ships an extra pin past
// the perimeter count (e.g. position "49" on a UFQFPN48).
import { describe, it, expect } from 'vitest';
import { exportSvg } from '../src/ui/svg-export';
import type { Mcu } from '../src/types';

function qfn(withEp: boolean, pkg = 'UFQFPN48'): Mcu {
  const physicalPins = [];
  for (let i = 1; i <= 48; i++) {
    physicalPins.push({
      position: String(i),
      logicals: [{ name: `PA${i}`, type: 'I/O', isAssignable: true, signals: [] }],
    });
  }
  if (withEp) {
    physicalPins.push({
      position: '49',
      logicals: [{ name: 'VSS', type: 'Power', isAssignable: false, signals: [] }],
    });
  }
  return { refName: 'STM32TEST', package: pkg, physicalPins, logicalPins: [], peripherals: [] } as unknown as Mcu;
}

describe('QFN center pad', () => {
  it('draws the exposed pad with its designator when present', () => {
    const svg = exportSvg(qfn(true), [], new Map());
    expect(svg).toContain('VSS 49');
  });

  it('omits the pad when the data has no extra pin', () => {
    expect(exportSvg(qfn(false), [], new Map())).not.toContain('VSS 49');
  });

  it('keeps the extra pin off the perimeter', () => {
    const svg = exportSvg(qfn(true), [], new Map());
    // 48 perimeter pin rects (stroke-width 0.5) + 1 center pad rect
    expect((svg.match(/stroke-width="0\.5"/g) ?? []).length).toBe(49);
  });

  it('ignores the extra pin on non-QFN packages', () => {
    const svg = exportSvg(qfn(true, 'LQFP48'), [], new Map());
    expect(svg).not.toContain('VSS 49');
    expect((svg.match(/stroke-width="0\.5"/g) ?? []).length).toBe(48);
  });
});

describe('ST XML importer center-pad synthesis', () => {
  it('adds the missing pad on a real UFQFPN32 file and renders it', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { parseMcuXml } = await import('../src/parser/mcu-xml-parser');
    const mcu = parseMcuXml(readFileSync(join(__dirname, 'all/mcu/STM32F301K(6-8)Ux.xml'), 'utf-8'));
    const pad = mcu.physicalPins.find(p => p.position === '33');
    expect(pad).toBeDefined();
    expect(pad!.logicals[0].name).toBe('VSS');
    expect(pad!.logicals[0].isAssignable).toBe(false);
    expect(exportSvg(mcu, [], new Map())).toContain('VSS 33');
    // synthesized only once even though the perimeter already has VSS pins
    expect(mcu.physicalPins.filter(p => parseInt(p.position, 10) > 32).length).toBe(1);
  });
});
