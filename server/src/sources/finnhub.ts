import { z } from 'zod';
import type { RevenueRow, Timing } from '../types.js';
import { type Http, SourceFormatError } from './http.js';

const ItemSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  hour: z.string().nullish(),
  revenueActual: z.number().nullish(),
  revenueEstimate: z.number().nullish(),
  epsActual: z.number().nullish(),
});
const ResponseSchema = z.object({ earningsCalendar: z.array(ItemSchema) });

export function finnhubTiming(hour: string | null | undefined): Timing {
  if (hour === 'bmo') return 'BMO';
  if (hour === 'amc') return 'AMC';
  if (hour === 'dmh') return 'DMH';
  return 'UNKNOWN';
}

export function parseFinnhubEarnings(json: unknown): RevenueRow[] {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Finnhub earnings: ${parsed.error.message}`);
  return parsed.data.earningsCalendar.map((i) => ({
    symbol: i.symbol.trim(),
    reportDate: i.date,
    timing: finnhubTiming(i.hour),
    revenueEstimate: i.revenueEstimate ?? null,
    revenueActual: i.revenueActual ?? null,
    epsActual: i.epsActual ?? null,
  }));
}

/** Token is sent by makeHttp as the X-Finnhub-Token header, never in the URL. */
export async function fetchFinnhubEarnings(http: Http, from: string, to: string): Promise<RevenueRow[]> {
  return parseFinnhubEarnings(await http.json(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}`));
}
