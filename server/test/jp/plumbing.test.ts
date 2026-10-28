import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { config } from '../../src/config.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';
import { markEdinetSeen, markJpSecSeen, saveJpExpectedMove, syncJpUniverse, upsertJpCalendarRow } from '../../src/jp/db/jpRepo.js';
import type { JpUniverseEntry } from '../../src/jp/universe.js';
import { computeCoverage } from '../../src/jobs/coverage.js';
import { jpNoteDeadline } from '../../src/notes/store.js';
import { SymbolIndex, jpEntries } from '../../src/watchlist/search.js';
import { addWatch, ensureWatchSchema, listWatch } from '../../src/watchlist/store.js';

const NOW = '2026-10-27T00:00:00.000Z';
const TODAY = '2026-10-27';
const entry = (code: string, name: string, extra: Partial<JpUniverseEntry> = {}): JpUniverseEntry => ({
  code, edinetCode: `E${code}`, name, nameJa: `${name}株式会社`, fyEndMonth: 3, industryJa: '電気機器', adr: null, adrRatio: null, cik: null, ...extra,
});
const OLD_US_IN = `CREATE TABLE watchlists (
  user_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('US','IN')),
  symbol TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, market, symbol)
);`;
const OLD_US_IN_HK = OLD_US_IN.replace("'US','IN'", "'US','IN','HK'");

let db: Db;
let app: FastifyInstance;
let clock: number;
const savedKey = config.edinetApiKey;
beforeEach(() => {
  db = openDb(':memory:');
  ensureAuthSchema(db);
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)').run('1A', 'x', '2026-10-01T00:00:00Z');
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 1)').run('ADM', 'x', '2026-10-01T00:00:00Z');
  syncJpUniverse(db, [
    entry('7203', 'TOYOTA', { adr: 'TM', adrRatio: 10, cik: 1094517 }),
    entry('285A', 'KIOXIA'),
    entry('6501', 'HITACHI'),
  ], NOW);
  clock = Date.parse('2026-10-27T04:00:00Z');
  const index = new SymbolIndex();
  index.set('JP', jpEntries(db));
  app = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index } });
});
afterEach(() => { config.edinetApiKey = savedKey; });
const as = (id: string) => ({ cookie: `session=${createSession(db, id, clock).token}` });
const sqlOf = (d: Db) => (d.prepare("SELECT sql FROM sqlite_master WHERE name = 'watchlists'").get() as { sql: string }).sql;
const q2 = { periodEnd: '2026-09-30', fiscalQuarter: 2 as const, fyEnd: '2027-03-31' };

describe('market JP plumbing', () => {
  test('prefs round-trip JP', async () => {
    const h = as('1A');
    expect((await app.inject({ method: 'PUT', url: '/api/prefs', headers: h, payload: { market: 'JP' } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/prefs', headers: h })).json()).toEqual({ market: 'JP' });
    const bad = await app.inject({ method: 'PUT', url: '/api/prefs', headers: h, payload: { market: 'XX' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('market must be "US", "IN", "HK", "JP", "UK" or "EU"');
  });

  test('old watchlists table without JP is rebuilt and keeps US and HK rows', () => {
    // Prior state 1: US/IN only (before HK).
    const a = openDb(':memory:');
    a.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_US_IN}
      INSERT INTO watchlists VALUES ('u','US','AAPL','2026-01-01T00:00:00.000Z'), ('u','IN','TCS','2026-01-02T00:00:00.000Z');`);
    ensureWatchSchema(a);
    addWatch(a, 'u', 'HK', '0700', 1);
    addWatch(a, 'u', 'JP', '7203', 2);
    expect(listWatch(a, 'u', 'US')).toEqual(['AAPL']);
    expect(listWatch(a, 'u', 'IN')).toEqual(['TCS']);
    expect(listWatch(a, 'u', 'HK')).toEqual(['0700']);
    expect(listWatch(a, 'u', 'JP')).toEqual(['7203']);
    expect((a.prepare("SELECT added_at FROM watchlists WHERE symbol = 'AAPL'").get() as { added_at: string }).added_at).toBe('2026-01-01T00:00:00.000Z');
    expect(sqlOf(a)).toContain("'JP'");

    // Prior state 2: US/IN/HK (the shipped HK rebuild).
    const b = openDb(':memory:');
    b.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_US_IN_HK}
      INSERT INTO watchlists VALUES ('u','US','AAPL','t1'), ('u','IN','TCS','t2'), ('u','HK','0700','t3'), ('v','HK','9988','t4');`);
    ensureWatchSchema(b);
    expect(b.prepare('SELECT user_id, market, symbol, added_at FROM watchlists ORDER BY added_at').all().map((r) => ({ ...r })))
      .toEqual([
        { user_id: 'u', market: 'US', symbol: 'AAPL', added_at: 't1' }, { user_id: 'u', market: 'IN', symbol: 'TCS', added_at: 't2' },
        { user_id: 'u', market: 'HK', symbol: '0700', added_at: 't3' }, { user_id: 'v', market: 'HK', symbol: '9988', added_at: 't4' },
      ]);
    addWatch(b, 'u', 'JP', '285A', 5);
    expect(listWatch(b, 'u', 'JP')).toEqual(['285A']);
    expect(sqlOf(b)).toContain("'JP'");
    expect(b.prepare("SELECT name FROM sqlite_master WHERE name = 'watchlists_new'").get()).toBeUndefined();
  });

  test('watchlist rebuild is idempotent, transactional and tolerates a stale watchlists_new', () => {
    const d = openDb(':memory:');
    d.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_US_IN_HK} INSERT INTO watchlists VALUES ('u','HK','0700','t');
      CREATE TABLE watchlists_new (junk TEXT);`);
    ensureWatchSchema(d);
    const once = sqlOf(d);
    ensureWatchSchema(d);
    expect(sqlOf(d)).toBe(once);
    expect(d.prepare('SELECT COUNT(*) AS n FROM watchlists').get()).toEqual({ n: 1 });
    // A failure part-way rolls back: a legacy row the new CHECK rejects aborts the copy, and the old table and rows survive.
    const f = openDb(':memory:');
    f.exec(`DROP TABLE IF EXISTS watchlists;
      CREATE TABLE watchlists (user_id TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (user_id, market, symbol));
      INSERT INTO watchlists VALUES ('u','US','AAPL','t'), ('u','XX','BAD','t');`);
    expect(() => ensureWatchSchema(f)).toThrow();
    expect(sqlOf(f)).not.toContain("'JP'");
    expect(f.prepare('SELECT COUNT(*) AS n FROM watchlists').get()).toEqual({ n: 2 });
    expect(f.prepare("SELECT name FROM sqlite_master WHERE name = 'watchlists_new'").get()).toBeUndefined();
  });

  test('JP watch accepts 7203 and 285a (stored 285A), rejects 72030', async () => {
    const h = as('1A');
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/JP/7203', headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/JP/285a', headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/JP/72030', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/JP/9999', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/watchlist?market=JP', headers: h })).json()).toEqual({ symbols: ['285A', '7203'] });
    const fresh = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index: new SymbolIndex() } });
    expect((await fresh.inject({ method: 'PUT', url: '/api/watchlist/JP/72030', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/watchlist/JP/285a', headers: h })).statusCode).toBe(204);
    expect(listWatch(db, '1A', 'JP')).toEqual(['7203']);
  });

  test('JP search finds English and Japanese names; watchlist rows carry the next report', async () => {
    const h = as('1A');
    expect((await app.inject({ url: '/api/symbols?market=JP&q=kiox', headers: h })).json().results)
      .toEqual([{ symbol: '285A', name: 'KIOXIA', exchange: 'TSE' }]);
    expect((await app.inject({ url: `/api/symbols?market=JP&q=${encodeURIComponent('TOYOTA株式')}`, headers: h })).json().results[0]).toMatchObject({ symbol: '7203' });
    upsertJpCalendarRow(db, { code: '7203', name: 'TOYOTA', period: q2, periodLabel: '2Q FY27', reportDate: '2026-11-05', dateStatus: 'confirmed' }, NOW);
    await app.inject({ method: 'PUT', url: '/api/watchlist/JP/7203', headers: h });
    const row = (await app.inject({ url: '/api/watchlist/rows?market=JP', headers: h })).json().rows[0];
    expect(row.next).toMatchObject({ market: 'JP', symbol: '7203', reportDate: '2026-11-05' });
  });

  test('JP note deadline: 15:30 JST + 24 h for AMC without release time', () => {
    expect(jpNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: null })).toBe('2026-11-06T06:30:00.000Z');
    expect(jpNoteDeadline({ reportDate: '2026-11-05', timing: 'DMH', releasedAt: null })).toBe('2026-11-06T06:30:00.000Z');
    expect(jpNoteDeadline({ reportDate: '2026-11-05', timing: 'BMO', releasedAt: null })).toBe('2026-11-06T00:00:00.000Z');
    expect(jpNoteDeadline({ reportDate: '2026-11-05', timing: 'UNKNOWN', releasedAt: null })).toBe('2026-11-06T14:59:59.000Z');
    expect(jpNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: '2026-11-05T10:00:00.000Z' })).toBe('2026-11-06T10:00:00.000Z');
  });

  test('notes accept a JP report id and use the JP deadline', async () => {
    const id = upsertJpCalendarRow(db, { code: '7203', name: 'TOYOTA', period: q2, periodLabel: '2Q FY27', reportDate: '2026-11-05', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'yahoo' }, NOW);
    const put = await app.inject({ method: 'PUT', url: `/api/notes/${id}`, headers: as('1A'), payload: { text: 'hello' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().deleteAt).toBe('2026-11-06T06:30:00.000Z');
  });

  test('status coverage has JP rows; expectedMove counts full level only', async () => {
    const mk = (code: string, name: string) => upsertJpCalendarRow(db, { code, name, period: q2, periodLabel: '2Q FY27', reportDate: '2026-10-29', dateStatus: 'confirmed' }, NOW);
    const a = mk('7203', 'TOYOTA');
    mk('6501', 'HITACHI');
    saveJpExpectedMove(db, a, { adr: 'TM', expiry: '2026-11-06', strike: 1, callMid: 1, putMid: 1, underlying: 1, movePct: 3, illiquid: false, quoteDate: '2026-10-26' }, false, NOW);
    const cov = computeCoverage(db, 'JP', TODAY);
    expect(cov.map((r) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
    expect(cov.find((r) => r.field === 'epsEstimate')).toMatchObject({ total: 2, min: 30 });
    expect(cov.find((r) => r.field === 'marketCap')).toMatchObject({ min: 90 });
    expect(cov.find((r) => r.field === 'previousMove')).toMatchObject({ min: 30 });
    // Only the full-level stock counts for the straddle.
    expect(cov.find((r) => r.field === 'expectedMove')).toMatchObject({ filled: 1, total: 1, pct: 100, min: 60, ok: true });
    const body = (await app.inject({ url: '/api/status', headers: as('1A') })).json();
    expect(body.coverage.JP.map((r: { field: string }) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
  });

  test('admin jp: admins only; edinetConfigured true/false; body never contains the key', async () => {
    expect((await app.inject({ url: '/api/admin/jp' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/jp', headers: as('1A') })).statusCode).toBe(403);
    markJpSecSeen(db, '0001-26-000001', 1, 'results', '2026-10-26T10:00:00.000Z');
    markEdinetSeen(db, 'S100ABCD', '7203', '120', '2026-03-31', 'merged', '2026-10-26T11:00:00.000Z');
    config.edinetApiKey = 'sekrit-123';
    const on = await app.inject({ url: '/api/admin/jp', headers: as('ADM') });
    expect(on.statusCode).toBe(200);
    expect(on.body).not.toContain('sekrit-123');
    expect(on.json()).toEqual({
      full: 1, basic: 2, secConfigured: !!config.secUserAgent, edinetConfigured: true,
      readerOn: !!(config.fastFields.jpEps || config.fastFields.jpRevenue),
      lastSixKAt: '2026-10-26T10:00:00.000Z', lastEdinetAt: '2026-10-26T11:00:00.000Z',
    });
    config.edinetApiKey = '';
    expect((await app.inject({ url: '/api/admin/jp', headers: as('ADM') })).json().edinetConfigured).toBe(false);
  });

  test('visible accepts JP codes', async () => {
    const seen: [string, string[]][] = [];
    const a = buildServer(db, { requireAuth: true, now: () => clock, jp: { setVisible: (u, c) => seen.push([u, c]) } });
    const h = as('1A');
    const put = (symbols: unknown) => a.inject({ method: 'PUT', url: '/api/live/visible', headers: h, payload: { market: 'JP', symbols } });
    expect((await put(['7203', '285A', '7203'])).statusCode).toBe(204);
    expect(seen).toEqual([['1A', ['7203', '285A']]]);
    expect((await put(['AAPL'])).statusCode).toBe(400);
    expect((await put(['72030'])).statusCode).toBe(400);
    expect((await put(['285a'])).statusCode).toBe(400);
  });
});
