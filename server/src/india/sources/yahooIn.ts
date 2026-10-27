import { DateTime } from 'luxon';
import { z } from 'zod';
import { type Http, SourceFormatError } from '../../sources/http.js';
import { createQuoteSummaryFetcher } from '../../sources/yahooEarnings.js';
import { yahooLimiter } from '../../sources/yahooLimiter.js';
import { IST } from '../domain/nseCalendar.js';

/** What Yahoo knows about one NSE stock (`<SYMBOL>.NS`). A backup source: never the result date's confirmation. */
export interface YahooInSummary {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;   // rupees
  marketCapAsOf: string | null; // YYYY-MM-DD IST
  /** defaultKeyStatistics.sharesOutstanding; null when Yahoo has no such module. */
  sharesOutstanding: number | null;
  /** Next result date per Yahoo (estimated). */
  nextDate: string | null;
  /** Quarterly consensus only (periods "0q", "+1q"): annual figures never match a quarter. */
  quarters: { periodEnd: string; eps: number | null; epsAnalysts: number | null; revenue: number | null; revenueAnalysts: number | null }[];
}

const Raw = z.object({ raw: z.number().nullish() }).nullish();
const Schema = z.object({
  quoteSummary: z.object({
    result: z.array(z.object({
      price: z.object({ currency: z.string().nullish(), marketCap: Raw, regularMarketTime: z.number().nullish() }).nullish(),
      defaultKeyStatistics: z.object({ sharesOutstanding: Raw }).nullish(),
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
    })).min(1),
  }),
});

export function parseYahooInSummary(json: unknown): YahooInSummary {
  const parsed = Schema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Yahoo quoteSummary (.NS): ${parsed.error.message}`);
  const r = parsed.data.quoteSummary.result[0]!;
  const inr = r.price?.currency === 'INR';
  const time = r.price?.regularMarketTime;
  const dates = r.calendarEvents?.earnings?.earningsDate ?? [];
  return {
    sector: r.assetProfile?.sector || null,
    industry: r.assetProfile?.industry || null,
    marketCap: inr ? r.price?.marketCap?.raw ?? null : null,
    marketCapAsOf: inr && r.price?.marketCap?.raw != null && time ? DateTime.fromSeconds(time, { zone: IST }).toISODate() : null,
    sharesOutstanding: r.defaultKeyStatistics?.sharesOutstanding?.raw ?? null,
    // Yahoo gives a range when unsure; only a single date is usable.
    nextDate: dates.length === 1 ? DateTime.fromSeconds(dates[0]!.raw, { zone: IST }).toISODate() : null,
    quarters: (r.earningsTrend?.trend ?? [])
      .filter((t) => t.endDate && /q$/.test(t.period ?? ''))
      .map((t) => {
        const epsOk = t.earningsEstimate?.earningsCurrency === 'INR';
        const revOk = t.revenueEstimate?.revenueCurrency === 'INR';
        return {
          periodEnd: t.endDate!,
          eps: epsOk ? t.earningsEstimate?.avg?.raw ?? null : null,
          epsAnalysts: epsOk ? t.earningsEstimate?.numberOfAnalysts?.raw ?? null : null,
          revenue: revOk ? t.revenueEstimate?.avg?.raw ?? null : null,
          revenueAnalysts: revOk ? t.revenueEstimate?.numberOfAnalysts?.raw ?? null : null,
        };
      }),
  };
}

/** quoteSummary for an NSE stock; requests wait for the cross-market Yahoo budget (`yahooLimiter`). */
export function createYahooInFetcher(): (nseSymbol: string) => Promise<YahooInSummary | null> {
  const get = createQuoteSummaryFetcher('price,assetProfile,earningsTrend,calendarEvents,defaultKeyStatistics', parseYahooInSummary,
    { limiter: yahooLimiter });
  return (nseSymbol) => get(`${nseSymbol}.NS`);
}

/** Index quote from Yahoo's chart API (fallback for the markets strip). */
export async function fetchYahooIndex(http: Http, yahooSymbol: string): Promise<{ price: number; prevClose: number | null } | null> {
  const raw = await http.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`) as {
    chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }[] };
  };
  const meta = raw.chart?.result?.[0]?.meta;
  if (typeof meta?.regularMarketPrice !== 'number') return null;
  return { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null };
}
