import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { HttpError, type Http } from '../../src/sources/http.js';
import { SixKWatch, type ForeignFiling, type SixKMarket } from '../../src/sources/sixKWatch.js';

const FEED_6K = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=6-K&company=&dateb=&owner=include&start=0&count=100&output=atom';
const NOW = '2026-10-27T12:00:00.000Z';
const feedXml = readFileSync(new URL('../fixtures/hk/sec_getcurrent_6k.xml', import.meta.url), 'utf8');

function stubHttp(docs: Record<string, string>) {
  const requested: string[] = [];
  const http: Http = {
    async text(url) {
      requested.push(url);
      const body = docs[url];
      if (body === undefined) throw new HttpError(404, url);
      return body;
    },
    async json(url) {
      return JSON.parse(await http.text(url));
    },
  };
  return { http, requested };
}

function stubMarket(name: 'hk' | 'jp', ciks: number[], opts: { due?: boolean; handle?: (f: ForeignFiling) => Promise<number[]> } = {}) {
  const handled: ForeignFiling[] = [];
  const seen = new Set<string>();
  const onChanged = vi.fn();
  const market: SixKMarket = {
    name,
    ciks: () => new Set(ciks),
    eightKCiks: () => new Set(),
    due: () => opts.due ?? false,
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('SixKWatch', () => {
  it('one feed request serves both markets and routes by CIK', async () => {
    const { http, requested } = stubHttp({ [FEED_6K]: feedXml });
    const hk = stubMarket('hk', [1073404], { handle: async () => [7] });
    const jp = stubMarket('jp', [1735556, 1999297], { handle: async (f) => [3_000_000_000 + (f.cik % 1000)] });
    const ids = await new SixKWatch([hk.market, jp.market], http, base()).tick();

    expect(requested).toEqual([FEED_6K]);
    expect(hk.handled.length).toBeGreaterThan(0);
    expect(hk.handled.every((f) => f.cik === 1073404)).toBe(true);
    expect(new Set(jp.handled.map((f) => f.cik))).toEqual(new Set([1735556, 1999297]));
    // Index-URL CIK, acceptance in UTC, oldest first.
    for (const f of [...hk.handled, ...jp.handled]) {
      expect(f.indexUrl).toContain(`/edgar/data/${f.cik}/`);
      expect(f.acceptedAt).toMatch(/Z$/);
    }
    const accepted = hk.handled.map((f) => f.acceptedAt);
    expect(accepted).toEqual([...accepted].sort());
    expect(ids.sort()).toEqual([7, 3_000_000_297, 3_000_000_556].sort());
    expect(hk.onChanged).toHaveBeenCalledWith([7]);
    expect(jp.onChanged).toHaveBeenCalledWith([3_000_000_556]);

    // A second tick: everything is seen, still one feed request and nothing handled again.
    const before = hk.handled.length + jp.handled.length;
    const w = new SixKWatch([hk.market, jp.market], http, base());
    await w.tick();
    expect(requested).toEqual([FEED_6K, FEED_6K]);
    expect(hk.handled.length + jp.handled.length).toBe(before);
  });

  it('2 s when any market is due, else 30 s', async () => {
    const { http } = stubHttp({ [FEED_6K]: feedXml });
    const idle = stubMarket('hk', []);
    const due = stubMarket('jp', [], { due: true });
    expect(new SixKWatch([idle.market, due.market], http, base()).intervalMs()).toBe(2_000);
    expect(new SixKWatch([idle.market, stubMarket('jp', []).market], http, base()).intervalMs()).toBe(30_000);

    vi.useFakeTimers();
    const fast = stubHttp({ [FEED_6K]: feedXml });
    const w = new SixKWatch([idle.market, due.market], fast.http, base());
    w.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fast.requested.length).toBe(1);
    w.stop();
  });

  it('a failing filing is retried and left to the sweep after 10 tries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { http } = stubHttp({ [FEED_6K]: feedXml });
    const jp = stubMarket('jp', [1999297], { handle: async () => { throw new HttpError(503, 'x'); } });
    const w = new SixKWatch([jp.market], http, base());
    for (let i = 0; i < 10; i++) await w.tick();
    expect(jp.handled.length).toBe(10);
    await w.tick(); // given up: the sweep picks it up (not marked seen)
    expect(jp.handled.length).toBe(10);
    expect(jp.market.seen(jp.handled[0]!.accession)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/\[jp-sec\] .*left to the sweep after 10 tries/));
  });
});
