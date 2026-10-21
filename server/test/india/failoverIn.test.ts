import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { listSourceStatus, openDb } from '../../src/db/repo.js';
import { activeStocks, saveFoList, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import { refreshInCalendar } from '../../src/india/jobs/calendar.js';
import type { InJobContext } from '../../src/india/jobs/context.js';
import { refreshInEstimates } from '../../src/india/jobs/estimates.js';
import { refreshInResults, resetInResultsState } from '../../src/india/jobs/results.js';
import { loadFoCache, refreshInStocks } from '../../src/india/jobs/stocks.js';
import { HttpError, type Http } from '../../src/sources/http.js';

const NOW = '2026-10-15T12:30:00.000Z';
function makeCtx(text: () => string, yahoo: InJobContext['yahoo'] = async () => null) {
  const db = openDb(':memory:') as unknown as DatabaseSync;
  saveFoList(db, [{ symbol: 'GAIL', name: 'GAIL (INDIA)', lotSize: 3150 }, { symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 }], NOW);
  loadFoCache(db);
  const http: Http = { text: async () => text(), json: async () => { throw new Error('unused'); } };
  const ctx: InJobContext = {
    db, http, kite: { quotes: async () => new Map(), candles: async () => [] }, kiteSession: () => null,
    yahoo, now: () => NOW, todayIST: () => '2026-10-15',
  };
  return { ctx, db };
}
const status = (db: DatabaseSync, source: string) => listSourceStatus(db as never).find((s) => s.source === source);

describe('NSE Board_Meetings failover', () => {
  it('HTTP 429: stored dates stay, source is blocked for a minute', async () => {
    const { ctx, db } = makeCtx(() => { throw new HttpError(429, 'u'); });
    upsertInCalendarRow(db, { symbol: 'GAIL', name: 'GAIL', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-30' }, NOW);
    await refreshInCalendar(ctx);
    expect(status(db, 'nse-board-meetings')).toMatchObject({ state: 'blocked', blockedUntil: '2026-10-15T12:31:00.000Z' });
    expect(db.prepare('SELECT report_date AS d FROM in_reports').all()).toEqual([{ d: '2026-10-30' }]);
  });
  it('an HTML page served as 200 counts as blocked', async () => {
    const { ctx, db } = makeCtx(() => '<html>Access Denied</html>');
    await refreshInCalendar(ctx);
    expect(status(db, 'nse-board-meetings')).toMatchObject({ state: 'blocked' });
    expect(status(db, 'nse-board-meetings')!.lastError).toContain('not RSS');
  });
});

describe('other NSE feeds', () => {
  it('a 200 HTML block page on Integrated_Filing is recorded as blocked and backed off', async () => {
    resetInResultsState();
    const { ctx, db } = makeCtx(() => '<html><body>Request Rate Threshold Exceeded not RSS</body></html>');
    await refreshInResults(ctx);
    expect(status(db, 'nse-integrated-filing')).toMatchObject({ state: 'blocked', blockedUntil: '2026-10-15T12:31:00.000Z' });
    expect(status(db, 'nse-online-announcements')).toMatchObject({ state: 'blocked' });
  });
  it('F&O list 429: blocked, the stored list stays', async () => {
    const { ctx, db } = makeCtx(() => { throw new HttpError(429, 'u'); });
    await refreshInStocks(ctx);
    expect(status(db, 'nse-fo-list')).toMatchObject({ state: 'blocked' });
    expect(activeStocks(db)).toHaveLength(2);
  });
});

describe('Yahoo estimates: near (next 7 days) and far', () => {
  it('near asks only stocks reporting within 7 days; far asks the others; all asks every stock', async () => {
    const asked: string[] = [];
    const { ctx, db } = makeCtx(() => '', async (s) => { asked.push(s); return null; });
    upsertInCalendarRow(db, { symbol: 'GAIL', name: 'GAIL', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-20' }, NOW);
    upsertInCalendarRow(db, { symbol: 'TATACOMM', name: 'TC', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-11-20' }, NOW);
    expect(activeStocks(db)).toHaveLength(2);
    await refreshInEstimates(ctx, 'near');
    expect(asked).toEqual(['GAIL']);
    asked.length = 0;
    await refreshInEstimates(ctx, 'far');
    expect(asked).toEqual(['TATACOMM']);
    asked.length = 0;
    await refreshInEstimates(ctx);
    expect(asked).toEqual(['GAIL', 'TATACOMM']);
  });
});
