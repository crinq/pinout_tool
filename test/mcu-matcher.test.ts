import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import { extractMcuFilters } from '../src/mcu-matcher';

const filtersFor = (src: string) => extractMcuFilters(parseConstraints(src).ast);

describe('extractMcuFilters — temperature', () => {
  // Regression: `temp: 130` used to set only reqTempMin, so a part rated to
  // 125°C passed. A bare value is a point the part must be rated for.
  it('a bare value constrains both ends (point coverage)', () => {
    const f = filtersFor('temp: 130');
    expect(f.reqTempMin).toBe(130); // mcu.tempMin ≤ 130
    expect(f.reqTempMax).toBe(130); // mcu.tempMax ≥ 130  → excludes a 125°C part
  });

  it('< only constrains the hot end', () => {
    const f = filtersFor('temp: < 85');
    expect(f.reqTempMin).toBeUndefined();
    expect(f.reqTempMax).toBe(85);
  });

  it('a range constrains both ends', () => {
    const f = filtersFor('temp: -40 < 125');
    expect(f.reqTempMin).toBe(-40);
    expect(f.reqTempMax).toBe(125);
  });
});
