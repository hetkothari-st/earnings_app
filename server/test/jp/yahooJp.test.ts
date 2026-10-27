import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { HKT } from '../../src/hk/domain/hkCalendar.js';
import { parseYahooHkSummary } from '../../src/hk/sources/yahooHk.js';
import { JST } from '../../src/jp/domain/jpCalendar.js';
import {
  createYahooJpSummary, fetchJpEarningsCalendar, fetchYahooQuotes, jpRevenueQuarterLabel, parseYahooCalendarPage,
} from '../../src/jp/sources/yahooJp.js';
import { HttpError } from '../../src/sources/http.js';
import { parseIndexQuote, parseYahooDailyCloses } from '../../src/sources/yahoo.js';
import type { YahooClient } from '../../src/sources/yahooClient.js';
import { parseYahooSummaryFor } from '../../src/sources/yahooForeignSummary.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/jp/${n}`, import.meta.url), 'utf8'));
const hkFx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8'));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** A YahooClient stub; only the methods a test sets are usable. */
function stub(o: { json?: (url: string) => Promise<unknown>; postJson?: (url: string, body: unknown) => Promise<unknown> }): YahooClient {
  return {
    json: o.json ?? (async () => { throw new Error('json not stubbed'); }),
    text: async () => { throw new Error('text not stubbed'); },
    postJson: o.postJson ?? (async () => { throw new Error('postJson not stubbed'); }),
  };
}

describe('Yahoo JP bulk calendar', () => {
  it('calendar page: TAS row gets JST date and timing; other rows the UTC date and UNKNOWN', () => {
    const p = parseYahooCalendarPage(fx('y_cal_page1.json'));
    expect(p.total).toBe(185);
    // 100 rows on the page, 4 of them not on Tokyo (.S Sapporo, .F Fukuoka): dropped.
    expect(p.rows.length).toBe(96);
    expect(p.rows.every((r) => r.symbol.endsWith('.T'))).toBe(true);
    expect(p.rows[0]).toEqual({ symbol: '2593.T', code: '2593', date: '2025-06-02', timing: 'AMC', timeType: 'TAS', epsActual: 22.74 });
    // 2025-06-02T07:30Z = 16:30 JST.
    expect(p.rows.find((r) => r.symbol === '7865.T')).toEqual({ symbol: '7865.T', code: '7865', date: '2025-06-02', timing: 'AMC', timeType: 'TAS', epsActual: null });
    // The one TNS (time not supplied) row: "2025-06-11T10:59:00.000Z" -> UTC date, no timing.
    expect(p.rows.filter((r) => r.timeType !== 'TAS')).toEqual([
      { symbol: '6325.T', code: '6325', date: '2025-06-11', timing: 'UNKNOWN', timeType: 'TNS', epsActual: null },
    ]);

    const inline = {
      finance: { result: [{ total: 2, documents: [{
        columns: [{ id: 'ticker' }, { id: 'startdatetime' }, { id: 'startdatetimetype' }],
        rows: [['7203.T', '2026-11-05T04:25:00.000Z', 'TAS'], ['7203.T', '2026-11-04T22:00:00.000Z', 'TNS']],
      }] }] },
    };
    const q = parseYahooCalendarPage(inline);
    expect(q.total).toBe(2);
    expect(q.rows[0]).toEqual({ symbol: '7203.T', code: '7203', date: '2026-11-05', timing: 'DMH', timeType: 'TAS', epsActual: null });
    // 22:00 UTC is already the 5th in Tokyo, but a non-TAS row keeps the UTC date.
    const at = (iso: string) => parseYahooCalendarPage({ finance: { result: [{ total: 1, documents: [{
      columns: [{ id: 'ticker' }, { id: 'startdatetime' }, { id: 'startdatetimetype' }], rows: [['7203.T', iso, 'TAS']],
    }] }] } }).rows[0]!.timing;
    // A TAS row at 15:30 JST (06:30Z) is at the close: AMC; 15:29 is still during.
    expect(at('2026-11-05T06:30:00.000Z')).toBe('AMC');
    expect(at('2026-11-05T06:29:00.000Z')).toBe('DMH');
    expect(q.rows[1]).toMatchObject({ date: '2026-11-04', timing: 'UNKNOWN' });
  });

  it('calendar page: no result gives no rows and no total', () => {
    expect(parseYahooCalendarPage({ finance: { result: null, error: null } })).toEqual({ rows: [], total: null });
    expect(parseYahooCalendarPage(null)).toEqual({ rows: [], total: null });
  });

  it('sweep pages until total; a failing page keeps earlier rows, complete false', async () => {
    const p1 = fx('y_cal_page1.json');
    const p2 = fx('y_cal_page2.json');
    const bodies: { offset: number; size: number; query: unknown }[] = [];
    const urls: string[] = [];
    const y = stub({ postJson: async (url, body) => {
      urls.push(url);
      const b = body as { offset: number; size: number; query: unknown };
      bodies.push(b);
      return b.offset === 0 ? p1 : b.offset === 100 ? p2 : (() => { throw new Error('asked past total'); })();
    } });
    const all = await fetchJpEarningsCalendar(y, '2025-06-01', '2025-06-13');
    expect(all.complete).toBe(true);
    expect(bodies.map((b) => b.offset)).toEqual([0, 100]);
    expect(bodies.every((b) => b.size === 100)).toBe(true);
    expect(urls.every((u) => u === 'https://query1.finance.yahoo.com/v1/finance/visualization')).toBe(true);
    // One day of margin on each side (Yahoo reads the bounds as US Eastern dates); the region operand.
    expect(bodies[0]!.query).toEqual({ operator: 'and', operands: [
      { operator: 'gte', operands: ['startdatetime', '2025-05-31'] },
      { operator: 'lt', operands: ['startdatetime', '2025-06-15'] },
      { operator: 'eq', operands: ['region', 'jp'] },
    ] });
    expect(all.rows.length).toBe(96 + 83);

    // The window is applied to the mapped dates.
    const narrow = await fetchJpEarningsCalendar(y, '2025-06-03', '2025-06-03');
    expect(narrow.rows.length).toBeGreaterThan(0);
    expect(narrow.rows.every((r) => r.date === '2025-06-03')).toBe(true);

    // Page 7 of 40 fails: pages 1–6 are kept, complete is false.
    const big = clone(p1);
    big.finance.result[0].total = 4000;
    let calls = 0;
    const failing = stub({ postJson: async () => { calls++; if (calls === 7) throw new HttpError(500, 'https://query1.finance.yahoo.com/v1/finance/visualization'); return big; } });
    const partial = await fetchJpEarningsCalendar(failing, '2025-06-01', '2025-06-13');
    expect(calls).toBe(7);
    expect(partial.complete).toBe(false);
    expect(partial.rows.length).toBe(6 * 96);

    // An empty page ends the sweep (complete); the 80-page cap does not count as complete.
    const empty = clone(p1);
    empty.finance.result[0].documents[0].rows = [];
    let n = 0;
    const endsEarly = stub({ postJson: async () => (++n === 1 ? big : empty) });
    expect((await fetchJpEarningsCalendar(endsEarly, '2025-06-01', '2025-06-13')).complete).toBe(true);
    expect(n).toBe(2);
    const huge = clone(p1);
    huge.finance.result[0].total = 1_000_000;
    let m = 0;
    const endless = stub({ postJson: async () => { m++; return huge; } });
    const capped = await fetchJpEarningsCalendar(endless, '2025-06-01', '2025-06-13');
    expect(m).toBe(80);
    expect(capped.complete).toBe(false);
  });

  it('a first page that fails gives no rows, complete false', async () => {
    const y = stub({ postJson: async () => { throw new HttpError(429, 'https://query1.finance.yahoo.com/v1/finance/visualization'); } });
    expect(await fetchJpEarningsCalendar(y, '2025-06-01', '2025-06-13')).toEqual({ rows: [], complete: false });
  });
});

describe('Yahoo JP batch quotes', () => {
  it('batch quotes: alphanumeric code present, unknown symbol absent, cap only in JPY', async () => {
    const batch = fx('y_quote_batch.json');
    const asked: string[] = [];
    const y = stub({ json: async (url) => { asked.push(url); return asked.length === 1 ? batch : { quoteResponse: { result: [], error: null } }; } });
    const fifty = ['7203.T', '6758.T', '8306.T', '8316.T', '8411.T', '7267.T', '8604.T', '4502.T', '9983.T', '3382.T', '6861.T', '9984.T',
      '9432.T', '9433.T', '8035.T', '6501.T', '6098.T', '4063.T', '8058.T', '8001.T', '8031.T', '7974.T', '6902.T', '4519.T', '4568.T',
      '6367.T', '7741.T', '6594.T', '6981.T', '6954.T', '2914.T', '4661.T', '8766.T', '8591.T', '8802.T', '9022.T', '9020.T', '5108.T',
      '6273.T', '7751.T', '4543.T', '6702.T', '6752.T', '7011.T', '8053.T', '4452.T', '2802.T', '1306.T', '285A.T', '0001.T'];
    const extra = Array.from({ length: 70 }, (_, i) => `${1300 + i}.T`);
    const quotes = await fetchYahooQuotes(y, [...fifty, ...extra]);
    expect(asked.length).toBe(3);
    expect(asked[0]).toBe(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${fifty.join(',')}`);
    expect(asked.map((u) => new URL(u).searchParams.get('symbols')!.split(',').length)).toEqual([50, 50, 20]);

    expect(quotes.size).toBe(49);
    expect(quotes.has('0001.T')).toBe(false);
    expect(quotes.get('285A.T')).toEqual({
      symbol: '285A.T', price: 12605, prevClose: 12550, time: 1793082600_000, currency: 'JPY',
      marketCap: 20141599358976, name: 'Kioxia Holdings Corporation',
    });
    expect(quotes.get('7203.T')).toMatchObject({ price: 3102, prevClose: 3117, currency: 'JPY', name: 'Toyota Motor Corporation' });
    expect(quotes.get('1306.T')!.marketCap).toBeNull(); // the ETF has no cap

    const usd = clone(batch);
    const k = usd.quoteResponse.result.find((q: { symbol: string }) => q.symbol === '285A.T');
    k.currency = 'USD';
    const q2 = await fetchYahooQuotes(stub({ json: async () => usd }), ['285A.T']);
    expect(q2.get('285A.T')).toMatchObject({ currency: 'USD', marketCap: null, price: 12605 });
  });

  it('no symbols, no request', async () => {
    const json = vi.fn();
    expect((await fetchYahooQuotes(stub({ json }), [])).size).toBe(0);
    expect(json).not.toHaveBeenCalled();
  });
});

describe('Yahoo JP summary', () => {
  it('summary: JPY cap, trend periods with end dates, single next date', async () => {
    const raw = fx('y_7203.T.json');
    const urls: string[] = [];
    const y = stub({ json: async (url) => { urls.push(url); return raw; } });
    const get = createYahooJpSummary(y);
    const s = (await get('7203.T', 60_000))!;
    expect(urls).toEqual(['https://query2.finance.yahoo.com/v10/finance/quoteSummary/7203.T?modules=price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings']);
    expect(s.name).toBe('Toyota Motor Corporation');
    expect(s.priceCurrency).toBe('JPY');
    expect(s.marketCap).toBe(36535558733824);
    expect(s.marketCapAsOf).toBe('2026-10-27');
    expect(s.sector).toBe('Consumer Cyclical');
    expect(s.industry).toBe('Auto Manufacturers');
    expect(s.nextDate).toBe('2026-11-05');
    expect(s.trend.map((t) => [t.period, t.periodEnd])).toEqual([
      ['0q', '2026-09-30'], ['+1q', '2026-12-31'], ['0y', '2027-03-31'], ['+1y', '2028-03-31'],
    ]);
    expect(s.trend[0]).toMatchObject({ eps: 56.37642, epsCurrency: 'JPY', revenue: 13345378533800, revenueCurrency: 'JPY' });
    expect(s.epsHistory.at(-1)).toEqual({ periodEnd: '2026-06-30', actual: 120.69, currency: 'JPY' });
    expect(s.revenueQuarters.at(-1)).toEqual({ label: '2Q2026', revenue: 13525400000000 });
    expect(s.financialCurrency).toBe('JPY');

    // Cached by fetch time.
    await get('7203.T', 60_000);
    expect(urls.length).toBe(1);
    await get('7203.T', 0);
    expect(urls.length).toBe(2);
  });

  it('cap is null when the quote is not in JPY', () => {
    const raw = clone(fx('y_7203.T.json'));
    raw.quoteSummary.result[0].price.currency = 'USD';
    const s = parseYahooSummaryFor(raw, { zone: JST, capCurrency: 'JPY' });
    expect(s.marketCap).toBeNull();
    expect(s.marketCapAsOf).toBeNull();
  });

  it('failures are not cached; an unknown symbol is null', async () => {
    let n = 0;
    const y = stub({ json: async () => { n++; if (n === 1) throw new HttpError(500, 'x'); if (n === 2) return fx('y_7203.T.json'); throw new HttpError(404, 'y'); } });
    const get = createYahooJpSummary(y);
    await expect(get('7203.T', 60_000)).rejects.toBeInstanceOf(HttpError);
    expect((await get('7203.T', 60_000))!.priceCurrency).toBe('JPY');
    expect(n).toBe(2);
    expect(await get('0001.T', 60_000)).toBeNull();
  });

  it('Feb and Aug fiscal years: trend end dates are month ends', () => {
    const isMonthEnd = (d: string) => DateTime.fromISO(d).endOf('month').toISODate() === d;
    const s3382 = parseYahooSummaryFor(fx('y_3382.T.json'), { zone: JST, capCurrency: 'JPY' });
    expect(s3382.trend.map((t) => t.periodEnd)).toEqual(['2026-11-30', '2027-02-28', '2027-02-28', '2028-02-29']);
    const s9983 = parseYahooSummaryFor(fx('y_9983.T.json'), { zone: JST, capCurrency: 'JPY' });
    expect(s9983.trend.map((t) => t.periodEnd)).toEqual(['2026-11-30', '2027-02-28', '2027-08-31', '2028-08-31']);
    for (const s of [s3382, s9983]) {
      expect(s.trend.every((t) => isMonthEnd(t.periodEnd))).toBe(true);
      expect(s.epsHistory.every((h) => isMonthEnd(h.periodEnd))).toBe(true);
      expect(s.nextDate).toBe('2027-01-07');
    }
  });

  it('revenue quarter label rule', () => {
    // financialsChart.quarterly and earningsChart.quarterly list the same quarters in the same order;
    // earningsChart states each quarter's end date. Every pair in all three fixtures follows one rule:
    // the label is the calendar quarter (and year) containing the period end.
    for (const f of ['y_7203.T.json', 'y_3382.T.json', 'y_9983.T.json']) {
      const e = fx(f).quoteSummary.result[0].earnings;
      const fin = e.financialsChart.quarterly as { date: string }[];
      const chart = e.earningsChart.quarterly as { date: string; periodEndDate: { fmt: string } }[];
      expect(fin.length).toBe(4);
      fin.forEach((q, i) => {
        expect(chart[i]!.date).toBe(q.date);
        expect(jpRevenueQuarterLabel(chart[i]!.periodEndDate.fmt)).toBe(q.date);
      });
    }
    expect(jpRevenueQuarterLabel('2026-09-30')).toBe('3Q2026'); // March FY, Q2
    expect(jpRevenueQuarterLabel('2025-11-30')).toBe('4Q2025'); // Feb/Aug FY quarter ending November
    expect(jpRevenueQuarterLabel('2026-02-28')).toBe('1Q2026');
    expect(jpRevenueQuarterLabel('2026-08-31')).toBe('3Q2026');
    expect(jpRevenueQuarterLabel('bad')).toBe('');
  });
});

describe('Yahoo JP indices and charts', () => {
  it('indices are JPY', () => {
    const n = parseIndexQuote(fx('y_^N225.json'));
    expect(n.symbol).toBe('^N225');
    expect(n.currency).toBe('JPY');
    const t = parseIndexQuote(fx('y_1306.T.json'));
    expect(t.symbol).toBe('1306.T');
    expect(t.currency).toBe('JPY');
  });

  it('daily closes keyed by JST date', () => {
    const closes = parseYahooDailyCloses(fx('y_chart_7203.T.json'), JST);
    expect(closes.get('2026-10-26')).toBe(3117);
    expect(closes.get('2026-10-23')).toBe(3105);
  });
});

describe('HK summary unchanged', () => {
  it('parseYahooHkSummary is the shared parser with HKT and HKD', () => {
    for (const f of ['y_0700.HK.json', 'y_9988.HK.json']) {
      const raw = hkFx(f);
      expect(parseYahooHkSummary(raw)).toEqual(parseYahooSummaryFor(raw, { zone: HKT, capCurrency: 'HKD' }));
    }
  });
});
