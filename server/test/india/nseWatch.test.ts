import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { listInRange, saveFoList, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import type { InJobContext } from '../../src/india/jobs/context.js';
import { resetInResultsState } from '../../src/india/jobs/results.js';
import { loadFoCache } from '../../src/india/jobs/stocks.js';
import { NseWatch } from '../../src/india/live/nseWatch.js';
import { HttpError, type Http } from '../../src/sources/http.js';

const fixture = (f: string) => readFileSync(new URL(`../fixtures/india/${f}`, import.meta.url), 'utf8');
const URL_ = 'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml';
const ITEM = `<item><title>Tata Communications Limited</title><link>https://nsearchives.nseindia.com/corporate/TATACOMM_15102026.pdf</link><description>Tata Communications Limited has informed the Exchange regarding Financial Results for the quarter ended September 30, 2026 |SUBJECT: Outcome of Board Meeting</description><pubDate>15-Oct-2026 15:10:00</pubDate></item>`;
const feed = (items: string) => fixture('rss_Online_announcements.xml').replace('</channel>', `${items}</channel>`);

function setup(body: () => string | Promise<string>, withRow = true) {
  const db = openDb(':memory:') as unknown as DatabaseSync;
  const now = '2026-10-15T10:00:00.000Z';
  saveFoList(db, [{ symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 }], now);
  loadFoCache(db);
  if (withRow) upsertInCalendarRow(db, { symbol: 'TATACOMM', name: 'Tata Communications', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-15' }, now);
  const http: Http = { text: async () => body(), json: async () => { throw new Error('unused'); } };
  const ctx: InJobContext = {
    db, http, kite: { quotes: async () => new Map(), candles: async () => [] }, kiteSession: () => null,
    yahoo: async () => null, now: () => now, todayIST: () => '2026-10-15',
  };
  return { db, ctx };
}
const rows = (db: DatabaseSync) => listInRange(db, { from: '2026-10-01', to: '2026-10-31', q: null });

describe('NseWatch', () => {
  beforeEach(() => resetInResultsState());

  it('a results announcement flips within one tick, ids returned', async () => {
    const { db, ctx } = setup(() => feed(ITEM));
    const seen: number[][] = [];
    const ids = await new NseWatch(ctx, (i) => seen.push(i)).tick();
    expect(ids).toHaveLength(1);
    expect(seen).toEqual([ids]);
    expect(rows(db)[0]).toMatchObject({ symbol: 'TATACOMM', timing: 'DMH', timingSource: 'nse-announcement' });
  });

  it('same item next tick: no change', async () => {
    const { ctx } = setup(() => feed(ITEM));
    const w = new NseWatch(ctx, () => {});
    expect(await w.tick()).toHaveLength(1);
    expect(await w.tick()).toEqual([]);
  });

  it('an F&O stock with no calendar row gets a row and flips; the reader gets the pdf once', async () => {
    const { db, ctx } = setup(() => feed(ITEM), false);
    const reads: [string, number][] = [];
    const w = new NseWatch(ctx, () => {}, async (u, id) => { reads.push([u, id]); });
    const ids = await w.tick();
    expect(ids).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ symbol: 'TATACOMM', reportDate: '2026-10-15', quarterEnd: '2026-09-30' });
    await w.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toEqual([['https://nsearchives.nseindia.com/corporate/TATACOMM_15102026.pdf', ids[0]]]);
  });

  it('HTML instead of RSS: [] and state recorded', async () => {
    const { db, ctx } = setup(() => '<html>Request Rate Threshold Exceeded</html>');
    expect(await new NseWatch(ctx, () => {}).tick()).toEqual([]);
    expect(db.prepare("SELECT state FROM source_status WHERE source = 'nse-announcements-fast'").get()).toMatchObject({ state: expect.any(String) });
    expect(db.prepare("SELECT last_error FROM source_status WHERE source = 'nse-announcements-fast'").get())
      .toMatchObject({ last_error: expect.stringMatching(/blocked/) });
  });

  it('HTTP 403 is a block', async () => {
    const { db, ctx } = setup(() => { throw new HttpError(403, URL_); });
    expect(await new NseWatch(ctx, () => {}).tick()).toEqual([]);
    expect(db.prepare("SELECT state FROM source_status WHERE source = 'nse-announcements-fast'").get()).toMatchObject({ state: 'blocked' });
  });
});
