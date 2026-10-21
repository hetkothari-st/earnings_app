import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { listRange, openDb, saveExpectedMove, upsertCalendarRow } from '../../src/db/repo.js';
import { computeCoverage, coverageOk, runCoverageCheck } from '../../src/jobs/coverage.js';
import { saveFoList, saveInExpectedMove, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-21T10:00:00.000Z';
const TODAY = '2026-10-21';

const cal = (symbol: string, over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol, name: symbol, reportDate: '2026-10-23', fiscalQuarter: 'Sep/2026', timing: 'AMC',
  marketCap: 1e10, epsEstimate: 1.5, noOfEsts: 5, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});
const find = (rows: ReturnType<typeof computeCoverage>, field: string) => rows.find((r) => r.field === field)!;

function seedUs(db: ReturnType<typeof openDb>) {
  upsertCalendarRow(db, cal('AAA'), NOW, TODAY);                                                              // everything but a move
  upsertCalendarRow(db, cal('BBB', { timing: 'UNKNOWN', epsEstimate: null, marketCap: null }), NOW, TODAY);   // sparse, in 7 days
  upsertCalendarRow(db, cal('CCC', { reportDate: '2026-11-02' }), NOW, TODAY);                                // day 12: counts, outside 7 days
  upsertCalendarRow(db, cal('DDD', { reportDate: '2026-11-20' }), NOW, TODAY);                                // out of the window
  upsertCalendarRow(db, cal('EEE', { reportDate: '2026-10-20' }), NOW, TODAY);                                // already past
  const rows = listRange(db, { from: '2026-10-01', to: '2026-12-01', minCap: null, q: null });
  const id = (s: string) => rows.find((r) => r.symbol === s)!.id;
  saveExpectedMove(db, id('AAA'), { expiry: '2026-10-30', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false }, NOW);
  saveExpectedMove(db, id('CCC'), { expiry: '2026-11-06', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false }, NOW);
  db.prepare('UPDATE reports SET prev_move_pct = 4 WHERE id = ?').run(id('AAA'));
}

describe('coverage', () => {
  test('ok uses the exact share, not the rounded percentage', () => {
    expect(coverageOk(8496, 10000, 85)).toBe(false); // 84.96% rounds to 85.0 but is below
    expect(coverageOk(8500, 10000, 85)).toBe(true);
    expect(coverageOk(0, 0, 85)).toBe(false);
  });

  test('coverage counts filled fields over the next 14 days', () => {
    const db = openDb(':memory:');
    seedUs(db);
    const us = computeCoverage(db, 'US', TODAY);
    expect(find(us, 'epsEstimate')).toMatchObject({ filled: 2, total: 3, pct: 66.7, min: 85, ok: false });
    expect(find(us, 'marketCap')).toMatchObject({ filled: 2, total: 3, min: 95 });
    expect(find(us, 'timing')).toMatchObject({ filled: 2, total: 3, min: 70, ok: false });
    expect(find(us, 'previousMove')).toMatchObject({ filled: 1, total: 3, min: 70 });
    // Only AAA and BBB are within 7 days; CCC's move does not count and does not enlarge the total.
    expect(find(us, 'expectedMove')).toMatchObject({ filled: 1, total: 2, pct: 50, min: 60, ok: false });

    saveFoList(db, [{ symbol: 'RELIANCE', name: 'Reliance', lotSize: 250 }, { symbol: 'TCS', name: 'TCS', lotSize: 175 }], NOW);
    db.prepare('UPDATE in_stocks SET market_cap = 1e12 WHERE symbol = ?').run('RELIANCE');
    saveFoList(db, [{ symbol: 'RELIANCE', name: 'Reliance', lotSize: 250 }, { symbol: 'TCS', name: 'TCS', lotSize: 175 }], NOW);
    const q = { quarterEnd: '2026-09-30', quarterLabel: 'Q2 FY27' };
    const a = upsertInCalendarRow(db, { symbol: 'RELIANCE', name: 'Reliance', reportDate: '2026-10-24', ...q }, NOW);
    upsertInCalendarRow(db, { symbol: 'TCS', name: 'TCS', reportDate: '2026-10-25', ...q }, NOW);
    // A watched non-F&O stock does not count.
    db.prepare("INSERT INTO in_stocks (symbol, name, active, updated_at) VALUES ('ZZZ', 'Zzz', 0, ?)").run(NOW);
    upsertInCalendarRow(db, { symbol: 'ZZZ', name: 'Zzz', reportDate: '2026-10-24', ...q }, NOW);
    db.prepare('UPDATE in_reports SET eps_estimate = 10, prev_move_pct = 2 WHERE id = ?').run(a);
    saveInExpectedMove(db, a, { symbol: 'RELIANCE', expiry: '2026-10-29', strike: 1, callMid: 1, putMid: 1, underlying: 1, movePct: 3, illiquid: false }, false, NOW);
    const india = computeCoverage(db, 'IN', TODAY);
    expect(find(india, 'epsEstimate')).toMatchObject({ filled: 1, total: 2, pct: 50, min: 60, ok: false });
    expect(find(india, 'marketCap')).toMatchObject({ filled: 1, total: 2, min: 95 });
    expect(find(india, 'previousMove')).toMatchObject({ filled: 1, total: 2 });
    expect(find(india, 'expectedMove')).toMatchObject({ filled: 1, total: 2, min: 60 });
  });

  test('below minimum: ok false and the CLI exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
    try {
      const path = join(dir, 'c.db');
      const db = openDb(path);
      seedUs(db);
      const lines: string[] = [];
      expect(runCoverageCheck(db, TODAY, TODAY, (l) => lines.push(l))).toBe(1);
      expect(lines.join('\n')).toContain('BELOW MINIMUM');
      db.close();
      const cli = join(import.meta.dirname, '../../src/cli/coverageCheck.ts');
      const tsx = join(import.meta.dirname, '../../../node_modules/tsx/dist/cli.mjs');
      const res = spawnSync(process.execPath, [tsx, cli, '--db', path], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('epsEstimate');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a fully covered database passes', () => {
    const db = openDb(':memory:');
    upsertCalendarRow(db, cal('AAA'), NOW, TODAY);
    const id = listRange(db, { from: TODAY, to: '2026-11-04', minCap: null, q: null })[0]!.id;
    saveExpectedMove(db, id, { expiry: '2026-10-30', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false }, NOW);
    db.prepare('UPDATE reports SET prev_move_pct = 4 WHERE id = ?').run(id);
    saveFoList(db, [{ symbol: 'TCS', name: 'TCS', lotSize: 175 }], NOW);
    db.prepare('UPDATE in_stocks SET market_cap = 1e12').run();
    const r = upsertInCalendarRow(db, { symbol: 'TCS', name: 'TCS', reportDate: '2026-10-25', quarterEnd: '2026-09-30', quarterLabel: 'Q2' }, NOW);
    db.prepare('UPDATE in_reports SET eps_estimate = 1, prev_move_pct = 1 WHERE id = ?').run(r);
    saveInExpectedMove(db, r, { symbol: 'TCS', expiry: '2026-10-29', strike: 1, callMid: 1, putMid: 1, underlying: 1, movePct: 3, illiquid: false }, false, NOW);
    expect(runCoverageCheck(db, TODAY, TODAY, () => {})).toBe(0);
  });

  test('GET /api/status carries coverage for both markets', async () => {
    const db = openDb(':memory:');
    const app = buildServer(db);
    const body = (await app.inject('/api/status')).json();
    expect(body.coverage.US.map((r: { field: string }) => r.field)).toEqual(['epsEstimate', 'marketCap', 'timing', 'previousMove', 'expectedMove']);
    expect(body.coverage.IN.map((r: { field: string }) => r.field)).toEqual(['epsEstimate', 'marketCap', 'previousMove', 'expectedMove']);
    await app.close();
  });
});
