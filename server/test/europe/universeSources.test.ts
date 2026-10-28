import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { EuropeUniverseSources } from '../../src/europe/jobs/context.js';
import { createDilaClient, reusedUniverseSources, UNIVERSE_REUSE_MS } from '../../src/europe/jobs/universeSources.js';
import type { FirdsShare } from '../../src/europe/sources/firds.js';
import { DILA_BASE } from '../../src/europe/sources/sourceUrls.js';
import type { Http } from '../../src/sources/http.js';

const SIX_OK = 'ShortName;ValorSymbol;ValorNumber;ISIN;TradingBaseCurrency;ListingSegmentDesc;GeographicalAreaDesc;SecTypeDesc\n'
  + 'Nestle N;NESN;3886335;CH0038863350;CHF;Swiss Reporting Standard;Switzerland;Registered Shares\n';
const SHARE = { isin: 'GB0009895292', mic: 'XLON' } as unknown as FirdsShare;

function base(over: Partial<EuropeUniverseSources> = {}) {
  const calls = { firds: 0, six: 0 };
  const src: EuropeUniverseSources = {
    firds: async (_s, _m, onShare) => { calls.firds++; onShare(SHARE); return { files: 1, complete: true }; },
    sixList: async () => { calls.six++; return SIX_OK; },
    figi: async () => [], search: async () => [], names: async () => new Map(),
    ...over,
  };
  return { src, calls };
}

describe('universe sources reuse', () => {
  it('a SIX list that does not parse is never kept', async () => {
    let text = 'not a csv';
    const { src, calls } = base({ sixList: async () => { calls.six++; return text; } });
    const r = reusedUniverseSources(src, { now: () => 0, evict: () => {} });
    expect(await r.sixList()).toBe('not a csv');
    await r.sixList();
    expect(calls.six).toBe(2); // asked again
    text = SIX_OK;
    await r.sixList();
    await r.sixList();
    expect(calls.six).toBe(3); // kept once it parses
  });

  it('FIRDS and SIX are reused within 6 h and evicted after', async () => {
    let t = 0;
    const evictions: { fn: () => void; ms: number }[] = [];
    const { src, calls } = base();
    const r = reusedUniverseSources(src, { now: () => t, evict: (fn, ms) => evictions.push({ fn, ms }) });
    const got: FirdsShare[] = [];
    const mics = new Set(['XLON']);
    await r.firds('fca', mics, (s) => got.push(s));
    await r.firds('fca', mics, (s) => got.push(s));
    await r.sixList();
    await r.sixList();
    expect(calls).toEqual({ firds: 1, six: 1 });
    expect(got).toEqual([SHARE, SHARE]); // replayed to the second caller
    expect(evictions.map((e) => e.ms)).toEqual([UNIVERSE_REUSE_MS, UNIVERSE_REUSE_MS]);
    // The eviction timers drop the entries from memory.
    for (const e of evictions) e.fn();
    t = 1000;
    await r.firds('fca', mics, () => {});
    await r.sixList();
    expect(calls).toEqual({ firds: 2, six: 2 });
    // Without the timer, an entry 6 h old is not served either.
    t += UNIVERSE_REUSE_MS;
    await r.firds('fca', mics, () => {});
    expect(calls.firds).toBe(3);
  });

  it('an incomplete FIRDS read is never kept', async () => {
    const { src, calls } = base({ firds: async () => { calls.firds++; return { files: 0, complete: false }; } });
    const r = reusedUniverseSources(src, { now: () => 0, evict: () => {} });
    await r.firds('esma', new Set(['XPAR']), () => {});
    await r.firds('esma', new Set(['XPAR']), () => {});
    expect(calls.firds).toBe(2);
  });
});

describe('DILA client', () => {
  it('the archive download waits on the shared 1 s limiter and returns the body stream', async () => {
    const order: string[] = [];
    const limiter = { wait: vi.fn(async () => { order.push('wait'); }) };
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => { order.push(String(url)); return new Response(body, { status: 200 }); });
    const http: Http = { text: async () => readFileSync(new URL('../fixtures/europe/feeds/dila_listing.html', import.meta.url), 'utf8'), json: async () => ({}) };
    const dila = createDilaClient({ http, limiter, fetchImpl: fetchImpl as unknown as typeof fetch });
    const stream = await dila.archive('amf-gz_27102026_1905.tar.gz');
    expect(order).toEqual(['wait', `${DILA_BASE}amf-gz_27102026_1905.tar.gz`]);
    const chunks: number[] = [];
    for await (const c of stream) chunks.push(...c);
    expect(chunks).toEqual([1, 2]);
    await expect(dila.archive('../etc/passwd')).rejects.toThrow(/unexpected DILA batch name/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
