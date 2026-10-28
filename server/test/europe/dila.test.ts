import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDilaResults, listDilaFiles, parseDilaArchive, parseDilaArchiveStream } from '../../src/europe/sources/dila.js';
import type { DilaDoc } from '../../src/europe/sources/dila.js';
import { SourceFormatError } from '../../src/sources/http.js';
import { untarEntries } from '../../src/sources/tar.js';

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

  it('listing accepts absolute hrefs on the DILA host only', () => {
    const html = [
      '<a href="https://echanges.dila.gouv.fr/OPENDATA/AMF/amf-gz_27102026_0800.tar.gz">x</a>',
      '<a href="./amf-gz_27102026_1000.tar.gz">x</a>',
      '<a href="/OPENDATA/AMF/amf-gz_27102026_1800.tar.gz">x</a>',
      '<a href="https://other.example/OPENDATA/AMF/amf-gz_27102026_1200.tar.gz">x</a>',
    ].join('\n');
    expect(listDilaFiles(html, '2026-10-27')).toEqual([
      'amf-gz_27102026_0800.tar.gz', 'amf-gz_27102026_1000.tar.gz', 'amf-gz_27102026_1800.tar.gz',
    ]);
  });

  it('a non-AMF record is skipped and counted; a batch with none valid throws', async () => {
    const good = new TextDecoder().decode(untarEntries(fx('dila_sample.tar.gz'), (n) => n.endsWith('MDMKW111969_20260331.xml')).values().next().value);
    const stats = { skipped: 0 };
    const docs = parseDilaArchive(tarOf({ 'xml/MKW/2026/03/MDMKW111969_20260331.xml': good, 'xml/X/junk.xml': '<foo/>' }), stats);
    expect(docs.map((d) => d.id)).toEqual(['MDMKW111969_20260331']);
    expect(stats.skipped).toBe(1);
    const sStats = { skipped: 0 };
    await parseDilaArchiveStream(chunks(tarOf({ 'xml/a.xml': '<foo/>', 'xml/b.xml': good }), 300), sStats);
    expect(sStats.skipped).toBe(1);
    expect(() => parseDilaArchive(tarOf({ 'xml/X/junk.xml': '<foo/>' }))).toThrow(SourceFormatError);
    expect(parseDilaArchive(tarOf({}))).toEqual([]);
  });

  it('a filing time without a zone offset is read as Europe/Paris', () => {
    const good = new TextDecoder().decode(untarEntries(fx('dila_sample.tar.gz'), (n) => n.endsWith('MDMKW111969_20260331.xml')).values().next().value);
    const summer = good.replace('INF_DAT_EMT="2026-03-31T22:15:00+02:00"', 'INF_DAT_EMT="2026-03-31T22:15:00"');
    const winter = good.replace('INF_DAT_EMT="2026-03-31T22:15:00+02:00"', 'INF_DAT_EMT="2026-01-15T07:00:00"');
    expect(summer).not.toBe(good);
    expect(parseDilaArchive(tarOf({ 'xml/a.xml': summer }))[0]!.filedAt).toBe('2026-03-31T20:15:00.000Z');
    expect(parseDilaArchive(tarOf({ 'xml/a.xml': winter }))[0]!.filedAt).toBe('2026-01-15T06:00:00.000Z');
  });
});

/** A minimal ustar archive of text files, ending with the two zero blocks. */
function tarOf(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const put = (h: Uint8Array, off: number, s: string) => h.set(enc.encode(s), off);
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    put(h, 0, name);
    put(h, 100, '0000644\0');
    put(h, 108, '0000000\0');
    put(h, 116, '0000000\0');
    put(h, 124, data.length.toString(8).padStart(11, '0') + '\0');
    put(h, 136, '00000000000\0');
    put(h, 148, '        ');
    put(h, 156, '0');
    put(h, 257, 'ustar\0');
    put(h, 263, '00');
    const sum = h.reduce((a, b) => a + b, 0);
    put(h, 148, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
