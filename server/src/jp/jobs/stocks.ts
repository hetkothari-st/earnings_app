import { DateTime } from 'luxon';
import { recordSourceError, recordSourceSuccess } from '../../db/repo.js';
import { jpStocks, setJpProfile, syncJpUniverse } from '../db/jpRepo.js';
import { addDaysJST, holidaysUnknownJp, JST } from '../domain/jpCalendar.js';
import { buildJpUniverse, parseEdinetCodeList } from '../universe.js';
import { trackIn, type JpJobContext } from './context.js';

const QUOTE_BATCH = 50;
/** A code list with fewer listed rows than this is refused (about 3,800 are listed). */
export const JP_CODELIST_MIN_LISTED = 1000;

/** A `jp-holidays` status warning while the holiday list does not reach 60 days ahead (Ruling 19). */
export function checkJpHolidayCoverage(ctx: JpJobContext): void {
  if (holidaysUnknownJp(addDaysJST(ctx.todayJST(), 60))) {
    recordSourceError(ctx.db, 'jp-holidays', 'Japan holiday list for 2028 not added yet: weekends and year-end closure only', ctx.now());
  } else {
    recordSourceSuccess(ctx.db, 'jp-holidays', ctx.now());
  }
}

/**
 * The universe from the EDINET code list (a failed fetch, an unreadable list, or one with fewer than `minListed`
 * (1,000) listed rows or under half of the currently active codes keeps the stored universe: nothing is deactivated), then name and market cap from Yahoo batch quotes, 50 symbols per request. The served
 * name is the English code-list name, else the Yahoo name, else the Japanese name: a Yahoo name is stored only
 * for companies the code list gives no English name. The cap is JPY only (the quote parser drops others).
 * A failed batch loses only its 50 symbols; a symbol Yahoo does not quote keeps blank price and cap.
 */
export async function refreshJpStocks(ctx: JpJobContext, opts: { minListed?: number } = {}): Promise<void> {
  const minListed = opts.minListed ?? JP_CODELIST_MIN_LISTED;
  const universe = await trackIn(ctx, 'edinet-codelist', async () => {
    const listed = parseEdinetCodeList(await ctx.edinetCodeList());
    // A list that parses but is cut short would deactivate most of the universe: refused, the stored one is kept.
    const activeNow = (ctx.db.prepare('SELECT COUNT(*) AS n FROM jp_stocks WHERE active = 1').get() as { n: number }).n;
    if (listed.length < minListed || listed.length < activeNow * 0.5) {
      throw new Error(`EDINET code list refused: ${listed.length} listed rows (need at least ${minListed} and half of the ${activeNow} active codes)`);
    }
    return buildJpUniverse(listed);
  });
  if (universe) syncJpUniverse(ctx.db, universe, ctx.now());

  const active = jpStocks(ctx.db).filter((s) => s.active);
  // No English name in the code list: the universe name is the Japanese one.
  const noEnglish = new Set((ctx.db.prepare('SELECT code FROM jp_stocks WHERE name_ja IS NOT NULL AND name = name_ja').all() as { code: string }[])
    .map((r) => r.code));
  for (let i = 0; i < active.length; i += QUOTE_BATCH) {
    const batch = active.slice(i, i + QUOTE_BATCH);
    const quotes = await trackIn(ctx, 'yahoo-jp-quotes', () => ctx.yahooQuotes(batch.map((s) => s.yahooSymbol)));
    if (!quotes) continue;
    for (const s of batch) {
      const q = quotes.get(s.yahooSymbol);
      if (!q) continue;
      setJpProfile(ctx.db, s.code, {
        name: noEnglish.has(s.code) ? q.name : null, sector: null, industry: null,
        marketCap: q.marketCap, asOf: q.marketCap != null && q.time != null ? DateTime.fromMillis(q.time, { zone: JST }).toISODate() : null,
      }, ctx.now());
    }
  }
  checkJpHolidayCoverage(ctx);
}
