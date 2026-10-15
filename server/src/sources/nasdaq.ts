import { z } from 'zod';
import { parseIntOrNull, parseNumber } from '../domain/parse.js';
import type { CalendarRow, Timing } from '../types.js';
import { type Http, SourceFormatError } from './http.js';

const Str = z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : String(v)));

const RowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  time: z.string().nullish(),
  marketCap: Str,
  fiscalQuarterEnding: z.string().nullish(),
  epsForecast: Str,
  noOfEsts: Str,
  eps: Str,
  surprise: Str,
});

const ResponseSchema = z.object({
  data: z.object({ rows: z.array(RowSchema).nullish() }).nullish(),
});

export function nasdaqTiming(time: string | null | undefined): Timing {
  if (time === 'time-pre-market') return 'BMO';
  if (time === 'time-after-hours') return 'AMC';
  return 'UNKNOWN';
}

export function parseNasdaqCalendar(json: unknown, date: string): CalendarRow[] {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Nasdaq calendar ${date}: ${parsed.error.message}`);
  return (parsed.data.data?.rows ?? [])
    .filter((r) => r.symbol.trim() !== '')
    .map((r) => ({
      symbol: r.symbol.trim(),
      name: r.name.trim(),
      reportDate: date,
      fiscalQuarter: r.fiscalQuarterEnding?.trim() || `date:${date}`,
      timing: nasdaqTiming(r.time),
      marketCap: parseNumber(r.marketCap),
      epsEstimate: parseNumber(r.epsForecast),
      noOfEsts: parseIntOrNull(r.noOfEsts),
      epsActual: parseNumber(r.eps),
      epsSurprisePct: parseNumber(r.surprise),
    }));
}

export async function fetchNasdaqCalendar(http: Http, date: string): Promise<CalendarRow[]> {
  return parseNasdaqCalendar(await http.json(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`), date);
}
