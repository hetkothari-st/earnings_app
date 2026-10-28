import { describe, expect, it } from 'vitest';
import { parseEarningsFilings, parseFiscalYearEnd } from '../../src/sources/sec.js';

const recent = { accessionNumber: ['0001-26-000001'], filingDate: ['2026-10-28'], form: ['6-K'], items: [''], primaryDocument: ['a.htm'] };

describe('SEC submissions fiscalYearEnd (optional, additive)', () => {
  it('reads "MMDD" when present; null when absent or malformed; filings parse as before either way', () => {
    expect(parseFiscalYearEnd({ fiscalYearEnd: '1231', filings: { recent } })).toBe('1231');
    expect(parseFiscalYearEnd({ fiscalYearEnd: '0331', filings: { recent } })).toBe('0331');
    expect(parseFiscalYearEnd({ filings: { recent } })).toBeNull();
    expect(parseFiscalYearEnd({ fiscalYearEnd: null, filings: { recent } })).toBeNull();
    expect(parseFiscalYearEnd({ fiscalYearEnd: '12/31', filings: { recent } })).toBeNull();
    const want = parseEarningsFilings({ filings: { recent } }, 1);
    expect(parseEarningsFilings({ fiscalYearEnd: null, filings: { recent } }, 1)).toEqual(want);
    expect(parseEarningsFilings({ fiscalYearEnd: 1231, filings: { recent } }, 1)).toEqual(want);
  });
});
