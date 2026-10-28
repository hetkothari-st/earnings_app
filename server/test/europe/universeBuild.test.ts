import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { FirdsShare } from '../../src/europe/sources/firds.js';
import { fetchLegalNames } from '../../src/europe/sources/gleif.js';
import type { FigiAnswer } from '../../src/europe/sources/openFigi.js';
import { parseSixList } from '../../src/europe/sources/sixList.js';
import { EU_FULL, UK_FULL } from '../../src/europe/universe.js';
import {
  buildEuropeUniverse, figiJobsFor, leisFor, pickPrimaryLines, searchIsinsFor, trimFirdsName, yahooSymbolFor, type EuropeUniverseEntry,
} from '../../src/europe/universeBuild.js';
import type { Http } from '../../src/sources/http.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/europe/universe/${n}`, import.meta.url), 'utf8');

const share = (isin: string, mic: string, o: Partial<FirdsShare> = {}): FirdsShare =>
  ({ isin, mic, fullName: `${isin} ORD SHS`, cfi: 'ESVUFR', lei: null, issuerRequested: true, terminated: false, ...o });
const figi = (isin: string, exchCode: string, ...tickers: string[]): FigiAnswer => ({ isin, exchCode, tickers });

const base = { firdsUk: [] as FirdsShare[], firdsEu: [] as FirdsShare[], six: [] as ReturnType<typeof parseSixList>, names: new Map<string, string>(), figi: [] as FigiAnswer[], searched: new Map<string, string[]>(), full: [] };
const bySymbol = (rows: EuropeUniverseEntry[], s: string) => rows.find((r) => r.symbol === s);

describe('primary line', () => {
  it('IssrReq primary line; dual line resolved by ISIN country; still two → ambiguous, left out', () => {
    const shares = [
      // LVMH: issuer-requested on XPAR only; the XAMS line was not requested by the issuer.
      share('FR0000121014', 'XPAR'), share('FR0000121014', 'XAMS', { issuerRequested: false }),
      // TotalEnergies: issuer-requested on XPAR and XLON → FR ISIN picks Paris (it stays EU).
      share('FR0000120271', 'XPAR'), share('FR0000120271', 'XLON'),
      // 3M: issuer-requested on XPAR and XETA, ISIN country US matches neither, no UK line → ambiguous.
      share('US88579Y1010', 'XPAR'), share('US88579Y1010', 'XETA'),
      // Only a non-requested line → not picked (and not counted as ambiguous).
      share('NL00150001S5', 'XAMS', { issuerRequested: false }),
    ];
    const { picked, ambiguous } = pickPrimaryLines(shares);
    expect(picked.get('FR0000121014')?.mic).toBe('XPAR');
    expect(picked.get('FR0000120271')?.mic).toBe('XPAR');
    expect(picked.has('US88579Y1010')).toBe(false);
    expect(picked.has('NL00150001S5')).toBe(false);
    expect(ambiguous).toEqual(['US88579Y1010']);

    // No country match but one UK line → UK first.
    expect(pickPrimaryLines([share('US0000000001', 'XLON'), share('US0000000001', 'XPAR')]).picked.get('US0000000001')?.mic).toBe('XLON');
    // A terminated line never counts.
    expect(pickPrimaryLines([share('US88579Y1010', 'XPAR'), share('US88579Y1010', 'XETA', { terminated: true })]).picked.get('US88579Y1010')?.mic).toBe('XPAR');

    const u = buildEuropeUniverse({
      ...base, firdsUk: shares.filter((s) => s.mic === 'XLON'), firdsEu: shares.filter((s) => s.mic !== 'XLON'),
      figi: [figi('FR0000121014', 'FP', 'MC'), figi('FR0000120271', 'FP', 'TTE'), figi('US88579Y1010', 'FP', 'MMM')],
    });
    expect(u.uk).toEqual([]);
    expect(u.eu.map((e) => e.symbol)).toEqual(['MC.PA', 'TTE.PA']);
    expect(u.leftOut).toEqual([{ isin: 'US88579Y1010', reason: 'ambiguous-line' }]);
  });

  it('UK primary ISIN never in EU', () => {
    const shell = [share('GB00BP6MXD84', 'XLON', { lei: '21380068P1DRHMJ8KU70' }), share('GB00BP6MXD84', 'XAMS', { lei: '21380068P1DRHMJ8KU70' })];
    const u = buildEuropeUniverse({
      ...base, firdsUk: [shell[0]!], firdsEu: [shell[1]!],
      figi: [figi('GB00BP6MXD84', 'LN', 'SHEL'), figi('GB00BP6MXD84', 'NA', 'SHELL')],
      names: new Map([['21380068P1DRHMJ8KU70', 'Shell plc']]),
    });
    expect(u.uk.map((e) => e.symbol)).toEqual(['SHEL.L']);
    expect(u.eu).toEqual([]);
    expect(u.uk[0]).toMatchObject<Partial<EuropeUniverseEntry>>({
      market: 'UK', isin: 'GB00BP6MXD84', name: 'Shell plc', exchange: 'LSE', mic: 'XLON', country: 'GB', currency: 'GBp',
      adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
    });
    // Only the picked line is asked of OpenFIGI.
    expect(figiJobsFor({ firdsUk: [shell[0]!], firdsEu: [shell[1]!], six: [] })).toEqual([{ isin: 'GB00BP6MXD84', exchCode: 'LN' }]);
  });
});

describe('Yahoo symbols', () => {
  it('BT/A → BT-A.L exact', () => {
    expect(yahooSymbolFor('LSE', 'BT/A')).toEqual({ exact: 'BT-A.L' });
    expect(yahooSymbolFor('LSE', 'BA/')).toEqual({ exact: 'BA.L' });
    expect(yahooSymbolFor('LSE', 'AZN')).toEqual({ exact: 'AZN.L' });
    expect(yahooSymbolFor('HEL', 'KNEBV')).toEqual({ exact: 'KNEBV.HE' });
    expect(yahooSymbolFor('XET', 'SAP')).toEqual({ exact: 'SAP.DE' });
    const u = buildEuropeUniverse({ ...base, firdsUk: [share('GB0030913577', 'XLON')], figi: [figi('GB0030913577', 'LN', 'BT/A')] });
    expect(u.uk.map((e) => e.symbol)).toEqual(['BT-A.L']);
  });

  it('ERICB on STO → confirmed ERIC-B.ST by ISIN search; unconfirmed → left out', () => {
    expect(yahooSymbolFor('STO', 'ERICB')).toEqual({ candidates: ['ERIC-B.ST', 'ERICB.ST'] });
    expect(yahooSymbolFor('CPH', 'NOVOB')).toEqual({ candidates: ['NOVO-B.CO', 'NOVOB.CO'] });
    const u = buildEuropeUniverse({
      ...base,
      firdsEu: [share('SE0000108656', 'XSTO'), share('SE0005308558', 'SSME'), share('SE0000000001', 'XSTO')],
      figi: [figi('SE0000108656', 'SS', 'ERICB'), figi('SE0005308558', 'SF', 'CLAV'), figi('SE0000000001', 'SS', 'ABCB')],
      // The search found Ericsson's B line; for Clavister it returned an unrelated symbol; the third was never searched.
      searched: new Map([['SE0000108656', ['ERIC-B.ST', 'ERIC-A.ST']], ['SE0005308558', ['CLAV.OL']]]),
    });
    expect(u.eu.map((e) => [e.symbol, e.mic])).toEqual([['ERIC-B.ST', 'XSTO']]);
    expect(u.leftOut).toEqual([{ isin: 'SE0000000001', reason: 'not-confirmed' }, { isin: 'SE0005308558', reason: 'not-confirmed' }]);
    // The growth segment is asked with its own exchCode.
    expect(figiJobsFor({ firdsUk: [], firdsEu: [share('SE0005308558', 'SSME')], six: [] })).toEqual([{ isin: 'SE0005308558', exchCode: 'SF' }]);
    // Only search-exchange ISINs with a ticker go to the Yahoo ISIN search.
    expect(searchIsinsFor([figi('SE0000108656', 'SS', 'ERICB'), figi('SE0005308558', 'SF', 'CLAV'), figi('SE0000000002', 'SS'), figi('FR0000121014', 'FP', 'MC'), figi('DK0062498333', 'DC', 'NOVOB')]))
      .toEqual(['SE0000108656', 'SE0005308558', 'DK0062498333']);
  });

  it('two figi tickers on one exchange → ambiguous-ticker, left out', () => {
    const u = buildEuropeUniverse({
      ...base, firdsEu: [share('FR0000130452', 'XPAR'), share('FR0000121014', 'XPAR')],
      figi: [figi('FR0000130452', 'FP', 'FGR', 'FGRMC'), figi('FR0000121014', 'FP')],
    });
    expect(u.eu).toEqual([]);
    expect(u.leftOut).toEqual([{ isin: 'FR0000121014', reason: 'no-ticker' }, { isin: 'FR0000130452', reason: 'ambiguous-ticker' }]);
  });
});

describe('full level and names', () => {
  it('full entry overrides: HSBA.L full with HSBC', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = buildEuropeUniverse({
      ...base, firdsUk: [share('GB0005405286', 'XLON', { fullName: 'HSBC HLDGS PLC ORD $0.50 (UK REG)' }), share('GB0009895292', 'XLON')],
      figi: [figi('GB0005405286', 'LN', 'HSBA'), figi('GB0009895292', 'LN', 'AZN')], full: UK_FULL,
    });
    expect(bySymbol(u.uk, 'HSBA.L')).toMatchObject({ adr: 'HSBC', adrRatio: 5, adrRatioVerified: true, cik: 1089113, secForm: '6-K', name: 'HSBC HLDGS PLC' });
    expect(bySymbol(u.uk, 'AZN.L')).toMatchObject({ adr: 'AZN', cik: 901832 });
    warn.mockRestore();
  });

  it('every full-level row exists regardless of the FIRDS tie-break (BHP.L, WPP.L, CCEP.L, SAP.DE, NOKIA.HE)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = buildEuropeUniverse({
      ...base,
      firdsUk: [share('AU000000BHP4', 'XLON'), share('JE00B8KF9B49', 'XLON')],
      // CCEP's GB ISIN with only an Amsterdam issuer line would land in EU as CCEP.AS; the full list keeps it UK.
      // Stellantis on MTAA and XPAR with an NL ISIN is ambiguous by the tie-break; the full list keeps STLAM.MI.
      firdsEu: [share('GB00BDCPN049', 'XAMS'), share('NL00150001Q9', 'MTAA'), share('NL00150001Q9', 'XPAR'), share('DE0007164600', 'XETA', { lei: '529900D6BF99LW9R2E68' })],
      figi: [figi('AU000000BHP4', 'LN', 'BHP'), figi('JE00B8KF9B49', 'LN', 'WPP'), figi('GB00BDCPN049', 'NA', 'CCEP'), figi('DE0007164600', 'GY', 'SAP')],
      names: new Map([['529900D6BF99LW9R2E68', 'SAP SE']]),
      full: [...UK_FULL, ...EU_FULL],
    });
    for (const f of UK_FULL) expect(bySymbol(u.uk, f.symbol), f.symbol).toMatchObject({ isin: f.isin, adr: f.adr, cik: f.cik });
    for (const f of EU_FULL) expect(bySymbol(u.eu, f.symbol), f.symbol).toMatchObject({ isin: f.isin, adr: f.adr, cik: f.cik });
    expect(bySymbol(u.uk, 'BHP.L')).toMatchObject({ isin: 'AU000000BHP4', exchange: 'LSE', mic: 'XLON', currency: 'GBp' });
    expect(bySymbol(u.uk, 'WPP.L')).toMatchObject({ isin: 'JE00B8KF9B49', mic: 'XLON' });
    expect(bySymbol(u.uk, 'CCEP.L')).toMatchObject({ isin: 'GB00BDCPN049', exchange: 'LSE', name: 'Coca-Cola Europacific Partners PLC' });
    expect(bySymbol(u.eu, 'CCEP.AS')).toBeUndefined();
    expect(bySymbol(u.eu, 'SAP.DE')).toMatchObject({ lei: '529900D6BF99LW9R2E68', mic: 'XETA', name: 'SAP SE', cik: 1000184 });
    expect(bySymbol(u.eu, 'NOKIA.HE')).toMatchObject({ isin: 'FI0009000681', exchange: 'HEL', country: 'FI', currency: 'EUR' });
    expect(bySymbol(u.eu, 'STLAM.MI')).toMatchObject({ exchange: 'MIL', mic: 'MTAA' });
    expect(bySymbol(u.eu, 'NOVN.SW')).toMatchObject({ exchange: 'SIX', currency: 'CHF' });
    expect(u.leftOut.map((l) => l.isin)).not.toContain('NL00150001Q9');
    // One ISIN, one row, one market.
    const isins = [...u.uk, ...u.eu].map((e) => e.isin);
    expect(new Set(isins).size).toBe(isins.length);
    // Rows the build did not produce are logged.
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('NOKIA.HE'))).toBe(true);
    warn.mockRestore();
  });

  it('GLEIF name preferred; FIRDS FullNm trimmed otherwise', () => {
    const u = buildEuropeUniverse({
      ...base,
      firdsUk: [
        share('GB0030913577', 'XLON', { lei: '213800LRO7NS5CYQMN21', fullName: 'BT GROUP PLC ORD 5P' }),
        share('GB0009895292', 'XLON', { lei: 'PY6ZZQWO2IZFZC3IOL08', fullName: 'ASTRAZENECA PLC ORD SHS $0.25' }),
      ],
      figi: [figi('GB0030913577', 'LN', 'BT/A'), figi('GB0009895292', 'LN', 'AZN')],
      names: new Map([['213800LRO7NS5CYQMN21', 'BT GROUP PLC']]),
    });
    expect(bySymbol(u.uk, 'BT-A.L')?.name).toBe('BT GROUP PLC');
    expect(bySymbol(u.uk, 'AZN.L')?.name).toBe('ASTRAZENECA PLC');
    expect(leisFor({ firdsUk: [share('GB0030913577', 'XLON', { lei: '213800LRO7NS5CYQMN21' }), share('GB0009895292', 'XLON')], firdsEu: [], six: [] }))
      .toEqual(['213800LRO7NS5CYQMN21']);
    expect(trimFirdsName('SAP SE Inhaber-Aktien o.N.')).toBe('SAP SE');
    expect(trimFirdsName('NÜRNBERGER Beteiligungs-AG VINK.NAMENS-AKTIEN O.N.')).toBe('NÜRNBERGER Beteiligungs-AG');
    expect(trimFirdsName('HAMMERSON PLC Ordinary Shares')).toBe('HAMMERSON PLC');
    expect(trimFirdsName('Ericsson, Telefonab. L M ser. B')).toBe('Ericsson, Telefonab. L M');
    expect(trimFirdsName('Kingfish Co NV/The SHRS')).toBe('Kingfish Co NV/The');
    expect(trimFirdsName('LVMH')).toBe('LVMH');
  });
});

describe('SIX list', () => {
  it('drops sponsored, rights and 2. LINIE lines; SIX rows keep the list name and currency', () => {
    const rows = parseSixList(fx('six_list_sample.csv'));
    expect(rows.find((r) => r.isin === 'CH0012005267')).toEqual({ isin: 'CH0012005267', symbol: 'NOVN', name: 'NOVARTIS N', currency: 'CHF' });
    expect(rows.some((r) => /LINIE/.test(r.name))).toBe(false);
    expect(rows.some((r) => r.isin === 'DE0005545503' || r.isin === 'CH1595632147')).toBe(false);
    expect(rows.map((r) => r.symbol)).toContain('ALPN');
    const u = buildEuropeUniverse({ ...base, six: rows });
    expect(bySymbol(u.eu, 'NOVN.SW')).toMatchObject({ name: 'NOVARTIS N', currency: 'CHF', country: 'CH', exchange: 'SIX', lei: null });
    expect(u.eu).toHaveLength(rows.length);
  });
});

describe('fetchLegalNames', () => {
  it('batches of 200; a failed batch leaves its LEIs absent', async () => {
    const urls: string[] = [];
    const answer = JSON.parse(fx('gleif_batch.json'));
    const http: Http = {
      json: async (url) => {
        urls.push(url);
        if (urls.length === 2) throw new Error('HTTP 503');
        return answer;
      },
      text: async () => '',
    };
    const leis = ['213800LRO7NS5CYQMN21', 'PY6ZZQWO2IZFZC3IOL08', ...Array.from({ length: 199 }, (_, i) => `ZZ${String(i).padStart(18, '0')}`), 'PY6ZZQWO2IZFZC3IOL08', 'bad lei'];
    const names = await fetchLegalNames(http, leis);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^https:\/\/api\.gleif\.org\/api\/v1\/lei-records\?filter%5Blei%5D=213800LRO7NS5CYQMN21%2CPY6ZZQWO2IZFZC3IOL08%2C/);
    expect(urls[0]).toContain('page%5Bsize%5D=200');
    expect(names.get('213800LRO7NS5CYQMN21')).toBe('BT GROUP PLC');
    expect(names.get('PY6ZZQWO2IZFZC3IOL08')).toBe('ASTRAZENECA PLC');
    expect(names.get('724500Y6DUVHQD6OXN27')).toBeUndefined(); // in the answer but not asked for
    expect(names.size).toBe(2);
  });
});
