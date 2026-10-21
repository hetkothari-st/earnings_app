import { describe, expect, test } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { parseQuoteSummary, yahooFill } from '../../src/sources/yahooEarnings.js';

// Shapes copied from live quoteSummary responses on 2026-10-15 (trimmed).
const tsm = { quoteSummary: { result: [{
  price: { currency: 'USD' },
  earnings: { financialCurrency: 'TWD', financialsChart: { quarterly: [
    { date: '1Q2026', revenue: { raw: 1134103000000 } },
    { date: '2Q2026', revenue: { raw: 1270380000000 } },
  ] } },
  earningsHistory: { history: [
    { quarter: { fmt: '2026-03-31' }, epsActual: { raw: 3.49 }, currency: 'USD' },
    { quarter: { fmt: '2026-06-30' }, epsActual: { raw: 4.31 }, currency: 'USD' },
  ] },
  earningsTrend: { trend: [
    { period: '0q', endDate: '2026-09-30', revenueEstimate: { avg: { raw: 1460392943930 }, revenueCurrency: 'TWD' } },
    { period: '+1q', endDate: '2026-12-31', revenueEstimate: { avg: { raw: 1613260108730 }, revenueCurrency: 'TWD' } },
  ] },
}] } };

// ASML: EPS history in EUR although the US listing trades in USD; Yahoo had already rolled its
// "next" estimate forward to the December quarter right after the October report.
const asml = { quoteSummary: { result: [{
  price: { currency: 'USD' },
  earnings: { financialCurrency: 'EUR', financialsChart: { quarterly: [{ date: '3Q2026', revenue: { raw: 11662000000 } }] } },
  earningsHistory: { history: [{ quarter: { fmt: '2026-09-30' }, epsActual: { raw: 11.8193 }, currency: 'EUR' }] },
  earningsTrend: { trend: [{ period: '0q', endDate: '2026-12-31', revenueEstimate: { avg: { raw: 14436628480 }, revenueCurrency: 'EUR' } }] },
}] } };

describe('parseQuoteSummary', () => {
  test('EPS history with currency, quarterly revenue, per-quarter revenue estimates', () => {
    expect(parseQuoteSummary(tsm)).toEqual({
      priceCurrency: 'USD', financialCurrency: 'TWD',
      epsHistory: [{ periodEnd: '2026-03-31', actual: 3.49, currency: 'USD' }, { periodEnd: '2026-06-30', actual: 4.31, currency: 'USD' }],
      revenueQuarters: [{ label: '1Q2026', revenue: 1134103000000 }, { label: '2Q2026', revenue: 1270380000000 }],
      revenueEstimates: [
        { periodEnd: '2026-09-30', estimate: 1460392943930, currency: 'TWD' },
        { periodEnd: '2026-12-31', estimate: 1613260108730, currency: 'TWD' },
      ],
    });
  });
  test('missing result is a format error', () => {
    expect(() => parseQuoteSummary({ quoteSummary: { result: null, error: { code: 'Not Found' } } })).toThrow(SourceFormatError);
  });
});

describe('yahooFill', () => {
  test('matches the report by fiscal quarter end; revenue in the reporting currency', () => {
    expect(yahooFill(parseQuoteSummary(tsm), { reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026' }))
      .toEqual({ epsActual: null, revenueEstimate: null, revenueActual: 1270380000000, revenueCurrency: 'TWD' });
  });
  test('EPS of a company reporting in another currency is never used, even when Yahoo shows it in USD (live ERIC: Yahoo 0.1956 vs about 0.177)', () => {
    expect(yahooFill(parseQuoteSummary(tsm), { reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026' }).epsActual).toBeNull();
  });
  test('EPS of a company reporting in USD is used', () => {
    const us = { quoteSummary: { result: [{
      price: { currency: 'USD' }, earnings: { financialCurrency: 'USD', financialsChart: { quarterly: [] } },
      earningsHistory: { history: [{ quarter: { fmt: '2026-09-30' }, epsActual: { raw: 2.34 }, currency: 'USD' }] },
    }] } };
    expect(yahooFill(parseQuoteSummary(us), { reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026' }).epsActual).toBe(2.34);
  });
  test('revenue estimate comes from the forecast for the same quarter', () => {
    expect(yahooFill(parseQuoteSummary(tsm), { reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026' }))
      .toEqual({ epsActual: null, revenueEstimate: 1460392943930, revenueActual: null, revenueCurrency: 'TWD' });
  });
  test('EPS in a non-USD currency is never used (live ASML)', () => {
    expect(yahooFill(parseQuoteSummary(asml), { reportDate: '2026-10-14', fiscalQuarter: 'Sep/2026' }).epsActual).toBeNull();
  });
  test('a forecast for another quarter is never used as the estimate (live ASML)', () => {
    const f = yahooFill(parseQuoteSummary(asml), { reportDate: '2026-10-14', fiscalQuarter: 'Sep/2026' });
    expect(f).toEqual({ epsActual: null, revenueEstimate: null, revenueActual: 11662000000, revenueCurrency: 'EUR' });
  });
  test('non-calendar fiscal quarters never take a quarterly revenue (labels may not line up)', () => {
    expect(yahooFill(parseQuoteSummary(tsm), { reportDate: '2026-06-25', fiscalQuarter: 'May/2026' }).revenueActual).toBeNull();
  });
});
