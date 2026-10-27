import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyHkExhibit, parseDateNotice, pickReleaseDoc } from '../../src/hk/sources/sixK.js';
import { parseFilingDocs } from '../../src/sources/secFeed.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8');

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
    expect(classifyHkExhibit(fx('tcom_date_notice_ex99.htm'))).toEqual({ kind: 'date-notice', date: '2026-09-16', timing: 'UNKNOWN' });
  });

  it('buyback / AGM / board-meeting notices are other', () => {
    expect(classifyHkExhibit(fx('baba_exrate_notice_ex99.htm'))).toEqual({ kind: 'other' });
    // names the quarter's results and a date, but is not "(to|will) announce results on" and has no table
    expect(classifyHkExhibit(fx('baba_board_meeting_ex99.htm'))).toEqual({ kind: 'other' });
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
