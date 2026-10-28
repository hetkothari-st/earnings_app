import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXCHANGES } from '../../src/europe/exchanges.js';
import { classifySixK, parseDateNoticeFor } from '../../src/sources/sixKClassify.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

/**
 * Saved from EDGAR (Task 4). Filing dates are the acceptance dates:
 * - AZN 0001654954-26-004047 (6-K "1st Quarter Results", Q1 2026), 2026-04-29.
 * - HSBC 2026 interim results 6-K (hk fixture), 2026-08-04.
 * - ASML 0001628280-26-065813 (EX-99.1, "2026 third-quarter results"), 2026-10-14.
 * - NVO 0000353278-26-000023 (6-K "Financial report for the period 1 January 2026 to 30 June 2026"), 2026-08-04.
 */
const AZN_FILED = '2026-04-29';
const HSBC_INTERIM_FILED = '2026-08-04';
const ASML_FILED = '2026-10-14';
const NVO_FILED = '2026-08-04';

/** Sessions as the caller passes them: the stock's exchange row. */
const session = (id: keyof typeof EXCHANGES) => ({ zone: EXCHANGES[id].zone, openMin: EXCHANGES[id].openMin, closeMin: EXCHANGES[id].closeMin });
const LSE = session('LSE');
const PAR = session('PAR');
const OSL = session('OSL');
const SIX = session('SIX');
const HEL = session('HEL');

/** Results and period end only; a dividend / buyback / voting-rights notice has neither. */
const RESULTS_TABLE = '<table><tr><td>Revenue</td><td>1,234</td></tr><tr><td>Earnings per share</td><td>0.12</td></tr></table>';

describe("classifySixK, profiles 'uk' and 'eu'", () => {
  it('AZN results 6-K is results for its quarter end', () => {
    expect(classifySixK(fx('europe/sec/azn_q1_2026_results_6k.htm'), { filedOn: AZN_FILED, profile: 'uk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-03-31', span: 'quarter' });
  });

  it('HSBC interim 6-K under profile uk: results, half', () => {
    expect(classifySixK(fx('hk/hsbc_interim_6k.htm'), { filedOn: HSBC_INTERIM_FILED, profile: 'uk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
    // HSBC 0001654954-26-009161, "Earnings Release 3Q26", 2026-10-27.
    expect(classifySixK(fx('europe/sec/hsbc_3q26_earnings_release_6k.htm'), { filedOn: '2026-10-27', profile: 'uk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'quarter' });
  });

  it('LOGI 8-K EX-99.1 (fiscal year ends March) under profile eu: results, quarter', () => {
    // 0001032975-26-000059, "Logitech Announces Q2 Fiscal Year 2027 Results", 2026-10-27.
    expect(classifySixK(fx('europe/sec/logi_q2_fy27_8k_ex991.htm'), { filedOn: '2026-10-27', profile: 'eu', fyEndMonth: 3 }))
      .toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'quarter' });
  });

  it('ASML Q3 6-K under profile eu: results, quarter', () => {
    expect(classifySixK(fx('europe/sec/asml_q3_2026_results_6k.htm'), { filedOn: ASML_FILED, profile: 'eu' }))
      .toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'quarter' });
  });

  it('NVO 9M release: results, nine', () => {
    // The real H1 report: "Financial report for the period 1 January 2026 to 30 June 2026" is the half, though it
    // also names "Q2 2026" (a quarter label never outranks a stated period at the same end).
    expect(classifySixK(fx('europe/sec/nvo_h1_2026_results_6k.htm'), { filedOn: NVO_FILED, profile: 'eu' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
    // The 9M report (not yet filed on 2026-10-28) in the same title form.
    const nine = `<p>Financial report for the period 1 January 2026 to 30 September 2026</p>
      <p>Novo Nordisk reports adjusted operating profit for Q3 2026. Q3 2026 report.</p>${RESULTS_TABLE}`;
    expect(classifySixK(nine, { filedOn: '2026-11-05', profile: 'eu' })).toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'nine' });
    expect(classifySixK('<p>Interim results for the nine months to 30 September 2026</p>' + RESULTS_TABLE, { filedOn: '2026-11-05', profile: 'uk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'nine' });
  });

  it('a quarter label follows the fiscal year end when given, else calendar quarters', () => {
    const doc = `<p>Acme Q2 2026 results</p>${RESULTS_TABLE}`;
    expect(classifySixK(doc, { filedOn: '2026-11-20', profile: 'uk' })).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
    // FY ends March: FY2026 ends 2026-03-31, its Q2 ends 2025-09-30.
    expect(classifySixK(doc, { filedOn: '2026-11-20', profile: 'uk', fyEndMonth: 3 })).toEqual({ kind: 'results', periodEnd: '2025-09-30', span: 'quarter' });
  });

  it('"half-year to <date>" is the half; "year to <date>" is the year', () => {
    expect(classifySixK(`<p>Half-year 2026 results for the half-year to 30 June 2026</p>${RESULTS_TABLE}`, { filedOn: '2026-07-30', profile: 'uk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
    expect(classifySixK(`<p>Preliminary results for the year to 31 December 2026</p>${RESULTS_TABLE}`, { filedOn: '2027-02-20', profile: 'uk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-12-31', span: 'year' });
  });

  it('"Transaction in own shares" is other', () => {
    const doc = `<p>FORM 6-K Indicate by check mark whether the registrant files or will file annual reports under cover of Form 20-F
      or Form 40-F. Form 20-F X</p><p>HSBC Holdings plc Transaction in own shares 27 October 2026</p>
      <p>HSBC Holdings plc announces it has purchased the following number of its ordinary shares, following the
      announcement of the 3Q26 results. The shares were purchased in the three months ended 30 September 2026.</p>
      <table><tr><td>Highest price paid per share</td><td>1,050.40</td></tr></table>`;
    expect(classifySixK(doc, { filedOn: '2026-10-27', profile: 'uk' })).toEqual({ kind: 'other' });
    for (const title of ['Total voting rights', 'Director/PDMR shareholding', 'Declaration of interim dividend', 'Filing of Annual Report on Form 20-F']) {
      const t = `<p>Acme plc ${title}. Following the half year 2026 results, for the six months ended 30 June 2026.</p>${RESULTS_TABLE}`;
      expect(classifySixK(t, { filedOn: '2026-08-10', profile: 'uk' }), title).toEqual({ kind: 'other' });
    }
  });

  it('"will announce its half year results on 29 July 2026 at 7.00am (UK time)" → 2026-07-29 BMO', () => {
    const t = 'HSBC Holdings plc will announce its half year results on 29 July 2026 at 7.00am (UK time).';
    expect(parseDateNoticeFor(t, 'uk', LSE)).toEqual({ date: '2026-07-29', timing: 'BMO' });
    expect(classifySixK(`<p>${t}</p>`, { filedOn: '2026-07-01', profile: 'uk', session: LSE })).toEqual({ kind: 'date-notice', date: '2026-07-29', timing: 'BMO' });
    // London 12:00 is during the session; 16:30 is the close.
    expect(parseDateNoticeFor('Acme will publish its interim results on 29 July 2026 at 12:00 London time.', 'uk', LSE)).toEqual({ date: '2026-07-29', timing: 'DMH' });
    expect(parseDateNoticeFor('Acme will publish its interim results on 29 July 2026 at 4.30pm BST.', 'uk', LSE)).toEqual({ date: '2026-07-29', timing: 'AMC' });
  });

  it('"publish Q3 2026 results on 22 October 2026 at 07:00 CET" → 2026-10-22 BMO', () => {
    const t = 'ASML will publish Q3 2026 results on 22 October 2026 at 07:00 CET.';
    expect(parseDateNoticeFor(t, 'eu', PAR)).toEqual({ date: '2026-10-22', timing: 'BMO' });
    // Paris 09:00 is the open; a UK clock is read in the session's zone (08:00 London = 09:00 Paris).
    expect(parseDateNoticeFor('Acme will publish its Q3 2026 results on 22 October 2026 at 09:00 CEST.', 'eu', PAR)).toEqual({ date: '2026-10-22', timing: 'DMH' });
    expect(parseDateNoticeFor('Acme will publish its Q3 2026 results on 22 October 2026 at 7.00am UK time.', 'eu', PAR)).toEqual({ date: '2026-10-22', timing: 'BMO' });
    expect(parseDateNoticeFor('Acme will publish its Q3 2026 results on 22 October 2026 at 08:00 GMT.', 'eu', PAR)).toEqual({ date: '2026-10-22', timing: 'DMH' });
    // A conference-call time is not the release time.
    expect(parseDateNoticeFor('Acme will report its Q3 2026 results on 22 October 2026; a conference call will be held at 14:00 CET.', 'eu', PAR))
      .toEqual({ date: '2026-10-22', timing: 'UNKNOWN' });
  });

  it("clock times are judged against the stock's own session; no session → UNKNOWN", () => {
    const at = (clock: string) => `Acme will publish its Q3 2026 results on 22 October 2026 at ${clock}.`;
    // Oslo closes 16:20, SIX 17:20, Paris 17:30 (local; all CET-offset zones).
    expect(parseDateNoticeFor(at('16:30 CET'), 'eu', OSL)).toEqual({ date: '2026-10-22', timing: 'AMC' });
    expect(parseDateNoticeFor(at('17:25 CET'), 'eu', SIX)).toEqual({ date: '2026-10-22', timing: 'AMC' });
    expect(parseDateNoticeFor(at('17:25 CET'), 'eu', PAR)).toEqual({ date: '2026-10-22', timing: 'DMH' });
    // Helsinki opens 10:00 local = 09:00 CET.
    expect(parseDateNoticeFor(at('08:30 CET'), 'eu', HEL)).toEqual({ date: '2026-10-22', timing: 'BMO' });
    expect(parseDateNoticeFor(at('09:30 CET'), 'eu', HEL)).toEqual({ date: '2026-10-22', timing: 'DMH' });
    // An LSE stock: 16:00 CET is 15:00 London.
    expect(parseDateNoticeFor(at('16:00 CET'), 'uk', LSE)).toEqual({ date: '2026-10-22', timing: 'DMH' });
    for (const profile of ['uk', 'eu'] as const) {
      expect(parseDateNoticeFor(at('07:00 CET'), profile)).toEqual({ date: '2026-10-22', timing: 'UNKNOWN' });
      expect(classifySixK(`<p>${at('7.00am UK time')}</p>`, { filedOn: '2026-10-01', profile }))
        .toEqual({ kind: 'date-notice', date: '2026-10-22', timing: 'UNKNOWN' });
    }
  });

  it('"before the U.S. market opens" keeps the date but gives no European timing', () => {
    const t = 'Acme will report its third quarter 2026 results before the U.S. market opens on October 22, 2026.';
    expect(parseDateNoticeFor(t, 'eu', PAR)).toEqual({ date: '2026-10-22', timing: 'UNKNOWN' });
    expect(parseDateNoticeFor(t, 'uk', LSE)).toEqual({ date: '2026-10-22', timing: 'UNKNOWN' });
    expect(parseDateNoticeFor('Acme will report its third quarter 2026 results on October 22, 2026, before the U.S. market opens.', 'eu', PAR))
      .toEqual({ date: '2026-10-22', timing: 'UNKNOWN' });
    // Unchanged for hk.
    expect(parseDateNoticeFor(t, 'hk')).toEqual({ date: '2026-10-22', timing: 'AMC' });
  });

  it('"after the close" → AMC', () => {
    expect(parseDateNoticeFor('Acme will announce its full year 2026 results on 26 February 2027 after the close of the London Stock Exchange.', 'uk', LSE))
      .toEqual({ date: '2027-02-26', timing: 'AMC' });
    expect(parseDateNoticeFor('Acme will report its Q1 2027 results on 24 April 2027 before the London Stock Exchange opens.', 'uk', LSE))
      .toEqual({ date: '2027-04-24', timing: 'BMO' });
    // A bare "the close" / "the market" names no exchange (a dual-listed filer's may be the US one): UNKNOWN.
    expect(parseDateNoticeFor('Acme will announce its full year 2026 results on 26 February 2027 after the close.', 'uk', LSE))
      .toEqual({ date: '2027-02-26', timing: 'UNKNOWN' });
    expect(parseDateNoticeFor('Acme will report its Q1 2027 results on 24 April 2027 before the market opens.', 'eu', PAR))
      .toEqual({ date: '2027-04-24', timing: 'UNKNOWN' });
  });

  it('an "Annual Financial Report" 6-K is other', () => {
    const t = `<p>FORM 6-K Form 20-F X</p><p>Acme plc Annual Financial Report. Acme plc has today published its Annual Report and
      Accounts for the year ended 31 December 2025.</p>${RESULTS_TABLE}`;
    expect(classifySixK(t, { filedOn: '2026-03-20', profile: 'uk' })).toEqual({ kind: 'other' });
    expect(classifySixK(t, { filedOn: '2026-03-20', profile: 'eu' })).toEqual({ kind: 'other' });
  });

  it('hk and jp profiles unchanged', () => {
    expect(classifySixK(fx('hk/baba_results_ex99.htm'), { filedOn: '2026-08-20', profile: 'hk' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
    expect(classifySixK(fx('jp/toyota_1q_fy27_ex991.htm'), { filedOn: '2026-08-04', profile: 'jp' }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
    // UK/EU phrases mean nothing to hk / jp.
    const t = 'Acme will publish Q3 2026 results on 22 October 2026 at 07:00 CET.';
    expect(parseDateNoticeFor(t, 'hk')).toBeNull();
    expect(parseDateNoticeFor(t, 'jp')).toBeNull();
    expect(classifySixK(`<p>Acme Q2 2026 results</p>${RESULTS_TABLE}`, { filedOn: '2026-11-20', profile: 'hk' })).toEqual({ kind: 'other' });
  });
});

describe("classifySixK 'uk' / 'eu': N-month period ended, and a recency window (Task 18 fix round 1)", () => {
  const rel = (name: string) => fx(`europe/releases/eu/${name}`);

  it('BUD "Unaudited Interim Report for the three-month period ended 31 March 2025" (0001193125-25-115972, 2025-05-08) is Q1 2025', () => {
    expect(classifySixK(rel('BUD_2025-03-31.htm'), { filedOn: '2025-05-08', profile: 'eu', fyEndMonth: 12 }))
      .toEqual({ kind: 'results', periodEnd: '2025-03-31', span: 'quarter' });
  });

  it('STM IFRS semi-annual report, six-month period ended June 27, 2026 (0000932787-26-000069, 2026-08-19) is H1 2026', () => {
    expect(classifySixK(rel('STM_2026-06-27_ifrs.htm'), { filedOn: '2026-08-19', profile: 'eu', fyEndMonth: 12 }))
      .toEqual({ kind: 'results', periodEnd: '2026-06-27', span: 'half' });
  });

  it('"3-month / 6-month / 9-month period ended" forms are stated spans', () => {
    const doc = (phrase: string) => `<p>Interim results for the ${phrase} 30 September 2026</p>${RESULTS_TABLE}`;
    expect(classifySixK(doc('9-month period ended'), { filedOn: '2026-10-28', profile: 'eu' })).toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'nine' });
    expect(classifySixK(doc('nine-month period ended'), { filedOn: '2026-10-28', profile: 'uk' })).toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'nine' });
  });

  it('SAN "January - September 2026 Financial Report" (0000891478-26-000093, 2026-10-28) is results for Q3 2026', () => {
    // Before: no results phrase matched, and "Form 6-K furnished to the SEC on 1 April 2026" read as a past date notice.
    expect(classifySixK(fx('europe/sec/san_9m_2026_financial_report_6k.htm'), { filedOn: '2026-10-28', profile: 'eu', fyEndMonth: 12 }))
      .toEqual({ kind: 'results', periodEnd: '2026-09-30', span: 'quarter' });
  });

  it('a passing mention of the previous annual report never dates a release (no period within 100 days → other)', () => {
    const html = `<p>Interim results. See our annual report for the year ended 31 December 2025.</p>${RESULTS_TABLE}`;
    expect(classifySixK(html, { filedOn: '2026-08-19', profile: 'eu' })).toEqual({ kind: 'other' });
    expect(classifySixK(html, { filedOn: '2026-02-20', profile: 'eu' })).toEqual({ kind: 'results', periodEnd: '2025-12-31', span: 'year' });
  });
});
