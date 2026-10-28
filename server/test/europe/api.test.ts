import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { openDb } from '../../src/db/repo.js';
import { mergeEuropeActuals, setEuropeEstimates, syncEuropeUniverse, upsertEuropeCalendarRow } from '../../src/europe/db/europeRepo.js';
import type { EuropeEarningsResponse, EuropeReportDto } from '../../src/europe/api/types.js';
import { EUROPE_INDICES } from '../../src/europe/sources/yahooEurope.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import type { ExchangeId } from '../../src/europe/exchanges.js';

const NOW = '2026-10-28T09:00:00.000Z';
const entry = (symbol: string, isin: string, exchange: ExchangeId, extra: Partial<EuropeUniverseEntry> = {}): EuropeUniverseEntry => ({
  market: exchange === 'LSE' ? 'UK' : 'EU', symbol, isin, lei: null, name: `${symbol} name`, exchange, mic: 'XLON', country: isin.slice(0, 2),
  currency: exchange === 'LSE' ? 'GBp' : 'EUR', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null, ...extra,
});

function setup() {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [
    entry('TSCO.L', 'GB00BLGZ9862', 'LSE'),
    entry('AZN.L', 'GB0009895292', 'LSE', { adr: 'AZN', adrRatio: 1, adrRatioVerified: true, cik: 901832, secForm: '6-K', name: 'AstraZeneca PLC' }),
  ], NOW);
  syncEuropeUniverse(db, 'EU', [entry('SAP.DE', 'DE0007164600', 'XET'), entry('TTE.PA', 'FR0000120271', 'PAR')], NOW);
  const mk = (market: 'UK' | 'EU', symbol: string, exchange: ExchangeId, periodConfirmed = true) => upsertEuropeCalendarRow(db, market, {
    symbol, name: symbol, exchange, period: { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, periodLabel: 'H1 FY27',
    periodConfirmed, reportDate: '2026-11-05', dateStatus: 'confirmed',
  }, NOW);
  return { db, tsco: mk('UK', 'TSCO.L', 'LSE'), azn: mk('UK', 'AZN.L', 'LSE', false), sap: mk('EU', 'SAP.DE', 'XET'), tte: mk('EU', 'TTE.PA', 'PAR') };
}

const rowsOf = async (app: ReturnType<typeof buildServer>, path: string) =>
  ((await app.inject({ url: path })).json() as EuropeEarningsResponse).rows;

describe('/api/uk and /api/eu', () => {
  it('GBp actual vs GBP estimate: no colour, both shown', async () => {
    const { db, tsco } = setup();
    setEuropeEstimates(db, tsco, { eps: 0.118, epsAnalysts: 9, epsCurrency: 'GBP', revenue: 30e9, revenueAnalysts: 8, revenueCurrency: 'GBP', span: 'quarter' }, NOW);
    mergeEuropeActuals(db, tsco, {
      revenue: { value: 33e9, currency: 'GBP', span: 'quarter', ytdMonths: null },
      eps: { basic: 12.3, diluted: null, currency: 'GBp', span: 'quarter', ytdMonths: null }, source: 'yahoo',
    }, NOW);
    const r = (await rowsOf(buildServer(db), '/api/uk/earnings?from=2026-11-05&to=2026-11-05')).find((x) => x.id === tsco)!;
    expect(r.eps).toMatchObject({ estimate: 0.118, estimateCurrency: 'GBP', actual: 12.3, actualCurrency: 'GBp', result: null, surprisePct: null });
    // Revenue shares a currency and a span: coloured.
    expect(r.revenue).toMatchObject({ result: 'beat', surprisePct: 10 });
    expect(r).toMatchObject({ market: 'UK', exchange: 'LSE', isin: 'GB00BLGZ9862', country: 'GB' });
  });

  it('unconfirmed period served as null', async () => {
    const { db, tsco, azn } = setup();
    const rows = await rowsOf(buildServer(db), '/api/uk/earnings?from=2026-11-05&to=2026-11-05');
    expect(rows.find((x) => x.id === azn)).toMatchObject({ period: null, periodEnd: '2026-09-30', level: 'full', adrTicker: 'AZN', adrRatio: 1 });
    expect(rows.find((x) => x.id === tsco)!.period).toBe('H1 FY27');
  });

  it('exchange filter on /api/eu/earnings', async () => {
    const { db, sap } = setup();
    const app = buildServer(db);
    const rows = await rowsOf(app, '/api/eu/earnings?from=2026-11-01&to=2026-11-30&exchange=XET');
    expect(rows.map((x) => x.id)).toEqual([sap]);
    expect((await rowsOf(app, '/api/eu/earnings?from=2026-11-01&to=2026-11-30')).length).toBe(2);
    expect((await app.inject({ url: '/api/eu/earnings?from=2026-11-01&to=2026-11-30&exchange=LSE' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/eu/earnings?from=2026-11-30&to=2026-11-01' })).statusCode).toBe(400);
    expect((await rowsOf(app, '/api/eu/earnings?from=2026-11-01&to=2026-11-30&q=tte')).map((x) => x.symbol)).toEqual(['TTE.PA']);
  });

  it('/api/uk/earnings/:id 404 for an EU id', async () => {
    const { db, sap, tsco } = setup();
    const app = buildServer(db);
    expect((await app.inject({ url: `/api/uk/earnings/${sap}` })).statusCode).toBe(404);
    expect(((await app.inject({ url: `/api/eu/earnings/${sap}` })).json() as EuropeReportDto).symbol).toBe('SAP.DE');
    expect(((await app.inject({ url: `/api/uk/earnings/${tsco}` })).json() as EuropeReportDto).market).toBe('UK');
  });

  it('markets falls back to index quotes', async () => {
    const { db } = setup();
    const asked: string[] = [];
    const app = buildServer(db, {
      europe: {
        UK: { indexQuote: async (s) => { asked.push(s); return { price: 8000, changePct: 0.5, asOf: NOW, currency: 'GBP' } as never; } },
        EU: { indices: () => [{ index: 'DAX', price: 1, changePct: null, asOf: null }] },
      },
    });
    const uk = (await app.inject({ url: '/api/uk/markets' })).json() as { indices: { index: string; price: number | null }[] };
    expect(uk.indices.map((i) => i.index)).toEqual(EUROPE_INDICES.UK.map((i) => i.name));
    expect(uk.indices[0]).toMatchObject({ price: 8000 });
    expect(asked).toEqual(EUROPE_INDICES.UK.map((i) => i.yahoo));
    const eu = (await app.inject({ url: '/api/eu/markets' })).json() as { indices: { index: string }[] };
    expect(eu.indices).toEqual([{ index: 'DAX', price: 1, changePct: null, asOf: null }]);
    expect((await app.inject({ url: '/api/uk/prices' })).json()).toEqual({ prices: {} });
  });
});
