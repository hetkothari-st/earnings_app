import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { openDb } from '../../src/db/repo.js';
import { getHkReport, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import type { HkJobContext } from '../../src/hk/jobs/context.js';
import { hkSixKMarket } from '../../src/hk/live/hkSecWatch.js';
import { HK_UNIVERSE } from '../../src/hk/universe.js';
import { getJpReport, jpSecSeen, markJpSecSeen, mergeJpActuals, syncJpUniverse, upsertJpCalendarRow } from '../../src/jp/db/jpRepo.js';
import { jpPeriodFor, jpPeriodLabel } from '../../src/jp/domain/period.js';
import type { JpJobContext } from '../../src/jp/jobs/context.js';
import { sweepJpSec } from '../../src/jp/jobs/secSweep.js';
import { handleJpFiling, jpSixKMarket } from '../../src/jp/live/jpSixK.js';
import { JP_FULL, type JpUniverseEntry } from '../../src/jp/universe.js';
import { HttpError, type Http } from '../../src/sources/http.js';
import { SixKWatch } from '../../src/sources/sixKWatch.js';

const jpFx = (n: string) => readFileSync(new URL(`../fixtures/jp/${n}`, import.meta.url), 'utf8');
const hkFx = (n: string) => readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8');

const FEED_6K = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=6-K&company=&dateb=&owner=include&start=0&count=100&output=atom';

// Toyota 1Q FY2027 results (Task 2 fixtures): accepted 2026-08-04 06:03 ET = 19:03 JST.
const TM_CIK = 1094517;
const TM_ACC = '0001193125-26-331392';
const TM_DIR = 'https://www.sec.gov/Archives/edgar/data/1094517/000119312526331392';
const TM_INDEX = `${TM_DIR}/${TM_ACC}-index.htm`;
const TM_EX991 = `${TM_DIR}/d258414dex991.htm`;
const TM_MAIN = `${TM_DIR}/d258414d6k.htm`;
const TM_ACCEPTED = '2026-08-04T10:03:00.000Z';
// Nomura's notice "Nomura to Announce Second Quarter Operating Results on October 28" (15:30 JST = the close, AMC), accepted 2026-09-17.
const NMR_CIK = 1163653;
const NMR_ACC = '0001193125-26-393642';
const NMR_DIR = 'https://www.sec.gov/Archives/edgar/data/1163653/000119312526393642';
const NMR_INDEX = `${NMR_DIR}/${NMR_ACC}-index.htm`;
// Alibaba results 6-K (HK Task 6 fixtures).
const BABA_CIK = 1577552;
const BABA_ACC = '0001104659-26-099220';
const BABA_DIR = 'https://www.sec.gov/Archives/edgar/data/1577552/000110465926099220';
const BABA_INDEX = `${BABA_DIR}/${BABA_ACC}-index.htm`;

const BASE_DOCS: Record<string, string> = {
  [TM_INDEX]: jpFx('sec_index_toyota_1q_fy27.htm'),
  [TM_EX991]: jpFx('toyota_1q_fy27_ex991.htm'),
  [TM_MAIN]: '<html><body>Form 6-K cover</body></html>',
  [NMR_INDEX]: jpFx('sec_index_nomura_date_notice.htm'),
  [`${NMR_DIR}/d140285d6k.htm`]: jpFx('nomura_2q_date_notice_6k.htm'),
  [BABA_INDEX]: hkFx('sec_index_baba_results.htm'),
  [`${BABA_DIR}/tm2623667d1_ex99-1.htm`]: hkFx('baba_results_ex99.htm'),
  [`${BABA_DIR}/tm2623667d1_6k.htm`]: '<html><body>Form 6-K cover</body></html>',
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
    async json(url) {
      return JSON.parse(await http.text(url));
    },
  };
  return { http, requested };
}

/** One getcurrent Atom entry, in the shape of the saved feed fixture. */
const entry = (form: string, cik: number, accession: string, updated: string, indexUrl: string) => `<entry>
<title>${form} - SOME ISSUER (${String(cik).padStart(10, '0')}) (Filer)</title>
<link rel="alternate" type="text/html" href="${indexUrl}"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; ${updated.slice(0, 10)} &lt;b&gt;AccNo:&lt;/b&gt; ${accession} &lt;b&gt;Size:&lt;/b&gt; 35 KB
</summary>
<updated>${updated}</updated>
<category scheme="https://www.sec.gov/" label="form type" term="${form}"/>
<id>urn:tag:sec.gov,2008:accession-number=${accession}</id>
</entry>`;
const feed = (...entries: string[]) => `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title>${entries.join('\n')}</feed>`;

const full = (code: string, name: string): JpUniverseEntry => {
  const f = JP_FULL.find((e) => e.code === code)!;
  return { code, edinetCode: `E${code}`, name, nameJa: name, fyEndMonth: 3, industryJa: null, adr: f.adr, adrRatio: f.adrRatio, cik: f.cik };
};
const ENTRIES: JpUniverseEntry[] = [
  full('7203', 'TOYOTA MOTOR CORPORATION'),
  full('8604', 'Nomura Holdings, Inc.'),
  { code: '6501', edinetCode: 'E01737', name: 'Hitachi, Ltd.', nameJa: 'Hitachi', fyEndMonth: 3, industryJa: null, adr: null, adrRatio: null, cik: null },
];

const NOW = '2026-08-04T12:00:00.000Z';

function setup(opts: { today?: string; docs?: Record<string, string> } = {}) {
  const db = openDb(':memory:');
  syncJpUniverse(db, ENTRIES, NOW);
  const { http, requested } = stubHttp({ ...BASE_DOCS, ...opts.docs });
  const ctx: JpJobContext = {
    db, now: () => NOW, todayJST: () => opts.today ?? '2026-08-04',
    yahooCalendar: async () => ({ rows: [], complete: true }), yahooSummary: async () => null, yahooQuotes: async () => new Map(),
    yahooCloses: async () => new Map(), edinetCodeList: async () => '', edinet: null, optionChain: async () => null,
    secHttp: http, tierA: () => [],
  };
  return { db, ctx, http, requested };
}

const row = (db: ReturnType<typeof openDb>, code: string, reportDate: string, periodDate = reportDate) => {
  const period = jpPeriodFor(periodDate, 3);
  return upsertJpCalendarRow(db, { code, name: code, period, periodLabel: jpPeriodLabel(period), reportDate, dateStatus: 'estimated' }, NOW);
};

const TM_FILING = { cik: TM_CIK, accession: TM_ACC, indexUrl: TM_INDEX, acceptedAt: TM_ACCEPTED, form: '6-K' };
const GATES_CLOSED = { ...config.fastFields, jpEps: false, jpRevenue: false };
const GATES_OPEN = { ...config.fastFields, jpEps: true, jpRevenue: true };

afterEach(() => { vi.restoreAllMocks(); });

describe('Japan 6-K handling', () => {
  it('Toyota results 6-K flips the matching period row; timing stays UNKNOWN; releasedAt = acceptance', async () => {
    const { db, ctx, http } = setup({ docs: { [FEED_6K]: feed(entry('6-K', TM_CIK, TM_ACC, '2026-08-04T06:03:00-04:00', TM_INDEX)) } });
    const id = row(db, '7203', '2026-08-03'); // 1Q FY27 (June quarter), estimated a day early
    const onChanged = vi.fn();
    const ids = await new SixKWatch([jpSixKMarket(ctx, onChanged)], http, ctx).tick();
    expect(ids).toEqual([id]);
    expect(onChanged).toHaveBeenCalledWith([id]);
    expect(getJpReport(db, id)).toMatchObject({
      periodEnd: '2026-06-30', releasedAt: TM_ACCEPTED, timing: 'UNKNOWN', reportDate: '2026-08-04', rescheduledFrom: '2026-08-03',
    });
    expect(jpSecSeen(db, TM_ACC)).toBe(true);
  });

  it("release for another period never flips today's row", async () => {
    // The June-quarter release is filed while the September quarter is the row dated today: nothing flips.
    const { db, ctx } = setup({ today: '2026-10-08' });
    const q2 = row(db, '7203', '2026-10-08');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await handleJpFiling(ctx, { ...TM_FILING, acceptedAt: '2026-10-08T00:00:00.000Z' }, GATES_OPEN);
    expect(r).toEqual({ released: [], dated: [] });
    expect(getJpReport(db, q2)).toMatchObject({ periodEnd: '2026-09-30', releasedAt: null, reportDate: '2026-10-08', epsActual: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jp_reports WHERE code = '7203'").get()).toEqual({ n: 1 });
    expect(jpSecSeen(db, TM_ACC)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/7203: 6-K .* results for 2026-06-30, no row with that period end/));
  });

  it('with no row, one is created only for the latest period at the JST date', async () => {
    const { db, ctx } = setup();
    const r = await handleJpFiling(ctx, TM_FILING, GATES_CLOSED);
    expect(r.released).toHaveLength(1);
    expect(getJpReport(db, r.released[0]!)).toMatchObject({
      periodEnd: '2026-06-30', fiscalQuarter: 1, periodLabel: '1Q FY27', reportDate: '2026-08-04', dateStatus: 'estimated', releasedAt: TM_ACCEPTED,
    });
  });

  it('gate closed: flipped, no actuals; gate open: SEC actuals with span from the reader', async () => {
    const closed = setup();
    const a = row(closed.db, '7203', '2026-08-04');
    expect(await handleJpFiling(closed.ctx, TM_FILING, GATES_CLOSED)).toEqual({ released: [a], dated: [] });
    expect(getJpReport(closed.db, a)).toMatchObject({ releasedAt: TM_ACCEPTED, epsActual: null, revenueActual: null, epsSource: null, secDocUrl: null });

    const open = setup();
    const b = row(open.db, '7203', '2026-08-04');
    expect(await handleJpFiling(open.ctx, TM_FILING, GATES_OPEN)).toEqual({ released: [b], dated: [] });
    expect(getJpReport(open.db, b)).toMatchObject({
      releasedAt: TM_ACCEPTED, timing: 'UNKNOWN',
      epsActual: 120.69, epsDilutedActual: 120.69, epsCurrency: 'JPY', epsSource: 'sec', epsSpan: 'quarter', epsYtdMonths: null,
      revenueActual: 13_525_400_000_000, revenueCurrency: 'JPY', revenueSource: 'sec', revenueSpan: 'quarter', revenueYtdMonths: null,
      secDocUrl: TM_EX991,
    });

    // Only the open gate is written.
    const eps = setup();
    const c = row(eps.db, '7203', '2026-08-04');
    await handleJpFiling(eps.ctx, TM_FILING, { ...config.fastFields, jpEps: true, jpRevenue: false });
    expect(getJpReport(eps.db, c)).toMatchObject({ epsActual: 120.69, revenueActual: null });
  });

  it('SEC replaces an EDINET value', async () => {
    const { db, ctx } = setup();
    const id = row(db, '7203', '2026-08-04');
    mergeJpActuals(db, id, {
      eps: { basic: 100, diluted: 99, currency: 'JPY', span: 'ytd', ytdMonths: 6 },
      revenue: { value: 1_000, currency: 'JPY', span: 'ytd', ytdMonths: 6 }, source: 'edinet', edinetDocId: 'S100TEST',
    }, NOW);
    expect(await handleJpFiling(ctx, TM_FILING, GATES_OPEN)).toEqual({ released: [id], dated: [] });
    expect(getJpReport(db, id)).toMatchObject({
      epsActual: 120.69, epsSource: 'sec', epsSpan: 'quarter', epsYtdMonths: null,
      revenueActual: 13_525_400_000_000, revenueSource: 'sec', revenueSpan: 'quarter', edinetDocId: 'S100TEST', secDocUrl: TM_EX991,
    });
  });

  it('only the earliest filing of a period is read', async () => {
    const { db, ctx } = setup();
    const id = row(db, '7203', '2026-08-04');
    // Released by an earlier filing, gates closed then: a later re-filing neither re-reads nor moves releasedAt.
    await handleJpFiling(ctx, { ...TM_FILING, accession: '0001193125-26-000001' }, GATES_CLOSED);
    const later = await handleJpFiling(ctx, { ...TM_FILING, acceptedAt: '2026-08-05T10:00:00.000Z' }, GATES_OPEN);
    expect(later).toEqual({ released: [], dated: [] });
    expect(getJpReport(db, id)).toMatchObject({ releasedAt: TM_ACCEPTED, epsActual: null });
  });

  it("an exhibit that is no release: the 6-K main document is classified too", async () => {
    // Takeda-style: the results summary is the 6-K itself; the exhibit is something else.
    const { db, ctx } = setup({ docs: { [TM_EX991]: jpFx('mizuho_buyback_progress_6k.htm'), [TM_MAIN]: jpFx('toyota_1q_fy27_ex991.htm') } });
    const id = row(db, '7203', '2026-08-04');
    expect(await handleJpFiling(ctx, TM_FILING, GATES_OPEN)).toEqual({ released: [id], dated: [] });
    expect(getJpReport(db, id)).toMatchObject({ releasedAt: TM_ACCEPTED, epsActual: 120.69, secDocUrl: TM_MAIN });
  });

  it('a date notice confirms the date and timing; one naming a past date is ignored', async () => {
    const { db, ctx } = setup({ today: '2026-09-17' });
    const id = row(db, '8604', '2026-10-30');
    const filing = { cik: NMR_CIK, accession: NMR_ACC, indexUrl: NMR_INDEX, acceptedAt: '2026-09-17T10:01:00.000Z', form: '6-K' };
    expect(await handleJpFiling(ctx, filing)).toEqual({ released: [], dated: [id] });
    expect(getJpReport(db, id)).toMatchObject({
      periodEnd: '2026-09-30', reportDate: '2026-10-28', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'sec-notice', releasedAt: null,
    });

    // The same notice accepted after the date it names: nothing is dated.
    const late = setup({ today: '2026-10-29' });
    const lateId = row(late.db, '8604', '2026-10-30');
    expect(await handleJpFiling(late.ctx, { ...filing, acceptedAt: '2026-10-29T10:01:00.000Z' })).toEqual({ released: [], dated: [] });
    expect(getJpReport(late.db, lateId)).toMatchObject({ reportDate: '2026-10-30', dateStatus: 'estimated' });
    expect(jpSecSeen(late.db, NMR_ACC)).toBe(true);
  });

  it('a 6-K of a basic-level or unknown CIK fetches nothing', async () => {
    const { ctx, requested } = setup();
    expect(await handleJpFiling(ctx, { ...TM_FILING, cik: 999 })).toEqual({ released: [], dated: [] });
    expect(requested).toEqual([]);
  });

  it('due: a full-level report in JST today−1..+3, unreleased', () => {
    const { db, ctx } = setup({ today: '2026-08-01' });
    const m = jpSixKMarket(ctx, () => {});
    expect(m.ciks()).toEqual(new Set([TM_CIK, NMR_CIK]));
    expect(m.eightKCiks()).toEqual(new Set());
    row(db, '6501', '2026-08-02'); // basic level: never counts
    expect(m.due()).toBe(false);
    row(db, '7203', '2026-08-05'); // today+4
    expect(m.due()).toBe(false);
    row(db, '8604', '2026-08-04', '2026-07-31'); // today+3
    expect(m.due()).toBe(true);
  });

  it('shared watcher: an HK CIK and a JP CIK in one feed each reach their market', async () => {
    const { db, ctx, http, requested } = setup({
      docs: {
        [FEED_6K]: feed(
          entry('6-K', BABA_CIK, BABA_ACC, '2026-08-28T06:30:00-04:00', BABA_INDEX),
          entry('6-K', TM_CIK, TM_ACC, '2026-08-04T06:03:00-04:00', TM_INDEX),
        ),
      },
    });
    syncHkUniverse(db, HK_UNIVERSE, NOW);
    const hkCtx: HkJobContext = {
      db, now: () => NOW, todayHKT: () => '2026-08-28',
      yahoo: async () => null, yahooPastDates: async () => [], yahooCloses: async () => new Map(), optionChain: async () => null, secHttp: http,
    };
    const hkId = upsertHkCalendarRow(db, { code: '9988', name: '9988', periodEnd: '2026-06-30', periodKind: 'Q', periodLabel: 'Q2 26', reportDate: '2026-08-28', dateStatus: 'estimated' }, NOW);
    const jpId = row(db, '7203', '2026-08-04');
    const onHk = vi.fn();
    const onJp = vi.fn();
    const watch = new SixKWatch([hkSixKMarket(hkCtx, onHk), jpSixKMarket(ctx, onJp)], http, { db, now: () => NOW });
    expect(new Set(await watch.tick())).toEqual(new Set([hkId, jpId]));
    expect(requested.filter((u) => u === FEED_6K)).toHaveLength(1); // one feed request for both markets
    expect(onHk).toHaveBeenCalledWith([hkId]);
    expect(onJp).toHaveBeenCalledWith([jpId]);
    expect(getHkReport(db, hkId)!.releasedAt).toBe('2026-08-28T10:30:00.000Z');
    expect(getJpReport(db, jpId)!.releasedAt).toBe(TM_ACCEPTED);
  });
});

describe('sweepJpSec', () => {
  const submissions = (rows: { acc: string; date: string; form: string; doc: string }[]) => JSON.stringify({
    filings: { recent: {
      accessionNumber: rows.map((r) => r.acc), filingDate: rows.map((r) => r.date), form: rows.map((r) => r.form),
      items: rows.map(() => ''), primaryDocument: rows.map((r) => r.doc),
    } },
  });

  it('reads unseen filings of the last 45 days (JST) for every full-level CIK', async () => {
    const SEEN = '0001193125-26-330000';
    const OLD = '0001193125-26-100000';
    const { db, ctx, requested } = setup({
      today: '2026-08-05',
      docs: {
        'https://data.sec.gov/submissions/CIK0001094517.json': submissions([
          { acc: TM_ACC, date: '2026-08-04', form: '6-K', doc: 'd258414d6k.htm' },
          { acc: SEEN, date: '2026-08-03', form: '6-K', doc: 'x_6k.htm' },
          { acc: OLD, date: '2026-06-20', form: '6-K', doc: 'old_6k.htm' },
        ]),
        'https://data.sec.gov/submissions/CIK0001163653.json': submissions([]),
        [`${TM_DIR}/${TM_ACC}.hdr.sgml`]: '<SEC-HEADER>\n<ACCEPTANCE-DATETIME>20260804060300\n</SEC-HEADER>',
      },
    });
    markJpSecSeen(db, SEEN, TM_CIK, 'other', NOW);
    const id = row(db, '7203', '2026-08-04');
    expect(await sweepJpSec(ctx)).toEqual([id]);
    expect(getJpReport(db, id)!.releasedAt).toBe(TM_ACCEPTED);
    expect(requested.filter((u) => u.includes('330000') || u.includes('100000'))).toEqual([]);
  });

  it('without the SEC client nothing runs', async () => {
    const { ctx } = setup();
    expect(await sweepJpSec({ ...ctx, secHttp: null })).toEqual([]);
  });
});
