import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { openDb } from '../../src/db/repo.js';
import { getHkReport, markSecSeen, secSeen, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import { sweepHkSec } from '../../src/hk/jobs/secSweep.js';
import type { HkJobContext } from '../../src/hk/jobs/context.js';
import { handleHkFiling, HkSecWatch } from '../../src/hk/live/hkSecWatch.js';
import { HK_UNIVERSE, type HkUniverseEntry } from '../../src/hk/universe.js';
import { HttpError, type Http } from '../../src/sources/http.js';
import type { SecFeedItem } from '../../src/sources/secFeed.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8');

const NOW = '2026-08-28T12:00:00.000Z';
const FEED_6K = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=6-K&company=&dateb=&owner=include&start=0&count=100&output=atom';

// Alibaba results 6-K (Task 6 fixtures).
const BABA_CIK = 1577552;
const BABA_ACC = '0001104659-26-099220';
const BABA_DIR = 'https://www.sec.gov/Archives/edgar/data/1577552/000110465926099220';
const BABA_INDEX = `${BABA_DIR}/${BABA_ACC}-index.htm`;
const BABA_EX99 = `${BABA_DIR}/tm2623667d1_ex99-1.htm`;
// Tencent Music date notice.
const TME_CIK = 1744676;
const TME_ACC = '0000950103-26-015462';
const TME_DIR = 'https://www.sec.gov/Archives/edgar/data/1744676/000095010326015462';
const TME_INDEX = `${TME_DIR}/${TME_ACC}-index.htm`;

const BASE_DOCS: Record<string, string> = {
  [BABA_INDEX]: fx('sec_index_baba_results.htm'),
  [BABA_EX99]: fx('baba_results_ex99.htm'),
  [`${BABA_DIR}/tm2623667d1_6k.htm`]: '<html><body>Form 6-K cover</body></html>',
  [TME_INDEX]: fx('sec_index_tme_datenotice.htm'),
  [`${TME_DIR}/dp254872_ex9901.htm`]: fx('tme_date_notice_ex99.htm'),
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

function setup(opts: { today?: string; docs?: Record<string, string>; universe?: readonly HkUniverseEntry[]; now?: string } = {}) {
  const db = openDb(':memory:');
  syncHkUniverse(db, opts.universe ?? HK_UNIVERSE, NOW);
  const { http, requested } = stubHttp({ ...BASE_DOCS, ...opts.docs });
  const ctx: HkJobContext = {
    db, now: () => opts.now ?? NOW, todayHKT: () => opts.today ?? '2026-08-28',
    yahoo: async () => null, yahooPastDates: async () => [], yahooCloses: async () => new Map(), optionChain: async () => null,
    secHttp: http,
  };
  return { db, ctx, http, requested };
}

const row = (db: ReturnType<typeof openDb>, code: string, periodEnd: string, reportDate: string, label = 'Q2 26', kind: 'Q' | 'H' | 'FY' = 'Q') =>
  upsertHkCalendarRow(db, { code, name: code, periodEnd, periodKind: kind, periodLabel: label, reportDate, dateStatus: 'estimated' }, NOW);

const raw = (db: ReturnType<typeof openDb>, id: number) =>
  db.prepare('SELECT * FROM hk_reports WHERE id = ?').get(id) as Record<string, unknown>;

const GATES_CLOSED = { ...config.fastFields, hkEps: false, hkRevenue: false };
const GATES_OPEN = { ...config.fastFields, hkEps: true, hkRevenue: true };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('HkSecWatch.tick', () => {
  it('a results 6-K for a full-level CIK flips the matching period row and sets releasedAt', async () => {
    // Accepted 06:30 ET = 18:30 HKT on 08-28; the row was estimated for 08-27, so it moves to the HKT date.
    const { db, ctx, http } = setup({ docs: { [FEED_6K]: feed(entry('6-K', BABA_CIK, BABA_ACC, '2026-08-28T06:30:00-04:00', BABA_INDEX)) } });
    const id = row(db, '9988', '2026-06-30', '2026-08-27');
    const other = row(db, '9618', '2026-06-30', '2026-08-28');
    const onReleased = vi.fn();
    const ids = await new HkSecWatch(ctx, http, onReleased).tick();
    expect(ids).toEqual([id]);
    expect(onReleased).toHaveBeenCalledWith([id]);
    const r = getHkReport(db, id)!;
    expect(r.releasedAt).toBe('2026-08-28T10:30:00.000Z');
    expect(r.reportDate).toBe('2026-08-28');
    expect(r.rescheduledFrom).toBe('2026-08-27');
    expect(getHkReport(db, other)!.releasedAt).toBeNull();
    expect(secSeen(db, BABA_ACC)).toBe(true);
  });

  it('a 6-K for a non-universe CIK fetches nothing', async () => {
    // The saved feed holds 100 foreign filers; with only BABA and TME in the universe none of them is fetched.
    const universe = HK_UNIVERSE.filter((e) => e.code === '9988' || e.code === '1698');
    const { ctx, http, requested } = setup({ universe, docs: { [FEED_6K]: fx('sec_getcurrent_6k.xml') } });
    expect(await new HkSecWatch(ctx, http, vi.fn()).tick()).toEqual([]);
    expect(requested).toEqual([FEED_6K]);
  });

  it("a release for another period never flips today's row", async () => {
    // The June-quarter release arrives while the September quarter is the row dated today: nothing flips.
    const { db, ctx, http } = setup({
      today: '2026-11-13',
      docs: { [FEED_6K]: feed(entry('6-K', BABA_CIK, BABA_ACC, '2026-11-13T06:30:00-05:00', BABA_INDEX)) },
    });
    const q3 = row(db, '9988', '2026-09-30', '2026-11-13', 'Q3 26');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onReleased = vi.fn();
    expect(await new HkSecWatch(ctx, http, onReleased).tick()).toEqual([]);
    expect(onReleased).not.toHaveBeenCalled();
    expect(getHkReport(db, q3)).toMatchObject({ releasedAt: null, reportDate: '2026-11-13' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM hk_reports WHERE code = '9988'").get()).toEqual({ n: 1 });
    expect(secSeen(db, BABA_ACC)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/9988: 6-K .* results for 2026-06-30, no row with that period end/));
  });

  it('a date notice confirms the date and sets timing', async () => {
    const { db, ctx, http } = setup({
      today: '2026-10-27',
      docs: { [FEED_6K]: feed(entry('6-K', TME_CIK, TME_ACC, '2026-10-27T06:05:00-04:00', TME_INDEX)) },
    });
    const id = row(db, '1698', '2026-09-30', '2026-11-17', 'Q3 26');
    await new HkSecWatch(ctx, http, vi.fn()).tick();
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-11-17', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'sec-notice', releasedAt: null });
    expect(secSeen(db, TME_ACC)).toBe(true);
  });

  it('acceptance at 19:30 HKT never sets AMC', async () => {
    // 07:30 ET = 19:30 HKT on the report date: an upper bound on the release time, so the timing stays unknown.
    const { db, ctx, http } = setup({ docs: { [FEED_6K]: feed(entry('6-K', BABA_CIK, BABA_ACC, '2026-08-28T07:30:00-04:00', BABA_INDEX)) } });
    const id = row(db, '9988', '2026-06-30', '2026-08-28');
    await new HkSecWatch(ctx, http, vi.fn()).tick();
    expect(getHkReport(db, id)).toMatchObject({ timing: 'UNKNOWN', releasedAt: '2026-08-28T11:30:00.000Z', reportDate: '2026-08-28' });
  });

  it('feed cadence: 2 s when a full-level report is due within HK today−1..+3, else 30 s', async () => {
    vi.useFakeTimers();
    const due = setup({ today: '2026-08-26', docs: { [FEED_6K]: feed() } });
    row(due.db, '9988', '2026-06-30', '2026-08-29'); // today+3
    const w1 = new HkSecWatch(due.ctx, due.http, vi.fn());
    w1.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(due.requested.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(due.requested.length).toBe(2);
    w1.stop();

    const idle = setup({ today: '2026-08-20', docs: { [FEED_6K]: feed() } });
    row(idle.db, '9988', '2026-06-30', '2026-08-28'); // today+8: not due
    row(idle.db, '0700', '2026-06-30', '2026-08-21'); // basic level: never counts
    const w2 = new HkSecWatch(idle.ctx, idle.http, vi.fn());
    w2.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(idle.requested.length).toBe(0);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(idle.requested.length).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(idle.requested.length).toBe(2);
    w2.stop();
  });
});

describe('handleHkFiling gates', () => {
  const filing = { cik: BABA_CIK, accession: BABA_ACC, indexUrl: BABA_INDEX, acceptedAt: '2026-08-28T10:30:00.000Z', form: '6-K' };

  it('gate closed: flipped but no actuals stored', async () => {
    const { db, ctx } = setup();
    const id = row(db, '9988', '2026-06-30', '2026-08-28');
    expect(await handleHkFiling(ctx, filing, GATES_CLOSED)).toEqual({ released: [id], dated: [] });
    expect(raw(db, id)).toMatchObject({ released_at: '2026-08-28T10:30:00.000Z', eps_actual: null, revenue_actual: null, actual_source: null, sec_doc_url: null });
  });

  it('gate open: actuals stored with currency and basis', async () => {
    const { db, ctx } = setup();
    const id = row(db, '9988', '2026-06-30', '2026-08-28');
    expect(await handleHkFiling(ctx, filing, GATES_OPEN)).toEqual({ released: [id], dated: [] });
    expect(getHkReport(db, id)).toMatchObject({
      releasedAt: '2026-08-28T10:30:00.000Z', revenueActual: 268_953_000_000, revenueCurrency: 'CNY',
      epsActual: 0.46, epsCurrency: 'CNY', epsBasis: 'share', actualSource: 'sec', secDocUrl: BABA_EX99,
    });
  });

  it('only the open gate is written', async () => {
    const { db, ctx } = setup();
    const id = row(db, '9988', '2026-06-30', '2026-08-28');
    await handleHkFiling(ctx, filing, { ...GATES_CLOSED, hkEps: true });
    expect(getHkReport(db, id)).toMatchObject({ epsActual: 0.46, epsCurrency: 'CNY', revenueActual: null, revenueCurrency: null });
  });

  it('the acceptance date reaches the classifier: a period ending after acceptance is never the release period', async () => {
    // Served behind the BABA index page; the release names the FY and, in passing, a quarter ending after filing.
    const doc = '<p>Alibaba FY25 Results. For the year ended 31 December 2025. Our plan covers the quarter ended 31 March 2026.</p>'
      + '<table><tr><td>Revenue</td><td>1</td></tr></table>';
    const { db, ctx } = setup({ docs: { [BABA_EX99]: doc } });
    const fy = row(db, '9988', '2025-12-31', '2026-03-20', 'FY25', 'FY');
    const q1 = row(db, '9988', '2026-03-31', '2026-05-15', 'Q1 26');
    await handleHkFiling(ctx, { ...filing, acceptedAt: '2026-03-20T10:30:00.000Z' }, GATES_CLOSED);
    expect(getHkReport(db, fy)!.releasedAt).toBe('2026-03-20T10:30:00.000Z');
    expect(getHkReport(db, q1)!.releasedAt).toBeNull();
  });

  it("the stock's ADR ratio reaches the reader: NIO's combined per share/ADS row is per share only at ratio 1", async () => {
    // NIO Q2 2026 EX-99.1 (corpus fixture, 0001104659-26-104110): the only EPS row is "Net loss per share/ADS".
    // Served behind the BABA index page, whose EX-99.1 link is replaced by the NIO release.
    const NIO_CIK = 1736541;
    const nio = { ...filing, cik: NIO_CIK };
    const docs = { [BABA_EX99]: readFileSync(new URL('../fixtures/hk/releases/NIO_2026-06-30.htm', import.meta.url), 'utf8') };
    const run = async (adrRatio: number) => {
      const universe = HK_UNIVERSE.map((e) => (e.cik === NIO_CIK ? { ...e, adrRatio } : e));
      const { db, ctx } = setup({ docs, universe });
      const id = row(db, '9866', '2026-06-30', '2026-08-28');
      await handleHkFiling(ctx, nio, GATES_OPEN);
      return getHkReport(db, id)!;
    };
    expect(await run(1)).toMatchObject({ epsActual: -0.29, epsCurrency: 'CNY', epsBasis: 'share', revenueActual: 32_136_861_000 });
    expect(await run(2)).toMatchObject({ epsActual: null, epsBasis: null, revenueActual: 32_136_861_000 });
  });
});

describe('handleHkFiling: final review', () => {
  const filing = { cik: BABA_CIK, accession: BABA_ACC, indexUrl: BABA_INDEX, acceptedAt: '2026-08-28T10:30:00.000Z', form: '6-K' };
  const confirmed = (db: ReturnType<typeof openDb>, reportDate: string) =>
    upsertHkCalendarRow(db, { code: '9988', name: '9988', periodEnd: '2026-06-30', periodKind: 'Q', periodLabel: 'Q2 26', reportDate,
      dateStatus: 'confirmed', timing: 'AMC', timingSource: 'sec-notice' }, NOW);

  it('a late 6-K never moves a confirmed row later, and keeps its stated timing', async () => {
    const { db, ctx } = setup();
    const id = confirmed(db, '2026-08-27'); // accepted 18:30 HKT on 08-28: a day after the confirmed date
    await handleHkFiling(ctx, filing, GATES_CLOSED);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-08-27', dateStatus: 'confirmed', timing: 'AMC', timingSource: 'sec-notice', releasedAt: '2026-08-28T10:30:00.000Z', rescheduledFrom: null });
  });

  it('an early 6-K moves a confirmed row earlier without resetting its stated timing', async () => {
    const { db, ctx } = setup();
    const id = confirmed(db, '2026-08-29');
    await handleHkFiling(ctx, filing, GATES_CLOSED);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-08-28', rescheduledFrom: '2026-08-29', timing: 'AMC', timingSource: 'sec-notice' });
  });

  it('a later results 6-K for an already-released period does not re-read actuals or replace sec_doc_url', async () => {
    const LATER_INDEX = `${BABA_DIR}/0001104659-26-099999-index.htm`;
    const LATER_DOC = `${BABA_DIR}/later_ex99.htm`;
    const laterIndex = fx('sec_index_baba_results.htm').replaceAll('tm2623667d1_ex99-1.htm', 'later_ex99.htm');
    // Same release, but every revenue figure changed: re-reading would overwrite the stored actuals.
    const laterDoc = fx('baba_results_ex99.htm').replaceAll('268,953', '999,999');
    const { db, ctx } = setup({ docs: { [LATER_INDEX]: laterIndex, [LATER_DOC]: laterDoc } });
    const id = row(db, '9988', '2026-06-30', '2026-08-28');
    await handleHkFiling(ctx, filing, GATES_OPEN);
    const before = getHkReport(db, id)!;
    expect(before).toMatchObject({ revenueActual: 268_953_000_000, secDocUrl: BABA_EX99 });
    const r = await handleHkFiling(ctx, { ...filing, accession: '0001104659-26-099999', indexUrl: LATER_INDEX, acceptedAt: '2026-08-29T10:30:00.000Z' }, GATES_OPEN);
    expect(r.released).toEqual([]);
    expect(getHkReport(db, id)).toMatchObject({ revenueActual: 268_953_000_000, secDocUrl: BABA_EX99, releasedAt: '2026-08-28T10:30:00.000Z' });
    expect(secSeen(db, '0001104659-26-099999')).toBe(true);
  });

  it('a results 6-K arriving before its row exists creates the row (estimated, HKT date) and records the release', async () => {
    const { db, ctx } = setup();
    const r = await handleHkFiling(ctx, filing, GATES_CLOSED);
    const id = db.prepare("SELECT id FROM hk_reports WHERE code = '9988' AND period_end = '2026-06-30'").get() as { id: number } | undefined;
    expect(id).toBeDefined();
    expect(r.released).toEqual([id!.id]);
    expect(getHkReport(db, id!.id)).toMatchObject({
      periodKind: 'Q', periodLabel: 'Q2 26', reportDate: '2026-08-28', dateStatus: 'estimated', releasedAt: '2026-08-28T10:30:00.000Z',
    });
    expect(secSeen(db, BABA_ACC)).toBe(true);
  });

  it('a date notice whose date is before the filing date is ignored', async () => {
    // TME notice names 2026-11-17; accepted 2026-11-18 HKT.
    const { db, ctx } = setup({ today: '2026-11-18' });
    const id = row(db, '1698', '2026-09-30', '2026-11-20', 'Q3 26');
    const r = await handleHkFiling(ctx, { cik: TME_CIK, accession: TME_ACC, indexUrl: TME_INDEX, acceptedAt: '2026-11-18T02:00:00.000Z', form: '6-K' }, GATES_CLOSED);
    expect(r.dated).toEqual([]);
    expect(getHkReport(db, id)).toMatchObject({ reportDate: '2026-11-20', dateStatus: 'estimated', timing: 'UNKNOWN' });
    expect(secSeen(db, TME_ACC)).toBe(true);
  });
});

describe('sweepHkSec', () => {
  const submissions = (rows: { acc: string; date: string; form: string; items?: string; doc: string }[]) => JSON.stringify({
    filings: { recent: {
      accessionNumber: rows.map((r) => r.acc), filingDate: rows.map((r) => r.date), form: rows.map((r) => r.form),
      items: rows.map((r) => r.items ?? ''), primaryDocument: rows.map((r) => r.doc),
    } },
  });

  it('seen accessions are skipped by the sweep', async () => {
    const SEEN = '0001104659-26-099000';
    const OLD = '0001104659-26-050000';
    const { db, ctx, requested } = setup({
      today: '2026-08-29', universe: HK_UNIVERSE.filter((e) => e.code === '9988'),
      docs: {
        'https://data.sec.gov/submissions/CIK0001577552.json': submissions([
          { acc: BABA_ACC, date: '2026-08-28', form: '6-K', doc: 'tm2623667d1_6k.htm' },
          { acc: SEEN, date: '2026-08-27', form: '6-K', doc: 'x_6k.htm' },
          { acc: OLD, date: '2026-05-01', form: '6-K', doc: 'old_6k.htm' },
        ]),
        [`${BABA_DIR}/${BABA_ACC}.hdr.sgml`]: '<SEC-HEADER>\n<ACCEPTANCE-DATETIME>20260828063000\n</SEC-HEADER>',
      },
    });
    markSecSeen(db, SEEN, BABA_CIK, 'other', NOW);
    const id = row(db, '9988', '2026-06-30', '2026-08-28');
    expect(await sweepHkSec(ctx)).toEqual([id]);
    expect(getHkReport(db, id)!.releasedAt).toBe('2026-08-28T10:30:00.000Z');
    expect(requested.filter((u) => u.includes('099000') || u.includes('050000'))).toEqual([]);
  });

  it('every full-level CIK is swept, and a date notice filed up to 45 days ago is still read', async () => {
    // TME has no row at all; its notice (results on 2026-11-17) was filed 2026-10-20, 26 days before today.
    const universe = HK_UNIVERSE.filter((e) => e.code === '9988' || e.code === '1698');
    const { db, ctx, requested } = setup({
      today: '2026-11-15', universe,
      docs: {
        'https://data.sec.gov/submissions/CIK0001577552.json': submissions([]),
        'https://data.sec.gov/submissions/CIK0001744676.json': submissions([
          { acc: TME_ACC, date: '2026-10-20', form: '6-K', doc: 'dp254872_6k.htm' },
          { acc: '0000950103-26-000001', date: '2026-09-25', form: '6-K', doc: 'old_6k.htm' }, // 51 days back: not read
        ]),
        [`${TME_DIR}/${TME_ACC}.hdr.sgml`]: '<SEC-HEADER>\n<ACCEPTANCE-DATETIME>20261020060500\n</SEC-HEADER>',
      },
    });
    const ids = await sweepHkSec(ctx);
    expect(requested.filter((u) => u.includes('submissions')).sort()).toEqual([
      'https://data.sec.gov/submissions/CIK0001577552.json', 'https://data.sec.gov/submissions/CIK0001744676.json',
    ]);
    const tme = db.prepare("SELECT id, report_date, date_status, timing FROM hk_reports WHERE code = '1698'").get() as Record<string, unknown> | undefined;
    expect(tme).toMatchObject({ report_date: '2026-11-17', date_status: 'confirmed', timing: 'AMC' });
    expect(ids).toEqual([tme!.id]);
    expect(requested.some((u) => u.includes('000095010326000001'))).toBe(false);
  });
});

describe('HkSecWatch.onUsFeed', () => {
  it('8-K 2.02 for YUMC via onUsFeed flips the YUMC row', async () => {
    const dir = 'https://www.sec.gov/Archives/edgar/data/1673358/000167335826000050';
    const index = `${dir}/0001673358-26-000050-index.htm`;
    const indexHtml = `<table>
      <tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
      <tr><td>1</td><td>8-K</td><td><a href="/Archives/edgar/data/1673358/000167335826000050/yumc-8k.htm">yumc-8k.htm</a></td><td>8-K</td><td>1</td></tr>
      <tr><td>2</td><td>PRESS RELEASE</td><td><a href="/Archives/edgar/data/1673358/000167335826000050/yumc-ex991.htm">yumc-ex991.htm</a></td><td>EX-99.1</td><td>1</td></tr>
    </table>`;
    const release = `<p>Yum China Reports Third Quarter 2026 Results for the quarter ended September 30, 2026.</p>
      <table><tr><td></td><td>Quarter ended September 30, 2026</td></tr><tr><td></td><td>$</td></tr><tr><td>Total revenues</td><td>3,100</td></tr></table>`;
    const { db, ctx, http, requested } = setup({ today: '2026-11-04', docs: { [index]: indexHtml, [`${dir}/yumc-ex991.htm`]: release } });
    const id = row(db, '9987', '2026-09-30', '2026-11-04', 'Q3 26');
    const onReleased = vi.fn();
    const watch = new HkSecWatch(ctx, http, onReleased);
    const item = (over: Partial<SecFeedItem>): SecFeedItem => ({
      cik: 1673358, accession: '0001673358-26-000050', acceptedAt: '2026-11-04T21:05:00.000Z', items: ['2.02', '9.01'], indexUrl: index, form: '8-K', ...over,
    });
    const yumc = item({});
    const items = [
      yumc,
      item({ accession: '0001673358-26-000051', items: ['5.02'], indexUrl: `${dir}/other-index.htm` }), // not results
      item({ cik: 320193, accession: '0000320193-26-000001', indexUrl: 'https://www.sec.gov/Archives/edgar/data/320193/x/y-index.htm' }), // not HK
    ];
    watch.onUsFeed(items);
    watch.onUsFeed([yumc]); // at-least-once redelivery
    await vi.waitFor(() => expect(onReleased).toHaveBeenCalledWith([id]));
    await vi.waitFor(() => expect(secSeen(db, yumc.accession)).toBe(true));
    // After the US close on 11-04 (05:05 HKT on 11-05): HK date 11-05, before the HK open.
    expect(getHkReport(db, id)).toMatchObject({ releasedAt: '2026-11-04T21:05:00.000Z', reportDate: '2026-11-05', timing: 'BMO', timingSource: 'sec-8k' });
    expect(requested.filter((u) => u === index)).toEqual([index]);
    expect(requested.some((u) => u.includes('other-index') || u.includes('/320193/'))).toBe(false);
  });
});
