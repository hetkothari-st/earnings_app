import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchYahooPastDates, parseYahooPastDates } from '../../src/india/sources/yahooPastDates.js';

// Real response (RELIANCE.NS, 2026-10-21).
const real = JSON.parse(readFileSync(new URL('../fixtures/india/yahoo_visualization_RELIANCE.json', import.meta.url), 'utf8'));

describe('Yahoo past dates', () => {
  it('Yahoo past dates: TAS rows only, IST timing', () => {
    // Add rows of other types: they carry no real time and must be ignored.
    const json = structuredClone(real);
    json.finance.result[0].documents[0].rows.unshift(['RELIANCE.NS', '2026-07-17T00:00:00.000Z', 'TNS'], ['RELIANCE.NS', '2026-10-16T00:00:00.000Z', 'TBA']);
    const rows = parseYahooPastDates(json);
    expect(rows).toHaveLength(10);
    // 2025-04-25T14:31Z = 20:01 IST (after close); 2024-08-27T08:30Z = 14:00 IST (during market); 2024-01-19T11:30Z = 17:00 IST.
    expect(rows[0]).toEqual({ date: '2025-04-25', timing: 'AMC' });
    expect(rows.find((r) => r.date === '2024-08-27')).toEqual({ date: '2024-08-27', timing: 'DMH' });
    expect(rows.find((r) => r.date === '2024-01-19')).toEqual({ date: '2024-01-19', timing: 'AMC' });
  });

  it('the date is the IST date: 20:30Z is already the next day in India', () => {
    const json = { finance: { result: [{ documents: [{ rows: [['X.NS', '2026-07-17T20:30:00.000Z', 'TAS'], ['X.NS', '2026-07-10T03:00:00.000Z', 'TAS']] }] }] } };
    expect(parseYahooPastDates(json)).toEqual([{ date: '2026-07-18', timing: 'BMO' }, { date: '2026-07-10', timing: 'BMO' }]);
  });

  it('no rows or an unexpected shape gives an empty list', () => {
    expect(parseYahooPastDates({ finance: { result: [{ documents: [] }] } })).toEqual([]);
    expect(parseYahooPastDates({ finance: { result: null, error: { code: 'x' } } })).toEqual([]);
  });

  it('POSTs with the session cookie and crumb and the ticker as RELIANCE.NS', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(real), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchYahooPastDates('RELIANCE', { session: async () => ({ headers: { Cookie: 'A=1', 'User-Agent': 'ua' }, crumb: 'c r' }), fetchImpl });
    expect(out[0]).toEqual({ date: '2025-04-25', timing: 'AMC' });
    expect(calls[0]!.url).toBe('https://query1.finance.yahoo.com/v1/finance/visualization?crumb=c%20r');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Cookie).toBe('A=1');
    expect(JSON.parse(calls[0]!.init.body as string).query.operands).toEqual(['ticker', 'RELIANCE.NS']);
  });

  it('a non-200 answer throws so the caller records the error', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(fetchYahooPastDates('X', { session: async () => ({ headers: {}, crumb: 'c' }), fetchImpl })).rejects.toThrow(/429/);
  });
});
