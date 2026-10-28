import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { EXCHANGES, UNIVERSE_URLS, exchangeOfSymbol, exchangesOf, type ExchangeId } from '../../src/europe/exchanges.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/europe/universe/${name}`, import.meta.url), 'utf8');
const ids = Object.keys(EXCHANGES) as ExchangeId[];

describe('EXCHANGES', () => {
  it('14 exchanges, UK has only LSE, suffixes unique', () => {
    expect(ids).toHaveLength(14);
    expect(exchangesOf('UK')).toEqual(['LSE']);
    expect(exchangesOf('EU')).toHaveLength(13);
    expect(exchangesOf('EU')).not.toContain('LSE');
    const suffixes = ids.map((id) => EXCHANGES[id].suffix);
    expect(new Set(suffixes).size).toBe(14);
    for (const id of ids) expect(EXCHANGES[id].id).toBe(id);
  });

  it('exchangeOfSymbol: BT-A.L → LSE, ERIC-B.ST → STO, FTSEMIB.MI → MIL, AAPL → null', () => {
    expect(exchangeOfSymbol('BT-A.L')).toBe('LSE');
    expect(exchangeOfSymbol('ERIC-B.ST')).toBe('STO');
    expect(exchangeOfSymbol('FTSEMIB.MI')).toBe('MIL');
    expect(exchangeOfSymbol('NOVN.SW')).toBe('SIX');
    expect(exchangeOfSymbol('sap.de')).toBe('XET');
    expect(exchangeOfSymbol('AAPL')).toBeNull();
    expect(exchangeOfSymbol('0005.HK')).toBeNull();
  });

  it('sessions as Ruling 3: HEL 600–1110, OSL 540–980, SIX 540–1040, LIS 480–990', () => {
    const s = (id: ExchangeId) => [EXCHANGES[id].openMin, EXCHANGES[id].closeMin];
    expect(s('HEL')).toEqual([600, 1110]);
    expect(s('OSL')).toEqual([540, 980]);
    expect(s('SIX')).toEqual([540, 1040]);
    expect(s('LIS')).toEqual([480, 990]);
    expect(s('DUB')).toEqual([480, 990]);
    expect(s('LSE')).toEqual([480, 990]);
    for (const id of ['PAR', 'AMS', 'BRU', 'MIL', 'XET', 'STO', 'CPH', 'MAD'] as const) expect(s(id)).toEqual([540, 1050]);
  });

  it('MICs and OpenFIGI codes as verified live (2026-10-24 FULINS_E)', () => {
    expect(EXCHANGES.LSE.mics).toEqual(['XLON', 'AIMX']);
    expect(EXCHANGES.XET.mics).toEqual(['XETA', 'XETS']);
    expect(EXCHANGES.STO.mics).toEqual(['XSTO', 'SSME']);
    expect(EXCHANGES.SIX.mics).toEqual([]);
    expect(EXCHANGES.STO.micExchCodes).toEqual({ XSTO: 'SS', SSME: 'SF' });
    expect(EXCHANGES.HEL.micExchCodes).toEqual({ XHEL: 'FH', FSME: 'FF' });
    expect(EXCHANGES.CPH.micExchCodes).toEqual({ XCSE: 'DC', DSME: 'DF' });
    // Every MIC has an exchCode, no MIC belongs to two exchanges, and the main code is the first MIC's.
    const seen = new Set<string>();
    for (const id of ids) {
      const e = EXCHANGES[id];
      expect(Object.keys(e.micExchCodes)).toEqual([...e.mics]);
      if (e.mics.length > 0) expect(e.micExchCodes[e.mics[0]!]).toBe(e.figiExchCode);
      for (const m of e.mics) {
        expect(seen.has(m)).toBe(false);
        seen.add(m);
      }
    }
    expect(EXCHANGES.SIX.figiExchCode).toBe('SE');
    expect(EXCHANGES.LSE.universeSource).toBe('fca-firds');
    expect(EXCHANGES.SIX.universeSource).toBe('six-list');
    expect(EXCHANGES.PAR.universeSource).toBe('esma-firds');
    expect(EXCHANGES.LSE.currency).toBe('GBp');
  });

  it('tickerTransform is search for STO and CPH; exact elsewhere (HEL verified exact)', () => {
    const search = ids.filter((id) => EXCHANGES[id].tickerTransform === 'search');
    expect(search.sort()).toEqual(['CPH', 'STO']);
    expect(EXCHANGES.HEL.tickerTransform).toBe('exact');
  });

  it('universe URLs use only allowed hosts', () => {
    const hosts = Object.values(UNIVERSE_URLS).map((u) => new URL(u).host);
    expect(hosts).toEqual([
      'registers.esma.europa.eu',
      'api.data.fca.org.uk',
      'www.six-group.com',
      'api.gleif.org',
      'api.openfigi.com',
      'query2.finance.yahoo.com',
    ]);
  });
});

describe('fixtures are real answers', () => {
  it('firds_sample.xml has ≥ 60 <RefData> blocks with AIM, Xetra and one ISIN on two venues', () => {
    const xml = fixture('firds_sample.xml');
    const recs = xml.match(/<RefData>[\s\S]*?<\/RefData>/g) ?? [];
    expect(recs.length).toBeGreaterThanOrEqual(60);
    const venue = (r: string) => /<TradgVnRltdAttrbts>\s*<Id>(\w+)<\/Id>/.exec(r)?.[1];
    const mics = recs.map(venue);
    expect(mics).toContain('AIMX');
    expect(mics).toContain('XETA');
    // FIRDS never puts two venues in one record: a second venue is a second record for the same ISIN.
    expect(recs.every((r) => (r.match(/<TradgVnRltdAttrbts>/g) ?? []).length === 1)).toBe(true);
    const hammerson = recs.filter((r) => r.includes('<Id>GB00BRJQ8J25</Id>')).map(venue);
    expect(hammerson.sort()).toEqual(['XLON', 'XMSM']);
  });

  it('esma, fca, six, gleif, openfigi and yahoo answers have their recorded shapes', () => {
    const esma = JSON.parse(fixture('esma_index.json')) as { response: { docs: { file_name: string; download_link: string }[] } };
    expect(esma.response.docs.some((d) => /^FULINS_E_\d{8}_\d{2}of\d{2}\.zip$/.test(d.file_name))).toBe(true);
    const fca = JSON.parse(fixture('fca_index.json')) as { hits: { hits: { _source: { file_name: string; download_link: string } }[] } };
    expect(fca.hits.hits.some((h) => h._source.file_name.startsWith('FULINS_E_'))).toBe(true);

    const six = fixture('six_list_sample.csv').trim().split('\n');
    expect(six[0]).toBe('ShortName;ValorSymbol;ValorNumber;ISIN;TradingBaseCurrency;ListingSegmentDesc;GeographicalAreaDesc;SecTypeDesc');
    expect(six).toHaveLength(31);
    expect(six).toContain('NOVARTIS N;NOVN;1200526;CH0012005267;CHF;International Reporting Standard;Switzerland;Registered Share');

    const gleif = JSON.parse(fixture('gleif_batch.json')) as { data: { attributes: { lei: string; entity: { legalName: { name: string } } } }[] };
    expect(gleif.data.length).toBeGreaterThanOrEqual(5);
    expect(gleif.data.find((d) => d.attributes.lei === 'PY6ZZQWO2IZFZC3IOL08')?.attributes.entity.legalName.name).toBe('ASTRAZENECA PLC');

    const figi = JSON.parse(fixture('openfigi_batch.json')) as ({ data: { ticker: string; exchCode: string }[] } | { warning: string })[];
    expect(figi).toHaveLength(10);
    const tickers = figi.map((r) => ('data' in r ? r.data.map((d) => d.ticker) : null));
    expect(tickers[0]).toEqual(['AZN']);
    expect(tickers[1]).toEqual(['BT/A']);
    expect(tickers[2]).toEqual(['ERICB']);
    expect(tickers[3]).toEqual(['NOVOB']);
    expect(figi[4]).toEqual({ warning: 'No identifier found.' });
    expect(tickers[5]).toEqual(['FGR', 'FGRMC']);

    const yahoo = JSON.parse(fixture('yahoo_isin_search.json')) as { quotes: { symbol: string }[] };
    expect(yahoo.quotes.map((q) => q.symbol)).toContain('ERIC-B.ST');
  });
});
