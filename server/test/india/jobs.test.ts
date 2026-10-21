import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { listInRange, saveFoList, saveInLiveMove, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import { refreshInCalendar } from '../../src/india/jobs/calendar.js';
import type { InJobContext } from '../../src/india/jobs/context.js';
import { refreshInLiveMoves, resetNfoCache } from '../../src/india/jobs/moves.js';
import { refreshInResults, resetInResultsState } from '../../src/india/jobs/results.js';
import { loadFoCache } from '../../src/india/jobs/stocks.js';
import { HttpError, type Http } from '../../src/sources/http.js';

const fixture = (f: string) => readFileSync(new URL(`../fixtures/india/${f}`, import.meta.url), 'utf8');
const RSS = 'https://nsearchives.nseindia.com/content/RSS/';
const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

function makeCtx(pages: Record<string, string | (() => string)>, now = '2026-10-15T12:30:00.000Z') {
  const db = openDb(':memory:') as unknown as DatabaseSync;
  saveFoList(db, [
    { symbol: 'GAIL', name: 'GAIL (INDIA)', lotSize: 3150 },
    { symbol: 'BANDHANBNK', name: 'BANDHAN BANK', lotSize: 3600 },
    { symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 },
  ], now);
  loadFoCache(db);
  const fetched: string[] = [];
  const http: Http = {
    text: async (url) => {
      fetched.push(url);
      const p = pages[url];
      if (p == null) throw new HttpError(404, url);
      return typeof p === 'function' ? p() : p;
    },
    json: async () => { throw new Error('unused'); },
  };
  const ctx: InJobContext = {
    db, http, kite: { quotes: async () => new Map(), candles: async () => [] }, kiteSession: () => null,
    yahoo: async () => null, now: () => now, todayIST: () => '2026-10-15',
  };
  return { ctx, db, fetched };
}

describe('refreshInCalendar (real Board_Meetings feed)', () => {
  it('F&O companies with a results meeting: XBRL intimation and PDF notice; others skipped', async () => {
    const { ctx, db } = makeCtx({
      [`${RSS}Board_Meetings.xml`]: fixture('rss_Board_Meetings.xml'),
      'https://nsearchives.nseindia.com/corporate/xbrl/PRIOR_INTIMATION_1594_WebXMLFile_20261015_171758301.xml': fixture('xbrl_prior_intimation_GAIL.xml'),
    });
    await refreshInCalendar(ctx);
    const rows = listInRange(db, { from: '2026-10-01', to: '2026-11-30', q: null });
    expect(rows.map((r) => [r.symbol, r.reportDate, r.quarterLabel, r.dateStatus])).toEqual([
      ['BANDHANBNK', '2026-10-28', 'Sep/2026', 'confirmed'],
      ['GAIL', '2026-10-30', 'Sep/2026', 'confirmed'],
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM in_reports').get()).toEqual({ n: 2 }); // nothing stored for non-F&O
  });

  it('an HTML error page instead of RSS stores nothing and records the error (Review Focus #5)', async () => {
    const { ctx, db } = makeCtx({ [`${RSS}Board_Meetings.xml`]: '<html><body>Maintenance</body></html>' });
    await refreshInCalendar(ctx);
    expect(db.prepare("SELECT last_error FROM source_status WHERE source = 'nse-board-meetings'").get())
      .toMatchObject({ last_error: expect.stringContaining('not RSS') });
  });
});

describe('refreshInResults', () => {
  beforeEach(() => resetInResultsState());
  const FEED = (pub: string, desc = 'Integrated Filing- Financials|Original|') => rss(
    `<item><title>Tata Communications Limited</title><link>https://nsearchives.nseindia.com/corporate/INTEGRATED_FILING_INDAS_1_15102026_WEB.xml|null</link><description>${desc}</description><pubDate>${pub}</pubDate></item>`);
  const XBRL_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1_15102026_WEB.xml';

  it('a filing not up yet is retried next run without blocking; then actuals and timing land', async () => {
    let up = false;
    const { ctx, db } = makeCtx({
      [`${RSS}Integrated_Filing.xml`]: FEED('15-Oct-2026 17:33:55'),
      [`${RSS}Online_announcements.xml`]: rss(''),
      [XBRL_URL]: () => { if (!up) throw new HttpError(404, XBRL_URL); return fixture('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml'); },
    });
    const started = Date.now();
    expect(await refreshInResults(ctx)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    up = true;
    const ids = await refreshInResults(ctx);
    expect(ids).toHaveLength(1);
    expect(listInRange(db, { from: '2026-10-15', to: '2026-10-15', q: null })[0]).toMatchObject({
      symbol: 'TATACOMM', nature: 'Consolidated', epsActual: 11.96, revenueActual: 66_878_900_000, pnlActual: 3_356_100_000,
      timing: 'AMC', timingSource: 'nse-filing', quarterEnd: '2026-09-30',
    });
  });

  it('an earlier results announcement sets the timing; a revision filing never does', async () => {
    const { ctx, db } = makeCtx({
      [`${RSS}Integrated_Filing.xml`]: FEED('16-Oct-2026 10:00:00', 'Integrated Filing- Financials|Revision|'),
      [`${RSS}Online_announcements.xml`]: rss(`<item><title>Tata Communications Limited</title><link>x.pdf</link><description>Tata Communications Limited has informed the Exchange regarding Financial Results for the quarter ended September 30, 2026 |SUBJECT: Outcome of Board Meeting</description><pubDate>15-Oct-2026 15:10:00</pubDate></item>`),
      [XBRL_URL]: fixture('xbrl_indas_TATACOMM_Q2FY27_consolidated.xml'),
    });
    await refreshInResults(ctx);
    expect(listInRange(db, { from: '2026-10-15', to: '2026-10-15', q: null })[0]).toMatchObject({ timing: 'DMH', timingSource: 'nse-announcement' });
  });
});

describe('refreshInLiveMoves backs up the ticker', () => {
  const NOW = '2026-10-15T05:00:00.000Z'; // 10:30 IST, in session
  const run = async (savedAt: string) => {
    const { ctx, db, fetched } = makeCtx({}, NOW);
    const id = upsertInCalendarRow(db, { symbol: 'GAIL', name: 'GAIL', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-16' }, NOW);
    saveInLiveMove(db, id, { movePct: 4, illiquid: false, quoteTime: null }, savedAt);
    resetNfoCache();
    await refreshInLiveMoves({ ...ctx, kiteSession: () => ({ apiKey: 'k', accessToken: 't', expiresAt: Date.now() + 1e6 }) });
    return fetched.some((u) => u.includes('instruments'));
  };

  it('skips a report whose live move was saved in the last 60 s', async () => {
    expect(await run('2026-10-15T04:59:30.000Z')).toBe(false);
  });

  it('polls a report whose live move is older', async () => {
    expect(await run('2026-10-15T04:58:00.000Z')).toBe(true);
  });
});
