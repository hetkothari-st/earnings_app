import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTradegate, createTradegate } from '../../src/europe/sources/tradegate.js';
import { createSlotLimiter } from '../../src/sources/yahooLimiter.js';
import { EUROPE_UA } from '../../src/europe/sources/sourceUrls.js';

const fx = (n: string): string => readFileSync(new URL(`../fixtures/europe/feeds/${n}`, import.meta.url), 'utf8');
const AT = '2026-10-28T10:00:00.000Z';
const SAP = 'DE0007164600';
const AZN = 'GB0009895292';

const instant = { wait: async () => {} };

interface Call {
  url: string;
  headers: Record<string, string>;
}
function fakeFetch(handler: (url: string, n: number) => { status?: number; body: string }) {
  const calls: Call[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: { ...(init?.headers as Record<string, string>) } });
    const r = handler(u, calls.length);
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}
const isRobots = (u: string): boolean => u.endsWith('/robots.txt');
const okHandler = (u: string): { body: string } =>
  isRobots(u) ? { body: fx('tradegate_robots.txt') } : { body: fx('tradegate_DE0007164600.json') };

afterEach(() => vi.useRealTimers());

describe('parseTradegate', () => {
  it('parses the SAP and AZN fixtures; unknown ISIN → null', () => {
    const sap = parseTradegate(JSON.parse(fx('tradegate_DE0007164600.json')), SAP, AT)!;
    // bid is a JSON number, ask / high are German strings in the same answer
    expect(sap).toMatchObject({ isin: SAP, last: 213.15, close: 213, bid: 212.55, ask: 213.1, at: AT });
    const azn = parseTradegate(JSON.parse(fx('tradegate_GB0009895292.json')), AZN, AT)!;
    expect(azn).toMatchObject({ last: 152.4, close: 153.9, bid: 152.4, ask: 153 });
    const open = parseTradegate(JSON.parse(fx('tradegate_DE0007164600_open.json')), SAP, AT)!;
    expect(open).toMatchObject({ last: 211.9, close: 212.85, bid: 211.6, ask: 211.9 });
    // an unknown ISIN answers an empty body: nothing to parse
    expect(fx('tradegate_unknown.json').trim()).toBe('');
    expect(parseTradegate(null, 'XX0000000000', AT)).toBeNull();
    expect(parseTradegate('', 'XX0000000000', AT)).toBeNull();
    expect(parseTradegate({}, 'XX0000000000', AT)).toBeNull();
    expect(parseTradegate({ last: 'n/a', close: '' }, 'XX0000000000', AT)).toBeNull();
  });

  it("change from the same answer's close", () => {
    const sap = parseTradegate(JSON.parse(fx('tradegate_DE0007164600_open.json')), SAP, AT)!;
    expect(sap.changePct).toBeCloseTo(((211.9 - 212.85) / 212.85) * 100, 10);
    const azn = parseTradegate(JSON.parse(fx('tradegate_GB0009895292.json')), AZN, AT)!;
    expect(azn.changePct).toBeCloseTo(-0.97, 2); // matches Tradegate's own delta
    expect(parseTradegate({ last: 5 }, SAP, AT)).toMatchObject({ last: 5, close: null, changePct: null });
    expect(parseTradegate({ close: '5,00' }, SAP, AT)).toMatchObject({ last: null, close: 5, changePct: null });
    expect(parseTradegate({ last: 5, close: 0 }, SAP, AT)!.changePct).toBeNull();
    expect(parseTradegate({ last: '1.234,50', close: 1000 }, SAP, AT)!.last).toBe(1234.5);
  });
});

describe('createTradegate', () => {
  it('requests 1 s apart', async () => {
    vi.useFakeTimers();
    const { impl, calls } = fakeFetch(okHandler);
    const stamps: number[] = [];
    const f = (async (...a: Parameters<typeof fetch>) => {
      stamps.push(Date.now());
      return impl(...a);
    }) as typeof fetch;
    const tg = createTradegate({ enabled: true, fetchImpl: f, limiter: createSlotLimiter(1000, () => Date.now()) });
    const ps = [tg.quote(SAP), tg.quote(SAP), tg.quote(SAP)];
    await vi.advanceTimersByTimeAsync(3000);
    const qs = await Promise.all(ps);
    expect(qs.every((q) => q?.last === 213.15)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(1000);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(1000);
    expect(calls[0]!.url).toBe(`https://www.tradegatebsx.com/refresh.php?isin=${SAP}`);
    expect(calls[0]!.url).not.toContain('/json/');
  });

  it('429 → backoff 1 h, no fetch during it, resumes after', async () => {
    let t = 1_000_000;
    let status = 429;
    const { impl, calls } = fakeFetch((u) =>
      isRobots(u)
        ? { body: fx('tradegate_robots.txt') }
        : { status, body: status === 200 ? fx('tradegate_DE0007164600.json') : '' },
    );
    const tg = createTradegate({ enabled: true, fetchImpl: impl, now: () => t, limiter: instant });
    expect(tg.state()).toBe('on');
    expect(await tg.quote(SAP)).toBeNull();
    expect(tg.state()).toBe('backoff');
    expect(tg.backoffUntil()).toBe(new Date(t + 3_600_000).toISOString());
    expect(calls).toHaveLength(1);
    t += 3_599_999;
    expect(await tg.quote(SAP)).toBeNull();
    expect(calls).toHaveLength(1);
    t += 1;
    status = 200;
    expect((await tg.quote(SAP))?.last).toBe(213.15);
    expect(calls).toHaveLength(2);
    expect(tg.state()).toBe('on');
    expect(tg.backoffUntil()).toBeNull();
    expect(tg.lastPollAt()).toBe(new Date(t).toISOString());
    // 403 does the same
    status = 403;
    expect(await tg.quote(SAP)).toBeNull();
    expect(tg.state()).toBe('backoff');
  });

  it('robots disallowing /refresh.php → off-robots, no quote fetch', async () => {
    let robots = 'User-agent: *\nDisallow: /refresh.php\n';
    const { impl, calls } = fakeFetch((u) =>
      isRobots(u) ? { body: robots } : { body: fx('tradegate_DE0007164600.json') },
    );
    const tg = createTradegate({ enabled: true, fetchImpl: impl, limiter: instant });
    await tg.checkRobots();
    expect(tg.state()).toBe('off-robots');
    expect(await tg.quote(SAP)).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(['https://www.tradegatebsx.com/robots.txt']);
    // a later check that allows it again turns it back on
    robots = fx('tradegate_robots.txt');
    await tg.checkRobots();
    expect(tg.state()).toBe('on');
    expect((await tg.quote(SAP))?.last).toBe(213.15);
  });

  it('a failed robots fetch keeps the previous state; the first ever failure is off-robots', async () => {
    let fail = true;
    const { impl } = fakeFetch((u) =>
      isRobots(u) ? (fail ? { status: 500, body: '' } : { body: fx('tradegate_robots.txt') }) : { body: '' },
    );
    const tg = createTradegate({ enabled: true, fetchImpl: impl, limiter: instant });
    await tg.checkRobots();
    expect(tg.state()).toBe('off-robots');
    fail = false;
    await tg.checkRobots();
    expect(tg.state()).toBe('on');
    fail = true;
    await tg.checkRobots();
    expect(tg.state()).toBe('on');
    const thrower = createTradegate({
      enabled: true,
      fetchImpl: (async () => {
        throw new Error('down');
      }) as typeof fetch,
      limiter: instant,
    });
    await thrower.checkRobots();
    expect(thrower.state()).toBe('off-robots');
  });

  it('TRADEGATE_PRICES=0 → off-env, never fetches', async () => {
    const { impl, calls } = fakeFetch(okHandler);
    const tg = createTradegate({ enabled: false, fetchImpl: impl, limiter: instant });
    expect(tg.state()).toBe('off-env');
    await tg.checkRobots();
    expect(await tg.quote(SAP)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(tg.state()).toBe('off-env');
    expect(tg.lastPollAt()).toBeNull();
  });

  it('unknown ISIN (empty 200 body) → null and not an error', async () => {
    const { impl } = fakeFetch(() => ({ body: fx('tradegate_unknown.json') }));
    const tg = createTradegate({ enabled: true, fetchImpl: impl, limiter: instant });
    expect(await tg.quote('XX0000000000')).toBeNull();
    expect(tg.state()).toBe('on');
  });

  it('User-Agent has no @', async () => {
    const { impl, calls } = fakeFetch(okHandler);
    const tg = createTradegate({ enabled: true, fetchImpl: impl, limiter: instant });
    await tg.checkRobots();
    await tg.quote(SAP);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers['User-Agent']).toBe(EUROPE_UA);
      expect(c.headers['User-Agent']).not.toContain('@');
      expect(c.headers['Accept']).toBe('application/json');
    }
  });
});
