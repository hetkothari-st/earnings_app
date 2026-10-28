import { DateTime } from 'luxon';
import {
  esefSeen, europeStocksByLei, getEuropeReport, lastEsefDateAdded, markEsefSeen, mergeEuropeActuals, setEuropeProfile,
  findEuropeReportId, type EsefOutcome,
} from '../db/europeRepo.js';
import { EXCHANGES, exchangesOf, type EuropeMarket } from '../exchanges.js';
import { parseEsefFacts } from '../sources/esef.js';
import { trackIn, type EuropeJobContext } from './context.js';

/** EEA countries: ESEF applies there. Switzerland (SIX) files no ESEF. */
const EEA = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU',
  'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);

/** filings.xbrl.org country filters of a market: GB for UK; for EU, the EEA countries of its exchanges. */
export function esefCountries(market: EuropeMarket): string[] {
  if (market === 'UK') return ['GB'];
  return [...new Set(exchangesOf(market).map((id) => EXCHANGES[id].country).filter((c) => EEA.has(c)))].sort();
}

/**
 * The cursor margin. A filing whose facts fetch failed is not marked and is retried while its date_added is inside
 * the window; seen filings in the window cost no facts request. A filing still failing after this long is dropped.
 */
const SINCE_MARGIN_DAYS = 2;
/** First run: how far back the index is read. */
const FIRST_RUN_DAYS = 30;

/** `since` for `refreshEsefResults`: the latest handled date_added of the market less the margin (naive UTC). */
export function esefSinceFor(ctx: EuropeJobContext): string {
  const last = lastEsefDateAdded(ctx.db, ctx.market);
  const base = last
    ? DateTime.fromISO(last.replace(' ', 'T'), { zone: 'utc' }).minus({ days: SINCE_MARGIN_DAYS })
    : DateTime.fromISO(ctx.now(), { zone: 'utc' }).minus({ days: FIRST_RUN_DAYS });
  return base.toFormat('yyyy-MM-dd HH:mm:ss');
}

/**
 * ESEF annual figures (Ruling 6, precedence SEC > ESEF > Yahoo). Per unseen filing whose LEI is an active stock of
 * the market: the 12-month revenue and EPS ending the filing's period end are merged into each share line's report
 * for that period end (a fiscal-Q4 row only: a 12-month figure is never put in an H1 or quarter row), as
 * `esef` / `ytd` / 12 months with the report URL. Outcomes: `merged`; `superseded` (figures present but SEC holds every
 * field; the report link is still added when the row has none); `no-row` (nothing created); `blank` (no 12-month fact). A facts fetch
 * error is not marked, so it is retried. The filing's period end month becomes the fiscal year end (source esef)
 * when the filing carries a 12-month fact (a 9-month interim ESEF filing never does) and no later period is held.
 * Returns the ids changed.
 */
export async function refreshEsefResults(ctx: EuropeJobContext, since: string): Promise<number[]> {
  const filings = await trackIn(ctx, 'esef', () => ctx.esef.recent(esefCountries(ctx.market), since));
  if (!filings) return [];
  const changed = new Set<number>();
  for (const f of filings) {
    if (esefSeen(ctx.db, f.fxoId)) continue;
    const stocks = europeStocksByLei(ctx.db, f.lei).filter((s) => s.active && s.market === ctx.market);
    if (stocks.length === 0) continue;
    let json: unknown;
    try {
      json = await ctx.esef.facts(f.jsonUrl);
    } catch (err) {
      console.warn(`[esef] ${f.fxoId}: ${(err as Error).message}`);
      continue;
    }
    const now = ctx.now();
    const fig = parseEsefFacts(json, f.periodEnd);
    const mark = (outcome: EsefOutcome) => markEsefSeen(ctx.db, f.fxoId, stocks[0]!.symbol, f.periodEnd, outcome, now, f.dateAdded);
    const revenue = fig.revenue != null && fig.revenueCurrency
      ? { value: fig.revenue, currency: fig.revenueCurrency, span: 'ytd' as const, ytdMonths: 12 as const } : null;
    const eps = (fig.epsBasic != null || fig.epsDiluted != null) && fig.epsCurrency
      ? { basic: fig.epsBasic, diluted: fig.epsDiluted, currency: fig.epsCurrency, span: 'ytd' as const, ytdMonths: 12 as const } : null;
    if (!revenue && !eps) { mark('blank'); continue; }

    const month = Number(f.periodEnd.slice(5, 7));
    let anyRow = false;
    let merged = false;
    for (const s of stocks) {
      // A later annual period already held for this line keeps its month.
      const later = ctx.db.prepare(`SELECT 1 FROM europe_esef_seen WHERE symbol = ? AND period_end > ? AND outcome != 'blank'`)
        .get(s.symbol, f.periodEnd);
      if (!later) {
        setEuropeProfile(ctx.db, s.symbol, {
          name: null, sector: null, industry: null, marketCap: null, marketCapCurrency: null, asOf: null, fyEndMonth: { month, source: 'esef' },
        }, now);
      }
      const id = findEuropeReportId(ctx.db, s.symbol, f.periodEnd);
      if (id == null || getEuropeReport(ctx.db, id)?.fiscalQuarter !== 4) continue;
      anyRow = true;
      if (mergeEuropeActuals(ctx.db, id, { revenue, eps, source: 'esef', esefUrl: f.reportUrl }, now)) changed.add(id);
      // Only the link may have been added to a row SEC already holds: that is not a merge of figures.
      const r = getEuropeReport(ctx.db, id)!;
      if (r.revenueSource === 'esef' || r.epsSource === 'esef') merged = true;
    }
    mark(!anyRow ? 'no-row' : merged ? 'merged' : 'superseded');
  }
  return [...changed];
}
