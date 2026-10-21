import { beforeEach, describe, expect, test } from 'vitest';
import { toDto } from '../../src/api/dto.js';
import { confirmPrelim, savePrelim } from '../../src/db/prelim.js';
import { type Db, listRange, mergeFinnhubRow, mergeYahooFill, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-15T20:00:00.000Z';
const TODAY = '2026-10-15';
const ADJ = { usEpsAdjusted: true, usEpsGaap: true, usRevenue: true, inEps: false, inRevenue: false, inProfit: false };

const row = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026', timing: 'AMC',
  marketCap: 1e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});
const dto = () => toDto(listRange(db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null })[0]!);
const id = () => listRange(db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null })[0]!.id;

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  upsertCalendarRow(db, row(), NOW, TODAY);
});

describe('preliminary values', () => {
  test('prelim adjusted EPS shows as actual with preliminary true and beat colour', () => {
    expect(savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: 1.5, revenue: 5e9 }, NOW, ADJ)).toBe(true);
    const d = dto();
    expect(d.eps).toMatchObject({ actual: 1.8, preliminary: true, corrected: false, basis: 'adjusted', result: 'beat' });
    expect(d.eps.surprisePct).toBeCloseTo(8.4, 1);
    expect(d.revenue).toMatchObject({ actual: 5e9, preliminary: true, corrected: false });
  });

  test('GAAP-only prelim: result null', () => {
    expect(savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: 1.5, revenue: null }, NOW)).toBe(true); // default gates: GAAP only
    expect(dto().eps).toMatchObject({ actual: 1.5, preliminary: true, basis: 'gaap', result: null, surprisePct: null });
  });

  test('official equal within 0.01 clears the tag, corrected false', () => {
    savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: null, revenue: 5e9 }, NOW, ADJ);
    upsertCalendarRow(db, row({ epsActual: 1.81 }), NOW, TODAY);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-15', timing: 'AMC', revenueEstimate: null, revenueActual: 5.02e9, epsActual: null } as never, NOW);
    const d = dto();
    expect(d.eps).toMatchObject({ actual: 1.81, preliminary: false, corrected: false, basis: null });
    expect(d.revenue).toMatchObject({ actual: 5.02e9, preliminary: false, corrected: false });
  });

  test('official differs: official shown, corrected true', () => {
    savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: null, revenue: 5e9 }, NOW, ADJ);
    upsertCalendarRow(db, row({ epsActual: 1.7 }), NOW, TODAY);
    mergeYahooFill(db, id(), { epsActual: null, revenueEstimate: null, revenueActual: 4.5e9, revenueCurrency: 'USD' }, NOW);
    const d = dto();
    expect(d.eps).toMatchObject({ actual: 1.7, preliminary: false, corrected: true });
    expect(d.revenue).toMatchObject({ actual: 4.5e9, preliminary: false, corrected: true });
  });

  test('GAAP prelim cleared by official EPS without corrected', () => {
    savePrelim(db, id(), { epsAdjusted: null, epsGaap: 1.2, revenue: null }, NOW);
    upsertCalendarRow(db, row({ epsActual: 1.7 }), NOW, TODAY);
    expect(dto().eps).toMatchObject({ actual: 1.7, preliminary: false, corrected: false, basis: null });
  });

  test('a second fast read never replaces the first prelim', () => {
    expect(savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: null, revenue: 5e9 }, NOW, ADJ)).toBe(true);
    expect(savePrelim(db, id(), { epsAdjusted: 2.5, epsGaap: null, revenue: 6e9 }, NOW, ADJ)).toBe(false);
    expect(dto().eps.actual).toBe(1.8);
    expect(dto().revenue.actual).toBe(5e9);
  });

  test('official already present: prelim is not stored', () => {
    upsertCalendarRow(db, row({ epsActual: 1.7 }), NOW, TODAY);
    expect(savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: null, revenue: null }, NOW, ADJ)).toBe(false);
    expect(dto().eps).toMatchObject({ actual: 1.7, preliminary: false });
  });

  test('gates off store nothing; adjusted gate off falls back to GAAP', () => {
    const off = { ...ADJ, usEpsAdjusted: false, usEpsGaap: false, usRevenue: false };
    expect(savePrelim(db, id(), { epsAdjusted: 1.8, epsGaap: 1.5, revenue: 5e9 }, NOW, off)).toBe(false);
    expect(dto().eps.actual).toBeNull();
  });

  test('confirmPrelim with nothing stored is a no-op', () => {
    confirmPrelim(db, id());
    expect(dto().eps).toMatchObject({ preliminary: false, corrected: false });
  });
});
