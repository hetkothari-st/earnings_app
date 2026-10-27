import { DateTime } from 'luxon';
import { z } from 'zod';
import { type Http, SourceFormatError } from './http.js';

export interface IndexQuote {
  symbol: string;
  price: number;
  previousClose: number;
  changePct: number;       // rounded to 2 decimals
  asOf: string;            // ISO instant of the last quote
  currency: string | null;
}

const MetaSchema = z.object({
  symbol: z.string(),
  regularMarketPrice: z.number(),
  chartPreviousClose: z.number(),
  regularMarketTime: z.number(),
  currency: z.string().nullish(),
});
const ResponseSchema = z.object({ chart: z.object({ result: z.array(z.object({ meta: MetaSchema })).min(1) }) });

export function parseIndexQuote(json: unknown): IndexQuote {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Yahoo index quote: ${parsed.error.message}`);
  const m = parsed.data.chart.result[0]!.meta;
  return {
    symbol: m.symbol,
    price: m.regularMarketPrice,
    previousClose: m.chartPreviousClose,
    changePct: Math.round(((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose) * 10000) / 100,
    asOf: new Date(m.regularMarketTime * 1000).toISOString(),
    currency: m.currency ?? null,
  };
}

export async function fetchIndexQuote(http: Http, symbol: string): Promise<IndexQuote> {
  return parseIndexQuote(await http.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`));
}

/** Yahoo chart quote for a stock, shaped like a Finnhub quote (backup when Finnhub fails or blocks). */
export async function fetchStockQuote(http: Http, symbol: string): Promise<{ price: number; prevClose: number; time: number }> {
  const q = parseIndexQuote(await http.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`));
  return { price: q.price, prevClose: q.previousClose, time: Date.parse(q.asOf) };
}

const ChartSchema = z.object({
  chart: z.object({
    result: z.array(z.object({
      timestamp: z.array(z.number()).optional(),
      indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()).optional() })).min(1) }),
    })).min(1),
  }),
});

/** Daily closes of a Yahoo chart answer, keyed by the trading date in `zone`. Null closes are skipped. */
export function parseYahooDailyCloses(json: unknown, zone: string): Map<string, number> {
  const parsed = ChartSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Yahoo daily chart: ${parsed.error.message}`);
  const r = parsed.data.chart.result[0]!;
  const closes = r.indicators.quote[0]!.close ?? [];
  const out = new Map<string, number>();
  (r.timestamp ?? []).forEach((t, i) => {
    const c = closes[i];
    if (c == null) return;
    out.set(DateTime.fromSeconds(t, { zone }).toISODate()!, c);
  });
  return out;
}

/** Daily closes from `from` to `to` (YYYY-MM-DD days in `zone`, both inclusive). */
export async function fetchYahooDailyCloses(http: Http, symbol: string, from: string, to: string, zone: string): Promise<Map<string, number>> {
  const period1 = Math.floor(DateTime.fromISO(from, { zone }).startOf('day').toSeconds());
  const period2 = Math.floor(DateTime.fromISO(to, { zone }).plus({ days: 1 }).startOf('day').toSeconds());
  return parseYahooDailyCloses(
    await http.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`),
    zone,
  );
}
