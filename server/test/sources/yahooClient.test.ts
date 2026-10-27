import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYahooClient } from '../../src/sources/yahooClient.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('YahooClient', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('GET and POST share one 1 s limiter', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => { starts.push(Date.now() - t0); return ok({ ok: 1 }); });
    const y = createYahooClient({
      session: async () => ({ crumb: 'C', headers: { Cookie: 'k=v' } }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => Date.now(),
    });
    const all = Promise.all([
      y.json('https://query1.finance.yahoo.com/a'),
      y.postJson('https://query1.finance.yahoo.com/b', { x: 1 }),
      y.text('https://query1.finance.yahoo.com/c?d=1'),
    ]);
    await vi.advanceTimersByTimeAsync(2500);
    await all;
    expect(starts).toEqual([0, 1000, 2000]);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      'https://query1.finance.yahoo.com/a?crumb=C',
      'https://query1.finance.yahoo.com/b?crumb=C',
      'https://query1.finance.yahoo.com/c?d=1&crumb=C',
    ]);
    const post = fetchImpl.mock.calls[1]![1]!;
    expect(post.method).toBe('POST');
    expect(post.body).toBe('{"x":1}');
    expect((post.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((post.headers as Record<string, string>).Cookie).toBe('k=v');
  });

  it('401 renews the session once', async () => {
    let n = 0;
    const session = vi.fn(async () => ({ crumb: `C${++n}`, headers: {} }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('no', { status: 401 }))
      .mockResolvedValueOnce(ok({ fine: true }));
    const y = createYahooClient({ minIntervalMs: 0, session, fetchImpl });
    await expect(y.json('https://query1.finance.yahoo.com/q')).resolves.toEqual({ fine: true });
    expect(session).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe('https://query1.finance.yahoo.com/q?crumb=C2');

    // A second 401 in a row is not retried again.
    fetchImpl.mockResolvedValueOnce(new Response('no', { status: 403 })).mockResolvedValueOnce(new Response('no', { status: 403 }));
    await expect(y.json('https://query1.finance.yahoo.com/q')).rejects.toMatchObject({ status: 403 });
    expect(session).toHaveBeenCalledTimes(3);

    // The session is reused while it works.
    fetchImpl.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({}));
    await y.json('https://query1.finance.yahoo.com/q');
    await y.json('https://query1.finance.yahoo.com/q');
    expect(session).toHaveBeenCalledTimes(3);
  });

  it('crumb never in the error message', async () => {
    const crumb = 'SeCrEt.CrUmB/x';
    const y = createYahooClient({
      minIntervalMs: 0,
      session: async () => ({ crumb, headers: {} }),
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response('gone', { status: 404 }))
        .mockRejectedValueOnce(new TypeError(`fetch failed for https://x/?crumb=${crumb}`)) as unknown as typeof fetch,
    });
    const e1 = await y.json('https://query1.finance.yahoo.com/v7/finance/quote?symbols=A.T').catch((e: Error) => e);
    expect(String((e1 as Error).message)).toContain('https://query1.finance.yahoo.com/v7/finance/quote?symbols=A.T');
    expect(String((e1 as Error).message)).not.toContain(crumb);
    expect(String((e1 as Error).message)).not.toContain(encodeURIComponent(crumb));
    const e2 = await y.postJson('https://query1.finance.yahoo.com/v1/finance/visualization', {}).catch((e: Error) => e);
    expect(e2).toBeInstanceOf(Error);
    expect(String((e2 as Error).message)).toContain('https://query1.finance.yahoo.com/v1/finance/visualization');
    expect(String((e2 as Error).message)).not.toContain(crumb);
    expect(String((e2 as Error).message)).not.toContain(encodeURIComponent(crumb));
  });
});
