import { DateTime } from 'luxon';
import { recordSourceError, recordSourceSuccess } from '../../db/repo.js';
import { europeStocks, saveBankHolidays, saveEuropeUniverseRun, setEuropeProfile, syncEuropeUniverse } from '../db/europeRepo.js';
import { parseGovUkBankHolidays } from '../domain/bankHolidays.js';
import { calendarFor, holidaysUnknown } from '../domain/calendars.js';
import { EXCHANGES, exchangesOf } from '../exchanges.js';
import { trackIn, type EuropeJobContext } from './context.js';

const QUOTE_BATCH = 50;

/** Per-market source names: one market's success never hides the other's failure. */
export const europeSource = (ctx: Pick<EuropeJobContext, 'market'>, what: string): string => `${what}-${ctx.market.toLowerCase()}`;
/** `yahoo-uk-…` / `yahoo-eu-…`. */
export const yahooSource = (ctx: Pick<EuropeJobContext, 'market'>, what: string): string => `yahoo-${ctx.market.toLowerCase()}-${what}`;

/** The England and Wales event titles by date (the parser validates dates only; a missing title stays blank). */
function govUkTitles(json: unknown): Map<string, string> {
  const events = (json as { 'england-and-wales'?: { events?: unknown } } | null)?.['england-and-wales']?.events;
  const out = new Map<string, string>();
  if (!Array.isArray(events)) return out;
  for (const e of events as { date?: unknown; title?: unknown }[]) {
    if (typeof e?.date === 'string' && typeof e.title === 'string' && e.title.trim() && !out.has(e.date)) out.set(e.date, e.title.trim());
  }
  return out;
}

/** A `europe-holidays` status warning while any exchange of the market has no holiday list 60 days ahead (Ruling 16). */
export function checkEuropeHolidayCoverage(ctx: EuropeJobContext): void {
  const horizon = calendarFor(ctx.market === 'UK' ? 'LSE' : 'PAR').addDays(ctx.today(), 60);
  const unknown = exchangesOf(ctx.market).filter((ex) => holidaysUnknown(ex, horizon));
  if (unknown.length > 0) {
    recordSourceError(ctx.db, 'europe-holidays',
      `${ctx.market}: holiday lists for ${horizon.slice(0, 4)} not added yet (${unknown.join(', ')}): weekends only`, ctx.now());
  } else {
    recordSourceSuccess(ctx.db, 'europe-holidays', ctx.now());
  }
}

/**
 * The weekly universe and profile refresh of one market:
 * 1. `buildUniverse()`, then `syncEuropeUniverse`, only when the build is complete. An incomplete build (a FIRDS part,
 *    the SIX list, an OpenFIGI request or an ISIN search failed) would shrink the universe, so it is not synced: the
 *    stored universe is kept, nothing is deactivated, and a `europe-universe-<market>` error is recorded.
 * 2. Batch quotes (50 per request) for the active symbols → Yahoo name and market cap, the cap with the currency it is
 *    in (pounds for a pence `.L` line, the quote currency elsewhere: `europeCapCurrency`); never converted. A failed
 *    batch loses only its 50 symbols.
 * 3. UK only: the gov.uk bank holidays (England and Wales) replace the stored set; a failure keeps the stored dates.
 * 4. The `europe-holidays` warning (`checkEuropeHolidayCoverage`).
 */
export async function refreshEuropeStocks(ctx: EuropeJobContext): Promise<void> {
  const universeSource = europeSource(ctx, 'europe-universe');
  let built: Awaited<ReturnType<EuropeJobContext['buildUniverse']>> | null = null;
  try {
    built = await ctx.buildUniverse();
  } catch (err) {
    const message = `${ctx.market} universe build failed, stored universe kept: ${(err as Error).message}`;
    console.error(`[${universeSource}] ${message}`);
    recordSourceError(ctx.db, universeSource, message, ctx.now());
  }
  if (built && !built.complete) {
    const message = `${ctx.market} universe build incomplete (${built.entries.length} entries, ${built.leftOut} left out): not synced, stored universe kept`;
    console.warn(`[${universeSource}] ${message}`);
    recordSourceError(ctx.db, universeSource, message, ctx.now());
  } else if (built) {
    try {
      const r = syncEuropeUniverse(ctx.db, ctx.market, built.entries, ctx.now());
      console.log(`[${universeSource}] ${r.upserted} upserted, ${r.deactivated} deactivated, ${built.leftOut} left out`);
      recordSourceSuccess(ctx.db, universeSource, ctx.now());
      // The admin page reads the last complete build from here, also after a restart.
      saveEuropeUniverseRun(ctx.db, ctx.market, built.leftOut, ctx.now());
    } catch (err) {
      recordSourceError(ctx.db, universeSource, `${ctx.market} universe sync refused: ${(err as Error).message}`, ctx.now());
    }
  }

  const active = europeStocks(ctx.db, ctx.market).filter((s) => s.active);
  for (let i = 0; i < active.length; i += QUOTE_BATCH) {
    const batch = active.slice(i, i + QUOTE_BATCH);
    const quotes = await trackIn(ctx, yahooSource(ctx, 'quotes'), () => ctx.yahooQuotes(batch.map((s) => s.symbol)));
    if (!quotes) continue;
    for (const s of batch) {
      const q = quotes.get(s.symbol);
      if (!q) continue;
      const capOk = q.marketCap != null && q.marketCapCurrency != null;
      setEuropeProfile(ctx.db, s.symbol, {
        name: q.name, sector: null, industry: null,
        marketCap: capOk ? q.marketCap : null, marketCapCurrency: capOk ? q.marketCapCurrency : null,
        asOf: capOk && q.time != null ? DateTime.fromMillis(q.time, { zone: EXCHANGES[s.exchange].zone }).toISODate() : null,
      }, ctx.now());
    }
  }

  if (ctx.market === 'UK') {
    await trackIn(ctx, 'govuk-holidays', async () => {
      const json = await ctx.bankHolidaysJson();
      const titles = govUkTitles(json);
      saveBankHolidays(ctx.db, parseGovUkBankHolidays(json).map((date) => ({ date, title: titles.get(date) ?? '' })), ctx.now());
    });
  }
  checkEuropeHolidayCoverage(ctx);
}
