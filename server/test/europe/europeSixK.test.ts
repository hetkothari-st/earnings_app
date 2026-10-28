import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { openDb } from '../../src/db/repo.js';
import {
  europeSecSeen, getEuropeReport, setEuropeProfile, syncEuropeUniverse, upsertEuropeCalendarRow,
} from '../../src/europe/db/europeRepo.js';
import { europePeriodFor, europePeriodLabel } from '../../src/europe/domain/period.js';
import { EXCHANGES } from '../../src/europe/exchanges.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { europeSixKMarket, handleEuropeFiling } from '../../src/europe/live/europeSixK.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import { getHkReport, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import type { HkJobContext } from '../../src/hk/jobs/context.js';
import { hkSixKMarket } from '../../src/hk/live/hkSecWatch.js';
import { HK_UNIVERSE } from '../../src/hk/universe.js';
import { HttpError, type Http } from '../../src/sources/http.js';
import { SixKWatch } from '../../src/sources/sixKWatch.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

const FEED_6K = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=6-K&company=&dateb=&owner=include&start=0&count=100&output=atom';
const NOW = '2026-10-28T09:00:00.000Z';

/** An EDGAR filing index in the shape `parseFilingDocs` reads (seq, description, document, type). */
const index = (rows: [string, string][]) => `<html><body><table class="tableFile">
<tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
${rows.map(([href, type], i) => `<tr><td>${i + 1}</td><td>${type}</td><td><a href="${href}">${href.split('/').at(-1)}</a></td><td>${type}</td><td>1</td></tr>`).join('\n')}
</table></body></html>`;

// AstraZeneca Q1 2026 results 6-K (Task 4 fixture), accepted 2026-04-29 07:00 ET (12:00 London).
const AZN_CIK = 901832;
const AZN_ACC = '0001654954-26-004047';
const AZN_DIR = 'https://www.sec.gov/Archives/edgar/data/901832/000165495426004047';
const AZN_INDEX = `${AZN_DIR}/${AZN_ACC}-index.htm`;
const AZN_DOC = `${AZN_DIR}/azn_q1_2026.htm`;
const AZN_FILING = { cik: AZN_CIK, accession: AZN_ACC, indexUrl: AZN_INDEX, acceptedAt: '2026-04-29T11:00:00.000Z', form: '6-K' };

// A date notice (synthetic text in the shape of an RNS notice), accepted 2026-10-20.
const NOTICE_ACC = '0001654954-26-009999';
const NOTICE_DIR = 'https://www.sec.gov/Archives/edgar/data/901832/000165495426009999';
const NOTICE_INDEX = `${NOTICE_DIR}/${NOTICE_ACC}-index.htm`;
const NOTICE_DOC = `${NOTICE_DIR}/notice.htm`;
const NOTICE_HTML = `<html><body><p>AstraZeneca PLC</p><p>AstraZeneca will announce its results for the nine months and third quarter of 2026
on Thursday, 6 November 2026 at 07:00 GMT.</p></body></html>`;

// HSBC 2026 interim results (HK Task 6 fixtures), accepted 2026-08-04 04:30 ET.
const HSBC_CIK = 1089113;
const HSBC_ACC = '0001654954-26-007212';
const HSBC_DIR = 'https://www.sec.gov/Archives/edgar/data/1089113/000165495426007212';
const HSBC_INDEX = `${HSBC_DIR}/${HSBC_ACC}-index.htm`;

const DOCS: Record<string, string> = {
  [AZN_INDEX]: index([[AZN_DOC, '6-K']]),
  [AZN_DOC]: fx('europe/sec/azn_q1_2026_results_6k.htm'),
  [NOTICE_INDEX]: index([[NOTICE_DOC, '6-K']]),
  [NOTICE_DOC]: NOTICE_HTML,
  [HSBC_INDEX]: fx('hk/sec_index_hsbc_interim.htm'),
  [`${HSBC_DIR}/a1266p.htm`]: fx('hk/hsbc_interim_6k.htm'),
};

function stubHttp(docs: Record<string, string>) {
  const requested: string[] = [];
  const http: Http = {
    async text(url) {
      requested.push(url);
      const body = docs[url];
      if (body === undefined) throw new HttpError(404, url);
      return body;
    },
    async json(url) { return JSON.parse(await http.text(url)); },
  };
  return { http, requested };
}

const feed = (form: string, cik: number, accession: string, updated: string, indexUrl: string) => `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title><entry>
<title>${form} - SOME ISSUER (${String(cik).padStart(10, '0')}) (Filer)</title>
<link rel="alternate" type="text/html" href="${indexUrl}"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; ${updated.slice(0, 10)} &lt;b&gt;AccNo:&lt;/b&gt; ${accession} &lt;b&gt;Size:&lt;/b&gt; 35 KB</summary>
<updated>${updated}</updated>
<category scheme="https://www.sec.gov/" label="form type" term="${form}"/>
<id>urn:tag:sec.gov,2008:accession-number=${accession}</id>
</entry></feed>`;

const entry = (symbol: string, isin: string, extra: Partial<EuropeUniverseEntry> = {}): EuropeUniverseEntry => ({
  market: 'UK', symbol, isin, lei: null, name: `${symbol} plc`, exchange: 'LSE', mic: 'XLON', country: 'GB', currency: 'GBp',
  adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null, ...extra,
});
const ENTRIES: EuropeUniverseEntry[] = [
  entry('AZN.L', 'GB0009895292', { name: 'AstraZeneca PLC', adr: 'AZN', adrRatio: 1, adrRatioVerified: true, cik: AZN_CIK, secForm: '6-K' }),
  entry('HSBA.L', 'GB0005405286', { name: 'HSBC Holdings plc', adr: 'HSBC', adrRatio: 5, adrRatioVerified: true, cik: HSBC_CIK, secForm: '6-K' }),
  entry('BT-A.L', 'GB0030913577'),
];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function setup(docs: Record<string, string> = {}) {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', ENTRIES, NOW);
  for (const s of ['AZN.L', 'HSBA.L']) {
    setEuropeProfile(db, s, { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null,
      fyEndMonth: { month: 12, source: 'esef' } }, NOW);
  }
  const { http, requested } = stubHttp({ ...DOCS, ...docs });
  const down = async (): Promise<never> => { throw new Error('unused'); };
  const ctx: EuropeJobContext = {
    db, market: 'UK', now: () => NOW, today: () => '2026-10-28',
    yahooCalendar: down, yahooSummary: down, yahooQuotes: down, yahooCloses: down, buildUniverse: down, bankHolidaysJson: down,
    esef: { recent: down, facts: down }, prnFeed: down, dila: null, optionChain: async () => null, secHttp: http, tierA: () => [],
  };
  return { db, ctx, http, requested };
}

const row = (db: ReturnType<typeof openDb>, symbol: string, reportDate: string) => {
  const period = europePeriodFor(reportDate, 12);
  return upsertEuropeCalendarRow(db, 'UK', {
    symbol, name: symbol, exchange: 'LSE', period, periodLabel: europePeriodLabel(period), periodConfirmed: false,
    reportDate, dateStatus: 'estimated',
  }, NOW);
};

const GATES_CLOSED = { ...config.fastFields, ukEps: false, ukRevenue: false };
const GATES_OPEN = { ...config.fastFields, ukEps: true, ukRevenue: true };

describe('UK / EU on the shared 6-K watcher', () => {
  it('AZN results 6-K flips the matching UK row; timing stays UNKNOWN; period confirmed', async () => {
    const { db, ctx } = setup();
    const id = row(db, 'AZN.L', '2026-04-29'); // Q1 FY26 (period end 2026-03-31), not yet confirmed
    expect(getEuropeReport(db, id)!.periodConfirmed).toBe(false);
    const r = await handleEuropeFiling(ctx, AZN_FILING, GATES_CLOSED);
    expect(r.released).toEqual([id]);
    expect(getEuropeReport(db, id)).toMatchObject({
      periodEnd: '2026-03-31', releasedAt: AZN_FILING.acceptedAt, releasedSource: 'sec', timing: 'UNKNOWN', timingSource: null,
      periodConfirmed: true, signalUrl: AZN_DOC,
    });
    expect(europeSecSeen(db, 'UK', AZN_ACC)).toBe(true);
    expect(europeSecSeen(db, 'EU', AZN_ACC)).toBe(false); // seen per market
  });

  it('gate closed: flipped, no actuals; gate open: SEC actuals with GBp/USD currencies from the reader', async () => {
    const closed = setup();
    const a = row(closed.db, 'AZN.L', '2026-04-29');
    await handleEuropeFiling(closed.ctx, AZN_FILING, GATES_CLOSED);
    expect(getEuropeReport(closed.db, a)).toMatchObject({ releasedAt: AZN_FILING.acceptedAt, epsActual: null, revenueActual: null });

    const open = setup();
    const b = row(open.db, 'AZN.L', '2026-04-29');
    await handleEuropeFiling(open.ctx, AZN_FILING, GATES_OPEN);
    // AZN reports in US$: the reader's currency is stored as stated (never the GBp quote currency of AZN.L).
    expect(getEuropeReport(open.db, b)).toMatchObject({
      epsActual: 1.99, epsDilutedActual: 1.97, epsCurrency: 'USD', epsSource: 'sec', epsSpan: 'quarter',
      revenueActual: 15_288_000_000, revenueCurrency: 'USD', revenueSource: 'sec', secDocUrl: AZN_DOC,
    });

    // A pence release: EPS stays GBp (pence), revenue keeps its own currency (GBP from "£m"); nothing is divided by 100.
    const pDir = 'https://www.sec.gov/Archives/edgar/data/1089113/000165495426008888';
    const pIndex = `${pDir}/0001654954-26-008888-index.htm`;
    const pDoc = `${pDir}/q3.htm`;
    const pence = setup({
      [pIndex]: index([[pDoc, '6-K']]),
      [pDoc]: `<html><body><p>HSBC Holdings plc</p><p>Third quarter 2026 results for the three months ended 30 September 2026</p>
<table><tr><td></td><td>Three months ended 30 September 2026</td><td>Three months ended 30 September 2025</td></tr>
<tr><td></td><td>£m</td><td>£m</td></tr>
<tr><td>Revenue</td><td>12,345</td><td>11,000</td></tr>
<tr><td>Basic earnings per share (p)</td><td>21.4</td><td>19.0</td></tr>
<tr><td>Diluted earnings per share (p)</td><td>21.1</td><td>18.8</td></tr></table></body></html>`,
    });
    const c = row(pence.db, 'HSBA.L', '2026-10-28');
    await handleEuropeFiling(pence.ctx, { cik: HSBC_CIK, accession: '0001654954-26-008888', indexUrl: pIndex, acceptedAt: '2026-10-28T06:00:00.000Z', form: '6-K' }, GATES_OPEN);
    const rep = getEuropeReport(pence.db, c)!;
    expect(rep.releasedSource).toBe('sec');
    expect(rep).toMatchObject({ epsActual: 21.4, epsCurrency: 'GBp', revenueActual: 12_345_000_000, revenueCurrency: 'GBP' });
  });

  it('HSBC 6-K flips HK 0005 and UK HSBA.L through one SixKWatch tick', async () => {
    const accepted = '2026-08-04T04:30:00-04:00';
    const { db, ctx, http, requested } = setup({ [FEED_6K]: feed('6-K', HSBC_CIK, HSBC_ACC, accepted, HSBC_INDEX) });
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    const hkCtx: HkJobContext = {
      db, now: () => NOW, todayHKT: () => '2026-08-04',
      yahoo: async () => null, yahooPastDates: async () => [], yahooCloses: async () => new Map(), optionChain: async () => null, secHttp: http,
    };
    const hkId = upsertHkCalendarRow(db, { code: '0005', name: '0005', periodEnd: '2026-06-30', periodKind: 'Q', periodLabel: 'Q2 26', reportDate: '2026-08-04', dateStatus: 'estimated' }, NOW);
    const ukId = row(db, 'HSBA.L', '2026-08-04');
    const onHk = vi.fn();
    const onUk = vi.fn();
    const uk = europeSixKMarket(ctx, onUk);
    expect(uk.sessionFor!(HSBC_CIK)).toEqual({ zone: 'Europe/London', openMin: EXCHANGES.LSE.openMin, closeMin: EXCHANGES.LSE.closeMin });
    const watch = new SixKWatch([hkSixKMarket(hkCtx, onHk), uk], http, { db, now: () => NOW });
    expect(new Set(await watch.tick())).toEqual(new Set([hkId, ukId]));
    expect(requested.filter((u) => u === FEED_6K)).toHaveLength(1);
    expect(onHk).toHaveBeenCalledWith([hkId]);
    expect(onUk).toHaveBeenCalledWith([ukId]);
    expect(getHkReport(db, hkId)!.releasedAt).toBe('2026-08-04T08:30:00.000Z');
    expect(getEuropeReport(db, ukId)).toMatchObject({ releasedAt: '2026-08-04T08:30:00.000Z', releasedSource: 'sec', timing: 'UNKNOWN', periodConfirmed: true });
  });

  it('a UK handler failure never blocks the HK handling of the same filing', async () => {
    const accepted = '2026-08-04T04:30:00-04:00';
    const { db, http } = setup({ [FEED_6K]: feed('6-K', HSBC_CIK, HSBC_ACC, accepted, HSBC_INDEX) });
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    const hkCtx: HkJobContext = {
      db, now: () => NOW, todayHKT: () => '2026-08-04',
      yahoo: async () => null, yahooPastDates: async () => [], yahooCloses: async () => new Map(), optionChain: async () => null, secHttp: http,
    };
    const hkId = upsertHkCalendarRow(db, { code: '0005', name: '0005', periodEnd: '2026-06-30', periodKind: 'Q', periodLabel: 'Q2 26', reportDate: '2026-08-04', dateStatus: 'estimated' }, NOW);
    const broken = { ...europeSixKMarket(setup().ctx, () => {}), ciks: () => new Set([HSBC_CIK]), handle: async () => { throw new Error('uk down'); } };
    const watch = new SixKWatch([broken, hkSixKMarket(hkCtx, () => {})], http, { db, now: () => NOW });
    expect(await watch.tick()).toEqual([hkId]);
  });

  it('date notice confirms date and sets sec-notice timing', async () => {
    const { db, ctx } = setup();
    const id = row(db, 'AZN.L', '2026-11-05'); // estimated Q3 row a day early
    const r = await handleEuropeFiling(ctx, {
      cik: AZN_CIK, accession: NOTICE_ACC, indexUrl: NOTICE_INDEX, acceptedAt: '2026-10-20T10:00:00.000Z', form: '6-K',
      session: { zone: 'Europe/London', openMin: EXCHANGES.LSE.openMin, closeMin: EXCHANGES.LSE.closeMin },
    }, GATES_CLOSED);
    expect(r.dated).toEqual([id]);
    expect(getEuropeReport(db, id)).toMatchObject({
      reportDate: '2026-11-06', dateStatus: 'confirmed', timing: 'BMO', timingSource: 'sec-notice',
      releasedAt: null,
    });
    expect(europeSecSeen(db, 'UK', NOTICE_ACC)).toBe(true);
  });

  it('no fiscal year end yet: a notice or results 6-K is not marked seen, and is handled once the year end is known', async () => {
    const { db, ctx } = setup();
    db.prepare("UPDATE europe_stocks SET fy_end_month = NULL, fy_end_source = NULL WHERE symbol = 'AZN.L'").run();
    const notice = {
      cik: AZN_CIK, accession: NOTICE_ACC, indexUrl: NOTICE_INDEX, acceptedAt: '2026-10-20T10:00:00.000Z', form: '6-K',
      session: { zone: 'Europe/London', openMin: EXCHANGES.LSE.openMin, closeMin: EXCHANGES.LSE.closeMin },
    };
    expect((await handleEuropeFiling(ctx, notice, GATES_CLOSED)).dated).toEqual([]);
    expect(europeSecSeen(db, 'UK', NOTICE_ACC)).toBe(false);
    expect((await handleEuropeFiling(ctx, AZN_FILING, GATES_CLOSED)).released).toEqual([]);
    expect(europeSecSeen(db, 'UK', AZN_ACC)).toBe(false);

    setEuropeProfile(db, 'AZN.L', { name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null,
      fyEndMonth: { month: 12, source: 'yahoo' } }, NOW);
    const r = await handleEuropeFiling(ctx, notice, GATES_CLOSED);
    expect(r.dated).toHaveLength(1);
    expect(getEuropeReport(db, r.dated[0]!)).toMatchObject({ reportDate: '2026-11-06', dateStatus: 'confirmed' });
    expect(europeSecSeen(db, 'UK', NOTICE_ACC)).toBe(true);
  });

  it('a notice with no session gives UNKNOWN timing (never a default)', async () => {
    const { db, ctx } = setup();
    const id = row(db, 'AZN.L', '2026-11-05');
    await handleEuropeFiling(ctx, {
      cik: AZN_CIK, accession: NOTICE_ACC, indexUrl: NOTICE_INDEX, acceptedAt: '2026-10-20T10:00:00.000Z', form: '6-K', session: null,
    }, GATES_CLOSED);
    expect(getEuropeReport(db, id)).toMatchObject({ reportDate: '2026-11-06', dateStatus: 'confirmed', timing: 'UNKNOWN' });
  });

  it('ciks are the active full-level 6-K filers; due while a full-level row is near and unreleased', () => {
    const { db, ctx } = setup();
    const m = europeSixKMarket(ctx, () => {});
    expect(m.name).toBe('uk');
    expect([...m.ciks()].sort()).toEqual([AZN_CIK, HSBC_CIK].sort());
    expect(m.eightKCiks().size).toBe(0);
    expect(m.due()).toBe(false);
    row(db, 'AZN.L', '2026-10-29');
    expect(m.due()).toBe(true);
  });
});
