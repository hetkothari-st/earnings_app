import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { config } from '../../src/config.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';
import { HK_UNIVERSE } from '../../src/hk/universe.js';
import { markSecSeen, saveHkExpectedMove, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import { computeCoverage } from '../../src/jobs/coverage.js';
import { hkNoteDeadline } from '../../src/notes/store.js';
import { SymbolIndex, hkEntries, startSymbolRefresh } from '../../src/watchlist/search.js';
import { addWatch, ensureWatchSchema, listWatch } from '../../src/watchlist/store.js';

const NOW = '2026-10-27T00:00:00.000Z';
const TODAY = '2026-10-27';
const OLD_TABLE = `CREATE TABLE watchlists (
  user_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('US','IN')),
  symbol TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, market, symbol)
);`;

let db: Db;
let app: FastifyInstance;
let clock: number;
beforeEach(() => {
  db = openDb(':memory:');
  ensureAuthSchema(db);
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)').run('1A', 'x', '2026-10-01T00:00:00Z');
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 1)').run('ADM', 'x', '2026-10-01T00:00:00Z');
  clock = Date.parse('2026-10-27T04:00:00Z');
  const index = new SymbolIndex();
  index.set('HK', hkEntries(db));
  app = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index } });
});
const as = (id: string) => ({ cookie: `session=${createSession(db, id, clock).token}` });

describe('market HK plumbing', () => {
  test('prefs round-trip HK', async () => {
    const h = as('1A');
    expect((await app.inject({ method: 'PUT', url: '/api/prefs', headers: h, payload: { market: 'HK' } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/prefs', headers: h })).json()).toEqual({ market: 'HK' });
    const bad = await app.inject({ method: 'PUT', url: '/api/prefs', headers: h, payload: { market: 'XX' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('market must be "US", "IN", "HK", "JP", "UK" or "EU"');
  });

  test('old watchlists table without HK is rebuilt and keeps rows', () => {
    const old = openDb(':memory:');
    old.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_TABLE}
      INSERT INTO watchlists VALUES ('u','US','AAPL','2026-01-01T00:00:00.000Z'), ('u','IN','TCS','2026-01-02T00:00:00.000Z');`);
    ensureWatchSchema(old);
    addWatch(old, 'u', 'HK', '0700', 1);
    expect(listWatch(old, 'u', 'US')).toEqual(['AAPL']);
    expect(listWatch(old, 'u', 'IN')).toEqual(['TCS']);
    expect(listWatch(old, 'u', 'HK')).toEqual(['0700']);
    const row = old.prepare("SELECT added_at FROM watchlists WHERE symbol = 'AAPL'").get() as { added_at: string };
    expect(row.added_at).toBe('2026-01-01T00:00:00.000Z');
    const sql = (old.prepare("SELECT sql FROM sqlite_master WHERE name = 'watchlists'").get() as { sql: string }).sql;
    expect(sql).toContain("'HK'");
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'watchlists_new'").get()).toBeUndefined();
  });

  test('watchlist rebuild is idempotent and leaves no half-state', () => {
    const d = openDb(':memory:');
    d.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_TABLE} INSERT INTO watchlists VALUES ('u','US','AAPL','t');`);
    ensureWatchSchema(d);
    ensureWatchSchema(d);
    expect(d.prepare('SELECT COUNT(*) AS n FROM watchlists').get()).toEqual({ n: 1 });
    // A stale watchlists_new from an interrupted run does not break the next attempt.
    const e = openDb(':memory:');
    e.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_TABLE} INSERT INTO watchlists VALUES ('u','US','AAPL','t');
      CREATE TABLE watchlists_new (junk TEXT);`);
    ensureWatchSchema(e);
    expect(listWatch(e, 'u', 'US')).toEqual(['AAPL']);
    addWatch(e, 'u', 'HK', '0700', 1);
    expect(listWatch(e, 'u', 'HK')).toEqual(['0700']);
  });

  test('HK watch PUT accepts universe codes only', async () => {
    const h = as('1A');
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/HK/0700', headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/HK/700', headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/HK/1234', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/watchlist?market=HK', headers: h })).json()).toEqual({ symbols: ['0700'] });
    expect((await app.inject({ url: '/api/watchlist/rows?market=HK', headers: h })).json().rows[0]).toMatchObject({ symbol: '0700', next: null });
  });

  test('right after a restart (HK index not loaded yet) a non-universe code is still rejected', async () => {
    const fresh = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index: new SymbolIndex() } });
    const h = as('1A');
    expect((await fresh.inject({ method: 'PUT', url: '/api/watchlist/HK/1234', headers: h })).statusCode).toBe(400);
    expect((await fresh.inject({ method: 'PUT', url: '/api/watchlist/HK/0700', headers: h })).statusCode).toBe(204);
  });

  test('watchlist rows for HK carry the next report', async () => {
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-11-13', dateStatus: 'confirmed' }, NOW);
    const h = as('1A');
    await app.inject({ method: 'PUT', url: '/api/watchlist/HK/0700', headers: h });
    const row = (await app.inject({ url: '/api/watchlist/rows?market=HK', headers: h })).json().rows[0];
    expect(row.next).toMatchObject({ market: 'HK', symbol: '0700', reportDate: '2026-11-13' });
  });

  test('hkEntries come from the universe with names and caps from hk_stocks', async () => {
    const d = openDb(':memory:');
    syncHkUniverse(d, HK_UNIVERSE, NOW);
    d.prepare("UPDATE hk_stocks SET market_cap = 5e12, profile_name = 'Tencent Holdings' WHERE code = '0700'").run();
    const e = hkEntries(d).find((x) => x.symbol === '0700')!;
    expect(e).toMatchObject({ name: 'Tencent Holdings', exchange: 'HKEX', weight: 5e12 });
    expect(hkEntries().length).toBe(HK_UNIVERSE.length);
    const idx = new SymbolIndex();
    const stop = startSymbolRefresh(idx, { HK: async () => hkEntries(d) });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(idx.has('HK', '0700')).toBe(true);
  });

  test('HK note deadline: 16:00 HKT + 24 h for AMC without release time', () => {
    expect(hkNoteDeadline({ reportDate: '2026-11-20', timing: 'AMC', releasedAt: null })).toBe('2026-11-21T08:00:00.000Z');
    expect(hkNoteDeadline({ reportDate: '2026-11-20', timing: 'DMH', releasedAt: null })).toBe('2026-11-21T08:00:00.000Z');
    expect(hkNoteDeadline({ reportDate: '2026-11-20', timing: 'BMO', releasedAt: null })).toBe('2026-11-21T01:30:00.000Z');
    expect(hkNoteDeadline({ reportDate: '2026-11-20', timing: 'UNKNOWN', releasedAt: null })).toBe('2026-11-21T15:59:59.000Z');
    expect(hkNoteDeadline({ reportDate: '2026-11-20', timing: 'AMC', releasedAt: '2026-11-20T10:00:00.000Z' })).toBe('2026-11-21T10:00:00.000Z');
  });

  test('notes accept an HK report id and use the HK deadline', async () => {
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    const id = upsertHkCalendarRow(db, { code: '0700', name: 'Tencent', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-11-13', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'yahoo' }, NOW);
    const put = await app.inject({ method: 'PUT', url: `/api/notes/${id}`, headers: as('1A'), payload: { text: 'hello' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().deleteAt).toBe('2026-11-14T08:00:00.000Z');
  });

  test('status coverage has HK rows; expectedMove counts full level only', async () => {
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    const full = HK_UNIVERSE.find((e) => e.cik != null && e.adr != null)!;
    const basic = HK_UNIVERSE.find((e) => e.cik == null || e.adr == null)!;
    const mk = (e: { code: string; name: string }) => upsertHkCalendarRow(db, { code: e.code, name: e.name, periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-10-29', dateStatus: 'confirmed' }, NOW);
    const a = mk(full);
    mk(basic);
    saveHkExpectedMove(db, a, { adr: full.adr!, expiry: '2026-11-06', strike: 1, callMid: 1, putMid: 1, underlying: 1, movePct: 3, illiquid: false, quoteDate: '2026-10-26' }, false, NOW);
    const cov = computeCoverage(db, 'HK', TODAY);
    expect(cov.map((r) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
    expect(cov.find((r) => r.field === 'epsEstimate')).toMatchObject({ total: 2, min: 40 });
    expect(cov.find((r) => r.field === 'marketCap')).toMatchObject({ min: 95 });
    // Previous move: only full-level names have a prior date (the ADR's US report); basic names stay blank.
    db.prepare('UPDATE hk_reports SET prev_move_pct = 2 WHERE id = ?').run(a);
    expect(cov.find((r) => r.field === 'previousMove')).toMatchObject({ min: 50 });
    expect(computeCoverage(db, 'HK', TODAY).find((r) => r.field === 'previousMove')).toMatchObject({ filled: 1, total: 1, min: 50, ok: true });
    expect(cov.find((r) => r.field === 'expectedMove')).toMatchObject({ filled: 1, total: 1, min: 60, ok: true });
    const body = (await app.inject({ url: '/api/status', headers: as('1A') })).json();
    expect(body.coverage.HK.map((r: { field: string }) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
  });

  test('admin hk panel is admins only and reports counts', async () => {
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    expect((await app.inject({ url: '/api/admin/hk' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/hk', headers: as('1A') })).statusCode).toBe(403);
    markSecSeen(db, '0001-26-000001', 1, 'results', '2026-10-26T10:00:00.000Z');
    const r = await app.inject({ url: '/api/admin/hk', headers: as('ADM') });
    expect(r.statusCode).toBe(200);
    const fullN = HK_UNIVERSE.filter((e) => e.cik != null && e.adr != null).length;
    expect(r.json()).toEqual({ full: fullN, basic: HK_UNIVERSE.length - fullN, secConfigured: !!config.secUserAgent, readerOn: true, lastSixKAt: '2026-10-26T10:00:00.000Z' });
  });

  test('visible accepts HK codes', async () => {
    const seen: [string, string[]][] = [];
    const a = buildServer(db, { requireAuth: true, now: () => clock, hk: { setVisible: (u, c) => seen.push([u, c]) } });
    const h = as('1A');
    const put = (symbols: unknown) => a.inject({ method: 'PUT', url: '/api/live/visible', headers: h, payload: { market: 'HK', symbols } });
    expect((await put(['0700', '9988', '0700'])).statusCode).toBe(204);
    expect(seen).toEqual([['1A', ['0700', '9988']]]);
    expect((await put(['AAPL'])).statusCode).toBe(400);
    expect((await put(['700'])).statusCode).toBe(400);
  });
});
