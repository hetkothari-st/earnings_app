import { describe, expect, it } from 'vitest';
import { listRange, mergeInvestingRow, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import { refreshResults } from '../../src/jobs/refreshResults.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import type { CalendarRow } from '../../src/types.js';

const TODAY = '2026-10-16';
const YESTERDAY = '2026-10-15';

function makeTestCtx(over: Partial<Sources> = {}): JobContext {
  const sources: Sources = {
    calendar: async () => [],
    earningsDetails: async () => [],
    optionChain: async () => null,
    secTickers: async () => new Map(),
    secEarningsFilings: async () => [],
    secAcceptance: async () => '',
    dailyCloses: async () => new Map(),
    sectors: async () => new Map(),
    yahooSummary: async () => null,
    ...over,
  };
  return {
    db: openDb(':memory:'),
    sources,
    now: () => '2026-10-16T14:30:00.000Z',
    today: () => TODAY,
  };
}

const calRow: CalendarRow = {
  symbol: 'TRV',
  name: 'Travelers',
  reportDate: TODAY,
  fiscalQuarter: 'Sep/2026',
  timing: 'BMO',
  marketCap: 8e10,
  epsEstimate: 7.25,
  noOfEsts: 15,
  epsActual: null,
  epsSurprisePct: null,
  lastYearEps: 6.8,
  lastYearReportDate: '2025-10-17',
};

describe('Investing.com integration', () => {
  it('mergeInvestingRow fills a missing EPS and revenue actual but takes no estimates or surprise', () => {
    const db = openDb(':memory:');
    upsertCalendarRow(db, calRow, '2026-10-16T08:00:00.000Z', TODAY);

    const updated = mergeInvestingRow(
      db,
      {
        symbol: 'TRV',
        reportDate: TODAY,
        timing: 'BMO',
        epsActual: 7.5,
        epsEstimate: 7.25,
        epsSurprisePct: 3.45,
        revenueActual: 11_500_000_000,
        revenueEstimate: 11_310_000_000,
      },
      '2026-10-16T12:00:00.000Z'
    );

    expect(updated).toBe(true);

    const reports = listRange(db, { from: TODAY, to: TODAY, minCap: null, q: 'TRV' });
    expect(reports.length).toBe(1);
    const r = reports[0]!;
    expect(r.epsActual).toBe(7.5);
    expect(r.epsSurprisePct).toBeNull();
    expect(r.revenueActual).toBe(11_500_000_000);
    expect(r.revenueEstimate).toBeNull();
  });

  it('mergeInvestingRow never replaces an existing actual; a different value is flagged', () => {
    const db = openDb(':memory:');
    upsertCalendarRow(db, { ...calRow, epsActual: 7.4 }, '2026-10-16T08:00:00.000Z', TODAY);
    const row = { symbol: 'TRV', reportDate: TODAY, timing: 'BMO' as const, epsActual: 7.5, epsEstimate: null,
      epsSurprisePct: null, revenueActual: null, revenueEstimate: null };
    expect(mergeInvestingRow(db, row, '2026-10-16T12:00:00.000Z')).toBe(true);
    const r = listRange(db, { from: TODAY, to: TODAY, minCap: null, q: 'TRV' })[0]!;
    expect(r.epsActual).toBe(7.4);
    expect(r.epsConflict).toBe('Nasdaq reports EPS 7.4, Investing.com 7.5 (often adjusted vs GAAP)');
    expect(mergeInvestingRow(db, row, '2026-10-16T12:01:00.000Z')).toBe(false);
  });

  it('refreshResults picks up Investing.com actuals and returns changed report IDs', async () => {
    const ctx = makeTestCtx({
      calendar: async () => [calRow],
      investing: async (tab, date) => {
        if (tab === 'today') {
          return [
            {
              symbol: 'TRV',
              reportDate: TODAY,
              timing: 'BMO',
              epsActual: 7.5,
              epsEstimate: 7.25,
              epsSurprisePct: 3.45,
              revenueActual: 11_500_000_000,
              revenueEstimate: 11_310_000_000,
            },
          ];
        }
        return [];
      },
    });

    // Populate calendar first
    upsertCalendarRow(ctx.db, calRow, '2026-10-16T08:00:00.000Z', TODAY);

    const changedIds = await refreshResults(ctx);
    expect(changedIds.length).toBe(1);

    const rep = listRange(ctx.db, { from: TODAY, to: TODAY, minCap: null, q: 'TRV' })[0]!;
    expect(rep.id).toBe(changedIds[0]);
    expect(rep.epsActual).toBe(7.5);
    expect(rep.revenueActual).toBe(11_500_000_000);
  });
});
