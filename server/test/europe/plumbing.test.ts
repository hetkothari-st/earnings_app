import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { config } from '../../src/config.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';
import {
  markEsefSeen, markEuropeSecSeen, markSignalSeen, saveEuropeExpectedMove, syncEuropeUniverse, upsertEuropeCalendarRow,
} from '../../src/europe/db/europeRepo.js';
import type { EuropeAdminDto } from '../../src/europe/api/types.js';
import type { ExchangeId } from '../../src/europe/exchanges.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import { computeCoverage } from '../../src/jobs/coverage.js';
import { europeNoteDeadline } from '../../src/notes/store.js';
import { europeEntries, SymbolIndex } from '../../src/watchlist/search.js';
import { addWatch, ensureWatchSchema, listWatch } from '../../src/watchlist/store.js';

const NOW = '2026-10-28T09:00:00.000Z';
const TODAY = '2026-10-28';
const entry = (symbol: string, isin: string, exchange: ExchangeId, extra: Partial<EuropeUniverseEntry> = {}): EuropeUniverseEntry => ({
  market: exchange === 'LSE' ? 'UK' : 'EU', symbol, isin, lei: null, name: `${symbol} name`, exchange, mic: 'XLON', country: isin.slice(0, 2),
  currency: exchange === 'LSE' ? 'GBp' : 'EUR', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null, ...extra,
});
// The schema as shipped before UK/EU (the JP rebuild).
const OLD_WITH_JP = `CREATE TABLE watchlists (
      user_id TEXT NOT NULL,
      market TEXT NOT NULL CHECK (market IN ('US','IN','HK','JP')),
      symbol TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (user_id, market, symbol)
    );`;
const TRADEGATE: Pick<EuropeAdminDto, 'tradegate'> = { tradegate: { state: 'on', backoffUntil: null, lastPollAt: '2026-10-28T08:59:00.000Z' } };

let db: Db;
let app: FastifyInstance;
let clock: number;
const savedKey = config.openFigiApiKey;
beforeEach(() => {
  db = openDb(':memory:');
  ensureAuthSchema(db);
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)').run('1A', 'x', '2026-10-01T00:00:00Z');
  db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 1)').run('ADM', 'x', '2026-10-01T00:00:00Z');
  syncEuropeUniverse(db, 'UK', [
    entry('AZN.L', 'GB0009895292', 'LSE', { adr: 'AZN', adrRatio: 1, adrRatioVerified: true, cik: 901832, secForm: '6-K', name: 'AstraZeneca PLC' }),
    entry('BT-A.L', 'GB0030913577', 'LSE', { name: 'BT Group PLC' }),
  ], NOW);
  syncEuropeUniverse(db, 'EU', [
    entry('SAP.DE', 'DE0007164600', 'XET', { adr: 'SAP', adrRatio: 1, adrRatioVerified: true, cik: 1000184, secForm: '6-K', name: 'SAP SE', mic: 'XETA' }),
    entry('ERIC-B.ST', 'SE0000108656', 'STO', { name: 'Telefonaktiebolaget LM Ericsson', mic: 'XSTO' }),
  ], NOW);
  clock = Date.parse(NOW);
  const index = new SymbolIndex();
  index.set('UK', europeEntries(db, 'UK'));
  index.set('EU', europeEntries(db, 'EU'));
  app = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index }, europe: { admin: () => TRADEGATE } });
});
afterEach(() => { config.openFigiApiKey = savedKey; });
const as = (id: string) => ({ cookie: `session=${createSession(db, id, clock).token}` });
const sqlOf = (d: Db) => (d.prepare("SELECT sql FROM sqlite_master WHERE name = 'watchlists'").get() as { sql: string }).sql;
const q2 = { periodEnd: '2026-09-30', fiscalQuarter: 2 as const, fyEnd: '2027-03-31' };
const mk = (market: 'UK' | 'EU', symbol: string, exchange: ExchangeId, reportDate: string) => upsertEuropeCalendarRow(db, market, {
  symbol, name: symbol, exchange, period: q2, periodLabel: 'H1 FY27', periodConfirmed: true, reportDate, dateStatus: 'confirmed',
}, NOW);

describe('markets UK and EU plumbing', () => {
  test('prefs round-trip UK and EU', async () => {
    const h = as('1A');
    for (const market of ['UK', 'EU']) {
      expect((await app.inject({ method: 'PUT', url: '/api/prefs', headers: h, payload: { market } })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/prefs', headers: h })).json()).toEqual({ market });
    }
    const bad = await app.inject({ method: 'PUT', url: '/api/prefs', headers: h, payload: { market: 'XX' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('market must be "US", "IN", "HK", "JP", "UK" or "EU"');
  });

  test('watchlists table without EU is rebuilt and keeps US/HK/JP rows', () => {
    const a = openDb(':memory:');
    a.exec(`DROP TABLE IF EXISTS watchlists; ${OLD_WITH_JP}
      INSERT INTO watchlists VALUES ('u','US','AAPL','t1'), ('u','IN','TCS','t2'), ('u','HK','0700','t3'), ('v','JP','7203','t4'), ('v','JP','285A','t5');`);
    ensureWatchSchema(a);
    expect(a.prepare('SELECT user_id, market, symbol, added_at FROM watchlists ORDER BY added_at').all().map((r) => ({ ...r }))).toEqual([
      { user_id: 'u', market: 'US', symbol: 'AAPL', added_at: 't1' }, { user_id: 'u', market: 'IN', symbol: 'TCS', added_at: 't2' },
      { user_id: 'u', market: 'HK', symbol: '0700', added_at: 't3' }, { user_id: 'v', market: 'JP', symbol: '7203', added_at: 't4' },
      { user_id: 'v', market: 'JP', symbol: '285A', added_at: 't5' },
    ]);
    expect(sqlOf(a)).toContain("'UK'");
    expect(sqlOf(a)).toContain("'EU'");
    expect(a.prepare("SELECT name FROM sqlite_master WHERE name = 'watchlists_new'").get()).toBeUndefined();
    addWatch(a, 'u', 'UK', 'AZN.L', 6);
    addWatch(a, 'u', 'EU', 'SAP.DE', 7);
    expect(listWatch(a, 'u', 'UK')).toEqual(['AZN.L']);
    expect(listWatch(a, 'u', 'EU')).toEqual(['SAP.DE']);
    // Idempotent: a database already holding the new table (a later process start) is left as it is, rows and all.
    const migrated = sqlOf(a);
    const c = openDb(':memory:');
    c.exec(`DROP TABLE IF EXISTS watchlists; ${migrated}; INSERT INTO watchlists VALUES ('u','EU','SAP.DE','t'), ('u','US','MSFT','t0');`);
    ensureWatchSchema(c);
    expect(sqlOf(c)).toBe(migrated);
    expect(c.prepare('SELECT user_id, market, symbol, added_at FROM watchlists ORDER BY added_at').all().map((r) => ({ ...r }))).toEqual([
      { user_id: 'u', market: 'EU', symbol: 'SAP.DE', added_at: 't' }, { user_id: 'u', market: 'US', symbol: 'MSFT', added_at: 't0' },
    ]);
  });

  test('UK watch accepts bt-a.l (stored BT-A.L), rejects SAP.DE; EU accepts ERIC-B.ST, rejects AZN.L', async () => {
    const h = as('1A');
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/UK/bt-a.l', headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/UK/SAP.DE', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/EU/ERIC-B.ST', headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/watchlist/EU/AZN.L', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/watchlist?market=UK', headers: h })).json()).toEqual({ symbols: ['BT-A.L'] });
    expect((await app.inject({ url: '/api/watchlist?market=EU', headers: h })).json()).toEqual({ symbols: ['ERIC-B.ST'] });
    const empty = new SymbolIndex();
    const app2 = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index: empty } });
    // The registration loads the europe lists from the DB, as Japan's.
    expect(empty.size('UK')).toBe(2);
    expect((await app2.inject({ method: 'PUT', url: '/api/watchlist/UK/AZN.DE', headers: h })).statusCode).toBe(400);
    // Search and rows.
    expect((await app.inject({ url: '/api/symbols?market=UK&q=bt', headers: h })).json().results[0])
      .toEqual({ symbol: 'BT-A.L', name: 'BT Group PLC', exchange: 'London Stock Exchange (Main Market + AIM)' });
    mk('EU', 'ERIC-B.ST', 'STO', '2026-11-05');
    const row = (await app.inject({ url: '/api/watchlist/rows?market=EU', headers: h })).json().rows[0];
    expect(row.next).toMatchObject({ market: 'EU', symbol: 'ERIC-B.ST', reportDate: '2026-11-05' });
    expect((await app.inject({ method: 'DELETE', url: '/api/watchlist/UK/bt-a.l', headers: h })).statusCode).toBe(204);
    expect(listWatch(db, '1A', 'UK')).toEqual([]);
  });

  test('note deadline: LSE AMC without release → 16:30 London + 24 h', () => {
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: null, exchange: 'LSE' })).toBe('2026-11-06T16:30:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'DMH', releasedAt: null, exchange: 'LSE' })).toBe('2026-11-06T16:30:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'BMO', releasedAt: null, exchange: 'LSE' })).toBe('2026-11-06T08:00:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'UNKNOWN', releasedAt: null, exchange: 'LSE' })).toBe('2026-11-06T23:59:59.000Z');
    // Helsinki: 10:00-18:30 EET (UTC+2 in November).
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'BMO', releasedAt: null, exchange: 'HEL' })).toBe('2026-11-06T08:00:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: null, exchange: 'XET' })).toBe('2026-11-06T16:30:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: '2026-11-05T07:02:00.000Z', exchange: 'LSE' })).toBe('2026-11-06T07:02:00.000Z');
    // Summer time: 16:30 BST is 15:30Z.
    expect(europeNoteDeadline({ reportDate: '2026-06-05', timing: 'AMC', releasedAt: null, exchange: 'LSE' })).toBe('2026-06-06T15:30:00.000Z');
    // DST changeover Sundays: the close is wall-clock time on that day, not minutes after midnight.
    expect(europeNoteDeadline({ reportDate: '2026-10-25', timing: 'AMC', releasedAt: null, exchange: 'LSE' })).toBe('2026-10-26T16:30:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-03-29', timing: 'AMC', releasedAt: null, exchange: 'XET' })).toBe('2026-03-30T15:30:00.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-03-29', timing: 'BMO', releasedAt: null, exchange: 'XET' })).toBe('2026-03-30T07:00:00.000Z');
    // An unreadable stored release time falls back to the timing rule instead of throwing.
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: 'not-a-date', exchange: 'LSE' })).toBe('2026-11-06T16:30:00.000Z');
    // A Yahoo "results out" time is when the app saw Yahoo's actual, not the release: the timing rule applies.
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'UNKNOWN', releasedAt: '2026-11-09T12:35:00.000Z', releasedSource: 'yahoo', exchange: 'LSE' }))
      .toBe('2026-11-06T23:59:59.000Z');
    expect(europeNoteDeadline({ reportDate: '2026-11-05', timing: 'AMC', releasedAt: '2026-11-05T07:02:00.000Z', releasedSource: 'prn', exchange: 'LSE' }))
      .toBe('2026-11-06T07:02:00.000Z');
  });

  test('notes accept a UK report id and use the exchange deadline', async () => {
    const id = mk('UK', 'AZN.L', 'LSE', '2026-11-05');
    const put = await app.inject({ method: 'PUT', url: `/api/notes/${id}`, headers: as('1A'), payload: { text: 'hello' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().deleteAt).toBe('2026-11-06T23:59:59.000Z');
    const list = (await app.inject({ url: '/api/notes', headers: as('1A') })).json();
    expect(JSON.stringify(list)).toContain('2026-11-06T23:59:59.000Z');
    // A stored released_at that cannot be read keeps GET /api/notes working (Task 13 keeps such values).
    db.prepare("UPDATE europe_reports SET released_at = 'garbage' WHERE id = ?").run(id);
    const again = await app.inject({ url: '/api/notes', headers: as('1A') });
    expect(again.statusCode).toBe(200);
    expect(again.json().notes).toEqual([expect.objectContaining({ reportId: id, deleteAt: '2026-11-06T23:59:59.000Z' })]);
  });

  test('status has UK and EU coverage; expectedMove counts full only', async () => {
    const azn = mk('UK', 'AZN.L', 'LSE', '2026-10-30');
    mk('UK', 'BT-A.L', 'LSE', '2026-10-30');
    mk('EU', 'ERIC-B.ST', 'STO', '2026-10-30');
    saveEuropeExpectedMove(db, azn, { adr: 'AZN', expiry: '2026-11-06', strike: 1, callMid: 1, putMid: 1, underlying: 1, movePct: 3, illiquid: false, quoteDate: '2026-10-27' }, false, NOW);
    const uk = computeCoverage(db, 'UK', TODAY);
    expect(uk.map((r) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
    expect(uk.find((r) => r.field === 'epsEstimate')).toMatchObject({ total: 2, min: 30 });
    expect(uk.find((r) => r.field === 'marketCap')).toMatchObject({ min: 90 });
    expect(uk.find((r) => r.field === 'previousMove')).toMatchObject({ min: 30 });
    expect(uk.find((r) => r.field === 'expectedMove')).toMatchObject({ filled: 1, total: 1, pct: 100, min: 60, ok: true });
    const eu = computeCoverage(db, 'EU', TODAY);
    // The EU row is basic: no straddle expected; the UK rows never count for EU.
    expect(eu.find((r) => r.field === 'epsEstimate')).toMatchObject({ total: 1 });
    expect(eu.find((r) => r.field === 'expectedMove')).toMatchObject({ total: 0 });
    const body = (await app.inject({ url: '/api/status', headers: as('1A') })).json();
    expect(body.coverage.UK.map((r: { field: string }) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
    expect(body.coverage.EU.map((r: { field: string }) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
  });

  test('admin europe: admins only; openFigiConfigured; body never contains the key', async () => {
    expect((await app.inject({ url: '/api/admin/europe' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/europe', headers: as('1A') })).statusCode).toBe(403);
    markEuropeSecSeen(db, 'UK', '0000901832-26-000001', 901832, 'results', '2026-10-27T10:00:00.000Z');
    markSignalSeen(db, 'prn', 'p1', 'BT-A.L', 'flipped', '2026-10-27T07:02:00.000Z');
    markSignalSeen(db, 'dila', 'd1', null, 'no-match', '2026-10-27T12:00:00.000Z');
    markEsefSeen(db, 'fx1', 'SAP.DE', '2025-12-31', 'merged', '2026-10-26T12:00:00.000Z');
    db.prepare("UPDATE europe_stocks SET active = 0 WHERE symbol = 'ERIC-B.ST'").run();
    config.openFigiApiKey = 'sekrit-123';
    const on = await app.inject({ url: '/api/admin/europe', headers: as('ADM') });
    expect(on.statusCode).toBe(200);
    expect(on.body).not.toContain('sekrit-123');
    const body = on.json() as EuropeAdminDto;
    expect(body.openFigiConfigured).toBe(true);
    expect(body.secConfigured).toBe(!!config.secUserAgent);
    expect(body.tradegate).toEqual(TRADEGATE.tradegate);
    expect(body.UK).toEqual({
      full: 1, basic: 1, inactive: 0, leftOut: null, lastUniverseAt: null, lastSixKAt: '2026-10-27T10:00:00.000Z',
      lastPrnAt: '2026-10-27T07:02:00.000Z', lastDilaAt: null, lastEsefAt: null,
      readerOn: !!(config.fastFields.ukEps || config.fastFields.ukRevenue),
    });
    expect(body.EU).toEqual({
      full: 1, basic: 0, inactive: 1, leftOut: null, lastUniverseAt: null, lastSixKAt: null,
      lastPrnAt: '2026-10-27T07:02:00.000Z', lastDilaAt: '2026-10-27T12:00:00.000Z', lastEsefAt: '2026-10-26T12:00:00.000Z',
      readerOn: !!(config.fastFields.euEps || config.fastFields.euRevenue),
    });
    config.openFigiApiKey = '';
    expect((await app.inject({ url: '/api/admin/europe', headers: as('ADM') })).json().openFigiConfigured).toBe(false);
    // The last universe build, when the running server knows it.
    const withUniverse = buildServer(db, { requireAuth: true, now: () => clock, europe: { admin: () => ({
      ...TRADEGATE, universe: { UK: { leftOut: 7, at: '2026-10-25T03:00:00.000Z' } },
    }) } });
    const u = (await withUniverse.inject({ url: '/api/admin/europe', headers: as('ADM') })).json() as EuropeAdminDto;
    expect(u.UK).toMatchObject({ leftOut: 7, lastUniverseAt: '2026-10-25T03:00:00.000Z' });
    // Unknown stays unknown: never a made-up 0.
    expect(u.EU).toMatchObject({ leftOut: null, lastUniverseAt: null });
    expect(Object.keys(u)).not.toContain('universe');
  });

  test('admin europe without a live Tradegate client: state unknown, off-env only when the flag is off', async () => {
    const saved = config.tradegatePrices;
    try {
      const bare = buildServer(db, { requireAuth: true, now: () => clock });
      config.tradegatePrices = true;
      expect((await bare.inject({ url: '/api/admin/europe', headers: as('ADM') })).json().tradegate)
        .toEqual({ state: null, backoffUntil: null, lastPollAt: null });
      config.tradegatePrices = false;
      expect((await bare.inject({ url: '/api/admin/europe', headers: as('ADM') })).json().tradegate.state).toBe('off-env');
    } finally { config.tradegatePrices = saved; }
  });

  test('visible accepts UK and EU symbols by the Ruling 2 format', async () => {
    const seen: [string, string, string[]][] = [];
    const a = buildServer(db, { requireAuth: true, now: () => clock, europe: {
      UK: { setVisible: (u, s) => seen.push(['UK', u, s]) }, EU: { setVisible: (u, s) => seen.push(['EU', u, s]) },
    } });
    const h = as('1A');
    const put = (market: string, symbols: unknown) => a.inject({ method: 'PUT', url: '/api/live/visible', headers: h, payload: { market, symbols } });
    expect((await put('UK', ['AZN.L', 'bt-a.l', 'AZN.L'])).statusCode).toBe(204);
    expect((await put('EU', ['SAP.DE', 'ERIC-B.ST'])).statusCode).toBe(204);
    expect(seen).toEqual([['UK', '1A', ['AZN.L', 'BT-A.L']], ['EU', '1A', ['SAP.DE', 'ERIC-B.ST']]]);
    // An invalid code is dropped, not the batch: one odd symbol never removes prices for the whole page.
    seen.length = 0;
    expect((await put('UK', ['SAP.DE', 'AZN.L', 'M&S.L'])).statusCode).toBe(204);
    expect((await put('EU', ['AZN.L', 'AAPL', 'SAP.DE'])).statusCode).toBe(204);
    expect((await put('EU', ['AAPL'])).statusCode).toBe(204);
    expect(seen).toEqual([['UK', '1A', ['AZN.L']], ['EU', '1A', ['SAP.DE']], ['EU', '1A', []]]);
    // The batch shape is still checked.
    expect((await put('UK', 'AZN.L')).statusCode).toBe(400);
    expect((await put('UK', [1])).statusCode).toBe(400);
  });
});
