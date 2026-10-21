import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYahooPastDates } from '../../src/india/sources/yahooPastDates.js';
import { openDb } from '../../src/db/repo.js';
import { saveFoList, setEqTokens, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import type { InJobContext } from '../../src/india/jobs/context.js';
import { computeInPrevMoves } from '../../src/india/jobs/prevMoves.js';
import type { Http } from '../../src/sources/http.js';

const NOW = '2026-10-15T12:30:00.000Z';

function setup(yahooPastDates: InJobContext['yahooPastDates']) {
  const calls = { candles: 0 };
  const db = openDb(':memory:') as unknown as DatabaseSync;
  saveFoList(db, [{ symbol: 'GAIL', name: 'GAIL (INDIA)', lotSize: 3150 }], NOW);
  setEqTokens(db, new Map([['GAIL', 42]]));
  upsertInCalendarRow(db, { symbol: 'GAIL', name: 'GAIL', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-30' }, NOW);
  const ctx: InJobContext = {
    db, http: {} as Http,
    kite: {
      quotes: async () => new Map(),
      // After-close result on 2026-07-24 (Fri): reaction is Fri close -> Mon close.
      candles: async () => (calls.candles++, [
        { date: '2026-07-24', open: 0, high: 0, low: 0, close: 100, volume: 0 },
        { date: '2026-07-27', open: 0, high: 0, low: 0, close: 104, volume: 0 },
      ]),
    },
    kiteSession: () => ({ accessToken: 't' } as never),
    yahoo: async () => null, yahooPastDates, now: () => NOW, todayIST: () => '2026-10-15',
  };
  return { ctx, db, calls };
}
const row = (db: DatabaseSync) => db.prepare(
  "SELECT prev_move_pct AS p, prev_move_date AS d, prev_move_basis AS b FROM in_reports WHERE symbol = 'GAIL' AND quarter_label = 'Sep/2026'").get();

describe('computeInPrevMoves with Yahoo past dates', () => {
  it('no captured prior report: Yahoo date used, basis known', async () => {
    const { ctx, db } = setup(async () => [
      { date: '2026-10-30', timing: 'AMC' }, // not before this report: ignored
      { date: '2026-07-24', timing: 'AMC' },
      { date: '2026-04-20', timing: 'BMO' },
    ]);
    await computeInPrevMoves(ctx);
    expect(row(db)).toEqual({ p: 4, d: '2026-07-24', b: 'known' });
  });

  it("a Yahoo date without a time is assumed (this quarter's timing)", async () => {
    const { ctx, db } = setup(async () => [{ date: '2026-07-24', timing: null }]);
    db.prepare("UPDATE in_reports SET timing = 'AMC' WHERE symbol = 'GAIL'").run();
    await computeInPrevMoves(ctx);
    expect(row(db)).toEqual({ p: 4, d: '2026-07-24', b: 'assumed' });
  });

  it('nothing from Yahoo (empty or failing) leaves the move blank', async () => {
    const a = setup(async () => []);
    await computeInPrevMoves(a.ctx);
    expect(row(a.db)).toMatchObject({ p: null });
    const b = setup(async () => { throw new Error('429'); });
    await computeInPrevMoves(b.ctx);
    expect(row(b.db)).toMatchObject({ p: null });
  });

  it('real RELIANCE fixture (latest date 2025-04-25) against an Oct-2026 report: too old, no previous move', async () => {
    const real = parseYahooPastDates(JSON.parse(readFileSync(new URL('../fixtures/india/yahoo_visualization_RELIANCE.json', import.meta.url), 'utf8')));
    const { ctx, db, calls } = setup(async () => real);
    await computeInPrevMoves(ctx);
    expect(row(db)).toMatchObject({ p: null, d: null, b: null });
    expect(calls.candles).toBe(0);
  });

  it('a Yahoo date only 10 days before the report is no previous quarter: blank', async () => {
    const { ctx, db, calls } = setup(async () => [{ date: '2026-10-20', timing: 'AMC' }]);
    await computeInPrevMoves(ctx);
    expect(row(db)).toMatchObject({ p: null });
    expect(calls.candles).toBe(0);
  });

  it('a captured prior report wins over Yahoo', async () => {
    let asked = false;
    const { ctx, db } = setup(async () => { asked = true; return [{ date: '2026-04-20', timing: 'BMO' }]; });
    upsertInCalendarRow(db, { symbol: 'GAIL', name: 'GAIL', quarterEnd: '2026-06-30', quarterLabel: 'Jun/2026', reportDate: '2026-07-24' }, NOW);
    db.prepare("UPDATE in_reports SET released_at = '2026-07-24T14:30:00.000Z', timing = 'AMC' WHERE quarter_label = 'Jun/2026'").run();
    await computeInPrevMoves(ctx);
    expect(asked).toBe(false);
    expect(row(db)).toEqual({ p: 4, d: '2026-07-24', b: 'known' });
  });
});
