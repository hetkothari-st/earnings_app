import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import {
  EU_ID_BASE, UK_ID_BASE, confirmEuropePeriod, lastEsefAt, lastEsefDateAdded, markEsefSeen, setEuropePrevMove, europeStocks, figiCached, getEuropeReport, mergeEuropeActuals, recordEuropeRelease,
  saveBankHolidays, saveFigi, setEuropeEstimates, setEuropeProfile, setEuropeTiming, storedBankHolidays, syncEuropeUniverse,
  upsertEuropeCalendarRow,
} from '../../src/europe/db/europeRepo.js';
import { buildEuropeUniverseFor } from '../../src/europe/jobs/context.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import type { FirdsShare } from '../../src/europe/sources/firds.js';
import type { FigiAnswer } from '../../src/europe/sources/openFigi.js';

const NOW = '2026-10-28T09:00:00.000Z';

const entry = (symbol: string, isin: string, extra: Partial<EuropeUniverseEntry> = {}): EuropeUniverseEntry => ({
  market: symbol.endsWith('.L') ? 'UK' : 'EU', symbol, isin, lei: null, name: `${symbol} plc`,
  exchange: symbol.endsWith('.L') ? 'LSE' : symbol.endsWith('.DE') ? 'XET' : 'PAR', mic: symbol.endsWith('.L') ? 'XLON' : 'XPAR',
  country: isin.slice(0, 2), currency: symbol.endsWith('.L') ? 'GBp' : 'EUR',
  adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null, ...extra,
});

const Q = { periodEnd: '2026-09-30', fiscalQuarter: 3 as const, fyEnd: '2026-12-31' };

function setup() {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [entry('AZN.L', 'GB0009895292'), entry('TSCO.L', 'GB00BLGZ9862')], NOW);
  syncEuropeUniverse(db, 'EU', [entry('SAP.DE', 'DE0007164600'), entry('TTE.PA', 'FR0000120271')], NOW);
  const row = (symbol: string, extra: Partial<Parameters<typeof upsertEuropeCalendarRow>[2]> = {}) =>
    upsertEuropeCalendarRow(db, symbol.endsWith('.L') ? 'UK' : 'EU', {
      symbol, name: symbol, exchange: symbol.endsWith('.L') ? 'LSE' : 'PAR', period: Q, periodLabel: 'Q3 FY26', periodConfirmed: false,
      reportDate: '2026-11-05', dateStatus: 'estimated', ...extra,
    }, NOW);
  return { db, row };
}

describe('europeRepo', () => {
  it('UK ids from 4_000_000_001, EU from 5_000_000_001, independent', () => {
    const { db, row } = setup();
    expect(UK_ID_BASE).toBe(4_000_000_001);
    expect(EU_ID_BASE).toBe(5_000_000_001);
    expect(row('AZN.L')).toBe(4_000_000_001);
    expect(row('SAP.DE')).toBe(5_000_000_001);
    expect(row('TSCO.L')).toBe(4_000_000_002);
    expect(row('TTE.PA')).toBe(5_000_000_002);
    expect(row('AZN.L')).toBe(4_000_000_001); // same period: same row
    expect(getEuropeReport(db, 5_000_000_001)).toMatchObject({ market: 'EU', symbol: 'SAP.DE' });
  });

  it('precedence sec > esef > yahoo; equal first wins; null never blanks', () => {
    const { db, row } = setup();
    const id = row('AZN.L');
    const rev = (value: number) => ({ value, currency: 'USD', span: 'quarter' as const, ytdMonths: null });
    const eps = (basic: number | null) => ({ basic, diluted: null, currency: 'USD', span: 'quarter' as const, ytdMonths: null });
    expect(mergeEuropeActuals(db, id, { revenue: rev(100), eps: eps(1), source: 'yahoo' }, NOW)).toBe(true);
    expect(mergeEuropeActuals(db, id, { revenue: rev(101), eps: eps(1.1), source: 'yahoo' }, NOW)).toBe(false); // equal: first wins
    expect(mergeEuropeActuals(db, id, { revenue: rev(102), eps: eps(1.2), source: 'esef', esefUrl: 'https://filings.xbrl.org/r' }, NOW)).toBe(true);
    expect(getEuropeReport(db, id)).toMatchObject({ revenueActual: 102, revenueSource: 'esef', epsActual: 1.2, esefUrl: 'https://filings.xbrl.org/r' });
    expect(mergeEuropeActuals(db, id, { revenue: rev(103), eps: eps(1.3), source: 'sec', docUrl: 'https://www.sec.gov/x' }, NOW)).toBe(true);
    expect(mergeEuropeActuals(db, id, { revenue: rev(104), eps: eps(1.4), source: 'esef' }, NOW)).toBe(false); // lower never replaces
    expect(mergeEuropeActuals(db, id, { revenue: null, eps: eps(null), source: 'sec' }, NOW)).toBe(false); // null never blanks
    expect(getEuropeReport(db, id)).toMatchObject({
      revenueActual: 103, revenueSource: 'sec', epsActual: 1.3, epsSource: 'sec', secDocUrl: 'https://www.sec.gov/x',
      esefUrl: 'https://filings.xbrl.org/r',
    });
  });

  it('GBp EPS and GBP revenue kept apart', () => {
    const { db, row } = setup();
    const id = row('TSCO.L');
    mergeEuropeActuals(db, id, {
      revenue: { value: 31_500_000_000, currency: 'GBP', span: 'ytd', ytdMonths: 6 },
      eps: { basic: 12.3, diluted: 12.1, currency: 'GBp', span: 'ytd', ytdMonths: 6 }, source: 'yahoo',
    }, NOW);
    setEuropeEstimates(db, id, { eps: 0.118, epsAnalysts: 9, epsCurrency: 'GBP', revenue: 31e9, revenueAnalysts: 8, revenueCurrency: 'GBP', span: 'quarter' }, NOW);
    expect(getEuropeReport(db, id)).toMatchObject({
      epsActual: 12.3, epsDilutedActual: 12.1, epsCurrency: 'GBp', revenueActual: 31_500_000_000, revenueCurrency: 'GBP',
      epsEstimate: 0.118, epsEstimateCurrency: 'GBP', revenueEstimate: 31e9, revenueEstimateCurrency: 'GBP',
    });
    // An estimate side without a currency is skipped; it never takes the other side's.
    setEuropeEstimates(db, id, { eps: 0.2, epsAnalysts: 3, epsCurrency: null, revenue: 32e9, revenueAnalysts: 8, revenueCurrency: 'GBP', span: 'quarter' }, NOW);
    expect(getEuropeReport(db, id)).toMatchObject({ epsEstimate: 0.118, epsEstimateCurrency: 'GBP', revenueEstimate: 32e9 });
  });

  it('earliest release signal wins; later sec does not move releasedAt', () => {
    const { db, row } = setup();
    const id = row('AZN.L');
    expect(recordEuropeRelease(db, id, { at: '2026-11-05T07:20:00.000Z', source: 'dila', timing: null, title: 'Rapport', url: 'https://d/1' })).toBe(true);
    expect(recordEuropeRelease(db, id, { at: '2026-11-05T07:02:00.000Z', source: 'prn', timing: 'BMO', title: 'AstraZeneca Q3 results', url: 'https://www.prnewswire.co.uk/x' })).toBe(true);
    expect(recordEuropeRelease(db, id, { at: '2026-11-05T11:00:00.000Z', source: 'sec', timing: null, url: 'https://www.sec.gov/y' })).toBe(false);
    expect(getEuropeReport(db, id)).toMatchObject({
      releasedAt: '2026-11-05T07:02:00.000Z', releasedSource: 'prn', signalTitle: 'AstraZeneca Q3 results',
      signalUrl: 'https://www.prnewswire.co.uk/x', timing: 'BMO', timingSource: 'prn',
    });
    // Released: a Yahoo TAS timing never overwrites the PRN-stamped one.
    expect(setEuropeTiming(db, id, 'AMC', 'yahoo')).toBe(false);
  });

  it('inactive after two consecutive misses, not one; empty build refused', () => {
    const { db } = setup();
    syncEuropeUniverse(db, 'UK', [entry('AZN.L', 'GB0009895292')], NOW);
    const tsco = () => europeStocks(db, 'UK').find((s) => s.symbol === 'TSCO.L')!;
    expect(tsco()).toMatchObject({ active: true, missedRefreshes: 1 });
    const r = syncEuropeUniverse(db, 'UK', [entry('AZN.L', 'GB0009895292')], NOW);
    expect(r.deactivated).toBe(1);
    expect(tsco()).toMatchObject({ active: false, missedRefreshes: 2 });
    // Back in the universe: active again, misses reset.
    syncEuropeUniverse(db, 'UK', [entry('AZN.L', 'GB0009895292'), entry('TSCO.L', 'GB00BLGZ9862')], NOW);
    expect(tsco()).toMatchObject({ active: true, missedRefreshes: 0 });
    expect(() => syncEuropeUniverse(db, 'UK', [], NOW)).toThrow();
    expect(tsco().active).toBe(true);
    // The EU market is untouched by UK syncs.
    expect(europeStocks(db, 'EU').every((s) => s.active && s.missedRefreshes === 0)).toBe(true);
  });

  it('esef fiscal year end beats yahoo', () => {
    const { db } = setup();
    const p = { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null };
    const fy = () => europeStocks(db, 'UK').find((s) => s.symbol === 'AZN.L')!;
    setEuropeProfile(db, 'AZN.L', { ...p, fyEndMonth: { month: 3, source: 'yahoo' } }, NOW);
    expect(fy()).toMatchObject({ fyEndMonth: 3, fyEndSource: 'yahoo' });
    setEuropeProfile(db, 'AZN.L', { ...p, fyEndMonth: { month: 12, source: 'esef' } }, NOW);
    setEuropeProfile(db, 'AZN.L', { ...p, fyEndMonth: { month: 6, source: 'yahoo' } }, NOW);
    expect(fy()).toMatchObject({ fyEndMonth: 12, fyEndSource: 'esef' });
    // A profile without a cap never blanks the stored one.
    setEuropeProfile(db, 'AZN.L', { ...p, marketCap: 2e11, marketCapCurrency: 'GBP', asOf: '2026-10-28' }, NOW);
    setEuropeProfile(db, 'AZN.L', p, NOW);
    expect(fy()).toMatchObject({ marketCap: 2e11, marketCapCurrency: 'GBP', fyEndMonth: 12 });
  });

  it('market cap date moves with the cap: a new cap without a date never keeps the old date', () => {
    const { db } = setup();
    const p = { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null };
    const s = () => europeStocks(db, 'UK').find((x) => x.symbol === 'AZN.L')!;
    setEuropeProfile(db, 'AZN.L', { ...p, marketCap: 2e11, marketCapCurrency: 'GBP', asOf: '2026-10-28' }, NOW);
    // A date without a cap changes nothing.
    setEuropeProfile(db, 'AZN.L', { ...p, asOf: '2026-10-29' }, NOW);
    expect(s()).toMatchObject({ marketCap: 2e11, marketCapAsOf: '2026-10-28' });
    setEuropeProfile(db, 'AZN.L', { ...p, marketCap: 2.1e11, marketCapCurrency: 'GBP', asOf: null }, NOW);
    expect(s()).toMatchObject({ marketCap: 2.1e11, marketCapCurrency: 'GBP', marketCapAsOf: null });
    setEuropeProfile(db, 'AZN.L', { ...p, marketCap: 2.2e11, marketCapCurrency: 'GBP', asOf: '2026-10-30' }, NOW);
    expect(s()).toMatchObject({ marketCap: 2.2e11, marketCapAsOf: '2026-10-30' });
  });

  it('an unparseable stored released_at is kept', () => {
    const { db, row } = setup();
    const id = row('AZN.L');
    db.prepare("UPDATE europe_reports SET released_at = 'garbage', released_source = 'sec' WHERE id = ?").run(id);
    expect(recordEuropeRelease(db, id, { at: '2026-11-05T07:02:00.000Z', source: 'prn', timing: 'BMO', title: 't', url: 'https://u' })).toBe(false);
    expect(getEuropeReport(db, id)).toMatchObject({ releasedAt: 'garbage', releasedSource: 'sec', timing: 'UNKNOWN' });
    expect(recordEuropeRelease(db, row('TSCO.L'), { at: 'not a time', source: 'prn', timing: null })).toBe(false);
  });

  it('previous move: a found move is stored, a miss keeps it and only records the check', () => {
    const { db, row } = setup();
    const id = row('AZN.L');
    setEuropePrevMove(db, id, { pct: -3.2, date: '2026-07-29', basis: 'known' }, NOW);
    setEuropePrevMove(db, id, null, '2026-10-29T09:00:00.000Z');
    expect(getEuropeReport(db, id)).toMatchObject({
      prevMovePct: -3.2, prevMoveDate: '2026-07-29', prevMoveBasis: 'known', prevMoveCheckedAt: '2026-10-29T09:00:00.000Z',
    });
  });

  it('estimates: a null never blanks; a currency change replaces value, analysts and currency together; a span change rewrites all', () => {
    const { db, row } = setup();
    const id = row('AZN.L');
    const e = { eps: 2.1, epsAnalysts: 10, epsCurrency: 'USD', revenue: 14e9, revenueAnalysts: 9, revenueCurrency: 'USD', span: 'quarter' as const };
    setEuropeEstimates(db, id, e, NOW);
    setEuropeEstimates(db, id, { ...e, eps: null, epsAnalysts: null, revenue: null }, NOW);
    expect(getEuropeReport(db, id)).toMatchObject({ epsEstimate: 2.1, epsAnalysts: 10, epsEstimateCurrency: 'USD', revenueEstimate: 14e9, revenueAnalysts: 9 });
    setEuropeEstimates(db, id, { ...e, eps: 160, epsAnalysts: null, epsCurrency: 'GBp', revenue: null, revenueAnalysts: null }, NOW);
    expect(getEuropeReport(db, id)).toMatchObject({
      epsEstimate: 160, epsAnalysts: null, epsEstimateCurrency: 'GBp', revenueEstimate: 14e9, revenueEstimateCurrency: 'USD',
    });
    setEuropeEstimates(db, id, { ...e, revenue: null, revenueAnalysts: null, revenueCurrency: 'GBP' }, NOW);
    expect(getEuropeReport(db, id)).toMatchObject({ revenueEstimate: null, revenueAnalysts: null, revenueEstimateCurrency: 'GBP' });
    setEuropeEstimates(db, id, { eps: 8, epsAnalysts: 11, epsCurrency: 'USD', revenue: null, revenueAnalysts: null, revenueCurrency: 'USD', span: 'year' }, NOW);
    expect(getEuropeReport(db, id)).toMatchObject({
      estimateSpan: 'year', epsEstimate: 8, epsEstimateCurrency: 'USD', revenueEstimate: null, revenueEstimateCurrency: 'USD',
    });
  });

  it('ESEF seen keeps the filing date_added; lastEsefDateAdded reads it per market', () => {
    const { db } = setup();
    markEsefSeen(db, 'fxo-1', 'AZN.L', '2025-12-31', 'merged', NOW, '2026-03-01 10:00:00.000000');
    markEsefSeen(db, 'fxo-2', 'TTE.PA', '2025-12-31', 'merged', NOW, '2026-04-02 11:00:00.000000');
    markEsefSeen(db, 'fxo-3', null, null, 'no-row', NOW); // no date_added: the old signature still works
    expect(lastEsefDateAdded(db)).toBe('2026-04-02 11:00:00.000000');
    expect(lastEsefDateAdded(db, 'UK')).toBe('2026-03-01 10:00:00.000000');
    expect(lastEsefDateAdded(db, 'EU')).toBe('2026-04-02 11:00:00.000000');
    expect(lastEsefAt(db, 'UK')).toBe(NOW);
  });

  it('merge confirms the period', () => {
    const { db, row } = setup();
    const id = row('AZN.L');
    expect(getEuropeReport(db, id)!.periodConfirmed).toBe(false);
    mergeEuropeActuals(db, id, { revenue: { value: 1, currency: 'USD', span: 'quarter', ytdMonths: null }, source: 'yahoo' }, NOW);
    expect(getEuropeReport(db, id)!.periodConfirmed).toBe(true);
    const id2 = row('TSCO.L');
    confirmEuropePeriod(db, id2);
    expect(getEuropeReport(db, id2)!.periodConfirmed).toBe(true);
    // A later unconfirmed calendar pass never un-confirms.
    row('TSCO.L');
    expect(getEuropeReport(db, id2)!.periodConfirmed).toBe(true);
  });

  it('bank holidays replace the stored set; an empty list is refused', () => {
    const { db } = setup();
    saveBankHolidays(db, [{ date: '2026-12-25', title: 'Christmas Day' }, { date: '2026-12-28', title: 'Boxing Day' }], NOW);
    expect(() => saveBankHolidays(db, [], NOW)).toThrow();
    expect([...storedBankHolidays(db)]).toEqual(['2026-12-25', '2026-12-28']);
  });

  it('migration is additive: opening an existing JP database adds tables and changes no jp_ row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eu-mig-'));
    const path = join(dir, 'x.db');
    try {
      const old = openDb(path);
      old.exec('DROP TABLE IF EXISTS europe_reports; DROP TABLE IF EXISTS europe_stocks;');
      for (const t of (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'europe_%'").all() as { name: string }[])) {
        old.exec(`DROP TABLE ${t.name}`);
      }
      old.exec('CREATE TABLE europe_esef_seen (fxo_id TEXT PRIMARY KEY, symbol TEXT, period_end TEXT, outcome TEXT NOT NULL, seen_at TEXT NOT NULL)');
      old.exec(`INSERT INTO europe_esef_seen VALUES ('fxo-old', NULL, NULL, 'no-row', '${NOW}')`);
      old.exec(`INSERT INTO reports (symbol, symbol_key, name, fiscal_quarter, report_date) VALUES ('AAPL', 'AAPL', 'Apple', 'Q4 2026', '2026-10-30')`);
      old.exec(`INSERT INTO hk_stocks (code, name, yahoo_symbol, level, cadence, fy_end_month, updated_at)
        VALUES ('0005', 'HSBC', '0005.HK', 'full', 'Q', 12, '${NOW}')`);
      old.exec(`INSERT INTO jp_stocks (code, name, yahoo_symbol, level, updated_at) VALUES ('7203', 'TOYOTA', '7203.T', 'full', '${NOW}')`);
      old.exec(`INSERT INTO jp_reports (id, code, name, period_end, fiscal_quarter, fy_end, period_label, report_date)
        VALUES (3000000001, '7203', 'TOYOTA', '2026-09-30', 2, '2027-03-31', '2Q FY27', '2026-11-05')`);
      const dump = (d: DatabaseSync) => JSON.stringify(['jp_stocks', 'jp_reports', 'reports', 'hk_stocks'].map((t) => d.prepare(`SELECT * FROM ${t}`).all()));
      const before = dump(old);
      old.close();
      const db = openDb(path);
      expect(dump(db)).toBe(before);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'europe_%' ORDER BY name").all() as { name: string }[])
        .map((t) => t.name);
      expect(tables).toEqual([
        'europe_bank_holidays', 'europe_date_sweep', 'europe_esef_seen', 'europe_expected_moves', 'europe_figi', 'europe_live_moves',
        'europe_past_dates', 'europe_reports', 'europe_sec_seen', 'europe_signal_seen', 'europe_stocks', 'europe_universe_runs',
      ]);
      // The US and HK rows survived too (dump compared above), and the old europe_esef_seen gained date_added.
      expect((JSON.parse(dump(db)) as unknown[][]).map((t) => t.length)).toEqual([1, 1, 1, 1]);
      expect(db.prepare('SELECT fxo_id, date_added FROM europe_esef_seen').all()).toEqual([{ fxo_id: 'fxo-old', date_added: null }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildEuropeUniverseFor', () => {
  const share = (isin: string, mic: string, fullName: string, issuerRequested = true): FirdsShare =>
    ({ isin, fullName, cfi: 'ESVUFR', lei: null, mic, issuerRequested, terminated: false });
  const sources = (
    figi: (jobs: { isin: string; exchCode: string }[]) => Promise<FigiAnswer[]>,
    o: { firdsComplete?: boolean; sixThrows?: boolean; fca?: FirdsShare[]; esma?: FirdsShare[] } = {},
  ) => ({
    firds: async (source: 'esma' | 'fca', _mics: ReadonlySet<string>, onShare: (s: FirdsShare) => void) => {
      if (source === 'fca') [share('GB00BLGZ9862', 'XLON', 'TESCO PLC ORD 6 1/3P'), ...o.fca ?? []].forEach(onShare);
      else [share('FR0000120271', 'XPAR', 'TOTALENERGIES SE'), ...o.esma ?? []].forEach(onShare);
      return { files: 1, complete: source === 'fca' ? o.firdsComplete ?? true : true };
    },
    sixList: async () => {
      if (o.sixThrows) throw new Error('six down');
      return 'ShortName;ValorSymbol;ValorNumber;ISIN;TradingBaseCurrency;ListingSegmentDesc;GeographicalAreaDesc;SecTypeDesc\n'
        + 'NOVARTIS N;NOVN;1200526;CH0012005267;CHF;International Reporting Standard;Switzerland;Registered Shares\n';
    },
    figi,
    search: async () => [],
    names: async () => new Map<string, string>(),
  });
  const answer = (jobs: { isin: string; exchCode: string }[]): FigiAnswer[] =>
    jobs.map((j) => ({ ...j, tickers: j.isin === 'GB00BLGZ9862' ? ['TSCO'] : ['TTE'] }));

  it('a failed OpenFIGI job makes the build incomplete and is never cached as "no ticker"', async () => {
    const db = openDb(':memory:');
    const failing = async (jobs: { isin: string; exchCode: string }[]): Promise<FigiAnswer[]> =>
      jobs.map((j) => (j.isin === 'GB00BLGZ9862' ? { ...j, tickers: [], failed: true as const } : { ...j, tickers: ['TTE'] }));
    const r = await buildEuropeUniverseFor(db, 'UK', sources(failing), NOW);
    expect(r.complete).toBe(false);
    expect(figiCached(db, 'GB00BLGZ9862', 'LN')).toBeNull();
    expect(figiCached(db, 'FR0000120271', 'FP')).toMatchObject({ tickers: ['TTE'] });
    // syncEuropeUniverse must not run on it: the caller checks `complete`.
  });

  it('incomplete FIRDS or a SIX failure → complete=false; a clean run is complete and uses the cache', async () => {
    const db = openDb(':memory:');
    expect((await buildEuropeUniverseFor(db, 'UK', sources(async (j) => answer(j), { firdsComplete: false }), NOW)).complete).toBe(false);
    expect((await buildEuropeUniverseFor(db, 'UK', sources(async (j) => answer(j), { sixThrows: true }), NOW)).complete).toBe(false);
    const ok = await buildEuropeUniverseFor(db, 'UK', sources(async (j) => answer(j)), NOW);
    expect(ok.complete).toBe(true);
    expect(ok.entries.map((e) => e.symbol)).toContain('TSCO.L');
    expect(ok.entries.some((e) => e.symbol === 'AZN.L')).toBe(true); // full-level rows always exist
    expect(ok.entries.every((e) => e.market === 'UK')).toBe(true);
    let asked = 0;
    await buildEuropeUniverseFor(db, 'UK', sources(async (j) => { asked += j.length; return answer(j); }), NOW);
    expect(asked).toBe(0);
    saveFigi(db, { isin: 'X', exchCode: 'LN', tickers: [], outcome: 'no-ticker' }, NOW);
    expect(figiCached(db, 'X', 'LN')).toMatchObject({ tickers: [], outcome: 'no-ticker' });
  });

  it('leftOut per market: an ISIN with live lines on both sides counts for UK only (UK first); a dead UK line does not pull an EU ISIN to UK', async () => {
    const db = openDb(':memory:');
    const o = {
      // US ISIN, issuer-requested on XLON, AIMX and XPAR: two UK lines, no home line -> ambiguous; counted for UK only.
      fca: [share('US0000000001', 'XLON', 'DUAL A'), share('US0000000001', 'AIMX', 'DUAL A'),
        // EU-ambiguous ISIN that also has a non-issuer-requested UK line: counted for EU.
        share('US0000000002', 'XLON', 'DUAL B', false)],
      esma: [share('US0000000001', 'XPAR', 'DUAL A'), share('US0000000002', 'XPAR', 'DUAL B'), share('US0000000002', 'XETA', 'DUAL B')],
    };
    const uk = await buildEuropeUniverseFor(db, 'UK', sources(async (j) => answer(j), o), NOW);
    const eu = await buildEuropeUniverseFor(db, 'EU', sources(async (j) => answer(j), o), NOW);
    expect(uk.leftOut).toBe(1);
    expect(eu.leftOut).toBe(1);
  });
});
