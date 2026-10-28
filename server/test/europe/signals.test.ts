import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { getEuropeReport, recordEuropeRelease, syncEuropeUniverse, upsertEuropeCalendarRow } from '../../src/europe/db/europeRepo.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { refreshDilaSignals, refreshPrnSignals } from '../../src/europe/jobs/signals.js';
import type { ExchangeId } from '../../src/europe/exchanges.js';
import { parsePrnRss, prnReleaseKey, type PrnItem } from '../../src/europe/sources/prnewswire.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/europe/feeds/${n}`, import.meta.url));
// Task 3 live feeds: Pearson's 07:00 BST nine-month update is in both (06:10 UTC, .co.uk link in each).
const UK_FEED = parsePrnRss(fx('prn_uk.rss').toString('utf8'));
const EU_FEED = parsePrnRss(fx('prn_eu.rss').toString('utf8'));
const NOW = '2026-10-28T09:00:00.000Z';

const EXCH: Record<string, ExchangeId> = { L: 'LSE', ST: 'STO', PA: 'PAR' };
const entry = (symbol: string, isin: string, name: string, lei: string | null = null): EuropeUniverseEntry => {
  const exchange = EXCH[symbol.split('.').pop()!]!;
  return {
    market: exchange === 'LSE' ? 'UK' : 'EU', symbol, isin, lei, name, exchange, mic: { LSE: 'XLON', STO: 'XSTO', PAR: 'XPAR' }[exchange as 'LSE'], country: isin.slice(0, 2),
    currency: exchange === 'LSE' ? 'GBp' : 'EUR', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
  };
};

// The jobs log expected source failures (trackIn); keep the test output clean.
afterEach(() => { vi.restoreAllMocks(); });
const quiet = () => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };

function setup(o: { uk?: PrnItem[]; eu?: PrnItem[]; dila?: EuropeJobContext['dila']; today?: string } = {}) {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [
    entry('PSON.L', 'GB0006776081', 'Pearson plc'),
    entry('ACME.L', 'GB00B0000001', 'Acme plc'),
  ], NOW);
  syncEuropeUniverse(db, 'EU', [
    entry('SECU-B.ST', 'SE0000163594', 'Securitas AB', 'LEI00000000000000SEC'),
    entry('SECX.PA', 'FR0000000001', 'Securitas', 'LEI00000000000000SXP'),
    entry('ERIC-A.ST', 'SE0000108649', 'Ericsson', 'LEI00000000000000ERI'),
    entry('ERIC-B.ST', 'SE0000108656', 'Ericsson', 'LEI00000000000000ERI'),
    entry('NANO.PA', 'FR0011341205', 'Nanobiotix'),
    entry('ALHYP.PA', 'FR0012821916', 'HiPay Group'),
    entry('SGO.PA', 'FR0000125007', 'Compagnie de Saint-Gobain'),
    entry('EXA.PA', 'FR0000062671', 'Exail Technologies'),
    entry('ALCJ.PA', 'FR0011716265', 'Crossject'),
    entry('VK.PA', 'FR0013506730', 'Vallourec'),
  ], NOW);
  const row = (symbol: string, reportDate: string) => {
    const exchange = EXCH[symbol.split('.').pop()!]!;
    return upsertEuropeCalendarRow(db, exchange === 'LSE' ? 'UK' : 'EU', {
      symbol, name: symbol, exchange, period: { periodEnd: '2026-09-30', fiscalQuarter: 3, fyEnd: '2026-12-31' }, periodLabel: 'Q3 FY26',
      periodConfirmed: false, reportDate, dateStatus: 'estimated',
    }, NOW);
  };
  const ctx = (market: 'UK' | 'EU') => ({
    db, market, now: () => NOW, today: () => o.today ?? '2026-10-28',
    prnFeed: async () => (market === 'UK' ? o.uk ?? UK_FEED : o.eu ?? EU_FEED),
    dila: market === 'EU' ? o.dila ?? null : null,
  }) as unknown as EuropeJobContext;
  const outcome = (source: string, id: string) =>
    (db.prepare('SELECT outcome FROM europe_signal_seen WHERE source = ? AND item_id = ?').get(source, id) as { outcome: string } | undefined)?.outcome;
  return { db, row, ctx, outcome };
}

async function* chunks(buf: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

const item = (title: string, publishedAt: string, contributor: string | null, n: number, description = ''): PrnItem => {
  const link = `https://www.prnewswire.co.uk/news-releases/x-${300000000 + n}.html`;
  return { id: link, title, link, publishedAt, description, contributor };
};

describe('refreshPrnSignals', () => {
  it('results item for one matched issuer with a row tomorrow flips; timing from pubDate in London', async () => {
    const { db, row, ctx, outcome } = setup();
    const id = row('PSON.L', '2026-10-23');
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([id]);
    expect(getEuropeReport(db, id)).toMatchObject({
      releasedAt: '2026-10-22T06:10:00.000Z', releasedSource: 'prn',
      signalTitle: 'Pearson 2026 Nine Month Trading Update (Unaudited)',
      signalUrl: 'https://www.prnewswire.co.uk/news-releases/pearson-2026-nine-month-trading-update-unaudited-302915984.html',
      // 06:10 UTC is 07:10 BST, and 06:30 BST (40 minutes earlier, the feed's lag) is also before the 08:00 open.
      timing: 'BMO', timingSource: 'prn',
    });
    expect(outcome('prn', 'prn:302915984')).toBe('flipped');
  });

  it('a pubDate whose 40-minute lag window spans the open flips but leaves timing unknown', async () => {
    // 07:20 UTC = 08:20 BST (after the 08:00 open) but the release may have been at 07:40 BST (before it).
    const { db, row, ctx } = setup({ uk: [item('Acme plc Half-year results', '2026-10-22T07:20:00Z', 'Acme plc', 1)] });
    const id = row('ACME.L', '2026-10-22');
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([id]);
    expect(getEuropeReport(db, id)).toMatchObject({ releasedAt: '2026-10-22T07:20:00Z', releasedSource: 'prn', timing: 'UNKNOWN', timingSource: null });
  });

  it('two issuers with one normalised name → ambiguous, no flip', async () => {
    const { db, row, ctx, outcome } = setup();
    const a = row('SECU-B.ST', '2026-10-24');
    const b = row('SECX.PA', '2026-10-24');
    // Ericsson A and B share one LEI: one company, so both of its lines flip (07:32 CEST, before the 09:00 open).
    const ea = row('ERIC-A.ST', '2026-10-15');
    const eb = row('ERIC-B.ST', '2026-10-15');
    const changed = await refreshPrnSignals(ctx('EU'));
    expect(changed).not.toContain(a);
    expect(changed).not.toContain(b);
    expect(getEuropeReport(db, a)!.releasedAt).toBeNull();
    expect(getEuropeReport(db, b)!.releasedAt).toBeNull();
    const sec = EU_FEED.find((i) => i.contributor === 'Securitas')!;
    expect(outcome('prn', prnReleaseKey(sec.link))).toBe('ambiguous');
    expect(changed).toEqual(expect.arrayContaining([ea, eb]));
    for (const id of [ea, eb]) {
      expect(getEuropeReport(db, id)).toMatchObject({ releasedAt: '2026-10-15T05:32:00.000Z', releasedSource: 'prn', timing: 'BMO' });
    }
  });

  it('no row within ±3 days → no flip', async () => {
    const { db, row, ctx, outcome } = setup();
    const id = row('PSON.L', '2026-10-26'); // 4 days after the 10-22 item
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([]);
    expect(getEuropeReport(db, id)!.releasedAt).toBeNull();
    expect(outcome('prn', 'prn:302915984')).toBe('no-row');
  });

  it('"to announce results on" → not-results', async () => {
    const { db, row, ctx, outcome } = setup({
      uk: [item('Acme plc to announce half-year results on 23 October', '2026-10-22T06:00:00Z', 'Acme plc', 2)],
    });
    const id = row('ACME.L', '2026-10-23');
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([]);
    expect(getEuropeReport(db, id)!.releasedAt).toBeNull();
    expect(outcome('prn', 'prn:300000002')).toBe('not-results');
  });

  it('an unknown issuer is no-match; an ISIN in the text matches when the name does not', async () => {
    const { db, row, ctx, outcome } = setup({
      uk: [
        item('Zeta plc Interim results', '2026-10-22T06:00:00Z', 'Zeta plc', 3),
        item('Interim results', '2026-10-22T06:00:00Z', 'Some Sender Ltd', 4, 'ISIN: GB00B0000001'),
      ],
    });
    const id = row('ACME.L', '2026-10-22');
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([id]);
    expect(outcome('prn', 'prn:300000003')).toBe('no-match');
    expect(outcome('prn', 'prn:300000004')).toBe('flipped');
    expect(getEuropeReport(db, id)!.releasedSource).toBe('prn');
  });

  it('item seen once', async () => {
    const { db, row, ctx } = setup();
    const id = row('PSON.L', '2026-10-23');
    // Pearson is in the UK and the EU feed: the UK run handles it, the EU run skips it, a second UK run too.
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([id]);
    db.prepare('UPDATE europe_reports SET released_at = NULL, released_source = NULL WHERE id = ?').run(id);
    expect(await refreshPrnSignals(ctx('EU'))).not.toContain(id);
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([]);
    expect(getEuropeReport(db, id)!.releasedAt).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM europe_signal_seen WHERE source = 'prn' AND item_id = 'prn:302915984'").get() as { n: number }).n).toBe(1);
  });

  it('a PRN item after an earlier release stamps only the timing; the release stays the earliest', async () => {
    const { db, row, ctx, outcome } = setup();
    const id = row('PSON.L', '2026-10-23');
    // A DILA-style signal at 06:00Z, before the Pearson PRN item (06:10Z).
    recordEuropeRelease(db, id, { at: '2026-10-22T06:00:00.000Z', source: 'dila', timing: null, title: 'earlier', url: null });
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([id]);
    expect(getEuropeReport(db, id)).toMatchObject({
      releasedAt: '2026-10-22T06:00:00.000Z', releasedSource: 'dila', signalTitle: 'earlier', timing: 'BMO', timingSource: 'prn',
    });
    expect(outcome('prn', 'prn:302915984')).toBe('timing');
  });

  it('a PRN item whose lag window spans the open, after an earlier release, changes nothing', async () => {
    const { db, row, ctx, outcome } = setup({ uk: [item('Acme plc Half-year results', '2026-10-22T07:20:00Z', 'Acme plc', 5)] });
    const id = row('ACME.L', '2026-10-22');
    recordEuropeRelease(db, id, { at: '2026-10-22T06:00:00.000Z', source: 'dila', timing: null });
    expect(await refreshPrnSignals(ctx('UK'))).toEqual([]);
    expect(getEuropeReport(db, id)).toMatchObject({ releasedSource: 'dila', timing: 'UNKNOWN' });
    expect(outcome('prn', 'prn:300000005')).toBe('timing');
  });

  it('a feed failure marks nothing', async () => {
    quiet();
    const { db, ctx } = setup();
    const c = { ...ctx('UK'), prnFeed: async () => { throw new Error('PRN 503'); } } as EuropeJobContext;
    expect(await refreshPrnSignals(c)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM europe_signal_seen").get() as { n: number }).n).toBe(0);
  });
});

describe('refreshDilaSignals', () => {
  it('DILA results doc flips the French row; non-results doc does not; DILA never sets timing', async () => {
    const press = new Uint8Array(fx('dila_sample_press.tar.gz'));
    const annual = new Uint8Array(fx('dila_sample.tar.gz'));
    const opened: string[] = [];
    const dila = {
      list: async (day: string) => (day === '2026-03-25'
        ? ['amf-gz_25032026_0800.tar.gz', 'amf-gz_25032026_1000.tar.gz', 'amf-gz_25032026_2200.tar.gz'] : []),
      // The first two batches hold the same records: each document counts once (by id). The third holds Nanobiotix's
      // 003000 (annual financial report type) record, which is not a results type (controller ruling).
      archive: async (name: string) => { opened.push(name); return chunks(name.endsWith('2200.tar.gz') ? annual : press, 64 * 1024); },
    };
    const { db, ctx, outcome } = setup({ dila, today: '2026-03-25' });
    const fy = (symbol: string, reportDate: string) => upsertEuropeCalendarRow(db, 'EU', {
      symbol, name: symbol, exchange: 'PAR', period: { periodEnd: '2025-12-31', fiscalQuarter: 4, fyEnd: '2025-12-31' },
      periodLabel: 'FY25', periodConfirmed: false, reportDate, dateStatus: 'estimated',
    }, NOW);
    const crossject = fy('ALCJ.PA', '2026-03-25');
    const vallourec = fy('VK.PA', '2026-03-25');
    const nano = fy('NANO.PA', '2026-03-27');
    // Crossject's 001007 results release, filed 07:20 Paris (before the open): released, timing still unknown.
    expect(await refreshDilaSignals(ctx('EU'))).toEqual([crossject]);
    expect(getEuropeReport(db, crossject)).toMatchObject({
      releasedAt: '2026-03-25T06:20:00.000Z', releasedSource: 'dila', timing: 'UNKNOWN', timingSource: null,
    });
    // Vallourec's 001006 press releases and Nanobiotix's 003000 record flip nothing.
    expect(getEuropeReport(db, vallourec)!.releasedAt).toBeNull();
    expect(getEuropeReport(db, nano)!.releasedAt).toBeNull();
    expect(outcome('dila', 'MDMKW111969_20260331')).toBe('not-results');
    for (const f of ['amf-gz_25032026_0800.tar.gz', 'amf-gz_25032026_1000.tar.gz', 'amf-gz_25032026_2200.tar.gz']) {
      expect(outcome('dila-file', f)).toBe('done');
    }
    // A file already read is not downloaded again.
    expect(await refreshDilaSignals(ctx('EU'))).toEqual([]);
    expect(opened).toHaveLength(3);
    // UK has no DILA.
    expect(await refreshDilaSignals(ctx('UK'))).toEqual([]);
  });

  it('a failed archive is not marked, so the next run reads it again', async () => {
    quiet();
    let fail = true;
    const tar = new Uint8Array(fx('dila_sample_press.tar.gz'));
    const dila = {
      list: async () => ['amf-gz_25032026_0800.tar.gz'],
      archive: async () => {
        if (fail) return (async function* () { yield tar.subarray(0, 1000); throw new Error('reset'); })();
        return chunks(tar, 64 * 1024);
      },
    };
    const { db, ctx, outcome } = setup({ dila, today: '2026-03-25' });
    const crossject = upsertEuropeCalendarRow(db, 'EU', {
      symbol: 'ALCJ.PA', name: 'Crossject', exchange: 'PAR', period: { periodEnd: '2025-12-31', fiscalQuarter: 4, fyEnd: '2025-12-31' },
      periodLabel: 'FY25', periodConfirmed: false, reportDate: '2026-03-25', dateStatus: 'estimated',
    }, NOW);
    expect(await refreshDilaSignals(ctx('EU'))).toEqual([]);
    expect(outcome('dila-file', 'amf-gz_25032026_0800.tar.gz')).toBeUndefined();
    fail = false;
    expect(await refreshDilaSignals(ctx('EU'))).toEqual([crossject]);
  });

  it('an ISIN can name only one EU line (schema UNIQUE (market, isin)); the job flips only that line', async () => {
    const tar = new Uint8Array(fx('dila_sample_press.tar.gz'));
    const dila = { list: async () => ['amf-gz_25032026_0800.tar.gz'], archive: async () => chunks(tar, 64 * 1024) };
    const { db, ctx } = setup({ dila, today: '2026-03-25' });
    // A second line with Crossject's ISIN is refused by the table, so two lines can never share it. The job still
    // asks for every line (activeEuropeStocksByIsin) and marks `ambiguous` on more than one, as a guard.
    expect(() => db.prepare("UPDATE europe_stocks SET isin = 'FR0011716265' WHERE symbol = 'VK.PA'").run()).toThrow(/UNIQUE/);
    const fy = (symbol: string) => upsertEuropeCalendarRow(db, 'EU', {
      symbol, name: symbol, exchange: 'PAR', period: { periodEnd: '2025-12-31', fiscalQuarter: 4, fyEnd: '2025-12-31' },
      periodLabel: 'FY25', periodConfirmed: false, reportDate: '2026-03-25', dateStatus: 'estimated',
    }, NOW);
    const a = fy('ALCJ.PA');
    const b = fy('VK.PA');
    expect(await refreshDilaSignals(ctx('EU'))).toEqual([a]);
    expect(getEuropeReport(db, b)!.releasedAt).toBeNull();
  });

  it('live 005002 (quarterly sales) flips its row; live 004000 (half-year financial report) flips nothing', async () => {
    // Saved as-is from the 27 and 26 Oct 2026 DILA batches (Task 16).
    const tar = tarOf({
      'xml/ECO/2026/10/MDECO083570_20261027.xml': fx('dila_005002_MDECO083570_20261027.xml').toString('utf8'),
      'xml/ACT/2026/10/MDACT081985_20261026.xml': fx('dila_004000_MDACT081985_20261026.xml').toString('utf8'),
    });
    const dila = { list: async () => ['amf-gz_27102026_1800.tar.gz'], archive: async () => chunks(tar, 4096) };
    const { db, ctx, outcome } = setup({ dila, today: '2026-10-27' });
    const q3 = (symbol: string, reportDate: string) => upsertEuropeCalendarRow(db, 'EU', {
      symbol, name: symbol, exchange: 'PAR', period: { periodEnd: '2026-09-30', fiscalQuarter: 3, fyEnd: '2026-12-31' }, periodLabel: 'Q3 FY26',
      periodConfirmed: false, reportDate, dateStatus: 'estimated',
    }, NOW);
    const sgo = q3('SGO.PA', '2026-10-27');
    // Exail's row is within ±3 days of its 26 Oct filing: only the document type keeps it unflipped.
    const exa = q3('EXA.PA', '2026-10-28');
    expect(await refreshDilaSignals(ctx('EU'))).toEqual([sgo]);
    expect(getEuropeReport(db, sgo)).toMatchObject({
      releasedAt: '2026-10-27T16:01:21.000Z', releasedSource: 'dila', signalTitle: 'Chiffre d’affaires du 3e trimestre 2026', timing: 'UNKNOWN',
    });
    expect(getEuropeReport(db, exa)!.releasedAt).toBeNull();
    expect(outcome('dila', 'MDACT081985_20261026')).toBe('not-results');
    expect(outcome('dila', 'MDECO083570_20261027')).toBe('flipped');
  });
});

function tarOf(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const put = (h: Uint8Array, off: number, s: string) => h.set(enc.encode(s), off);
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    put(h, 0, name);
    put(h, 100, '0000644\0');
    put(h, 108, '0000000\0');
    put(h, 116, '0000000\0');
    put(h, 124, data.length.toString(8).padStart(11, '0') + '\0');
    put(h, 136, '00000000000\0');
    put(h, 148, '        ');
    put(h, 156, '0');
    put(h, 257, 'ustar\0');
    put(h, 263, '00');
    const sum = h.reduce((a, b) => a + b, 0);
    put(h, 148, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
