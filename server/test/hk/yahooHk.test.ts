import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HKT, hkTimingFromHkt } from '../../src/hk/domain/hkCalendar.js';
import { parseYahooHkSummary } from '../../src/hk/sources/yahooHk.js';
import { parseYahooPastDatesIn } from '../../src/india/sources/yahooPastDates.js';
import { parseIndexQuote, parseYahooDailyCloses } from '../../src/sources/yahoo.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8'));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('Yahoo .HK summary', () => {
  it('summary keeps currencies as stated', () => {
    const raw = fx('y_0700.HK.json');
    const s = parseYahooHkSummary(raw);
    expect(s.priceCurrency).toBe('HKD');
    expect(s.marketCap!).toBeGreaterThan(1e12);
    expect(s.name).toBe('Tencent Holdings Limited');
    expect(s.financialCurrency).toBe('CNY');
    const src = raw.quoteSummary.result[0].earningsTrend.trend as { period: string; earningsEstimate: { earningsCurrency: string }; revenueEstimate: { revenueCurrency: string } }[];
    expect(s.trend.length).toBe(4);
    for (const t of s.trend) {
      const o = src.find((x) => x.period === t.period)!;
      expect(t.epsCurrency).toBe(o.earningsEstimate.earningsCurrency);
      expect(t.revenueCurrency).toBe(o.revenueEstimate.revenueCurrency);
    }
    expect(s.epsHistory.at(-1)).toEqual({ periodEnd: '2026-06-30', actual: 7.433, currency: 'CNY' });
    expect(s.revenueQuarters.at(-1)).toEqual({ label: '1Q2026', revenue: 196458000000 });
    expect(s.nextDate).toBe('2026-11-18');
    expect(s.marketCapAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('market cap is null when the quote is not in HKD', () => {
    const raw = clone(fx('y_0700.HK.json'));
    raw.quoteSummary.result[0].price.currency = 'USD';
    const s = parseYahooHkSummary(raw);
    expect(s.marketCap).toBeNull();
    expect(s.marketCapAsOf).toBeNull();
    expect(s.priceCurrency).toBe('USD');
  });

  it('a two-date range gives nextDate null', () => {
    const raw = clone(fx('y_0700.HK.json'));
    const e = raw.quoteSummary.result[0].calendarEvents.earnings;
    e.earningsDate = [e.earningsDate[0], { raw: e.earningsDate[0].raw + 7 * 86400, fmt: 'x' }];
    expect(parseYahooHkSummary(raw).nextDate).toBeNull();
  });

  it('yearly and quarterly trend periods are both kept with their end dates', () => {
    const s = parseYahooHkSummary(fx('y_9988.HK.json'));
    expect(s.trend.map((t) => t.period)).toEqual(['0q', '+1q', '0y', '+1y']);
    for (const t of s.trend) expect(t.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.trend[2]!.periodEnd).not.toBe(s.trend[0]!.periodEnd);
  });

  it('throws SourceFormatError on a wrong shape', () => {
    expect(() => parseYahooHkSummary({ quoteSummary: { result: [] } })).toThrow(/Yahoo quoteSummary/);
  });
});

describe('Yahoo past dates (generalized)', () => {
  it('past dates: TAS only, HKT date and timing', () => {
    const json = { finance: { result: [{ documents: [{ rows: [['0700.HK', '2026-08-13T08:30:00.000Z', 'TAS'], ['0700.HK', '2026-05-14T00:00:00.000Z', 'TNS']] }] }] } };
    expect(parseYahooPastDatesIn(json, HKT, hkTimingFromHkt)).toEqual([{ date: '2026-08-13', timing: 'AMC' }]);
  });

  it('parses the saved 0700 visualization answer', () => {
    const rows = parseYahooPastDatesIn(fx('y_viz_0700.HK.json'), HKT, hkTimingFromHkt);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows[0]).toEqual({ date: '2025-05-14', timing: 'AMC' });
  });
});

describe('Yahoo daily closes', () => {
  it('daily closes keyed by HKT date', () => {
    const m = parseYahooDailyCloses(fx('y_chart_0700.HK.json'), HKT);
    expect(m.size).toBeGreaterThanOrEqual(200);
    for (const d of m.keys()) expect([6, 7]).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay() || 7);
  });

  it('skips null closes', () => {
    const raw = clone(fx('y_chart_0700.HK.json'));
    const n = raw.chart.result[0].timestamp.length;
    raw.chart.result[0].indicators.quote[0].close[n - 1] = null;
    expect(parseYahooDailyCloses(raw, HKT).size).toBe(parseYahooDailyCloses(fx('y_chart_0700.HK.json'), HKT).size - 1);
  });
});

describe('HK index symbols', () => {
  it('index symbols verified', () => {
    expect(parseIndexQuote(fx('y_^HSI.json')).currency).toBe('HKD');
    expect(parseIndexQuote(fx('y_^HSCE.json')).currency).toBe('HKD');
    // Yahoo returns no currency for the Hang Seng Tech index (^HSTECH is not found); the symbol still quotes.
    const tech = parseIndexQuote(fx('y_HSTECH.HK.json'));
    expect(tech.symbol).toBe('HSTECH.HK');
    expect(tech.currency).toBeNull();
    expect(tech.price).toBeGreaterThan(0);
  });
});
