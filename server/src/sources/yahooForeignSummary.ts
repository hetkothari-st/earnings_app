import { DateTime } from 'luxon';
import { z } from 'zod';
import { SourceFormatError } from './http.js';

/** What Yahoo knows about one foreign-listed stock (.HK, .T). Currencies are kept as Yahoo states them (never converted). */
export interface YahooForeignSummary {
  name: string | null;
  priceCurrency: string | null;
  sector: string | null;
  industry: string | null;
  /** Only when the quote is in the market's own currency (`capCurrency`). */
  marketCap: number | null;
  /** Local date (in `zone`) of the quote the cap belongs to. */
  marketCapAsOf: string | null;
  /** Next report date: a single date only (a range gives null), local date in `zone`. */
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

/**
 * Parses a quoteSummary answer (modules price, assetProfile, calendarEvents, earningsTrend,
 * earningsHistory, earnings) for a stock listed in `zone`, whose own currency is `capCurrency`.
 */
export function parseYahooSummaryFor(json: unknown, o: { zone: string; capCurrency: string }): YahooForeignSummary {
  const parsed = Schema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Yahoo quoteSummary (${o.capCurrency}): ${parsed.error.message}`);
  const r = parsed.data.quoteSummary.result[0]!;
  const own = r.price?.currency === o.capCurrency;
  const cap = r.price?.marketCap?.raw ?? null;
  const time = r.price?.regularMarketTime;
  const dates = r.calendarEvents?.earnings?.earningsDate ?? [];
  return {
    name: r.price?.longName || r.price?.shortName || null,
    priceCurrency: r.price?.currency ?? null,
    sector: r.assetProfile?.sector || null,
    industry: r.assetProfile?.industry || null,
    marketCap: own ? cap : null,
    marketCapAsOf: own && cap != null && time ? DateTime.fromSeconds(time, { zone: o.zone }).toISODate() : null,
    nextDate: dates.length === 1 ? DateTime.fromSeconds(dates[0]!.raw, { zone: o.zone }).toISODate() : null,
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
