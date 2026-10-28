import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDilaResults, listDilaFiles, parseDilaArchive, parseDilaArchiveStream } from '../../src/europe/sources/dila.js';
import type { DilaDoc } from '../../src/europe/sources/dila.js';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/europe/feeds/${n}`, import.meta.url)));

async function* chunks(buf: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe('DILA AMF flow', () => {
  it("listing → today's files", () => {
    const html = new TextDecoder().decode(fx('dila_listing.html'));
    expect(listDilaFiles(html, '2026-10-27')).toEqual([
      'amf-gz_27102026_0800.tar.gz',
      'amf-gz_27102026_1000.tar.gz',
      'amf-gz_27102026_1200.tar.gz',
      'amf-gz_27102026_1800.tar.gz',
      'amf-gz_27102026_1905.tar.gz',
      'amf-gz_27102026_2200.tar.gz',
    ]);
    expect(listDilaFiles(html, '2026-10-26')).toContain('amf-gz_26102026_1905.tar.gz');
    expect(listDilaFiles(html, '2026-10-28')).toEqual([]);
  });

  it('archive → ISIN-tagged docs; results type recognised; AGM notice not', async () => {
    const docs = parseDilaArchive(fx('dila_sample.tar.gz'));
    // NANOBIOTIX filed EN and FR at one timestamp: one doc, the English one. HIPAY's two filings differ in time.
    expect(docs).toHaveLength(3);
    const nano = docs.find((d) => d.issuer === 'NANOBIOTIX')!;
    expect(nano).toEqual<DilaDoc>({
      id: 'MDMKW111969_20260331',
      isin: 'FR0011341205',
      issuer: 'NANOBIOTIX',
      type: '003000',
      subtype: null,
      filedAt: '2026-03-31T20:15:00.000Z',
      title: 'NANOBIOTIX Provides Business Update and Reports Full Year 2025 Financial Results',
      url: null,
    });
    expect(isDilaResults(nano)).toBe(true);
    const hipay = docs.filter((d) => d.issuer === 'HIPAY GROUP');
    expect(hipay.map((d) => d.type)).toEqual(['013001', '013001']);
    expect(hipay.some(isDilaResults)).toBe(false);
    expect(hipay.find((d) => d.id === 'MD149622089_20260331')!.title).toBe('Activation of the company’s share repurchase program');

    // The streaming reader (used for the 200-660 MB season batches) gives the same documents.
    const press = await parseDilaArchiveStream(chunks(fx('dila_sample_press.tar.gz'), 4096));
    expect(press).toEqual(parseDilaArchive(fx('dila_sample_press.tar.gz')));
    const crossject = press.find((d) => d.issuer === 'CROSSJECT')!;
    expect(crossject).toMatchObject({ isin: 'FR0011716265', type: '001007', filedAt: '2026-03-25T06:20:00.000Z' });
    expect(isDilaResults(crossject)).toBe(true);
    // Buy-back, acquisition and other press releases are not results.
    for (const d of press.filter((x) => x.issuer !== 'CROSSJECT')) expect(isDilaResults(d), d.title).toBe(false);
    expect(press.map((d) => d.type).sort()).toEqual(['001002', '001006', '001007', '013005']);

    // A meeting notice (002xxx) never counts, whatever its title says.
    const agm: DilaDoc = { ...nano, type: '002001', title: 'Avis de réunion — assemblée générale (résultats annuels)' };
    expect(isDilaResults(agm)).toBe(false);
  });
});
