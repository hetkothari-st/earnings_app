import { describe, it, expect } from 'vitest';
import {
  EU_FULL, UK_FULL, europeAdrRatioShown, europeFullFor, europeIssuerFor, europeLevel,
} from '../../src/europe/universe.js';
import { coverRatio, findRatioSentence, flatText, fxPairFor, impliedLocalPerUs, secFormFrom } from '../../src/cli/verifyEuropeUniverse.js';

const ALL = [...UK_FULL, ...EU_FULL];

describe('europe full-level lists', () => {
  it('symbols, ADRs and ISINs unique per market', () => {
    for (const list of [UK_FULL, EU_FULL]) {
      expect(new Set(list.map((e) => e.symbol)).size).toBe(list.length);
      expect(new Set(list.map((e) => e.adr)).size).toBe(list.length);
      expect(new Set(list.map((e) => e.isin)).size).toBe(list.length);
    }
    // An ADR ticker is never in both markets (the reader's issuer guard looks it up across both).
    expect(new Set(ALL.map((e) => e.adr)).size).toBe(ALL.length);
    expect(ALL.every((e) => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(e.isin))).toBe(true);
    expect(ALL.every((e) => Number.isInteger(e.cik) && e.cik > 0 && e.adrRatio > 0 && e.names.length > 0)).toBe(true);
  });

  it('HSBC is UK full with HSBA.L and CIK 1089113', () => {
    const e = europeFullFor('UK', 'HSBA.L');
    expect(e).toMatchObject({ market: 'UK', symbol: 'HSBA.L', adr: 'HSBC', cik: 1089113, secForm: '6-K' });
    expect(europeFullFor('EU', 'HSBA.L')).toBeUndefined();
    expect(europeFullFor('UK', 'NOPE.L')).toBeUndefined();
  });

  it('every symbol suffix matches its market (UK .L only)', () => {
    const code = /^[A-Z0-9][A-Z0-9.\-]{0,14}\.(L|PA|AS|BR|LS|IR|MI|OL|DE|SW|ST|CO|HE|MC)$/;
    expect(UK_FULL.length).toBeGreaterThan(0);
    expect(EU_FULL.length).toBeGreaterThan(0);
    for (const e of UK_FULL) {
      expect(e.market).toBe('UK');
      expect(e.symbol).toMatch(code);
      expect(e.symbol.endsWith('.L')).toBe(true);
    }
    for (const e of EU_FULL) {
      expect(e.market).toBe('EU');
      expect(e.symbol).toMatch(code);
      expect(e.symbol.endsWith('.L')).toBe(false);
    }
  });

  it('ratio shown only when verified', () => {
    expect(europeAdrRatioShown({ adrRatio: 5, adrRatioVerified: true })).toBe(5);
    expect(europeAdrRatioShown({ adrRatio: 5, adrRatioVerified: false })).toBeNull();
    expect(europeAdrRatioShown({ adrRatio: null, adrRatioVerified: true })).toBeNull();
    for (const e of ALL) expect(europeAdrRatioShown(e)).toBe(e.adrRatioVerified ? e.adrRatio : null);
  });

  it('no entry without a local line', () => {
    // Ruling: US-listed names with no primary line on a target exchange are dropped, not added.
    for (const adr of ['ARM', 'SPOT', 'NXPI', 'BNTX', 'CHKP', 'CRH']) {
      expect(ALL.find((e) => e.adr === adr)).toBeUndefined();
      expect(europeIssuerFor(adr)).toBeUndefined();
    }
    for (const e of ALL) expect(e.symbol).not.toBe('');
  });

  it('level and issuer lookup', () => {
    expect(europeLevel({ cik: 1089113, adr: 'HSBC' })).toBe('full');
    expect(europeLevel({ cik: null, adr: 'HSBC' })).toBe('basic');
    expect(europeLevel({ cik: 1089113, adr: null })).toBe('basic');
    const hsbc = europeFullFor('UK', 'HSBA.L')!;
    expect(europeIssuerFor('HSBC')).toEqual({ names: hsbc.names, ticker: 'HSBC' });
    expect(europeIssuerFor('HSBA.L')).toEqual({ names: hsbc.names, ticker: 'HSBC' });
    expect(europeIssuerFor('ZZZZ')).toBeUndefined();
  });
});

describe('verify-europe-universe helpers', () => {

  it('ratio sentences, including one-half of one, the right to receive and receipts', () => {
    expect(findRatioSentence('Each American Depositary Share representing one-half of one ordinary share')?.ratio).toBe(0.5);
    expect(findRatioSentence('American Depositary Share, or ADS, represents one-half of one share')?.ratio).toBe(0.5);
    expect(findRatioSentence('American Depositary Shares, each representing the right to receive one ordinary share')?.ratio).toBe(1);
    expect(findRatioSentence('American Depositary Receipts, each representing one B Share NVO')?.ratio).toBe(1);
    expect(findRatioSentence('American Depositary Shares (each representing one RELX PLC ordinary share)')?.ratio).toBe(1);
    expect(findRatioSentence('One ADR is equivalent to 10 ordinary shares')?.ratio).toBe(10);
    // An unreadable number is skipped, not returned.
    expect(findRatioSentence('American Depositary Shares representing these shares. Nokia’s ADSs, each representing one share, trade')?.ratio).toBe(1);
    expect(findRatioSentence('no depositary words here')).toBeNull();
  });

  it('cover: the ADS class ratio wins; shares listed directly are 1; a historical body sentence is not read', () => {
    const nwg = flatText('Securities registered or to be registered pursuant to Section 12(b) of the Act:&#8203; Title of each class Trading Symbol(s) Name of each exchange on which registered American Depositary Shares, each representing 2 ordinary shares, nominal value &#163;1.0769 per share NWG New York Stock Exchange Securities registered pursuant to Section 12(g) of the Act: None. ... the ratio of one ADS representing one ordinary share changed');
    expect(coverRatio(nwg)?.ratio).toBe(2);
    const db = 'Section 12(b) of the Act (as of February 28, 2026) Title of each class Trading Symbol(s) Name of each exchange on which registered Ordinary shares, no par value DB The New York Stock Exchange';
    expect(coverRatio(db)?.ratio).toBe(1);
    const nok = 'Section 12(b) of the Securities Exchange Act of 1934 (the “Exchange Act”): Title of each class Trading Symbol(s) American Depositary Shares NOK New York Stock Exchange Shares New York Stock Exchange (1) Not for trading, but only in connection with the registration of American Depositary Shares representing these shares. Securities registered pursuant to Section 12(g) of the Exchange Act: None';
    expect(coverRatio(nok)).toBeNull();
    expect(coverRatio('no cover here')).toBeNull();
  });

  it('implied ratio: pence are divided by 100; FX pair per currency', () => {
    expect(impliedLocalPerUs(86.01, 1365.4, 'GBp', 1.3289)).toBeCloseTo(4.74, 2);
    expect(impliedLocalPerUs(41.89, 74.58, 'EUR', 1.1121)).toBeCloseTo(0.505, 3);
    expect(impliedLocalPerUs(0, 10, 'EUR', 1)).toBeNull();
    expect(fxPairFor('GBp')).toBe('GBPUSD=X');
    expect(fxPairFor('CHF')).toBe('CHFUSD=X');
    expect(fxPairFor('USD')).toBeNull();
  });

  it('filer form from the last 24 months', () => {
    expect(secFormFrom([{ form: '6-K', date: '2026-01-01' }, { form: '20-F', date: '2026-02-01' }], '2024-10-28')).toBe('6-K');
    expect(secFormFrom([{ form: '8-K', date: '2026-01-01' }, { form: '10-Q', date: '2026-02-01' }], '2024-10-28')).toBe('8-K');
    expect(secFormFrom([{ form: '10-K', date: '2020-01-01' }, { form: '6-K', date: '2026-02-01' }], '2024-10-28')).toBe('6-K');
    expect(secFormFrom([], '2024-10-28')).toBeNull();
  });
});
