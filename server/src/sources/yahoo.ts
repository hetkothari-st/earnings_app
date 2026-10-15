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
