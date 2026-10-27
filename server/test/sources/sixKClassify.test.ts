import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFilingDocs } from '../../src/sources/secFeed.js';
import { classifySixK, parseDateNoticeFor, pickReleaseDoc } from '../../src/sources/sixKClassify.js';

const jp = (n: string) => readFileSync(new URL(`../fixtures/jp/${n}`, import.meta.url), 'utf8');
const hk = (n: string) => readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8');

/**
 * Saved from EDGAR on 2026-10-27. Filing dates are the JST date of the SEC "Accepted" time (ET) on the index page:
 * - Toyota 0001193125-26-331392 (EX-99.1 "FY2027 First Quarter Financial Summary"), accepted 2026-08-04 06:03 ET.
 * - MUFG 0001193125-26-329414 (6-K "Consolidated Summary Report … three months ended June 30, 2026"), 2026-08-03.
 * - Sony 0001104659-26-088915 (6-K "Consolidated Financial Summary for the First Quarter Ended June 30, 2026"), 2026-07-31.
 * - Mizuho 0001193125-26-329443 (6-K "Notice regarding Progress of Repurchase of Our Common Stock"), 2026-08-03.
 * - Takeda 0001395064-24-000167 (6-K "(English Translation) Semi-annual Securities Report For The Six-month Period
 *   Ended September 30, 2024"), accepted 2024-10-31 06:28 ET.
 * - Nomura 0001193125-26-393642 (6-K "Nomura to Announce Second Quarter Operating Results on October 28"), accepted
 *   2026-09-17 06:01 ET. The only date notices among the 8 full-level filers' 6-Ks since 2024-10-27 are Nomura's.
 */
const TOYOTA_FILED = '2026-08-04';
const MUFG_FILED = '2026-08-03';
const SONY_FILED = '2026-07-31';

describe("classifySixK, profile 'jp'", () => {
  it('Toyota release is results for its quarter end', () => {
    const docs = parseFilingDocs(jp('sec_index_toyota_1q_fy27.htm'), 'https://www.sec.gov/Archives/edgar/data/1094517/000119312526331392/0001193125-26-331392-index.htm');
    expect(pickReleaseDoc(docs)).toBe('https://www.sec.gov/Archives/edgar/data/1094517/000119312526331392/d258414dex991.htm');
    expect(classifySixK(jp('toyota_1q_fy27_ex991.htm'), { filedOn: TOYOTA_FILED, profile: 'jp' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('bank summary report is results', () => {
    expect(classifySixK(jp('mufg_1q_fy26_summary_6k.htm'), { filedOn: MUFG_FILED, profile: 'jp' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('Sony financial summary is results', () => {
    expect(classifySixK(jp('sony_1q_fy26_summary_6k.htm'), { filedOn: SONY_FILED, profile: 'jp' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('buyback 6-K is other', () => {
    expect(classifySixK(jp('mizuho_buyback_progress_6k.htm'), { filedOn: '2026-08-03', profile: 'jp' })).toEqual({ kind: 'other' });
  });

  it("a period ending after filing is never this release's", () => {
    // Filed one day before the quarter end it reports: no period remains, so it is not results.
    expect(classifySixK(jp('toyota_1q_fy27_ex991.htm'), { filedOn: '2026-06-29', profile: 'jp' }).kind).not.toBe('results');
  });

  it('Annual Securities Report 6-K is other', () => {
    // An EDINET semi-annual report translation states the half's figures (with revenue and per-share rows).
    expect(classifySixK(jp('takeda_semiannual_securities_report_6k.htm'), { filedOn: '2024-10-31', profile: 'jp' })).toEqual({ kind: 'other' });
  });

  it('a report titled as an EDINET securities report is other; a filing schedule line is not a title', () => {
    const doc = (title: string) => `<p>${title}</p><p>Consolidated financial results for the three months ended June 30, 2026</p>
      <table><tr><td></td><td>Three months ended June 30, 2026</td></tr><tr><td>Revenue</td><td>1,234</td></tr></table>`;
    expect(classifySixK(doc('(English Translation) Annual Securities Report for the fiscal year ended March 31, 2026'), { filedOn: '2026-08-05', profile: 'jp' }))
      .toEqual({ kind: 'other' });
    expect(classifySixK(doc('Scheduled date to file the Semi-Annual Securities Report: November 12, 2026'), { filedOn: '2026-08-05', profile: 'jp' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('Toyota full-year summary is results for the year', () => {
    // 0001193125-26-213363 EX-99.1 "FY2026 Financial Summary", filed 2026-05-08.
    expect(classifySixK(jp('toyota_fy26_ex991.htm'), { filedOn: '2026-05-08', profile: 'jp' }))
      .toEqual({ kind: 'results', periodEnd: '2026-03-31', span: 'year' });
  });

  it("Nomura's date notice: 15:30 in Tokyo is during market hours", () => {
    const docs = parseFilingDocs(jp('sec_index_nomura_date_notice.htm'), 'https://www.sec.gov/Archives/edgar/data/1163653/000119312526393642/0001193125-26-393642-index.htm');
    expect(pickReleaseDoc(docs)).toBe('https://www.sec.gov/Archives/edgar/data/1163653/000119312526393642/d140285d6k.htm');
    expect(classifySixK(jp('nomura_2q_date_notice_6k.htm'), { filedOn: '2026-09-17', profile: 'jp' }))
      .toEqual({ kind: 'date-notice', date: '2026-10-28', timing: 'DMH' });
  });

  it('month-range headers name the period end; the span follows the range length', () => {
    const release = (header: string) => `<p>Consolidated Summary Report for the second quarter of fiscal year 2026</p>
      <table><tr><td></td><td>${header}</td></tr><tr><td>Net revenue</td><td>1,234</td></tr></table>`;
    expect(classifySixK(release('Apr.-Sep. 2026'), { filedOn: '2026-11-10', profile: 'jp' })).toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'half' });
    expect(classifySixK(release('July–September 2026'), { filedOn: '2026-11-10', profile: 'jp' })).toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'quarter' });
    expect(classifySixK(release('Apr. ~ Dec. 2026'), { filedOn: '2027-02-10', profile: 'jp' })).toEqual({ kind: 'results', periodEnd: '2026-12-31', span: 'nine' });
    const nine = `<p>Consolidated Financial Results for the Nine Months Ended December 31, 2026</p>
      <table><tr><td>Revenue</td><td>1,234</td></tr></table>`;
    expect(classifySixK(nine, { filedOn: '2027-02-10', profile: 'jp' })).toEqual({ kind: 'results', periodEnd: '2026-12-31', span: 'nine' });
  });
});

describe("parseDateNoticeFor 'jp'", () => {
  it('Tokyo clock: "at 3:00 p.m. Japan time on November 5, 2026" → 2026-11-05 DMH', () => {
    const t = 'Toyota Motor Corporation will announce its financial results for the second quarter of the fiscal year ending March 31, 2027 at 3:00 p.m. Japan time on November 5, 2026.';
    expect(parseDateNoticeFor(t, 'jp')).toEqual({ date: '2026-11-05', timing: 'DMH' });
    expect(parseDateNoticeFor(t.replace('3:00 p.m. Japan time', '4:00 p.m. (JST)'), 'jp')).toEqual({ date: '2026-11-05', timing: 'AMC' });
    expect(parseDateNoticeFor(t.replace('3:00 p.m. Japan time', '8:30 a.m. Tokyo time'), 'jp')).toEqual({ date: '2026-11-05', timing: 'BMO' });
    expect(parseDateNoticeFor(t.replace('3:00 p.m. Japan time', '15:30 JST'), 'jp')).toEqual({ date: '2026-11-05', timing: 'DMH' });
  });

  it('"after the close of the Tokyo Stock Exchange on November 5, 2026" → AMC', () => {
    const t = 'Sony Group Corporation will announce its consolidated financial results for the second quarter after the close of the Tokyo Stock Exchange on November 5, 2026.';
    expect(parseDateNoticeFor(t, 'jp')).toEqual({ date: '2026-11-05', timing: 'AMC' });
    expect(parseDateNoticeFor(t.replace('after the close of the Tokyo Stock Exchange', 'before the opening of trading on the TSE'), 'jp'))
      .toEqual({ date: '2026-11-05', timing: 'BMO' });
    expect(parseDateNoticeFor(t.replace('after the close of the Tokyo Stock Exchange', 'before the opening of the TSE'), 'jp'))
      .toEqual({ date: '2026-11-05', timing: 'BMO' });
    // The HK profile does not know the Tokyo exchange.
    expect(parseDateNoticeFor(t, 'hk')).toEqual({ date: '2026-11-05', timing: 'UNKNOWN' });
  });

  it('"before the U.S. market opens on November 5, 2026" → 2026-11-05 AMC', () => {
    const t = 'Honda will report its financial results for the second quarter of fiscal year 2027 before the U.S. market opens on November 5, 2026.';
    expect(parseDateNoticeFor(t, 'jp')).toEqual({ date: '2026-11-05', timing: 'AMC' });
  });

  it("notice date and timing come from the verb's own sentence", () => {
    const t = 'MUFG will announce its financial results for the six months ended September 30, 2026 on November 13, 2026. '
      + 'The ordinary general meeting of shareholders will be held at 10:00 a.m. Japan time on June 26, 2027.';
    expect(parseDateNoticeFor(t, 'jp')).toEqual({ date: '2026-11-13', timing: 'UNKNOWN' });
  });
});

describe("classifySixK, profile 'hk'", () => {
  it('hk profile never returns span nine', () => {
    expect(classifySixK(hk('baba_results_ex99.htm'), { filedOn: '2026-08-20', profile: 'hk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
    // A nine-month column alone names no HK span.
    const nine = `<p>Acme announces third quarter results for the nine months ended September 30, 2026.</p>
      <table><tr><td>Revenue</td><td>1,234</td></tr></table>`;
    expect(classifySixK(nine, { filedOn: '2026-11-10', profile: 'hk' })).not.toMatchObject({ span: 'nine' });
    expect(classifySixK(nine, { filedOn: '2026-11-10', profile: 'jp' })).toMatchObject({ span: 'nine' });
  });
});
