import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import {
  europeStocks, getEuropeReport, lastEsefDateAdded, mergeEuropeActuals, setEuropeProfile, syncEuropeUniverse, upsertEuropeCalendarRow,
} from '../../src/europe/db/europeRepo.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { esefCountries, esefSinceFor, refreshEsefResults } from '../../src/europe/jobs/esefResults.js';
import type { EsefFiling } from '../../src/europe/sources/esef.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';

const esefDir = new URL('../fixtures/europe/esef/', import.meta.url);
const corpus = (name: string): unknown => JSON.parse(gunzipSync(readFileSync(new URL(name, esefDir))).toString('utf8'));
// Hays plc FY to 2026-06-30 (Task 12 corpus): revenue GBP 6,421.2m, basic and diluted EPS -0.0364 GBP.
const HAYS = corpus('hays_gb.json.gz');
// Coloplast 9M interim to 2026-06-30: no 12-month fact at all.
const COLOPLAST_9M = corpus('coloplast_dk_9m.json.gz');
const NOW = '2026-10-28T09:00:00.000Z';

const entry = (symbol: string, lei: string): EuropeUniverseEntry => ({
  market: 'UK', symbol, isin: `GB00000000${symbol.length}${symbol.charCodeAt(0) % 10}`, lei, name: `${symbol} plc`, exchange: 'LSE', mic: 'XLON',
  country: 'GB', currency: 'GBp', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
});

const filing = (n: number, lei: string, json: string, periodEnd = '2026-06-30'): EsefFiling => ({
  fxoId: `${lei}-${periodEnd}-ESEF-GB-${n}`, lei, country: 'GB', periodEnd, dateAdded: `2026-10-15 10:27:2${n}.387506`,
  jsonUrl: `https://filings.xbrl.org/${lei}/${json}.json`, reportUrl: `https://filings.xbrl.org/${lei}/reports/${json}.xhtml`,
});

function setup(filings: EsefFiling[], facts: (url: string) => unknown) {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [entry('HAS.L', 'LEIHAYS0000000000001'), entry('SECA.L', 'LEISECA0000000000002'), entry('COLO.L', 'LEICOLO0000000000003')], NOW);
  const fyRow = (symbol: string) => upsertEuropeCalendarRow(db, 'UK', {
    symbol, name: symbol, exchange: 'LSE', period: { periodEnd: '2026-06-30', fiscalQuarter: 4, fyEnd: '2026-06-30' }, periodLabel: 'FY26',
    periodConfirmed: false, reportDate: '2026-08-20', dateStatus: 'confirmed',
  }, NOW);
  const asked: { countries: readonly string[]; since: string }[] = [];
  const fetched: string[] = [];
  const ctx = {
    db, market: 'UK', now: () => NOW,
    esef: {
      recent: async (countries: readonly string[], since: string) => { asked.push({ countries, since }); return filings; },
      facts: async (url: string) => { fetched.push(url); return facts(url); },
    },
  } as unknown as EuropeJobContext;
  const seen = (fxoId: string) => db.prepare('SELECT * FROM europe_esef_seen WHERE fxo_id = ?').get(fxoId) as Record<string, unknown> | undefined;
  return { db, ctx, fyRow, asked, fetched, seen };
}

describe('refreshEsefResults', () => {
  it('FY row merged ytd 12 with source esef and url', async () => {
    const f = filing(1, 'LEIHAYS0000000000001', 'hays');
    const { db, ctx, fyRow, asked, seen } = setup([f], () => HAYS);
    const id = fyRow('HAS.L');
    expect(await refreshEsefResults(ctx, '2026-10-01 00:00:00')).toEqual([id]);
    expect(asked).toEqual([{ countries: ['GB'], since: '2026-10-01 00:00:00' }]);
    expect(getEuropeReport(db, id)).toMatchObject({
      revenueActual: 6421200000, revenueCurrency: 'GBP', revenueSource: 'esef', revenueSpan: 'ytd', revenueYtdMonths: 12,
      epsActual: -0.0364, epsDilutedActual: -0.0364, epsCurrency: 'GBP', epsSource: 'esef', epsSpan: 'ytd', epsYtdMonths: 12,
      esefUrl: 'https://filings.xbrl.org/LEIHAYS0000000000001/reports/hays.xhtml', periodConfirmed: true,
    });
    expect(seen(f.fxoId)).toMatchObject({ symbol: 'HAS.L', period_end: '2026-06-30', outcome: 'merged', date_added: f.dateAdded });
    expect(lastEsefDateAdded(db, 'UK')).toBe(f.dateAdded);
    // Seen: never fetched again.
    expect(await refreshEsefResults(ctx, '2026-10-01 00:00:00')).toEqual([]);
  });

  it('never replaces SEC; replaces Yahoo', async () => {
    const sec = filing(1, 'LEISECA0000000000002', 'seca');
    const yah = filing(2, 'LEIHAYS0000000000001', 'hays');
    const { db, ctx, fyRow, seen } = setup([sec, yah], () => HAYS);
    const secId = fyRow('SECA.L');
    const yId = fyRow('HAS.L');
    const q = (source: 'sec' | 'yahoo', v: number) => mergeEuropeActuals(db, source === 'sec' ? secId : yId, {
      revenue: { value: v, currency: 'GBP', span: 'ytd', ytdMonths: 12 },
      eps: { basic: 0.01, diluted: null, currency: 'GBP', span: 'ytd', ytdMonths: 12 }, source,
    }, NOW);
    q('sec', 1);
    q('yahoo', 2);
    expect((await refreshEsefResults(ctx, '2026-10-01 00:00:00')).sort()).toEqual([secId, yId].sort());
    // The SEC row keeps every figure; only the ESEF report link is added (it had none).
    expect(getEuropeReport(db, secId)).toMatchObject({
      revenueActual: 1, revenueSource: 'sec', epsActual: 0.01, epsSource: 'sec', esefUrl: sec.reportUrl,
    });
    expect(getEuropeReport(db, yId)).toMatchObject({ revenueActual: 6421200000, revenueSource: 'esef', epsActual: -0.0364, epsSource: 'esef' });
    expect(seen(sec.fxoId)!.outcome).toBe('superseded');
    expect(seen(yah.fxoId)!.outcome).toBe('merged');
  });

  it('no row → no-row, nothing created', async () => {
    const f = filing(1, 'LEIHAYS0000000000001', 'hays');
    const other = { ...filing(2, 'LEIUNKNOWN0000000009', 'x') };
    const { db, ctx, seen, fetched } = setup([f, other], () => HAYS);
    expect(await refreshEsefResults(ctx, '2026-10-01 00:00:00')).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM europe_reports').get() as { n: number }).n).toBe(0);
    expect(seen(f.fxoId)!.outcome).toBe('no-row');
    // An LEI that is no stock of the market is not fetched.
    expect(fetched).toEqual([f.jsonUrl]);
    expect(seen(other.fxoId)).toBeUndefined();
  });

  it('a row of another quarter with that period end is not merged (12-month figures)', async () => {
    const f = filing(1, 'LEIHAYS0000000000001', 'hays');
    const { db, ctx, seen } = setup([f], () => HAYS);
    const id = upsertEuropeCalendarRow(db, 'UK', {
      symbol: 'HAS.L', name: 'HAS.L', exchange: 'LSE', period: { periodEnd: '2026-06-30', fiscalQuarter: 2, fyEnd: '2026-12-31' },
      periodLabel: 'H1 FY26', periodConfirmed: false, reportDate: '2026-08-20', dateStatus: 'confirmed',
    }, NOW);
    expect(await refreshEsefResults(ctx, '2026-10-01 00:00:00')).toEqual([]);
    expect(getEuropeReport(db, id)!.revenueActual).toBeNull();
    expect(seen(f.fxoId)!.outcome).toBe('no-row');
  });

  it('fyEndMonth from ESEF', async () => {
    const hays = filing(1, 'LEIHAYS0000000000001', 'hays');
    const colo = filing(2, 'LEICOLO0000000000003', 'colo');
    const { db, ctx, seen } = setup([hays, colo], (url) => (url.endsWith('colo.json') ? COLOPLAST_9M : HAYS));
    setEuropeProfile(db, 'HAS.L', { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null,
      fyEndMonth: { month: 12, source: 'yahoo' } }, NOW);
    setEuropeProfile(db, 'COLO.L', { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null,
      fyEndMonth: { month: 9, source: 'yahoo' } }, NOW);
    await refreshEsefResults(ctx, '2026-10-01 00:00:00');
    const stocks = new Map(europeStocks(db, 'UK').map((s) => [s.symbol, s]));
    expect(stocks.get('HAS.L')).toMatchObject({ fyEndMonth: 6, fyEndSource: 'esef' });
    // A 9-month interim filing (no 12-month fact) never states the fiscal year end.
    expect(stocks.get('COLO.L')).toMatchObject({ fyEndMonth: 9, fyEndSource: 'yahoo' });
    expect(seen(colo.fxoId)!.outcome).toBe('blank');
  });

  it('an older period never overrides the fiscal year end of a later one', async () => {
    const later = filing(1, 'LEIHAYS0000000000001', 'hays');
    const older = { ...filing(2, 'LEIHAYS0000000000001', 'old', '2025-12-31'), fxoId: 'LEIHAYS-old' };
    const shifted = { facts: Object.fromEntries(Object.entries((HAYS as { facts: Record<string, any> }).facts).map(([k, f]) => [k, {
      ...f, dimensions: { ...f.dimensions, period: typeof f.dimensions?.period === 'string'
        ? f.dimensions.period.replace(/2025-07-01/g, '2025-01-01').replace(/2026-07-01/g, '2026-01-01') : f.dimensions?.period },
    }])) };
    const { db, ctx } = setup([later, older], (url) => (url.endsWith('old.json') ? shifted : HAYS));
    await refreshEsefResults(ctx, '2026-10-01 00:00:00');
    expect(europeStocks(db, 'UK').find((s) => s.symbol === 'HAS.L')).toMatchObject({ fyEndMonth: 6, fyEndSource: 'esef' });
  });

  it('fetch error not marked seen', async () => {
    const f = filing(1, 'LEIHAYS0000000000001', 'hays');
    let fail = true;
    const { db, ctx, fyRow, seen } = setup([f], () => { if (fail) throw new Error('filings.xbrl.org 502'); return HAYS; });
    const id = fyRow('HAS.L');
    expect(await refreshEsefResults(ctx, '2026-10-01 00:00:00')).toEqual([]);
    expect(seen(f.fxoId)).toBeUndefined();
    fail = false;
    expect(await refreshEsefResults(ctx, '2026-10-01 00:00:00')).toEqual([id]);
    expect(getEuropeReport(db, id)!.revenueSource).toBe('esef');
  });

  it('countries: GB for UK; the EEA countries of the EU exchanges (no CH)', () => {
    expect(esefCountries('UK')).toEqual(['GB']);
    expect(esefCountries('EU')).toEqual(['BE', 'DE', 'DK', 'ES', 'FI', 'FR', 'IE', 'IT', 'NL', 'NO', 'PT', 'SE']);
  });

  it('since: the last date_added handled less a margin, or 30 days back on a first run', async () => {
    const f = filing(1, 'LEIHAYS0000000000001', 'hays');
    const { ctx, fyRow } = setup([f], () => HAYS);
    expect(esefSinceFor(ctx)).toBe('2026-09-28 09:00:00');
    fyRow('HAS.L');
    await refreshEsefResults(ctx, esefSinceFor(ctx));
    expect(esefSinceFor(ctx)).toBe('2026-10-13 10:27:21');
  });
});
