import { z } from 'zod';
import { parseIntOrNull, parseNumber } from '../domain/parse.js';
import { normalizeTicker } from '../domain/ticker.js';
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
  lastYearEPS: Str,
  lastYearRptDt: Str,
});

// data: null is only an empty day when status says OK ("No record found" for far-future dates);
// otherwise it is a failure. rows: null is an empty day (weekends).
const ResponseSchema = z.object({
  data: z.object({ rows: z.array(RowSchema).nullish() }).nullable(),
  status: z.object({ rCode: z.number().nullish() }).nullish(),
});

export function nasdaqTiming(time: string | null | undefined): Timing {
  if (time === 'time-pre-market') return 'BMO';
  if (time === 'time-after-hours') return 'AMC';
  return 'UNKNOWN';
}

/** "10/16/2025" -> "2025-10-16"; anything else -> null. */
function usDate(s: string | null): string | null {
  const m = s ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim()) : null;
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null;
}

export function parseNasdaqCalendar(json: unknown, date: string): CalendarRow[] {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Nasdaq calendar ${date}: ${parsed.error.message}`);
  const rCode = parsed.data.status?.rCode;
  if (rCode != null && rCode !== 200) throw new SourceFormatError(`Nasdaq calendar ${date}: status rCode ${rCode}`);
  if (parsed.data.data === null) {
    if (rCode === 200) return [];
    throw new SourceFormatError(`Nasdaq calendar ${date}: no data and no OK status`);
  }
  return (parsed.data.data.rows ?? [])
    .filter((r) => r.symbol.trim() !== '')
    .map((r) => {
      // Until Nasdaq records the surprise, its EPS column still holds a placeholder (last year's EPS).
      const epsSurprisePct = parseNumber(r.surprise);
      return {
      symbol: r.symbol.trim(),
      name: r.name.trim(),
      reportDate: date,
      fiscalQuarter: r.fiscalQuarterEnding?.trim() || `date:${date}`,
      timing: nasdaqTiming(r.time),
      marketCap: parseNumber(r.marketCap),
      epsEstimate: parseNumber(r.epsForecast),
      noOfEsts: parseIntOrNull(r.noOfEsts),
      epsActual: epsSurprisePct == null ? null : parseNumber(r.eps),
      epsSurprisePct,
      lastYearEps: parseNumber(r.lastYearEPS),
      lastYearReportDate: usDate(r.lastYearRptDt),
    };
    });
}

/** A past quarter's reported EPS, as backfilled for a watched stock. */
export interface PastEps {
  fiscalQuarter: string;        // 'Jun/2026', as the calendar spells it
  reportDate: string;           // YYYY-MM-DD, or the quarter end when the source gives no report date
  epsActual: number;
  epsEstimate: number | null;
  epsSurprisePct: number | null;
}

const SurpriseSchema = z.object({
  data: z.object({
    earningsSurpriseTable: z.object({
      rows: z.array(z.object({
        fiscalQtrEnd: z.string(), dateReported: z.string(), eps: Str, consensusForecast: Str, percentageSurprise: Str,
      })).nullish(),
    }).nullish(),
  }).nullable(),
  status: z.object({ rCode: z.number().nullish() }).nullish(),
});

/** Nasdaq's company earnings-surprise table: past quarters only (fiscal quarter end, date reported, EPS, consensus). */
export function parseNasdaqEarningsSurprise(json: unknown): PastEps[] {
  const parsed = SurpriseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Nasdaq earnings surprise: ${parsed.error.message}`);
  const rCode = parsed.data.status?.rCode;
  if (rCode != null && rCode !== 200) throw new SourceFormatError(`Nasdaq earnings surprise: status rCode ${rCode}`);
  const rows = parsed.data.data?.earningsSurpriseTable?.rows;
  if (!rows?.length) throw new SourceFormatError('Nasdaq earnings surprise: no quarters');
  const out: PastEps[] = [];
  for (const r of rows) {
    const q = /^([A-Z][a-z]{2})\s+(\d{4})$/.exec(r.fiscalQtrEnd.trim());
    const reportDate = usDate(r.dateReported);
    const epsActual = parseNumber(r.eps);
    if (!q || !reportDate || epsActual == null) continue;
    out.push({
      fiscalQuarter: `${q[1]}/${q[2]}`, reportDate, epsActual,
      epsEstimate: parseNumber(r.consensusForecast), epsSurprisePct: parseNumber(r.percentageSurprise),
    });
  }
  return out;
}

export async function fetchNasdaqEarningsSurprise(http: Http, symbol: string): Promise<PastEps[]> {
  const s = encodeURIComponent(symbol.trim().toUpperCase().replace('-', '.'));
  return parseNasdaqEarningsSurprise(await http.json(`https://api.nasdaq.com/api/company/${s}/earnings-surprise`));
}

export async function fetchNasdaqCalendar(http: Http, date: string): Promise<CalendarRow[]> {
  return parseNasdaqCalendar(await http.json(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`), date);
}

const HistorySchema = z.object({
  data: z.object({
    tradesTable: z.object({ rows: z.array(z.object({ date: z.string(), close: z.string() })).nullish() }).nullish(),
  }).nullish(),
});

/** Daily closes keyed by ISO date. */
export function parseNasdaqHistory(json: unknown): Map<string, number> {
  const parsed = HistorySchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Nasdaq history: ${parsed.error.message}`);
  const out = new Map<string, number>();
  for (const r of parsed.data.data?.tradesTable?.rows ?? []) {
    const date = usDate(r.date);
    const close = parseNumber(r.close);
    if (date && close != null) out.set(date, close);
  }
  return out;
}

export async function fetchDailyCloses(http: Http, symbol: string, from: string, to: string): Promise<Map<string, number>> {
  const s = encodeURIComponent(symbol.trim().toUpperCase().replace('/', '.'));
  return parseNasdaqHistory(await http.json(
    `https://api.nasdaq.com/api/quote/${s}/historical?assetclass=stocks&fromdate=${from}&todate=${to}&limit=1000`));
}

const ScreenerSchema = z.object({
  data: z.object({ rows: z.array(z.object({ symbol: z.string(), sector: z.string().nullish(), industry: z.string().nullish() })) }),
});

/** Sector and industry for every US-listed stock, keyed by normalized ticker. */
export function parseNasdaqScreener(json: unknown): Map<string, { sector: string | null; industry: string | null }> {
  const parsed = ScreenerSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Nasdaq screener: ${parsed.error.message}`);
  const out = new Map<string, { sector: string | null; industry: string | null }>();
  for (const r of parsed.data.data.rows) {
    out.set(normalizeTicker(r.symbol), { sector: r.sector?.trim() || null, industry: r.industry?.trim() || null });
  }
  return out;
}

export async function fetchSectors(http: Http): Promise<Map<string, { sector: string | null; industry: string | null }>> {
  return parseNasdaqScreener(await http.json('https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true'));
}
