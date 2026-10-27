import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyHkExhibit, parseDateNotice, pickReleaseDoc } from '../../src/hk/sources/sixK.js';
import { parseFilingDocs } from '../../src/sources/secFeed.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8');

/**
 * Filing dates of the release fixtures. From the saved SEC filing index ("Accepted") where one is in the repo or
 * scratch: BABA_2026-06-30 / baba_results_ex99 (2026-08-20), HSBC_2026-06-30 / hsbc_interim_6k (2026-08-04),
 * JD_2026-06-30 (2026-08-13). The rest: the release's own dateline (e.g. "BEIJING, China, May 18, 2026",
 * HSBC "Group CEO 30 July 2025", Alibaba "Hong Kong, May 13, 2026"); SEC acceptance is that day or later, so the
 * dateline is the stricter bound. No SEC index was fetched for this (no SEC_USER_AGENT in the build environment).
 */
const FILED_ON: Record<string, string> = {
  'BABA_2026-03-31.htm': '2026-05-13', 'BABA_2026-06-30.htm': '2026-08-20',
  'BIDU_2026-03-31.htm': '2026-05-18', 'BIDU_2026-06-30.htm': '2026-08-18',
  'BILI_2026-03-31.htm': '2026-05-19', 'BILI_2026-06-30.htm': '2026-08-27',
  'HSBC_2025-06-30.htm': '2025-07-30', 'HSBC_2026-06-30.htm': '2026-08-04',
  'JD_2026-03-31.htm': '2026-05-12', 'JD_2026-06-30.htm': '2026-08-13',
  'LI_2026-03-31.htm': '2026-05-28', 'LI_2026-06-30.htm': '2026-08-26',
  'NIO_2026-03-31.htm': '2026-05-21', 'NIO_2026-06-30.htm': '2026-09-01',
  'NTES_2026-03-31.htm': '2026-05-21', 'NTES_2026-06-30.htm': '2026-08-20',
  'ONC_2026-03-31.htm': '2026-05-06', 'ONC_2026-06-30.htm': '2026-08-05',
  'TCOM_2026-03-31.htm': '2026-06-24', 'TCOM_2026-06-30.htm': '2026-09-15',
  'XPEV_2026-03-31.htm': '2026-05-28', 'XPEV_2026-06-30.htm': '2026-08-24',
  'YUMC_2025-03-31.htm': '2025-04-30', 'YUMC_2026-03-31.htm': '2026-04-29',
  'hsbc_3q25_earnings_release_6k.htm': '2025-10-28',
  'puk_2026_half_year_results_6k.htm': '2026-08-27', 'puk_fy25_results_6k.htm': '2026-03-18',
};

describe('classifyHkExhibit: period from table headers split across cells', () => {
  const corpus = (n: string) => readFileSync(new URL(`../fixtures/hk/releases/${n}`, import.meta.url), 'utf8');

  it('Trip.com Q2 2026 (0001193125-26-392473): "Three Months Ended" over "June 30, 2026 RMB (million)" → 2026-06-30 quarter', () => {
    expect(classifyHkExhibit(corpus('TCOM_2026-06-30.htm'))).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('NetEase and BeOne Q2 2026 releases carry a three-month column → quarter, not half', () => {
    expect(classifyHkExhibit(corpus('NTES_2026-06-30.htm'))).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
    expect(classifyHkExhibit(corpus('ONC_2026-06-30.htm'))).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('every corpus release classifies to its hand-checked period end and span', () => {
    const dir = new URL('../fixtures/hk/releases/', import.meta.url);
    const expected: Record<string, { periodEnd: string; kind: 'Q' | 'H' | 'FY' }> = JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8'));
    const SPAN = { Q: 'quarter', H: 'half', FY: 'year' } as const;
    for (const [file, e] of Object.entries(expected)) {
      expect(classifyHkExhibit(corpus(file)), file).toEqual({ kind: 'results', periodEnd: e.periodEnd, span: SPAN[e.kind] });
      expect(FILED_ON[file], file).toBeDefined();
      expect(classifyHkExhibit(corpus(file), { filedOn: FILED_ON[file] }), file).toEqual({ kind: 'results', periodEnd: e.periodEnd, span: SPAN[e.kind] });
    }
  });

  it('a split header names the period: "Three Months Ended" | "Six Months Ended" over dated cells', () => {
    const html = `<p>Acme Announces Second Quarter 2026 Results</p>
    <table>
      <tr><td></td><td colspan="4">Three Months Ended</td><td colspan="2">Six Months Ended</td></tr>
      <tr><td></td><td colspan="2">June 30, 2025</td><td colspan="2">June 30, 2026</td><td colspan="2">June 30, 2026</td></tr>
      <tr><td>Revenue</td><td></td><td>1</td><td></td><td>2</td><td></td><td>3</td></tr>
    </table>`;
    expect(classifyHkExhibit(html)).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
    // Only a six-month column for the latest end → half.
    const half = html.replace('<td colspan="2">June 30, 2026</td><td colspan="2">June 30, 2026</td>', '<td colspan="2">March 31, 2026</td><td colspan="2">June 30, 2026</td>');
    expect(classifyHkExhibit(half)).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
  });
});

describe('classifyHkExhibit: results titles without "announces … results" (HSBC, Prudential)', () => {
  // Real 6-K documents from the review's held-out set (not part of the reader corpus).
  it('HSBC "Earnings Release 3Q25" is the quarter ended 2025-09-30, not the dividend\'s financial year ended 2025-12-31', () => {
    const f = 'hsbc_3q25_earnings_release_6k.htm';
    expect(classifyHkExhibit(fx(f), { filedOn: FILED_ON[f] })).toEqual({ kind: 'results', periodEnd: '2025-09-30', span: 'quarter' });
    expect(classifyHkExhibit(fx(f))).toEqual({ kind: 'results', periodEnd: '2025-09-30', span: 'quarter' });
  });

  it('Prudential "2026 HALF YEAR RESULTS" and "FY25 RESULTS"', () => {
    const h = 'puk_2026_half_year_results_6k.htm';
    const y = 'puk_fy25_results_6k.htm';
    expect(classifyHkExhibit(fx(h), { filedOn: FILED_ON[h] })).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
    expect(classifyHkExhibit(fx(y), { filedOn: FILED_ON[y] })).toEqual({ kind: 'results', periodEnd: '2025-12-31', span: 'year' });
  });

  it('a results release cannot report a period ending after it was filed', () => {
    const table = '<table><tr><td>Revenue</td><td>1</td></tr></table>';
    const html = `<p>Acme FY25 Results. For the year ended 31 December 2025. Our 2026 plan covers the quarter ended 31 March 2026.</p>${table}`;
    expect(classifyHkExhibit(html, { filedOn: '2026-03-20' })).toEqual({ kind: 'results', periodEnd: '2025-12-31', span: 'year' });
    expect(classifyHkExhibit(html)).toEqual({ kind: 'results', periodEnd: '2026-03-31', span: 'quarter' }); // without filedOn
  });

  it('a "1Q26 outlook" in the title is not a period; "Earnings Release 3Q25 will be published on …" is not results', () => {
    const table = '<table><tr><td>Revenue</td><td>1</td></tr></table>';
    expect(classifyHkExhibit(`<p>Acme FY25 Results and 1Q26 outlook. For the year ended 31 December 2025.</p>${table}`, { filedOn: '2026-03-20' }))
      .toEqual({ kind: 'results', periodEnd: '2025-12-31', span: 'year' });
    expect(classifyHkExhibit(`<p>HSBC Holdings plc Earnings Release 3Q25 will be published on 28 October 2025.</p>${table}`, { filedOn: '2025-10-14' }).kind)
      .not.toBe('results');
  });

  it('"dividend income for investments, for the three months ended …" keeps the quarter', () => {
    const html = '<p>Acme Announces Third Quarter 2025 Results. Excluding the dividend income for investments, for the three months ended September 30, 2025, revenue grew.</p>'
      + '<table><tr><td>Revenue</td><td>1</td></tr></table>';
    expect(classifyHkExhibit(html, { filedOn: '2025-11-12' })).toEqual({ kind: 'results', periodEnd: '2025-09-30', span: 'quarter' });
  });

  it('new title forms still need a results table row; notices stay notices', () => {
    for (const title of ['Earnings Release 3Q25', '3Q 2025 Results', 'Full Year 2025 Results', '2026 Half Year Results', 'FY25 Results']) {
      const p = `<p>Acme ${title}. For the three months ended September 30, 2025.</p>`;
      expect(classifyHkExhibit(p).kind, title).not.toBe('results');
      expect(classifyHkExhibit(`${p}<table><tr><td>Revenue</td><td>1</td></tr></table>`).kind, title).toBe('results');
    }
    const notice = '<p>HSBC Holdings plc will publish its Earnings Release 3Q25 results on 28 October 2025 for the quarter ended 30 September 2025.</p>';
    expect(classifyHkExhibit(notice)).toEqual({ kind: 'date-notice', date: '2025-10-28', timing: 'UNKNOWN' });
  });

  it('dividend context is "dividend … for / in respect of the (financial) year ended" in the same sentence; other mentions are kept', () => {
    const table = '<table><tr><td>Revenue</td><td>1</td></tr></table>';
    // "Dividends declared." is its own sentence: the following year-ended mention counts.
    expect(classifyHkExhibit(`<p>Acme 2025 Annual Results. Dividends declared. Year ended 31 December 2025 results summary.</p>${table}`))
      .toEqual({ kind: 'results', periodEnd: '2025-12-31', span: 'year' });
    // Only a dividend's *year* is dropped: a six-month or quarter period named for a dividend still counts.
    expect(classifyHkExhibit(`<p>Acme 2026 Interim Results. The interim dividend in respect of the six months ended 30 June 2026 is US$0.1.</p>${table}`))
      .toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
    expect(classifyHkExhibit(`<p>Acme Earnings Release 3Q25. Dividends: the third interim dividend for the quarter ended 30 September 2025 is $0.10. Comparative: year ended 31 December 2024.</p>${table}`))
      .toEqual({ kind: 'results', periodEnd: '2025-09-30', span: 'quarter' });
  });

  it('a period named for a dividend is not the release period', () => {
    const html = '<p>Acme Earnings Release 3Q25. For the quarter ended 30 September 2025. The second interim dividend in respect of the financial year ended 31 December 2025 was paid in June 2025.</p>'
      + '<table><tr><td>Revenue</td><td>1</td></tr></table>';
    expect(classifyHkExhibit(html)).toEqual({ kind: 'results', periodEnd: '2025-09-30', span: 'quarter' });
  });
});

describe('classifyHkExhibit', () => {
  it('BABA EX-99.1 is results for the quarter ended 2026-06-30', () => {
    expect(classifyHkExhibit(fx('baba_results_ex99.htm'))).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('HSBC 6-K document is picked when there is no EX-99, and it classifies as the half-year results', () => {
    const idx = 'https://www.sec.gov/Archives/edgar/data/1089113/000165495426007212/0001654954-26-007212-index.htm';
    const docs = parseFilingDocs(fx('sec_index_hsbc_interim.htm'), idx);
    expect(pickReleaseDoc(docs)).toBe('https://www.sec.gov/Archives/edgar/data/1089113/000165495426007212/a1266p.htm');
    expect(classifyHkExhibit(fx('hsbc_interim_6k.htm'))).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'half' });
  });

  it('pickReleaseDoc prefers EX-99.1, then the first EX-99*, then the 6-K / 8-K, else null', () => {
    const d = (type: string) => ({ type, url: `u/${type}`, description: '' });
    expect(pickReleaseDoc([d('6-K'), d('EX-99.2'), d('EX-99.1')])).toBe('u/EX-99.1');
    expect(pickReleaseDoc([d('6-K'), d('EX-99.3'), d('EX-99.2')])).toBe('u/EX-99.3');
    expect(pickReleaseDoc([d('GRAPHIC'), d('8-K')])).toBe('u/8-K');
    expect(pickReleaseDoc([d('GRAPHIC')])).toBeNull();
  });

  it('a date notice is never results even though it names a quarter', () => {
    expect(classifyHkExhibit(fx('tme_date_notice_ex99.htm'))).toEqual({ kind: 'date-notice', date: '2026-11-17', timing: 'AMC' });
    // TCOM names "three months and six months ended June 30, 2026" and "announce the Results", yet has no results table.
    expect(classifyHkExhibit(fx('tcom_date_notice_ex99.htm'))).toEqual({ kind: 'date-notice', date: '2026-09-16', timing: 'BMO' });
  });

  it('HKEX-style board-meeting notices confirm the date (passive "will further be ... announced on")', () => {
    expect(classifyHkExhibit(fx('baba_board_meeting_ex99.htm'))).toEqual({ kind: 'date-notice', date: '2026-08-20', timing: 'UNKNOWN' });
  });

  it('buyback / AGM / board-meeting notices are other', () => {
    expect(classifyHkExhibit(fx('baba_exrate_notice_ex99.htm'))).toEqual({ kind: 'other' });
    expect(classifyHkExhibit('<p>The Company will announce the results of the annual general meeting on May 5, 2026 for the financial year.</p>')).toEqual({ kind: 'other' });
    expect(classifyHkExhibit('<p>The Company will publish the meeting results for the annual period on May 5, 2026.</p>')).toEqual({ kind: 'other' });
    expect(classifyHkExhibit('<p>The company will announce the results of the voting on May 5, 2026.</p>')).toEqual({ kind: 'other' });
    expect(classifyHkExhibit('<p>Share buy-back: the Company repurchased 1,000,000 shares for the year ended December 31, 2026.</p>')).toEqual({ kind: 'other' });
  });

  it('a results phrase and a period without a revenue / per-share table row is not results', () => {
    const noTable = '<p>Acme announces second quarter 2026 results for the quarter ended June 30, 2026.</p>';
    expect(classifyHkExhibit(noTable).kind).toBe('other');
    const withTable = `${noTable}<table><tr><td>Revenue</td><td>1</td></tr></table>`;
    expect(classifyHkExhibit(withTable)).toEqual({ kind: 'results', periodEnd: '2026-06-30', span: 'quarter' });
  });

  it('a fourth quarter and full year release is a quarter; the latest period end wins over comparatives', () => {
    const html = '<p>Acme Reports Fourth Quarter and Full Year 2025 Results. For the three months ended December 31, 2025 and the year ended December 31, 2025, compared with the year ended December 31, 2024.</p>'
      + '<table><tr><td>Diluted earnings per share</td><td>1.00</td></tr></table>';
    expect(classifyHkExhibit(html)).toEqual({ kind: 'results', periodEnd: '2025-12-31', span: 'quarter' });
  });

  it('"<Month> Quarter <yyyy>" gives that month end', () => {
    const html = '<p>Acme Group Announces March Quarter 2026 Results</p><table><tr><td>Revenue</td></tr></table>';
    expect(classifyHkExhibit(html)).toEqual({ kind: 'results', periodEnd: '2026-03-31', span: 'quarter' });
  });
});

describe('parseDateNotice', () => {
  it('before the U.S. market opens on D → HK date D, AMC', () => {
    expect(parseDateNotice('Acme will announce its unaudited financial results for the third quarter of 2026 before the U.S. market opens on Thursday, November 20, 2026.'))
      .toEqual({ date: '2026-11-20', timing: 'AMC' });
  });

  it('after the U.S. market closes on D → D+1 BMO', () => {
    expect(parseDateNotice('Acme will report its financial results for the second quarter of 2026 after the U.S. market closes on Tuesday, August 18, 2026.'))
      .toEqual({ date: '2026-08-19', timing: 'BMO' });
    expect(parseDateNotice('Acme to announce quarterly results after the U.S. market closes on December 31, 2026'))
      .toEqual({ date: '2027-01-01', timing: 'BMO' });
  });

  it('explicit Hong Kong time → by the clock', () => {
    expect(parseDateNotice('Acme will announce its interim results at 4:30 p.m. Hong Kong time on August 13, 2026'))
      .toEqual({ date: '2026-08-13', timing: 'AMC' });
    expect(parseDateNotice('Acme will announce its interim results at 8:00 a.m. Hong Kong time on August 13, 2026'))
      .toEqual({ date: '2026-08-13', timing: 'BMO' });
    expect(parseDateNotice('Acme will release its interim results at 12:30 p.m. Hong Kong time on 13 August 2026'))
      .toEqual({ date: '2026-08-13', timing: 'DMH' });
  });

  it('HKEX trading-hours phrases and "before the opening of the U.S. market"', () => {
    expect(parseDateNotice('We will upload the 2026 Interim Results Announcement to the Hong Kong Stock Exchange on Thursday, August 13, 2026 (Beijing/Hong Kong Time), after the trading hours of the Hong Kong Stock Exchange and before the opening of the U.S. market.'))
      .toEqual({ date: '2026-08-13', timing: 'AMC' });
    expect(parseDateNotice('The Company will announce its financial results on 5 March 2026, before the opening of the Hong Kong Stock Exchange.'))
      .toEqual({ date: '2026-03-05', timing: 'BMO' });
    expect(parseDateNotice('The Company will announce its annual results on 5 March 2026, after the close of the HKEX.'))
      .toEqual({ date: '2026-03-05', timing: 'AMC' });
  });

  it('the bare date is the one nearest the verb, not an earlier meeting date', () => {
    expect(parseDateNotice('The audit committee will hold a meeting on Monday, September 14, 2026 to approve the financial results. The Company will announce the Results on Wednesday, September 16, 2026.'))
      .toEqual({ date: '2026-09-16', timing: 'UNKNOWN' });
    // TCOM fixture: audit committee meets 09-14, results are on 09-16
    expect(classifyHkExhibit(fx('tcom_date_notice_ex99.htm'))).toMatchObject({ kind: 'date-notice', date: '2026-09-16' });
  });

  it('a dividend payment or record date is never the results date; a Rule 13.43 board meeting date is', () => {
    // Live spot-check (Task 14): HSBC 6-K 0001654954-26-008935, filed 2026-10-14. Board meeting 27 October 2026 to consider the
    // Q3 earnings release; the dividend is payable on 17 December 2026 to holders of record on 6 November 2026.
    expect(classifyHkExhibit(fx('hsbc_3q26_board_meeting_6k.htm'))).toEqual({ kind: 'date-notice', date: '2026-10-27', timing: 'UNKNOWN' });
    expect(parseDateNotice('The Board will consider the earnings release for the third quarter (the "Results") and a dividend. The dividend will be payable on 17 December 2026 to holders of record on 6 November 2026.'))
      .toBeNull();
    // An explicit announcement date still wins over the meeting date.
    expect(parseDateNotice('A meeting of the Board will be held on 25 March 2026 to approve the annual results. The Company will announce the results on 26 March 2026.'))
      .toEqual({ date: '2026-03-26', timing: 'UNKNOWN' });
  });

  it('a conference-call time is not a release time', () => {
    expect(parseDateNotice('Acme will announce its quarterly results on November 5, 2026. A conference call will be held at 8:00 p.m. Hong Kong time on November 5, 2026.'))
      .toEqual({ date: '2026-11-05', timing: 'UNKNOWN' });
  });

  it('a date with no timing statement is UNKNOWN; no date, or not earnings, is null', () => {
    expect(parseDateNotice('Acme will announce its financial results on Monday, March 9, 2026.')).toEqual({ date: '2026-03-09', timing: 'UNKNOWN' });
    expect(parseDateNotice('Acme will announce its financial results soon.')).toBeNull();
    expect(parseDateNotice('The company will announce the results of the poll on May 5, 2026.')).toBeNull();
  });
});

describe('final review: date and timing stay inside the verb\'s own sentence', () => {
  it('an EGM date in a later sentence is not the results date', () => {
    const text = 'The Company will publish its interim results for the six months ended 30 June 2026 in due course. The interim dividend will be paid on 10 October 2026 to shareholders on the register on 15 September 2026. The extraordinary general meeting will be held on 1 October 2026.';
    expect(parseDateNotice(text)?.date).not.toBe('2026-10-01');
    expect(parseDateNotice(text)).toBeNull();
  });

  it('"before the U.S. market opens" then an AGM date in the next sentence: no date', () => {
    const text = 'Acme will release its unaudited financial results for the third quarter 2026 before the U.S. market opens. The annual general meeting of the Company will be held on 30 December 2026.';
    expect(parseDateNotice(text)?.date).not.toBe('2026-12-30');
    expect(parseDateNotice(text)).toBeNull();
  });

  it('"U.S." and "p.m." do not end the sentence: the date after them is still read', () => {
    expect(parseDateNotice('Acme will release its unaudited financial results for the third quarter 2026 before the U.S. Market opens on November 20, 2026.'))
      .toEqual({ date: '2026-11-20', timing: 'AMC' });
    expect(parseDateNotice('Acme will announce its interim results at 4:30 p.m. Hong Kong time on August 13, 2026.'))
      .toEqual({ date: '2026-08-13', timing: 'AMC' });
  });
});

describe('final review: a date notice with a revenue row is a date notice', () => {
  it('a notice dated after filing wins over the results phrase + revenue row', () => {
    const html = '<p>Acme announces date of third quarter 2026 earnings release. Acme will report its unaudited results for the quarter ended September 30, 2026 on November 20, 2026.</p><table><tr><td>Revenue guidance</td><td>1,000</td></tr></table>';
    expect(classifyHkExhibit(html, { filedOn: '2026-11-05' })).toEqual({ kind: 'date-notice', date: '2026-11-20', timing: 'UNKNOWN' });
  });
});
