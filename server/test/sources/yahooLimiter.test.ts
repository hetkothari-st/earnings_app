import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHttp } from '../../src/sources/http.js';
import { createYahooClient } from '../../src/sources/yahooClient.js';
import { createSlotLimiter } from '../../src/sources/yahooLimiter.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('cross-market Yahoo limiter', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('the Japan client and another market\'s Yahoo client share one 1 s budget', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: string[] = [];
    const fetchImpl = (who: string) => vi.fn(async () => { starts.push(`${who}@${Date.now() - t0}`); return ok({ ok: 1 }); }) as unknown as typeof fetch;
    const shared = createSlotLimiter(1000, () => Date.now());
    const jp = createYahooClient({ session: async () => ({ crumb: 'C', headers: {} }), fetchImpl: fetchImpl('jp'), limiter: shared });
    const hk = makeHttp({ minIntervalMs: 1000, fetchImpl: fetchImpl('hk'), limiter: shared });
    const all = Promise.all([
      jp.json('https://query1.finance.yahoo.com/a'),
      hk.json('https://query2.finance.yahoo.com/b'),
      jp.json('https://query1.finance.yahoo.com/c'),
      hk.json('https://query2.finance.yahoo.com/d'),
    ]);
    await vi.advanceTimersByTimeAsync(3500);
    await all;
    expect(starts.map((s) => Number(s.split('@')[1]))).toEqual([0, 1000, 2000, 3000]);
    expect(new Set(starts.map((s) => s.split('@')[0]))).toEqual(new Set(['jp', 'hk']));
  });

  it('without a shared limiter each client keeps its own', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => { starts.push(Date.now() - t0); return ok({}); }) as unknown as typeof fetch;
    const a = makeHttp({ minIntervalMs: 1000, fetchImpl });
    const b = makeHttp({ minIntervalMs: 1000, fetchImpl });
    const all = Promise.all([a.json('https://x/1'), b.json('https://x/2')]);
    await vi.advanceTimersByTimeAsync(10);
    await all;
    expect(starts).toEqual([0, 0]);
  });
});
