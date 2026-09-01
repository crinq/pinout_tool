import { describe, it, expect } from 'vitest';
import { parseConstraints } from '../src/parser/constraint-parser';
import { buildPortColorMap, PORT_PALETTE } from '../src/ui/port-colors';

const colorsFor = (src: string) => buildPortColorMap(parseConstraints(src).ast);

const portsNamed = (...names: string[]) =>
  names.map(n => `port ${n}:\n  channel A = OUT`).join('\n\n');

describe('port colours', () => {
  it('honours an explicit colour', () => {
    const c = colorsFor(`port A color "#123456":
  channel X = OUT`);
    expect(c.get('A')).toBe('#123456');
  });

  it('gives every port a colour from the palette', () => {
    const c = colorsFor(portsNamed('Alpha', 'Beta', 'Gamma'));
    expect([...c.keys()]).toEqual(['Alpha', 'Beta', 'Gamma']);
    for (const v of c.values()) expect(PORT_PALETTE).toContain(v);
  });

  it('keeps a port\'s colour when another is inserted above it', () => {
    // The whole point of hashing the name rather than counting position.
    const before = colorsFor(portsNamed('Alpha', 'Beta', 'Gamma'));
    const after = colorsFor(portsNamed('Inserted', 'Alpha', 'Beta', 'Gamma'));
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      expect(after.get(name), name).toBe(before.get(name));
    }
  });

  it('keeps a port\'s colour when a neighbour is renamed', () => {
    const before = colorsFor(portsNamed('Alpha', 'Beta'));
    const after = colorsFor(portsNamed('Alpha', 'Renamed'));
    expect(after.get('Alpha')).toBe(before.get('Alpha'));
  });

  it('never repeats a colour while the palette has room', () => {
    const names = ['PWR', 'CMD', 'Debug', 'Module_Comms', 'USB_Ports', 'ENC0', 'MOT'];
    const c = colorsFor(portsNamed(...names));
    expect(new Set(c.values()).size).toBe(names.length);
  });

  it('does not let an auto colour collide with an explicit one it can avoid', () => {
    const c = colorsFor(portsNamed('Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'));
    expect(new Set(c.values()).size).toBe(5);
  });

  it('still assigns a colour when there are more ports than palette entries', () => {
    const names = Array.from({ length: PORT_PALETTE.length + 4 }, (_, i) => `P${i}`);
    const c = colorsFor(portsNamed(...names));
    expect(c.size).toBe(names.length);
    for (const n of names) expect(PORT_PALETTE).toContain(c.get(n)!);
  });

  it('returns an empty map for no AST', () => {
    expect(buildPortColorMap(null).size).toBe(0);
  });

  it('is what the minimap and the package viewer both read', () => {
    // Regression: app.ts recorded only explicit colours, so an uncoloured port
    // was palette-coloured in the right pane and plain blue on the package.
    const c = colorsFor(`port Explicit color "red":
  channel A = OUT

port Implicit:
  channel B = OUT`);
    expect(c.get('Explicit')).toBe('red');
    expect(c.get('Implicit')).toBeDefined();
    expect(c.get('Implicit')).not.toBe('red');
  });
});
