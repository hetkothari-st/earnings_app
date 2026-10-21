import { DateTime } from 'luxon';
import { type Db, isBackfilled, markBackfilled } from '../db/repo.js';
import { normalizeTicker } from '../domain/ticker.js';
import type { PastEps } from '../sources/nasdaq.js';
import { createFailover } from '../sources/failover.js';
import { type JobContext, track } from './context.js';

type PastSource = 'nasdaq' | 'yahoo';

/**
 * Stores past quarters for a watched symbol, keyed like the calendar (symbol_key + fiscal quarter, e.g. 'Sep/2026').
 * An existing report only gets its empty fields filled; a stored value is never overwritten. Returns rows touched.
 */
export function storePastEps(db: Db, symbol: string, name: string, rows: PastEps[], source: PastSource, now: string): number {
  const key = normalizeTicker(symbol);
  let touched = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const existing = (db.prepare('SELECT id, eps_actual FROM reports WHERE symbol_key = ? AND fiscal_quarter = ?').get(key, r.fiscalQuarter)
        // The calendar sometimes keeps a report without its fiscal quarter ('date:...'); same day is the same report.
        ?? db.prepare(`SELECT id, eps_actual FROM reports WHERE symbol_key = ? AND report_date = ? AND fiscal_quarter LIKE 'date:%'`).get(key, r.reportDate)
      ) as { id: number; eps_actual: number | null } | undefined;
      if (!existing) {
        db.prepare(`INSERT INTO reports (symbol, symbol_key, name, fiscal_quarter, report_date, timing, eps_estimate, eps_actual, eps_surprise_pct,
            eps_actual_source, calendar_fetched_at) VALUES (?, ?, ?, ?, ?, 'UNKNOWN', ?, ?, ?, ?, ?)`)
          .run(symbol, key, name, r.fiscalQuarter, r.reportDate, r.epsEstimate, r.epsActual, r.epsSurprisePct, source, now);
        touched++;
      } else if (existing.eps_actual == null) {
        db.prepare(`UPDATE reports SET eps_actual = ?, eps_actual_source = ?, eps_estimate = COALESCE(eps_estimate, ?),
            eps_surprise_pct = COALESCE(eps_surprise_pct, ?) WHERE id = ?`)
          .run(r.epsActual, source, r.epsEstimate, r.epsSurprisePct, existing.id);
        touched++;
      } else {
        db.prepare('UPDATE reports SET eps_estimate = COALESCE(eps_estimate, ?) WHERE id = ? AND eps_estimate IS NULL').run(r.epsEstimate, existing.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return touched;
}

/**
 * Fetches a US watched stock's past results once (Nasdaq earnings-surprise, Yahoo as backup).
 * Done once per symbol; when both sources fail nothing is marked, so a later call retries.
 */
export function createWatchBackfill(ctx: JobContext, nameOf: (symbol: string) => string | undefined = () => undefined) {
  const failover = createFailover(ctx.db, () => Date.parse(ctx.now()));
  const inFlight = new Set<string>();

  return async function backfillWatched(symbol: string): Promise<void> {
    const key = normalizeTicker(symbol);
    const doneKey = `watch:US:${key}`;
    if (inFlight.has(key) || isBackfilled(ctx.db, doneKey)) return;
    inFlight.add(key);
    try {
      const fast = {
        name: 'nasdaq-surprise',
        run: async (): Promise<PastEps[]> => {
          if (!ctx.sources.earningsSurprise) throw new Error('Nasdaq earnings-surprise source not configured');
          return ctx.sources.earningsSurprise(key);
        },
      };
      const backup = {
        name: 'yahoo',
        run: async (): Promise<PastEps[]> => {
          const summary = await ctx.sources.yahooSummary(key);
          if (!summary) throw new Error('Yahoo returned no summary');
          return summary.epsHistory.flatMap((h) => {
            const d = DateTime.fromISO(h.periodEnd, { zone: 'utc' });
            // Yahoo gives the quarter end only, no report date or consensus.
            return d.isValid ? [{ fiscalQuarter: d.toFormat('LLL/yyyy', { locale: 'en-US' }), reportDate: h.periodEnd, epsActual: h.actual, epsEstimate: null, epsSurprisePct: null }] : [];
          });
        },
      };
      const got = await failover(fast, backup);
      if (!got) return;
      const name = (ctx.db.prepare('SELECT name FROM reports WHERE symbol_key = ? LIMIT 1').get(key) as { name: string } | undefined)?.name
        ?? nameOf(key) ?? symbol;
      storePastEps(ctx.db, symbol, name, got.value, got.via === 'fast' ? 'nasdaq' : 'yahoo', ctx.now());
      markBackfilled(ctx.db, doneKey, ctx.now());
    } catch (err) {
      await track(ctx, 'watch-backfill', async () => { throw err; });
    } finally {
      inFlight.delete(key);
    }
  };
}
