import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createYahooEuropeSummary, defaultZoneOf, EUROPE_INDICES, fetchEuropeEarningsCalendar, fetchEuropeQuotes,
  parseEuropeCalendarPage, parseEuropeSummary, YAHOO_REGIONS, yahooIsinSearch, type ExchangeId,
} from '../../src/europe/sources/yahooEurope.js';
import { HttpError, SourceFormatError } from '../../src/sources/http.js';
import { parseIndexQuote } from '../../src/sources/yahoo.js';
import type { YahooClient } from '../../src/sources/yahooClient.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/europe/yahoo/${n}`, import.meta.url), 'utf8'));

/** A YahooClient stub; only the methods a test sets are usable. */
function stub(o: { json?: (url: string) => Promise<unknown>; postJson?: (url: string, body: unknown) => Promise<unknown> }): YahooClient {
  return {
    json: o.json ?? (async () => { throw new Error('json not stubbed'); }),
    text: async () => { throw new Error('text not stubbed'); },
    postJson: o.postJson ?? (async () => { throw new Error('postJson not stubbed'); }),
  };
}

/** A visualization answer holding `rows` (ticker, name, startdatetime, startdatetimetype, epsestimate, epsactual). */
const vizPage = (rows: unknown[][], total = rows.length) => ({
  finance: { result: [{ total, documents: [{
    columns: ['ticker', 'companyshortname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual'].map((id) => ({ id })),
    rows,
  }] }] },
});

describe('Yahoo Europe bulk calendar', () => {
  it('regions recorded: bulkCalendar flags match the fixtures', () => {
    const seen: string[] = [];
    for (const [id, { region, bulkCalendar }] of Object.entries(YAHOO_REGIONS) as [ExchangeId, { region: string; bulkCalendar: boolean }][]) {
      const page = parseEuropeCalendarPage(fx(`y_cal_${region}.json`), defaultZoneOf);
      const current = page.rows.some((r) => r.date >= '2026-01-01');
      expect({ id, bulkCalendar }).toEqual({ id, bulkCalendar: current });
      seen.push(region);
    }
    expect(seen).toHaveLength(14);
    // Recorded 2026-10-28: only these six regions have rows in the window.
    expect(Object.entries(YAHOO_REGIONS).filter(([, v]) => v.bulkCalendar).map(([k]) => k).sort())
      .toEqual(['CPH', 'LSE', 'MIL', 'SIX', 'STO', 'XET']);
  });

  it('real UK page: rows are .L only, dated in London, other venues (.IL, .XC) dropped', () => {
    const p = parseEuropeCalendarPage(fx('y_cal_gb.json'), defaultZoneOf);
    expect(p.total).toBe(18);
    expect(p.rows.length).toBe(8);
    expect(p.rows.every((r) => r.symbol.endsWith('.L'))).toBe(true);
    expect(p.rows.some((r) => r.timeType === 'TAS' && r.timing !== 'UNKNOWN')).toBe(true);
    expect(p.rows.filter((r) => r.timeType !== 'TAS').every((r) => r.timing === 'UNKNOWN')).toBe(true);
  });

  it('TAS row on .L gets London date and timing; .HE row uses Helsinki', () => {
    const page = vizPage([
      ['AZN.L', 'AstraZeneca', '2026-11-06T07:00:00.000Z', 'TAS', 2.5, null],
      ['NOKIA.HE', 'Nokia', '2026-10-23T05:00:00.000Z', 'TAS', 0.1, 0.12],
      ['SAP.DE', 'SAP', '2026-10-21T20:30:00.000Z', 'TAS', null, null],
      ['BT-A.L', 'BT', '2026-11-05T10:59:00.000Z', 'TNS', null, null],
      ['XYZ.F', 'Frankfurt line', '2026-11-05T07:00:00.000Z', 'TAS', null, null],
      ['AAPL', 'No suffix', '2026-11-05T07:00:00.000Z', 'TAS', null, null],
    ]);
    const p = parseEuropeCalendarPage(page, defaultZoneOf);
    expect(p.total).toBe(6);
    expect(p.rows).toEqual([
      { symbol: 'AZN.L', date: '2026-11-06', timing: 'BMO', timeType: 'TAS', epsActual: null },
      // 05:00Z = 08:00 Helsinki (EEST, UTC+3), before the 10:00 open.
      { symbol: 'NOKIA.HE', date: '2026-10-23', timing: 'BMO', timeType: 'TAS', epsActual: 0.12 },
      // 20:30Z = 22:30 Berlin (CEST), after the close: AMC on the same local date.
      { symbol: 'SAP.DE', date: '2026-10-21', timing: 'AMC', timeType: 'TAS', epsActual: null },
      // TNS: the UTC date, no timing.
      { symbol: 'BT-A.L', date: '2026-11-05', timing: 'UNKNOWN', timeType: 'TNS', epsActual: null },
    ]);
  });

  it('TAS crossing midnight moves the date into the exchange zone; mid-session is DMH, the close is AMC', () => {
    const page = vizPage([
      ['ASML.AS', 'ASML', '2026-11-03T23:30:00.000Z', 'TAS', null, null], // 00:30 Amsterdam next day
      ['SHEL.L', 'Shell', '2026-12-01T12:00:00.000Z', 'TAS', null, null], // 12:00 London (GMT)
      ['SHEL.L', 'Shell', '2026-12-01T16:30:00.000Z', 'TAS', null, null], // 16:30 = close
      ['NOVN.SW', 'Novartis', '2026-12-01T16:19:00.000Z', 'TAS', null, null], // 17:19 Zurich, before 17:20
    ]);
    const p = parseEuropeCalendarPage(page, defaultZoneOf);
    expect(p.rows.map((r) => [r.date, r.timing])).toEqual([
      ['2026-11-04', 'BMO'], ['2026-12-01', 'DMH'], ['2026-12-01', 'AMC'], ['2026-12-01', 'DMH'],
    ]);
  });

  it('fetch: pages until total, cuts to the window, a failure mid-sweep is incomplete', async () => {
    const bodies: any[] = [];
    const pages = [
      vizPage(Array.from({ length: 100 }, (_, i) => ['AZN.L', 'x', '2026-11-06T07:00:00.000Z', 'TAS', null, null].map((v, j) => (j === 0 ? `S${i}.L` : v))), 150),
      vizPage([['VOD.L', 'Vodafone', '2026-11-30T07:00:00.000Z', 'TAS', null, null]], 150),
    ];
    const ok = stub({ postJson: async (_u, b) => { bodies.push(b); return pages[bodies.length - 1]; } });
    const r = await fetchEuropeEarningsCalendar(ok, 'gb', '2026-11-01', '2026-11-20', defaultZoneOf);
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(100); // VOD.L is outside the window
    expect(bodies[0].query.operands[2]).toEqual({ operator: 'eq', operands: ['region', 'gb'] });
    expect(bodies[0].query.operands[0].operands[1]).toBe('2026-10-31');

    let n = 0;
    const failing = stub({ postJson: async () => { if (n++ === 0) return pages[0]; throw new Error('boom'); } });
    const f = await fetchEuropeEarningsCalendar(failing, 'gb', '2026-11-01', '2026-11-20', defaultZoneOf);
    expect(f.complete).toBe(false);
    expect(f.rows).toHaveLength(100);

    const bad = stub({ postJson: async () => ({ finance: { error: 'x' } }) });
    expect((await fetchEuropeEarningsCalendar(bad, 'gb', '2026-11-01', '2026-11-20', defaultZoneOf)).complete).toBe(false);
  });
});

describe('Yahoo Europe quotes', () => {
  it('quotes: GBp line, USD .L line and EUR line keep their currencies; cap kept with its currency; unknown absent', async () => {
    const asked: string[] = [];
    const y = stub({ json: async (url) => { asked.push(url); return fx('y_quote_batch.json'); } });
    const symbols = ['AZN.L', 'IHG.L', 'BT-A.L', 'SAP.DE', 'ZZZZ9.L', 'NOVN.SW', 'ERIC-B.ST', 'NOVO-B.CO'];
    const m = await fetchEuropeQuotes(y, symbols);
    expect(asked).toHaveLength(1);
    expect(m.has('ZZZZ9.L')).toBe(false);
    const azn = m.get('AZN.L')!;
    expect(azn.currency).toBe('GBp');
    expect(azn.price).toBe(12822);
    // Yahoo's cap for a pence line is in pounds, and is said so.
    expect(azn.marketCap).toBe(198857129984);
    expect(azn.marketCapCurrency).toBe('GBP');
    const ihg = m.get('IHG.L')!;
    expect([ihg.currency, ihg.marketCapCurrency, ihg.marketCap]).toEqual(['USD', 'USD', 23936333824]);
    expect(m.get('BT-A.L')!.currency).toBe('GBp');
    const sap = m.get('SAP.DE')!;
    expect([sap.currency, sap.marketCapCurrency]).toEqual(['EUR', 'EUR']);
    expect(m.get('NOVN.SW')!.marketCapCurrency).toBe('CHF');
    expect(m.get('ERIC-B.ST')!.currency).toBe('SEK');
    expect(m.get('NOVO-B.CO')!.currency).toBe('DKK');
    expect(azn.time).toBe(1793121300 * 1000);
    expect(azn.name).toBeTruthy();
  });

  it('batches of 50 and encodes symbols', async () => {
    const urls: string[] = [];
    const y = stub({ json: async (url) => { urls.push(url); return { quoteResponse: { result: [] } }; } });
    await fetchEuropeQuotes(y, Array.from({ length: 101 }, (_, i) => (i === 0 ? 'BT-A.L' : `S${i}.L`)));
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('symbols=BT-A.L,');
  });

  it('a quote with no marketCap or an unknown currency has no cap', async () => {
    const y = stub({ json: async () => ({ quoteResponse: { result: [
      { symbol: 'A.L', currency: 'GBp', regularMarketPrice: 10 },
      { symbol: 'B.L', marketCap: 5 },
    ] } }) });
    const m = await fetchEuropeQuotes(y, ['A.L', 'B.L']);
    expect(m.get('A.L')).toMatchObject({ marketCap: null, marketCapCurrency: null });
    expect(m.get('B.L')).toMatchObject({ marketCap: null, marketCapCurrency: null, currency: null });
  });
});

describe('Yahoo Europe summaries', () => {
  it('summary: fyEndMonth 12 for SAP.DE, 3 for VOD.L; trend EPS currency as stated', () => {
    const sap = parseEuropeSummary(fx('y_SAP.DE.json'), 'Europe/Berlin');
    expect(sap.fyEndMonth).toBe(12);
    expect(sap.priceCurrency).toBe('EUR');
    expect(sap.trend.find((t) => t.period === '0q')).toMatchObject({ periodEnd: '2026-12-31', epsCurrency: 'EUR', revenueCurrency: 'EUR' });
    expect(sap.marketCapCurrency).toBe('EUR');

    const vod = parseEuropeSummary(fx('y_VOD.L.json'), 'Europe/London');
    expect(vod.fyEndMonth).toBe(3);
    // The price is in pence but the estimates are in the reporting currency (EUR), as stated, never converted.
    expect(vod.priceCurrency).toBe('GBp');
    expect(vod.trend.map((t) => [t.period, t.epsCurrency])).toEqual([['0y', 'EUR'], ['+1y', 'EUR']]);
    expect(vod.marketCap).toBe(27545868288);
    expect(vod.marketCapCurrency).toBe('GBP');
    expect(vod.nextDate).toBe('2026-11-10');

    expect(parseEuropeSummary(fx('y_AZN.L.json'), 'Europe/London').trend[0]).toMatchObject({ period: '0q', periodEnd: '2026-09-30', epsCurrency: 'USD' });
    expect(parseEuropeSummary(fx('y_BT-A.L.json'), 'Europe/London').trend[0]!.epsCurrency).toBe('GBP');
    expect(parseEuropeSummary(fx('y_NOVO-B.CO.json'), 'Europe/Copenhagen')).toMatchObject({ fyEndMonth: 12, priceCurrency: 'DKK' });
  });

  it('AIM name (FEVR.L) and a May year end (GAW.L) parse; a missing defaultKeyStatistics gives a null month', () => {
    expect(parseEuropeSummary(fx('y_FEVR.L.json'), 'Europe/London')).toMatchObject({ fyEndMonth: 12, priceCurrency: 'GBp' });
    expect(parseEuropeSummary(fx('y_GAW.L.json'), 'Europe/London').fyEndMonth).toBe(5);
    const noKs = fx('y_SAP.DE.json');
    delete noKs.quoteSummary.result[0].defaultKeyStatistics;
    expect(parseEuropeSummary(noKs, 'Europe/Berlin').fyEndMonth).toBeNull();
  });

  it('createYahooEuropeSummary: caches by age, 404 is null, other errors throw and are not cached', async () => {
    let calls = 0;
    let mode: 'ok' | '404' | '500' = 'ok';
    const y = stub({ json: async (url) => {
      calls++;
      expect(url).toContain('modules=price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings,defaultKeyStatistics');
      if (mode === '404') throw new HttpError(404, url);
      if (mode === '500') throw new HttpError(500, url);
      return fx('y_SAP.DE.json');
    } });
    const get = createYahooEuropeSummary(y);
    expect((await get('SAP.DE', 60_000))!.fyEndMonth).toBe(12);
    await get('SAP.DE', 60_000);
    expect(calls).toBe(1);
    mode = '404';
    expect(await get('GONE.DE', 60_000)).toBeNull();
    mode = '500';
    await expect(get('ERR.DE', 60_000)).rejects.toThrow();
    mode = '404';
    expect(await get('ERR.DE', 60_000)).toBeNull();
    // A symbol with no known suffix is not requested.
    const before = calls;
    expect(await get('NOSUFFIX', 60_000)).toBeNull();
    expect(calls).toBe(before);
  });
});

describe('Yahoo Europe ISIN search and indices', () => {
  it('ISIN search returns ERIC-B.ST for SE0000108656', async () => {
    let url = '';
    const y = stub({ json: async (u) => { url = u; return fx('y_search_SE0000108656.json'); } });
    expect(await yahooIsinSearch(y, 'SE0000108656')).toEqual(['ERIC-B.ST']);
    expect(url).toContain('q=SE0000108656');
    expect(url).toContain('quotesCount=10');
    expect(await yahooIsinSearch(stub({ json: async () => ({ quotes: [] }) }), 'XX0000000000')).toEqual([]);
    await expect(yahooIsinSearch(stub({ json: async () => ({}) }), 'XX0000000000')).rejects.toBeInstanceOf(SourceFormatError);
    await expect(yahooIsinSearch(stub({ json: async () => null }), 'XX0000000000')).rejects.toBeInstanceOf(SourceFormatError);
    await expect(yahooIsinSearch(stub({ json: async () => ({ quotes: 'x' }) }), 'XX0000000000')).rejects.toBeInstanceOf(SourceFormatError);
    expect(await yahooIsinSearch(stub({ json: async () => ({ quotes: [
      { symbol: 'ABC.L', quoteType: 'EQUITY' }, { symbol: 'FUND.L', quoteType: 'MUTUALFUND' },
    ] }) }), 'GB0000000000')).toEqual(['ABC.L']);
  });

  it('all 11 indices parse', () => {
    const all = [...EUROPE_INDICES.UK, ...EUROPE_INDICES.EU];
    expect(all.map((i) => i.name)).toEqual([
      'FTSE 100', 'FTSE 250', 'FTSE AIM All-Share', 'Euro Stoxx 50', 'DAX', 'CAC 40', 'AEX', 'IBEX 35', 'FTSE MIB', 'SMI', 'OMXS30',
    ]);
    for (const idx of all) {
      const q = parseIndexQuote(fx(`y_idx_${idx.yahoo}.json`));
      expect(q.symbol).toBe(idx.yahoo);
      expect(q.price).toBeGreaterThan(0);
      expect(q.currency).toBeTruthy();
    }
  });
});
