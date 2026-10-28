import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIRDS_MAX_BYTES, fetchFirdsShares, makeFirdsHttp, parseFirdsRecords, type FirdsHttp, type FirdsShare } from '../../src/europe/sources/firds.js';
import { makeZip } from '../sources/zipBuilder.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/europe/universe/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-28T12:00:00Z');

describe('parseFirdsRecords', () => {
  it('parses real records: ISIN, CFI, LEI, MIC, IssrReq', () => {
    const shares = parseFirdsRecords(fx('firds_sample.xml'), NOW);
    // 61 records; the share (ES*) ones are AZN, BT, HSBC, Hammerson x2, YU, SAP x2, TotalEnergies x2, Ericsson.
    expect(shares).toHaveLength(11);
    expect(shares.find((s) => s.isin === 'GB0009895292')).toEqual<FirdsShare>({
      isin: 'GB0009895292', fullName: 'ASTRAZENECA PLC ORD SHS $0.25', cfi: 'ESVUFR', lei: 'PY6ZZQWO2IZFZC3IOL08',
      mic: 'XLON', issuerRequested: true, terminated: false,
    });
    expect(shares.filter((s) => s.isin === 'GB00BRJQ8J25').map((s) => s.mic)).toEqual(['XLON', 'XMSM']);
    expect(shares.find((s) => s.isin === 'SE0000108656')).toMatchObject({ cfi: 'ESRUFR', mic: 'XSTO', lei: '549300W9JLPW15XIFM52' });

    // ESMA's compact one-line layout reads the same.
    const esma = parseFirdsRecords(fx('firds_sample_esma.xml'), NOW);
    expect(esma.map((s) => `${s.isin}@${s.mic}`)).toEqual([
      'FR0000121014@XPAR', 'NL0010273215@XAMS', 'SE0005308558@SSME', 'DE0008435967@XETS',
    ]);
    expect(esma[3]!.fullName).toBe('NÜRNBERGER Beteiligungs-AG VINK.NAMENS-AKTIEN O.N.');
    expect(esma.every((s) => s.issuerRequested && !s.terminated)).toBe(true);
  });

  it('non-share CFI and terminated lines dropped', () => {
    const xml = fx('firds_sample.xml');
    // Every non-ES* record (certificates, bonds, ETFs, ...) is dropped by the parser.
    expect(parseFirdsRecords(xml, NOW).every((s) => s.cfi.startsWith('ES'))).toBe(true);
    // The real AstraZeneca record with a termination date added: past → terminated, future → still live.
    const azn = xml.slice(xml.lastIndexOf('<RefData>', xml.indexOf('GB0009895292')), xml.indexOf('</RefData>', xml.indexOf('GB0009895292')) + 10);
    expect(azn).toContain('<Id>XLON</Id>');
    const withEnd = (iso: string) => azn.replace('</IssrReq>', `</IssrReq>\n        <TermntnDt>${iso}</TermntnDt>`);
    expect(parseFirdsRecords(withEnd('2026-10-01T22:00:00Z'), NOW)[0]!.terminated).toBe(true);
    expect(parseFirdsRecords(withEnd('2026-12-18T22:00:00Z'), NOW)[0]!.terminated).toBe(false);
  });

  it('a record cut mid-block is not emitted', () => {
    const xml = fx('firds_sample.xml');
    const cutAt = xml.indexOf('</RefData>', xml.indexOf('GB0030913577')) - 40; // inside BT's block
    const cut = xml.slice(0, cutAt);
    const isins = parseFirdsRecords(cut, NOW).map((s) => s.isin);
    expect(isins).toEqual(['GB0009895292']);
    // A cut block followed by a complete one: only the complete one.
    const next = xml.slice(xml.lastIndexOf('<RefData>', xml.indexOf('GB0005405286')));
    expect(parseFirdsRecords(cut + next, NOW).map((s) => s.isin)[1]).toBe('GB0005405286');
    expect(parseFirdsRecords(cut + next, NOW).map((s) => s.isin)).not.toContain('GB0030913577');
  });
});

describe('fetchFirdsShares', () => {
  it('index → latest FULINS_E parts → streamed records on the wanted MICs', async () => {
    const urls: string[] = [];
    const esmaIndex = JSON.parse(fx('esma_index.json')) as { response: { docs: unknown[]; numFound: number } };
    const http: FirdsHttp = {
      json: async (url) => {
        urls.push(url);
        // Page 2 of the index is empty in this replay (the fixture holds page 1 of 120).
        return url.includes('start=0') ? esmaIndex : { response: { numFound: 120, docs: [] } };
      },
      text: async () => { throw new Error('unused'); },
      bytes: async (url) => {
        urls.push(url);
        // Part 2 repeats the FCA sample 40 times (~2.9 MB) so records straddle the streamed chunks.
        const xml = url.endsWith('01of02.zip') ? fx('firds_sample_esma.xml') : fx('firds_sample.xml').repeat(40);
        return makeZip([{ name: url.split('/').pop()!.replace('.zip', '.xml'), data: Buffer.from(xml, 'utf8') }]);
      },
    };
    const got: FirdsShare[] = [];
    const r = await fetchFirdsShares(http, 'esma', new Set(['XPAR', 'XAMS', 'XETA']), (s) => got.push(s), { now: () => NOW });
    expect(r).toEqual({ files: 2, complete: true });
    expect(urls.filter((u) => u.endsWith('.zip'))).toEqual([
      'https://firds.esma.europa.eu/firds/FULINS_E_20261024_01of02.zip',
      'https://firds.esma.europa.eu/firds/FULINS_E_20261024_02of02.zip',
    ]);
    expect(urls[0]).toMatch(/^https:\/\/registers\.esma\.europa\.eu\/solr\/esma_registers_firds_files\/select\?/);
    expect(got.slice(0, 4).map((s) => `${s.isin}@${s.mic}`)).toEqual([
      'FR0000121014@XPAR', 'NL0010273215@XAMS', 'DE0007164600@XETA', 'FR0000120271@XPAR',
    ]);
    expect(got).toHaveLength(2 + 2 * 40);
  });

  it('a failed part makes the run incomplete', async () => {
    const esmaIndex = JSON.parse(fx('esma_index.json'));
    const http: FirdsHttp = {
      json: async (url) => (url.includes('start=0') ? esmaIndex : { response: { numFound: 120, docs: [] } }),
      text: async () => '',
      bytes: async (url) => {
        if (url.endsWith('02of02.zip')) throw new Error('HTTP 500');
        return makeZip([{ name: 'a.xml', data: Buffer.from(fx('firds_sample_esma.xml'), 'utf8') }]);
      },
    };
    const r = await fetchFirdsShares(http, 'esma', new Set(['XPAR']), () => {}, { now: () => NOW });
    expect(r).toEqual({ files: 1, complete: false });
  });
  const esmaReplay = (bytes: (url: string) => Promise<Uint8Array>): FirdsHttp => {
    const esmaIndex = JSON.parse(fx('esma_index.json'));
    return {
      json: async (url) => (url.includes('start=0') ? esmaIndex : { response: { numFound: 120, docs: [] } }),
      text: async () => '',
      bytes,
    };
  };

  it('a part with no .xml entry, or no records, makes the run incomplete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noXml = esmaReplay(async () => makeZip([{ name: 'a.txt', data: Buffer.from(fx('firds_sample_esma.xml'), 'utf8') }]));
    expect((await fetchFirdsShares(noXml, 'esma', new Set(['XPAR']), () => {}, { now: () => NOW })).complete).toBe(false);
    const noRecords = esmaReplay(async () => makeZip([{ name: 'a.xml', data: Buffer.from('<?xml version="1.0"?><BizData></BizData>', 'utf8') }]));
    expect((await fetchFirdsShares(noRecords, 'esma', new Set(['XPAR']), () => {}, { now: () => NOW })).complete).toBe(false);
    warn.mockRestore();
  });

  it('an index walk that hits the page cap is incomplete', async () => {
    const esmaIndex = JSON.parse(fx('esma_index.json')) as { response: { docs: unknown[] } };
    let pages = 0;
    const http: FirdsHttp = {
      // Every page is full and numFound says there are more than the walk reads.
      json: async () => { pages++; return { response: { numFound: 5000, docs: esmaIndex.response.docs.slice(0, 100) } }; },
      text: async () => '',
      bytes: async () => makeZip([{ name: 'a.xml', data: Buffer.from(fx('firds_sample_esma.xml'), 'utf8') }]),
    };
    const r = await fetchFirdsShares(http, 'esma', new Set(['XPAR']), () => {}, { now: () => NOW });
    expect(pages).toBe(10);
    expect(r.complete).toBe(false);
  });

  it('a download above the size cap (3 GB) is refused and the run incomplete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(FIRDS_MAX_BYTES).toBe(3 * 1024 ** 3);
    // A declared Content-Length above the cap is refused before reading.
    const big = makeFirdsHttp({
      minIntervalMs: 0,
      fetchImpl: (async () => new Response('x', { status: 200, headers: { 'content-length': String(FIRDS_MAX_BYTES + 1) } })) as unknown as typeof fetch,
    });
    await expect(big.bytes('https://data.fca.org.uk/artefacts/FIRDS/FULINS_E_20261024_01of01.zip')).rejects.toThrow(/size cap/);
    // A body without a length is cut off once it passes the cap (a small cap here).
    const chunked = makeFirdsHttp({
      minIntervalMs: 0, maxBytes: 1000,
      fetchImpl: (async () => new Response(new ReadableStream({
        start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(400)); c.close(); },
      }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(chunked.bytes('https://data.fca.org.uk/x.zip')).rejects.toThrow(/size cap/);
    const r = await fetchFirdsShares(esmaReplay((url) => chunked.bytes(url)), 'esma', new Set(['XPAR']), () => {}, { now: () => NOW });
    expect(r).toEqual({ files: 0, complete: false });
    warn.mockRestore();
  });
});
