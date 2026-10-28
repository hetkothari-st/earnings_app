import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenFigi, figiRunComplete } from '../../src/europe/sources/openFigi.js';

const batch = readFileSync(new URL('../fixtures/europe/universe/openfigi_batch.json', import.meta.url), 'utf8');
/** Jobs matching the fixture's ten answers, in order (the warning at 4 is a growth-segment ISIN asked with SS). */
const FIXTURE_JOBS = [
  { isin: 'GB0009895292', exchCode: 'LN' }, { isin: 'GB0030913577', exchCode: 'LN' }, { isin: 'SE0000108656', exchCode: 'SS' },
  { isin: 'DK0062498333', exchCode: 'DC' }, { isin: 'FI0009013403', exchCode: 'SS' }, { isin: 'FR0000130452', exchCode: 'FP' },
  { isin: 'FI0009013403', exchCode: 'FH' }, { isin: 'CH0012005267', exchCode: 'SE' }, { isin: 'DE0007164600', exchCode: 'GY' },
  { isin: 'NO0003053605', exchCode: 'NO' },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createOpenFigi', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-28T10:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('10 jobs per request; 2.5 s apart', async () => {
    const calls: { at: number; jobs: unknown[]; headers: Headers }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const jobs = JSON.parse(String(init.body)) as unknown[];
      calls.push({ at: Date.now(), jobs, headers: new Headers(init.headers) });
      return json(jobs.map(() => ({ warning: 'No identifier found.' })));
    }) as unknown as typeof fetch;
    const figi = createOpenFigi({ fetchImpl, now: () => Date.now() });
    const jobs = Array.from({ length: 25 }, (_, i) => ({ isin: `GB00000000${String(i).padStart(2, '0')}`, exchCode: 'LN' }));
    const p = figi.map(jobs);
    await vi.runAllTimersAsync();
    const answers = await p;
    expect(answers).toHaveLength(25);
    expect(calls.map((c) => c.jobs.length)).toEqual([10, 10, 5]);
    const t0 = calls[0]!.at;
    expect(calls.map((c) => c.at - t0)).toEqual([0, 2500, 5000]);
    expect(calls[0]!.jobs[0]).toEqual({ idType: 'ID_ISIN', idValue: 'GB0000000000', exchCode: 'LN' });
    expect(calls[0]!.headers.get('x-openfigi-apikey')).toBeNull();
  });

  it('key only in header; 401 error text has no key', async () => {
    const seen: { url: string; body: string; key: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), key: new Headers(init.headers).get('x-openfigi-apikey') });
      return new Response('Invalid API key.', { status: 401 });
    }) as unknown as typeof fetch;
    const figi = createOpenFigi({ key: 'sekrit-123', fetchImpl, now: () => Date.now() });
    let err: unknown;
    const p = figi.map([{ isin: 'GB0009895292', exchCode: 'LN' }]).catch((e: unknown) => { err = e; });
    await vi.runAllTimersAsync();
    await p;
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain('401');
    expect(`${String(err)} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`).not.toContain('sekrit-123');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe('sekrit-123');
    expect(seen[0]!.url).toBe('https://api.openfigi.com/v3/mapping');
    expect(seen[0]!.url + seen[0]!.body).not.toContain('sekrit-123');
  });

  it('with a key, 100 jobs per request', async () => {
    const sizes: number[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const jobs = JSON.parse(String(init.body)) as unknown[];
      sizes.push(jobs.length);
      return json(jobs.map(() => ({ warning: 'No identifier found.' })));
    }) as unknown as typeof fetch;
    const figi = createOpenFigi({ key: 'sekrit-123', fetchImpl, now: () => Date.now() });
    const p = figi.map(Array.from({ length: 150 }, (_, i) => ({ isin: `X${i}`, exchCode: 'LN' })));
    await vi.runAllTimersAsync();
    await p;
    expect(sizes).toEqual([100, 50]);
  });

  it('warning answer → no tickers', async () => {
    const fetchImpl = (async () => new Response(batch, { status: 200 })) as unknown as typeof fetch;
    const figi = createOpenFigi({ fetchImpl, now: () => Date.now() });
    const p = figi.map(FIXTURE_JOBS);
    await vi.runAllTimersAsync();
    const a = await p;
    expect(a[4]).toEqual({ isin: 'FI0009013403', exchCode: 'SS', tickers: [] });
    expect(a[0]).toEqual({ isin: 'GB0009895292', exchCode: 'LN', tickers: ['AZN'] });
    expect(a[1]!.tickers).toEqual(['BT/A']);
    expect(a[2]!.tickers).toEqual(['ERICB']);
    // Eiffage: two tickers on one exchange are both returned (the build leaves it out).
    expect(a[5]!.tickers).toEqual(['FGR', 'FGRMC']);
  });
  it('one failed request loses only its own jobs (failed, no tickers); the others are kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const jobs = JSON.parse(String(init.body)) as { idValue: string }[];
      n++;
      if (n === 2) return new Response('upstream down', { status: 503 });
      return json(jobs.map((j) => ({ data: [{ ticker: `T${j.idValue}`, exchCode: 'LN' }] })));
    }) as unknown as typeof fetch;
    const figi = createOpenFigi({ fetchImpl, now: () => Date.now() });
    const jobs = Array.from({ length: 25 }, (_, i) => ({ isin: `I${i}`, exchCode: 'LN' }));
    const p = figi.map(jobs);
    await vi.runAllTimersAsync();
    const a = await p;
    expect(a).toHaveLength(25);
    expect(a.slice(0, 10).every((x) => x.tickers.length === 1 && !x.failed)).toBe(true);
    expect(a.slice(10, 20).every((x) => x.tickers.length === 0 && x.failed === true)).toBe(true);
    expect(a.slice(20).every((x) => x.tickers.length === 1 && !x.failed)).toBe(true);
    expect(figiRunComplete(a)).toBe(false);
    expect(figiRunComplete(a.slice(0, 10))).toBe(true);
    warn.mockRestore();
  });
});
