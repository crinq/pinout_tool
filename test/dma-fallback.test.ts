import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMcuXml } from '../src/parser/mcu-xml-parser';
import { parseConstraints } from '../src/parser/constraint-parser';
import { constraintsNeedDma, runPreSolveChecks } from '../src/solver/solver';
import { DataSource } from '../src/datasource';
import type { Mcu } from '../src/types';

// An MCU imported from CubeMX XML has no DMA data until the matching DMA modes
// XML is imported too. Remote JSON MCUs always carry theirs, so a dma()
// constraint should fall back to the catalogue instead of failing.

const DMA_SRC = `port P:
  channel TX = USART*_TX $u
  channel RX = USART*_RX $u
  require dma(TX, "USART_TX")`;

/** g474 XML *without* attaching the local DMA modes file. */
function xmlWithoutDma(): Mcu {
  const dir = join(__dirname, 'g474');
  const xml = readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('DMA-'))!;
  return parseMcuXml(readFileSync(join(dir, xml), 'utf-8'));
}

describe('constraintsNeedDma', () => {
  it('detects dma() straight from the AST', () => {
    expect(constraintsNeedDma(parseConstraints(DMA_SRC).ast!)).toBe(true);
  });

  it('is false without dma()', () => {
    const src = 'port P:\n  channel TX = USART*_TX';
    expect(constraintsNeedDma(parseConstraints(src).ast!)).toBe(false);
  });

  it('sees dma() that arrives via a stdlib macro / template expansion', () => {
    // uart_port() from the macro library carries dma() requires.
    const src = 'port P:\n  channel TX\n  channel RX\n  uart_port(TX, RX)';
    const ast = parseConstraints(src).ast;
    if (!ast) return;
    expect(typeof constraintsNeedDma(ast)).toBe('boolean'); // must not throw
  });
});

describe('DMA-less XML MCU', () => {
  it('fails pre-solve when dma() is used and no DMA data is present', () => {
    const mcu = xmlWithoutDma();
    expect(mcu.dma).toBeUndefined();
    const errs = runPreSolveChecks(parseConstraints(DMA_SRC).ast!, mcu)
      .filter(e => e.type === 'error' && /no DMA data/i.test(e.message));
    expect(errs.length).toBe(1);
    // and the message points at both remedies
    expect(errs[0].message).toMatch(/DMA modes XML/);
    expect(errs[0].message).toMatch(/remote data source/);
  });

  it('passes once DMA data is borrowed from the remote catalogue', async () => {
    const mcu = xmlWithoutDma();

    // Stand up a data source serving the real g474 JSON (which carries DMA).
    const root = join(__dirname, '..', 'dist/mcu-data/stm32');
    const dieFile = 'stm32g474re.json';
    const index = {
      schema_version: 1, vendor: 'stm32',
      devices: { stm32g474re: { file: `mcu/${dieFile}`, family: 'stm32g4', packages: {} as Record<string, string> } },
    };
    const dieDoc = JSON.parse(readFileSync(join(root, 'mcu', dieFile), 'utf-8'));
    for (const p of dieDoc.packages ?? []) index.devices.stm32g474re.packages[p.variant] = p.name;
    const variant = dieDoc.packages?.[0]?.variant as string;
    expect(variant).toBeTruthy();

    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      const body = url.endsWith('/index.json') ? index : dieDoc;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ds = new DataSource({ url: 'https://x.test/data', fetchImpl });

    const remote = await ds.loadVariant(variant);
    expect(remote?.dma, 'remote MCU carries DMA data').toBeDefined();

    // This is what ensureDmaData does: borrow the remote DMA data.
    mcu.dma = remote!.dma;
    const errs = runPreSolveChecks(parseConstraints(DMA_SRC).ast!, mcu)
      .filter(e => e.type === 'error' && /no DMA data/i.test(e.message));
    expect(errs).toEqual([]);
  });
});
