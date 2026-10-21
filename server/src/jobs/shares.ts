import { z } from 'zod';
import { type Db, setUsShares } from '../db/repo.js';
import { addDays } from '../domain/marketCalendar.js';
import { normalizeTicker } from '../domain/ticker.js';
import { setInShares, matchableStocks } from '../india/db/inRepo.js';
import { type InJobContext, trackIn } from '../india/jobs/context.js';
import { type Http, HttpError } from '../sources/http.js';
import { allWatched } from '../watchlist/store.js';
import { type JobContext, track } from './context.js';

const Concept = z.object({
  units: z.object({
    shares: z.array(z.object({ end: z.string(), val: z.number(), filed: z.string().nullish() })).nullish(),
  }),
});

/**
 * SEC companyconcept dei:EntityCommonStockSharesOutstanding: the entry with the greatest `end`
 * (cover-page date) wins; on a tie the latest `filed`. Null when the company reports none.
 */
export function parseSharesOutstanding(json: unknown): { shares: number; asOf: string } | null {
  const parsed = Concept.safeParse(json);
  if (!parsed.success) return null;
  let best: { end: string; val: number; filed?: string | null } | null = null;
  for (const e of parsed.data.units.shares ?? []) {
    if (!(e.val > 0)) continue;
    if (!best || e.end > best.end || (e.end === best.end && (e.filed ?? '') > (best.filed ?? ''))) best = e;
  }
  return best ? { shares: best.val, asOf: best.end } : null;
}

/** Companies that matter: reports dated today..+30 days, plus everything a user watches. */
function usSymbolKeys(db: Db, today: string): string[] {
  const keys = new Set((db.prepare('SELECT DISTINCT symbol_key FROM reports WHERE report_date BETWEEN ? AND ?')
    .all(today, addDays(today, 30)) as { symbol_key: string }[]).map((r) => r.symbol_key));
  for (const s of allWatched(db, 'US')) keys.add(normalizeTicker(s));
  return [...keys].sort();
}

/** Daily: share counts from SEC company facts. `http` is the shared SEC client (rate-limited). */
export async function refreshUsShares(ctx: JobContext, http: Http): Promise<void> {
  const keys = usSymbolKeys(ctx.db, ctx.today());
  if (keys.length === 0) return;
  const tickers = await track(ctx, 'sec', () => ctx.sources.secTickers());
  if (!tickers) return;
  for (const key of keys) {
    const cik = tickers.get(key)?.cik;
    if (cik == null) continue;
    const found = await track(ctx, 'sec-shares', async () => {
      try {
        const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/dei/EntityCommonStockSharesOutstanding.json`;
        return parseSharesOutstanding(await http.json(url));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null; // no such fact for this company
        throw err;
      }
    });
    if (found) setUsShares(ctx.db, key, found.shares, found.asOf);
  }
}

/** Daily: share counts from Yahoo defaultKeyStatistics for active F&O plus watched stocks. */
export async function refreshInShares(ctx: InJobContext): Promise<void> {
  const asOf = ctx.todayIST();
  for (const stock of matchableStocks(ctx.db)) {
    const y = await trackIn(ctx, 'yahoo-in', () => ctx.yahoo(stock.symbol));
    if (y?.sharesOutstanding != null && y.sharesOutstanding > 0) setInShares(ctx.db, stock.symbol, y.sharesOutstanding, asOf);
  }
}
