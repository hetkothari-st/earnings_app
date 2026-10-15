import { describe, expect, test, vi } from 'vitest';
import {
  fetchAcceptance, parseAcceptance, parseEarningsFilings, parseSecTickers,
} from '../../src/sources/sec.js';
import { SourceFormatError } from '../../src/sources/http.js';

// Shapes copied from live responses on 2026-10-15.
const tickers = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [19617, 'JPMORGAN CHASE & CO', 'JPM', 'NYSE'],
    [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'],
    [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-A', 'NYSE'],
    [999, 'NO EXCHANGE CO', 'NOEX', null],
  ],
};

const submissions = {
  cik: '0000019617',
  filings: { recent: {
    accessionNumber: ['0001628280-26-065616', '0001628280-26-065582', '0001628280-26-060000', '0001628280-26-048078'],
    filingDate: ['2026-10-13', '2026-10-13', '2026-10-01', '2026-07-14'],
    acceptanceDateTime: ['2026-10-13T17:38:53.000Z', '2026-10-13T14:30:38.000Z', '2026-10-01T20:00:00.000Z', '2026-07-14T14:30:38.000Z'],
    form: ['8-K', '8-K', '10-Q', '8-K'],
    items: ['7.01,9.01', '2.02,9.01', '', '2.02,9.01'],
    primaryDocument: ['jpm-a.htm', 'jpm-20261013.htm', 'q.htm', 'jpm-20260714.htm'],
  } },
};

const header = `<SEC-HEADER>0001628280-26-065582.hdr.sgml : 20261013
<ACCEPTANCE-DATETIME>20261013063038
<ACCESSION-NUMBER>0001628280-26-065582
<TYPE>8-K`;

describe('sec', () => {
  test('tickers keyed by normalized ticker', () => {
    const m = parseSecTickers(tickers);
    expect(m.get('JPM')).toEqual({ cik: 19617, exchange: 'NYSE' });
    expect(m.get('BRK-B')).toEqual({ cik: 1067983, exchange: 'NYSE' });
    expect(m.get('NOEX')).toEqual({ cik: 999, exchange: null });
  });
  test('tickers bad shape throws', () => {
    expect(() => parseSecTickers({ fields: ['x'], data: [] })).toThrow(SourceFormatError);
  });
  test('only 8-K with item 2.02, with document and index URLs', () => {
    expect(parseEarningsFilings(submissions, 19617)).toEqual([
      {
        accession: '0001628280-26-065582', filingDate: '2026-10-13', form: '8-K',
        docUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026065582/jpm-20261013.htm',
        indexUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026065582/0001628280-26-065582-index.htm',
      },
      {
        accession: '0001628280-26-048078', filingDate: '2026-07-14', form: '8-K',
        docUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026048078/jpm-20260714.htm',
        indexUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026048078/0001628280-26-048078-index.htm',
      },
    ]);
  });
  test('foreign issuers: 6-K filings are listed too, marked by form', () => {
    const sub6k = { filings: { recent: {
      accessionNumber: ['0001046179-26-000123'], filingDate: ['2026-10-15'], form: ['6-K'], items: [''], primaryDocument: ['tsm6k.htm'],
    } } };
    expect(parseEarningsFilings(sub6k, 1046179)).toEqual([{
      accession: '0001046179-26-000123', filingDate: '2026-10-15', form: '6-K',
      docUrl: 'https://www.sec.gov/Archives/edgar/data/1046179/000104617926000123/tsm6k.htm',
      indexUrl: 'https://www.sec.gov/Archives/edgar/data/1046179/000104617926000123/0001046179-26-000123-index.htm',
    }]);
  });
  test('acceptance comes from the SGML header as ET wall clock', () => {
    expect(parseAcceptance(header)).toBe('2026-10-13T06:30:38');
    expect(() => parseAcceptance('<html>rate limited</html>')).toThrow(SourceFormatError);
  });
  test('fetchAcceptance builds the header URL', async () => {
    const http = { json: vi.fn(), text: vi.fn().mockResolvedValue(header) };
    await fetchAcceptance(http, 19617, '0001628280-26-065582');
    expect(http.text).toHaveBeenCalledWith(
      'https://www.sec.gov/Archives/edgar/data/19617/000162828026065582/0001628280-26-065582.hdr.sgml');
  });
});
