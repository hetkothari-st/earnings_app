import { describe, expect, test } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { parseQuoteSummary, yahooFill } from '../../src/sources/yahooEarnings.js';

// Shape copied from the live TSM quoteSummary response on 2026-10-15 (trimmed).
const tsm = { quoteSummary: { result: [{
  price: { currency: 'USD' },
  earnings: { financialCurrency: 'TWD', financialsChart: { quarterly: [
    { date: '1Q2026', revenue: { raw: 1134103000000 }, earnings: { raw: 572480000000 } },
    { date: '2Q2026', revenue: { raw: 1270380000000 }, earnings: { raw: 706560000000 } },
  ] } },
  earningsHistory: { history: [
    { quarter: { raw: 1774915200, fmt: '2026-03-31' }, epsActual: { raw: 3.49 }, epsEstimate: { raw: 3.33393 } },
    { quarter: { raw: 1782777600, fmt: '2026-06-30' }, epsActual: { raw: 4.31 }, epsEstimate: { raw: 3.88658 } },
  ] },
  calendarEvents: { earnings: { earningsDate: [{ raw: 1792067400, fmt: '2026-10-15' }], revenueAverage: { raw: 1460392943930 } } },
}] } };

describe('parseQuoteSummary', () => {
  test('EPS history, quarterly revenue, next-report estimate and currencies', () => {
    expect(parseQuoteSummary(tsm)).toEqual({
      priceCurrency: 'USD', financialCurrency: 'TWD',
      epsHistory: [{ periodEnd: '2026-03-31', actual: 3.49 }, { periodEnd: '2026-06-30', actual: 4.31 }],
      revenueQuarters: [{ label: '1Q2026', revenue: 1134103000000 }, { label: '2Q2026', revenue: 1270380000000 }],
      nextReportDate: '2026-10-15', nextRevenueEstimate: 1460392943930,
    });
  });
  test('missing result is a format error', () => {
    expect(() => parseQuoteSummary({ quoteSummary: { result: null, error: { code: 'Not Found' } } })).toThrow(SourceFormatError);
  });
});

describe('yahooFill', () => {
  const s = parseQuoteSummary(tsm);
  test('matches the report by fiscal quarter end; revenue in the reporting currency', () => {
    expect(yahooFill(s, { reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026' }))
      .toEqual({ epsActual: 4.31, revenueEstimate: null, revenueActual: 1270380000000, revenueCurrency: 'TWD' });
  });
  test('upcoming report: revenue estimate only when the next Yahoo date is the report date', () => {
    expect(yahooFill(s, { reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026' }))
      .toEqual({ epsActual: null, revenueEstimate: 1460392943930, revenueActual: null, revenueCurrency: 'TWD' });
    expect(yahooFill(s, { reportDate: '2026-10-22', fiscalQuarter: 'Sep/2026' }).revenueEstimate).toBeNull();
  });
  test('non-calendar fiscal quarters never take a quarterly revenue (labels may not line up)', () => {
    expect(yahooFill(s, { reportDate: '2026-06-25', fiscalQuarter: 'May/2026' }).revenueActual).toBeNull();
  });
  test('EPS is only taken when quoted in USD', () => {
    expect(yahooFill({ ...s, priceCurrency: 'EUR' }, { reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026' }).epsActual).toBeNull();
  });
});
