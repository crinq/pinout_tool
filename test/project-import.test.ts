import { describe, it, expect } from 'vitest';
import { isExportedProject, mergeImportedVersions, migrateProjectData, type ProjectData, type ProjectVersion } from '../src/storage';

const version = (id: number, text: string): ProjectVersion => ({
  id, timestamp: 0, constraintText: text, mcuRef: 'STM32G474', solutions: [],
});
const project = (name: string, ...texts: string[]): ProjectData => ({
  name, versions: texts.map((t, i) => version(i, t)),
});

describe('isExportedProject', () => {
  it('accepts the versioned export format', () => {
    expect(isExportedProject({ name: 'p', versions: [] })).toBe(true);
  });

  it('accepts the legacy { name, constraintText } format', () => {
    expect(isExportedProject({ name: 'p', constraintText: 'port P:' })).toBe(true);
  });

  it('rejects anything else — notably an MCU JSON', () => {
    // migrateProjectData would happily fabricate a version for these, so the
    // shape check has to run first.
    expect(isExportedProject({ schema: 1, name: 'stm32g474', packages: [] })).toBe(false);
    expect(isExportedProject([])).toBe(false);
    expect(isExportedProject('nope')).toBe(false);
    expect(isExportedProject(null)).toBe(false);
    expect(isExportedProject(42)).toBe(false);
  });
});

describe('mergeImportedVersions', () => {
  it('appends into an existing project and renumbers ids', () => {
    const target = project('board', 'v0', 'v1');
    const imported = project('board', 'imported-a', 'imported-b');
    const out = mergeImportedVersions(target, imported);

    expect(out.versions.map(v => v.constraintText)).toEqual(['v0', 'v1', 'imported-a', 'imported-b']);
    expect(out.versions.map(v => v.id)).toEqual([0, 1, 2, 3]); // contiguous, latest last
  });

  it('importing into a fresh project keeps the imported versions', () => {
    const out = mergeImportedVersions({ name: 'new', versions: [] }, project('other', 'only'));
    expect(out.versions).toHaveLength(1);
    expect(out.versions[0].id).toBe(0);
    expect(out.versions[0].constraintText).toBe('only');
  });

  it('copies the imported versions (no aliasing back to the file object)', () => {
    const imported = project('src', 'x');
    const out = mergeImportedVersions({ name: 't', versions: [] }, imported);
    out.versions[0].constraintText = 'mutated';
    expect(imported.versions[0].constraintText).toBe('x');
    expect(imported.versions[0].id).toBe(0); // renumbering did not touch the source
  });

  it('round-trips a legacy export through migrate + merge', () => {
    const legacy = migrateProjectData({ name: 'old', constraintText: 'port P:\n  channel A = OUT' });
    const out = mergeImportedVersions(project('board', 'v0'), legacy);
    expect(out.versions).toHaveLength(2);
    expect(out.versions[1].constraintText).toContain('channel A = OUT');
    expect(out.versions[1].id).toBe(1);
  });
});
