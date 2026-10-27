import { DateTime } from 'luxon';
import { z } from 'zod';
import { fetchYahooPastDatesFor, type YahooPastDate } from '../../india/sources/yahooPastDates.js';
import { SourceFormatError } from '../../sources/http.js';
import { createQuoteSummaryFetcher } from '../../sources/yahooEarnings.js';
import { HKT, hkTimingFromHkt } from '../domain/hkCalendar.js';

/** What Yahoo knows about one `.HK` stock. Currencies are kept as Yahoo states them (never converted). */
export interface YahooHkSummary {
  name: string | null;
  priceCurrency: string | null;
  sector: string | null;
  industry: string | null;
  /** Only when the quote is in HKD. */
  marketCap: number | null;
  /** HKT date of the quote the cap belongs to. */
  marketCapAsOf: string | null;
  /** Next report date: a single date only (a range gives null), HKT. */
  nextDate: string | null;
  /** Periods 0q, +1q, 0y, +1y. */
  trend: {
    period: string; periodEnd: string;
    eps: number | null; epsAnalysts: number | null; epsCurrency: string | null;
    revenue: number | null; revenueAnalysts: number | null; revenueCurrency: string | null;
  }[];
  epsHistory: { periodEnd: string; actual: number; currency: string | null }[];
  /** Calendar quarters from earnings.financialsChart, e.g. "2Q2026". */
  revenueQuarters: { label: string; revenue: number }[];
  financialCurrency: string | null;
}

const Raw = z.object({ raw: z.number().nullish() }).nullish();
const TREND_PERIODS = new Set(['0q', '+1q', '0y', '+1y']);
const Schema = z.object({
  quoteSummary: z.object({
    result: z.array(z.object({
      price: z.object({
        currency: z.string().nullish(), marketCap: Raw, regularMarketTime: z.number().nullish(),
        longName: z.string().nullish(), shortName: z.string().nullish(),
      }).nullish(),
      assetProfile: z.object({ sector: z.string().nullish(), industry: z.string().nullish() }).nullish(),
      calendarEvents: z.object({
        earnings: z.object({ earningsDate: z.array(z.object({ raw: z.number() })).nullish() }).nullish(),
      }).nullish(),
      earningsTrend: z.object({
        trend: z.array(z.object({
          period: z.string().nullish(),
          endDate: z.string().nullish(),
          earningsEstimate: z.object({ avg: Raw, numberOfAnalysts: Raw, earningsCurrency: z.string().nullish() }).nullish(),
          revenueEstimate: z.object({ avg: Raw, numberOfAnalysts: Raw, revenueCurrency: z.string().nullish() }).nullish(),
        })).nullish(),
      }).nullish(),
      earningsHistory: z.object({
        history: z.array(z.object({
          epsActual: Raw, currency: z.string().nullish(),
          quarter: z.object({ fmt: z.string().nullish() }).nullish(),
        })).nullish(),
      }).nullish(),
      earnings: z.object({
        financialCurrency: z.string().nullish(),
        financialsChart: z.object({
          quarterly: z.array(z.object({ date: z.union([z.string(), z.number()]).nullish(), revenue: Raw })).nullish(),
        }).nullish(),
      }).nullish(),
    })).min(1),
  }),
});

export function parseYahooHkSummary(json: unknown): YahooHkSummary {
  const parsed = Schema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Yahoo quoteSummary (.HK): ${parsed.error.message}`);
  const r = parsed.data.quoteSummary.result[0]!;
  const hkd = r.price?.currency === 'HKD';
  const cap = r.price?.marketCap?.raw ?? null;
  const time = r.price?.regularMarketTime;
  const dates = r.calendarEvents?.earnings?.earningsDate ?? [];
  return {
    name: r.price?.longName || r.price?.shortName || null,
    priceCurrency: r.price?.currency ?? null,
    sector: r.assetProfile?.sector || null,
    industry: r.assetProfile?.industry || null,
    marketCap: hkd ? cap : null,
    marketCapAsOf: hkd && cap != null && time ? DateTime.fromSeconds(time, { zone: HKT }).toISODate() : null,
    nextDate: dates.length === 1 ? DateTime.fromSeconds(dates[0]!.raw, { zone: HKT }).toISODate() : null,
    trend: (r.earningsTrend?.trend ?? [])
      .filter((t) => t.endDate && TREND_PERIODS.has(t.period ?? ''))
      .map((t) => ({
        period: t.period!,
        periodEnd: t.endDate!,
        eps: t.earningsEstimate?.avg?.raw ?? null,
        epsAnalysts: t.earningsEstimate?.numberOfAnalysts?.raw ?? null,
        epsCurrency: t.earningsEstimate?.earningsCurrency ?? null,
        revenue: t.revenueEstimate?.avg?.raw ?? null,
        revenueAnalysts: t.revenueEstimate?.numberOfAnalysts?.raw ?? null,
        revenueCurrency: t.revenueEstimate?.revenueCurrency ?? null,
      })),
    epsHistory: (r.earningsHistory?.history ?? []).flatMap((h) =>
      h.epsActual?.raw != null && h.quarter?.fmt ? [{ periodEnd: h.quarter.fmt, actual: h.epsActual.raw, currency: h.currency ?? null }] : []),
    revenueQuarters: (r.earnings?.financialsChart?.quarterly ?? []).flatMap((q) =>
      q.revenue?.raw != null && q.date != null ? [{ label: String(q.date), revenue: q.revenue.raw }] : []),
    financialCurrency: r.earnings?.financialCurrency ?? null,
  };
}

/** One summary per code per `ttlMs` (default 25 min), shared by the calendar and estimates jobs. Failures are not cached. */
export function createYahooHkFetcher(ttlMs = 25 * 60_000): (yahooSymbol: string) => Promise<YahooHkSummary | null> {
  const get = createQuoteSummaryFetcher('price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings', parseYahooHkSummary);
  const cache = new Map<string, { at: number; value: YahooHkSummary | null }>();
  return async (yahooSymbol) => {
    const hit = cache.get(yahooSymbol);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await get(yahooSymbol);
    cache.set(yahooSymbol, { at: Date.now(), value });
    return value;
  };
}

/** Past result dates (newest first) of a `.HK` code, HKT date and timing. */
export function yahooHkPastDates(yahooSymbol: string): Promise<YahooPastDate[]> {
  return fetchYahooPastDatesFor(yahooSymbol, HKT, hkTimingFromHkt);
}
