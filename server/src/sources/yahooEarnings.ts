import { z } from 'zod';
import { BROWSER_UA, type Http, HttpError, makeHttp, SourceFormatError } from './http.js';

/** What Yahoo Finance knows about a company's reported and upcoming quarters. */
export interface YahooSummary {
  priceCurrency: string | null;     // currency of the quote and of per-share figures (EPS)
  financialCurrency: string | null; // reporting currency of revenue
  epsHistory: { periodEnd: string; actual: number; currency: string | null }[];
  revenueQuarters: { label: string; revenue: number }[]; // label like '3Q2026' (calendar quarter)
  /** Consensus revenue per fiscal quarter, keyed by quarter-end date. */
  revenueEstimates: { periodEnd: string; estimate: number; currency: string | null }[];
}

export interface YahooFill {
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueCurrency: string | null;
}

const Raw = z.object({ raw: z.number().nullish() }).nullish();
const ResultSchema = z.object({
  price: z.object({ currency: z.string().nullish() }).nullish(),
  earnings: z.object({
    financialCurrency: z.string().nullish(),
    financialsChart: z.object({ quarterly: z.array(z.object({ date: z.string(), revenue: Raw })).nullish() }).nullish(),
  }).nullish(),
  earningsHistory: z.object({
    history: z.array(z.object({
      quarter: z.object({ fmt: z.string().nullish() }).nullish(), epsActual: Raw, currency: z.string().nullish(),
    })).nullish(),
  }).nullish(),
  earningsTrend: z.object({
    trend: z.array(z.object({
      endDate: z.string().nullish(),
      revenueEstimate: z.object({ avg: Raw, revenueCurrency: z.string().nullish() }).nullish(),
    })).nullish(),
  }).nullish(),
});
const ResponseSchema = z.object({ quoteSummary: z.object({ result: z.array(ResultSchema).min(1) }) });

export function parseQuoteSummary(json: unknown): YahooSummary {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Yahoo quoteSummary: ${parsed.error.message}`);
  const r = parsed.data.quoteSummary.result[0]!;
  return {
    priceCurrency: r.price?.currency ?? null,
    financialCurrency: r.earnings?.financialCurrency ?? null,
    epsHistory: (r.earningsHistory?.history ?? [])
      .filter((h) => h.quarter?.fmt && h.epsActual?.raw != null)
      .map((h) => ({ periodEnd: h.quarter!.fmt!, actual: h.epsActual!.raw!, currency: h.currency ?? null })),
    revenueQuarters: (r.earnings?.financialsChart?.quarterly ?? [])
      .filter((q) => q.revenue?.raw != null)
      .map((q) => ({ label: q.date, revenue: q.revenue!.raw! })),
    revenueEstimates: (r.earningsTrend?.trend ?? [])
      .filter((t) => t.endDate && t.revenueEstimate?.avg?.raw != null)
      .map((t) => ({ periodEnd: t.endDate!, estimate: t.revenueEstimate!.avg!.raw!, currency: t.revenueEstimate!.revenueCurrency ?? null })),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep/2026" -> { year: 2026, month: 9 }; anything else (e.g. "date:...") -> null. */
function fiscalQuarterEnd(fq: string): { year: number; month: number } | null {
  const m = /^([A-Z][a-z]{2})\/(\d{4})$/.exec(fq);
  const month = m ? MONTHS.indexOf(m[1]!) + 1 : 0;
  return m && month > 0 ? { year: Number(m[2]), month } : null;
}

/**
 * Values Yahoo can supply for one report. Matching is strict so a wrong quarter or currency is never used:
 * EPS only from an entry for the same quarter-end month that is itself in USD (the US listing's estimate
 * basis); revenue actual only for calendar-aligned quarters, in the reporting currency; revenue estimate
 * only from the forecast for the same quarter-end, and only in that same currency.
 */
export function yahooFill(s: YahooSummary, report: { reportDate: string; fiscalQuarter: string }): YahooFill {
  const end = fiscalQuarterEnd(report.fiscalQuarter);
  const ym = end ? `${end.year}-${String(end.month).padStart(2, '0')}` : null;
  const epsEntry = ym ? s.epsHistory.find((h) => h.periodEnd.slice(0, 7) === ym) : undefined;
  // Only USD reporters: for foreign issuers Yahoo converts EPS at its own FX rate (live ERIC: 0.1956 vs ~0.177).
  const eps = epsEntry && epsEntry.currency === 'USD' && s.financialCurrency === 'USD' ? epsEntry.actual : null;
  const calendarAligned = end != null && end.month % 3 === 0;
  const label = calendarAligned ? `${end!.month / 3}Q${end!.year}` : null;
  const revenueActual = label ? s.revenueQuarters.find((q) => q.label === label)?.revenue ?? null : null;
  const est = ym ? s.revenueEstimates.find((e) => e.periodEnd.slice(0, 7) === ym) : undefined;
  const currency = revenueActual != null ? s.financialCurrency : est?.currency ?? null;
  const revenueEstimate = est && est.currency != null && est.currency === currency ? est.estimate : null;
  return {
    epsActual: eps,
    revenueEstimate,
    revenueActual,
    revenueCurrency: revenueActual != null || revenueEstimate != null ? currency : null,
  };
}

/**
 * Yahoo's quoteSummary needs a session cookie and a "crumb". One session is reused and renewed
 * when Yahoo rejects it. Unknown symbols return null.
 */
export function createYahooSummaryFetcher(): (symbol: string) => Promise<YahooSummary | null> {
  let session: { http: Http; crumb: string } | null = null;
  const open = async () => {
    const res = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual' });
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const headers = { 'User-Agent': BROWSER_UA, Cookie: cookie };
    const crumb = await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers })).text();
    if (!crumb || crumb.includes('<')) throw new SourceFormatError('Yahoo: could not obtain a session crumb');
    return { http: makeHttp({ minIntervalMs: 1000, headers }), crumb };
  };
  return async (symbol) => {
    const s = symbol.trim().toUpperCase().replace('/', '-');
    for (let attempt = 0; attempt < 2; attempt++) {
      session ??= await open();
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s)}`
        + `?modules=price,earnings,earningsHistory,earningsTrend&crumb=${encodeURIComponent(session.crumb)}`;
      try {
        return parseQuoteSummary(await session.http.json(url));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403) && attempt === 0) { session = null; continue; }
        throw err;
      }
    }
    return null;
  };
}
