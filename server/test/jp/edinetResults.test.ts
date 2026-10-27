import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import {
  edinetSeen, getJpReport, mergeJpActuals, syncJpUniverse, upsertJpCalendarRow,
} from '../../src/jp/db/jpRepo.js';
import type { JpJobContext } from '../../src/jp/jobs/context.js';
import { jpEdinetDates, refreshJpEdinet } from '../../src/jp/jobs/edinetResults.js';
import type { EdinetClient, EdinetDoc } from '../../src/jp/sources/edinet.js';
import type { JpUniverseEntry } from '../../src/jp/universe.js';

const fxPath = (n: string) => new URL(`../fixtures/jp/edinet/${n}`, import.meta.url);
/** The Task 4 corpus: real instances downloaded by hand from the EDINET viewer. */
const corpus = (JSON.parse(readFileSync(fxPath('expected.json'), 'utf8')) as {
  documents: { file: string; docID: string; docTypeCode: '120' | '160'; periodEnd: string }[];
}).documents;
const xbrlOf = new Map(corpus.map((d) => [d.docID, gunzipSync(readFileSync(fxPath(d.file))).toString('utf8')]));

const NOW = '2026-10-27T03:00:00.000Z';
const later = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();
const DATE = '2026-10-27';
const TAKEDA_HANKI = 'S100WX9G';
const NINTENDO_YUHO = 'S100Y9NX';
const NINTENDO_HANKI = 'S100WY6A';

const ENTRIES: JpUniverseEntry[] = [
  { code: '4502', edinetCode: 'E00919', name: 'Takeda Pharmaceutical', nameJa: '武田薬品工業株式会社', fyEndMonth: 3, industryJa: '医薬品',
    adr: 'TAK', adrRatio: 0.5, cik: 1395064 },
  { code: '7974', edinetCode: 'E02367', name: 'Nintendo Co., Ltd.', nameJa: '任天堂株式会社', fyEndMonth: 3, industryJa: 'その他製品',
    adr: null, adrRatio: null, cik: null },
];

/** A document-list entry for a corpus document (the fields `isResultsFiling` reads). */
function docOf(docID: string, secCode: string, over: Partial<EdinetDoc> = {}): EdinetDoc {
  const c = corpus.find((d) => d.docID === docID);
  return {
    docID, edinetCode: 'E00000', secCode, filerName: '', docTypeCode: c?.docTypeCode ?? '120', ordinanceCode: '010',
    periodStart: null, periodEnd: c?.periodEnd ?? '2026-03-31', submitDateTime: `${DATE} 15:00`, withdrawalStatus: '0', xbrlFlag: '1',
    ...over,
  };
}

function setup(docs: EdinetDoc[], opts: { fail?: (docID: string) => Error | null; client?: false } = {}) {
  const db = openDb(':memory:');
  syncJpUniverse(db, ENTRIES, NOW);
  const downloads: string[] = [];
  const clock = { now: NOW };
  const edinet: EdinetClient = {
    docList: async () => docs,
    xbrlInstance: async (docID) => {
      downloads.push(docID);
      const err = opts.fail?.(docID);
      if (err) throw err;
      const xml = xbrlOf.get(docID);
      if (!xml) throw new Error(`no fixture for ${docID}`);
      return xml;
    },
  };
  const ctx = { db, now: () => clock.now, todayJST: () => DATE, edinet: opts.client === false ? null : edinet } as unknown as JpJobContext;
  const row = (code: string, periodEnd: string, fiscalQuarter: 1 | 2 | 3 | 4, fyEnd: string) => upsertJpCalendarRow(db, {
    code, name: code, period: { periodEnd, fiscalQuarter, fyEnd }, periodLabel: 'x', reportDate: '2026-05-01', dateStatus: 'estimated',
  }, NOW);
  const status = () => db.prepare(`SELECT last_error AS e FROM source_status WHERE source = 'edinet'`).get() as { e: string | null } | undefined;
  const reports = () => (db.prepare('SELECT COUNT(*) AS n FROM jp_reports').get() as { n: number }).n;
  const outcome = (id: string) => (db.prepare('SELECT outcome FROM jp_edinet_seen WHERE doc_id = ?').get(id) as { outcome: string } | undefined)?.outcome;
  return { db, ctx, clock, downloads, row, status, reports, outcome };
}

afterEach(() => vi.restoreAllMocks());

describe('refreshJpEdinet', () => {
  it('半期報告書 merges ytd 6 into the 2Q row with source edinet and docId', async () => {
    const s = setup([docOf(TAKEDA_HANKI, '45020')]);
    const id = s.row('4502', '2025-09-30', 2, '2026-03-31');
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([id]);
    expect(getJpReport(s.db, id)).toMatchObject({
      revenueActual: 2219481000000, revenueCurrency: 'JPY', revenueSource: 'edinet', revenueSpan: 'ytd', revenueYtdMonths: 6,
      epsActual: 71.57, epsDilutedActual: 70.45, epsCurrency: 'JPY', epsSource: 'edinet', epsSpan: 'ytd', epsYtdMonths: 6,
      edinetDocId: TAKEDA_HANKI, releasedAt: null,
    });
    expect(s.outcome(TAKEDA_HANKI)).toBe('merged');
  });

  it('有報 merges ytd 12 into the FY row', async () => {
    const s = setup([docOf(NINTENDO_YUHO, '79740')]);
    const id = s.row('7974', '2026-03-31', 4, '2026-03-31');
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([id]);
    expect(getJpReport(s.db, id)).toMatchObject({
      revenueActual: 2313051000000, revenueSpan: 'ytd', revenueYtdMonths: 12, revenueSource: 'edinet',
      epsActual: 364.51, epsDilutedActual: null, epsSpan: 'ytd', epsYtdMonths: 12, epsSource: 'edinet', edinetDocId: NINTENDO_YUHO,
    });
  });

  it('no row with that period end → marked no-row, nothing created', async () => {
    const s = setup([docOf(NINTENDO_HANKI, '79740')]);
    s.row('7974', '2026-03-31', 4, '2026-03-31');
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([]);
    expect(s.reports()).toBe(1);
    expect(s.outcome(NINTENDO_HANKI)).toBe('no-row');
  });

  it('never replaces SEC; replaces Yahoo', async () => {
    const s = setup([docOf(TAKEDA_HANKI, '45020')]);
    const id = s.row('4502', '2025-09-30', 2, '2026-03-31');
    mergeJpActuals(s.db, id, { revenue: { value: 1_000, currency: 'JPY', span: 'quarter', ytdMonths: null }, source: 'yahoo' }, NOW);
    mergeJpActuals(s.db, id, {
      eps: { basic: 30, diluted: 29, currency: 'JPY', span: 'quarter', ytdMonths: null }, source: 'sec', docUrl: 'https://www.sec.gov/x',
    }, NOW);
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([id]);
    expect(getJpReport(s.db, id)).toMatchObject({
      revenueActual: 2219481000000, revenueSource: 'edinet', revenueSpan: 'ytd',
      epsActual: 30, epsDilutedActual: 29, epsSource: 'sec', epsSpan: 'quarter',
    });
  });

  it('each docID handled once', async () => {
    const s = setup([docOf(TAKEDA_HANKI, '45020'), docOf(NINTENDO_HANKI, '79740')]);
    s.row('4502', '2025-09-30', 2, '2026-03-31');
    await refreshJpEdinet(s.ctx, [DATE]);
    s.clock.now = later(60);
    expect(await refreshJpEdinet(s.ctx, [DATE, DATE])).toEqual([]);
    expect(s.downloads).toEqual([TAKEDA_HANKI, NINTENDO_HANKI]);
  });

  it('only results filings of active codes are downloaded', async () => {
    const s = setup([
      docOf(TAKEDA_HANKI, '45020', { docTypeCode: '140' }),
      docOf(TAKEDA_HANKI, '45020', { docID: 'S100AMND', docTypeCode: '170' }),
      docOf(NINTENDO_YUHO, '99990'),
      docOf(NINTENDO_YUHO, '79740', { withdrawalStatus: '1' }),
    ]);
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([]);
    expect(s.downloads).toEqual([]);
  });

  it('download error: not marked seen, source error has no key', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = 'https://api.edinet-fsa.go.jp/api/v2/documents/S100WX9G?type=1&Subscription-Key=';
    let failing = true;
    const s = setup([docOf(TAKEDA_HANKI, '45020')], {
      // The client's message (key already redacted) and, as a second line of defence, a raw one.
      fail: () => (failing ? new Error(`EDINET request failed for ${url}***: TypeError: fetch failed (was ${url}sekrit-123)`) : null),
    });
    const id = s.row('4502', '2025-09-30', 2, '2026-03-31');
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([]);
    const text = s.status()!.e!;
    expect(text).toContain('Subscription-Key=***');
    expect(text).not.toContain('sekrit-123');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sekrit-123');
    expect(getJpReport(s.db, id)!.epsActual).toBeNull();
    // Not seen: the next run (30 min later) retries it and merges.
    s.clock.now = later(30);
    expect(edinetSeen(s.db, TAKEDA_HANKI, s.clock.now)).toBe(false);
    failing = false;
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([id]);
    expect(s.outcome(TAKEDA_HANKI)).toBe('merged');
    expect(s.downloads).toEqual([TAKEDA_HANKI, TAKEDA_HANKI]);
  });

  it('errored documents are retried with doubling backoff, never given up; successes are not re-downloaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failing = true;
    const s = setup([docOf(TAKEDA_HANKI, '45020'), docOf(NINTENDO_YUHO, '79740')], {
      fail: (docID) => (failing && docID === TAKEDA_HANKI ? new Error('HTTP 500') : null),
    });
    const id = s.row('4502', '2025-09-30', 2, '2026-03-31');
    s.row('7974', '2026-03-31', 4, '2026-03-31');
    const takeda = () => s.downloads.filter((d) => d === TAKEDA_HANKI).length;
    const at = async (min: number) => { s.clock.now = later(min); await refreshJpEdinet(s.ctx, [DATE]); };
    await at(0);                               // attempt 1; next due +15 min
    await at(10);
    expect(takeda()).toBe(1);
    await at(15);                              // attempt 2; next due +30 min
    await at(40);
    expect(takeda()).toBe(2);
    await at(45);                              // attempt 3; next due +60 min
    await at(105);                             // attempt 4; next due +120 min
    await at(225);                             // attempt 5 (the error has lasted almost 4 h); next due +240 min
    await at(465);                             // attempt 6 (> 4 h): still retried; next due +360 min (the cap)
    expect(takeda()).toBe(6);
    await at(465 + 359);
    expect(takeda()).toBe(6);
    // Many attempts later the delay stays capped at 6 h and it is still retried.
    let t = 465 + 360;
    for (let i = 0; i < 6; i++) { await at(t); t += 360; }
    expect(takeda()).toBe(12);
    expect(s.outcome(TAKEDA_HANKI)).toBe('error');
    failing = false;
    await at(t);
    expect(s.outcome(TAKEDA_HANKI)).toBe('merged');
    expect(getJpReport(s.db, id)!.edinetDocId).toBe(TAKEDA_HANKI);
    expect(s.downloads.filter((d) => d === NINTENDO_YUHO)).toHaveLength(1);
  });

  it('a parser exception is final (parse-error) and never re-downloaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup([docOf(TAKEDA_HANKI, '45020')]);
    const parse = await import('../../src/jp/sources/edinetXbrl.js');
    vi.spyOn(parse, 'parseEdinetXbrl').mockImplementation(() => { throw new Error('boom'); });
    s.row('4502', '2025-09-30', 2, '2026-03-31');
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([]);
    expect(s.outcome(TAKEDA_HANKI)).toBe('parse-error');
    s.clock.now = later(7 * 24 * 60);
    expect(edinetSeen(s.db, TAKEDA_HANKI, s.clock.now)).toBe(true);
    await refreshJpEdinet(s.ctx, [DATE]);
    expect(s.downloads).toEqual([TAKEDA_HANKI]);
  });

  it('a document that changes nothing is marked superseded, not merged', async () => {
    const s = setup([docOf(TAKEDA_HANKI, '45020')]);
    const id = s.row('4502', '2025-09-30', 2, '2026-03-31');
    mergeJpActuals(s.db, id, {
      revenue: { value: 1_000, currency: 'JPY', span: 'quarter', ytdMonths: null },
      eps: { basic: 30, diluted: 29, currency: 'JPY', span: 'quarter', ytdMonths: null }, source: 'sec', edinetDocId: 'S100OTHER',
    }, NOW);
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([]);
    expect(s.outcome(TAKEDA_HANKI)).toBe('superseded');
    expect(getJpReport(s.db, id)).toMatchObject({ revenueSource: 'sec', epsSource: 'sec', edinetDocId: 'S100OTHER' });
  });

  it('no client → no-op with "not configured" status', async () => {
    const s = setup([docOf(TAKEDA_HANKI, '45020')], { client: false });
    s.row('4502', '2025-09-30', 2, '2026-03-31');
    expect(await refreshJpEdinet(s.ctx, [DATE])).toEqual([]);
    expect(s.status()!.e).toBe('EDINET_API_KEY not set');
    expect(s.downloads).toEqual([]);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM jp_edinet_seen').get()).toEqual({ n: 0 });
  });
});

describe('jpEdinetDates', () => {
  it('today, or the 7 days ending today', () => {
    expect(jpEdinetDates('2026-10-27', 'today')).toEqual(['2026-10-27']);
    expect(jpEdinetDates('2026-03-02', 'backfill')).toEqual([
      '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02',
    ]);
  });
});
