import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { HttpError, type Http } from '../../src/sources/http.js';
import type { SecFeedItem } from '../../src/sources/secFeed.js';
import { SixKWatch, type ForeignFiling, type SixKMarket } from '../../src/sources/sixKWatch.js';

const FEED_6K = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=6-K&company=&dateb=&owner=include&start=0&count=100&output=atom';
const NOW = '2026-10-27T12:00:00.000Z';
const feedXml = readFileSync(new URL('../fixtures/hk/sec_getcurrent_6k.xml', import.meta.url), 'utf8');
/** A CIK with filings in the saved feed, held here by two markets (as HSBC 1089113 is by HK and UK). */
const SHARED_CIK = 1073404;

function stubHttp() {
  const requested: string[] = [];
  const http: Http = {
    async text(url) {
      requested.push(url);
      if (url !== FEED_6K) throw new HttpError(404, url);
      return feedXml;
    },
    async json(url) {
      return JSON.parse(await http.text(url));
    },
  };
  return { http, requested };
}

type Name = SixKMarket['name'];

function stubMarket(name: Name, ciks: number[], opts: { eightK?: number[]; handle?: (f: ForeignFiling) => Promise<number[]> } = {}) {
  const handled: ForeignFiling[] = [];
  const seen = new Set<string>();
  const onChanged = vi.fn();
  const market: SixKMarket = {
    name,
    ciks: () => new Set(ciks),
    eightKCiks: () => new Set(opts.eightK ?? []),
    due: () => false,
    seen: (a) => seen.has(a),
    handle: async (f) => {
      handled.push(f);
      const ids = opts.handle ? await opts.handle(f) : [];
      seen.add(f.accession);
      return ids;
    },
    onChanged,
  };
  return { market, handled, onChanged };
}

const base = () => ({ db: openDb(':memory:'), now: () => NOW });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.restoreAllMocks(); });

describe('SixKWatch fan-out', () => {
  it('one feed item for a CIK held by HK and UK reaches both handlers', async () => {
    const { http } = stubHttp();
    const hk = stubMarket('hk', [SHARED_CIK], { handle: async () => [5] });
    const uk = stubMarket('uk', [SHARED_CIK], { handle: async () => [4_000_000_005] });
    const ids = await new SixKWatch([hk.market, uk.market], http, base()).tick();

    expect(hk.handled.length).toBeGreaterThan(0);
    expect(hk.handled.map((f) => f.accession)).toEqual(uk.handled.map((f) => f.accession));
    expect(uk.handled.every((f) => f.cik === SHARED_CIK)).toBe(true);
    expect(hk.onChanged).toHaveBeenCalledWith([5]);
    expect(uk.onChanged).toHaveBeenCalledWith([4_000_000_005]);
    expect(ids.sort()).toEqual([5, 4_000_000_005].sort());
  });

  it('UK handler throwing never re-queues or blocks HK; HK seen does not hide UK', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { http } = stubHttp();
    // UK first: its failure must not stop HK in the same tick.
    const uk = stubMarket('uk', [SHARED_CIK], { handle: async () => { throw new HttpError(503, 'x'); } });
    const hk = stubMarket('hk', [SHARED_CIK], { handle: async () => [5] });
    const w = new SixKWatch([uk.market, hk.market], http, base());
    await w.tick();
    const n = hk.handled.length;
    expect(n).toBeGreaterThan(0);
    expect(uk.handled.length).toBe(n);
    expect(hk.onChanged).toHaveBeenCalledWith([5]);

    // HK has seen every accession; UK still retries each, HK handles nothing again.
    await w.tick();
    expect(hk.handled.length).toBe(n);
    expect(uk.handled.length).toBe(2 * n);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[uk-sec\] .*\(try 2\)/));

    // UK gives up after 10 tries; that never marks HK, and HK's seen never stopped UK.
    for (let i = 0; i < 8; i++) await w.tick();
    expect(uk.handled.length).toBe(10 * n);
    await w.tick();
    expect(uk.handled.length).toBe(10 * n);
    expect(hk.handled.length).toBe(n);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[uk-sec\] .*left to the sweep after 10 tries/));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/^\[hk-sec\]/));
  });

  it('8-K 2.02 fans out the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { http } = stubHttp();
    const LOGI = 1032975;
    const item: SecFeedItem = {
      cik: LOGI, accession: '0001032975-26-000059', acceptedAt: '2026-10-27T20:05:00.000Z', items: ['2.02', '9.01'],
      indexUrl: `https://www.sec.gov/Archives/edgar/data/${LOGI}/000103297526000059/0001032975-26-000059-index.htm`, form: '8-K',
    };
    const notResults: SecFeedItem = { ...item, accession: '0001032975-26-000060', items: ['8.01'] };
    const hk = stubMarket('hk', [], { eightK: [LOGI], handle: async () => { throw new HttpError(503, 'x'); } });
    const eu = stubMarket('eu', [], { eightK: [LOGI], handle: async () => [5_000_000_001] });
    const w = new SixKWatch([hk.market, eu.market], http, base());
    w.onUsFeed([item, notResults]);
    w.onUsFeed([item]); // at-least-once redelivery while queued
    for (let i = 0; i < 5; i++) await flush();

    expect(hk.handled.map((f) => f.accession)).toEqual([item.accession]);
    expect(eu.handled.map((f) => f.accession)).toEqual([item.accession]);
    expect(eu.handled[0]).toMatchObject({ cik: LOGI, form: '8-K', acceptedAt: item.acceptedAt });
    expect(eu.onChanged).toHaveBeenCalledWith([5_000_000_001]);

    // Redelivered later: EU has it seen, HK (which failed) tries again.
    w.onUsFeed([item]);
    for (let i = 0; i < 5; i++) await flush();
    expect(eu.handled.length).toBe(1);
    expect(hk.handled.length).toBe(2);
  });

  it("each market's filing carries that market's session for the CIK; hk / jp filings carry none", async () => {
    const { http } = stubHttp();
    const LSE = { zone: 'Europe/London', openMin: 480, closeMin: 990 };
    const hk = stubMarket('hk', [SHARED_CIK]);
    const uk = stubMarket('uk', [SHARED_CIK]);
    const asked: number[] = [];
    uk.market.sessionFor = (cik) => { asked.push(cik); return LSE; };
    const eu = stubMarket('eu', [SHARED_CIK]);
    eu.market.sessionFor = () => null;
    await new SixKWatch([hk.market, uk.market, eu.market], http, base()).tick();

    expect(uk.handled.length).toBeGreaterThan(0);
    expect(uk.handled.every((f) => f.session === LSE)).toBe(true);
    expect(asked.length).toBe(uk.handled.length);
    expect(asked.every((c) => c === SHARED_CIK)).toBe(true);
    expect(hk.handled.every((f) => !('session' in f))).toBe(true);
    expect(eu.handled.every((f) => f.session === null)).toBe(true);
  });

  it('one feed request per tick', async () => {
    const { http, requested } = stubHttp();
    const hk = stubMarket('hk', [SHARED_CIK]);
    const uk = stubMarket('uk', [SHARED_CIK, 1131399]);
    const eu = stubMarket('eu', [1131399]);
    const w = new SixKWatch([hk.market, uk.market, eu.market], http, base());
    await w.tick();
    expect(requested).toEqual([FEED_6K]);
    expect(eu.handled.length).toBeGreaterThan(0);
    await w.tick();
    expect(requested).toEqual([FEED_6K, FEED_6K]);
  });
});
