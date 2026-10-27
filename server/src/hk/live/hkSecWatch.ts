import { DateTime } from 'luxon';
import { config } from '../../config.js';
import type { Http } from '../../sources/http.js';
import { parseFilingDocs } from '../../sources/secFeed.js';
import { SixKWatch, type ForeignFiling, type SixKMarket } from '../../sources/sixKWatch.js';
import {
  findHkReportId, getHkReport, hkReportsBetween, hkStocks, markSecSeen, mergeHkActuals, moveHkReportDate, nearestUnreleasedHk,
  recordHkRelease, secSeen, upsertHkCalendarRow, type HkStock,
} from '../db/hkRepo.js';
import { addDaysHKT, HKT, hkTimingFromAcceptance } from '../domain/hkCalendar.js';
import { hkPeriodFor, hkPeriodLabel } from '../domain/period.js';
import type { HkJobContext } from '../jobs/context.js';
import { readHkRelease } from '../sources/releaseHk.js';
import { classifyHkExhibit, pickReleaseDoc } from '../sources/sixK.js';

export type HkFiling = ForeignFiling;

/** A row moves to the acceptance's HKT date only within this many days. */
const MOVE_WINDOW_DAYS = 3;

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Full-level stocks by CIK. */
export function fullLevelByCik(ctx: HkJobContext): Map<number, HkStock> {
  const map = new Map<number, HkStock>();
  for (const s of hkStocks(ctx.db)) if (s.active && s.level === 'full' && s.cik != null) map.set(s.cik, s);
  return map;
}

/**
 * One SEC filing (6-K, or a domestic filer's 8-K 2.02) of a full-level HK stock: fetch the index, then the release
 * document, then classify it.
 * - Results: only the row with the release's period end flips (Review Focus 2). An unreleased row dated within
 *   ±3 days of the acceptance's HKT date moves to that date (a confirmed row only earlier, keeping its timing).
 *   With no row yet, one is created when the period is the stock's latest cadence period at the HKT date.
 *   Acceptance proves BMO at most (Review Focus 3). Actuals are written only for the fields whose reader gate is
 *   open, and only from the earliest filing of the period.
 * - Date notice: confirms the date of the period it announces, with the stated timing (not a date before filing).
 * Always marks the accession seen. Fetch errors throw (the caller retries).
 */
export async function handleHkFiling(
  ctx: HkJobContext, f: HkFiling, gates: { hkEps?: boolean; hkRevenue?: boolean } = config.fastFields,
): Promise<{ released: number[]; dated: number[] }> {
  const out = { released: [] as number[], dated: [] as number[] };
  const http = ctx.secHttp;
  const stock = fullLevelByCik(ctx).get(f.cik);
  if (!http || !stock) return out;

  const docUrl = pickReleaseDoc(parseFilingDocs(await http.text(f.indexUrl), f.indexUrl));
  if (!docUrl) {
    markSecSeen(ctx.db, f.accession, f.cik, 'other', ctx.now());
    return out;
  }
  const html = await http.text(docUrl);
  const hktDate = DateTime.fromISO(f.acceptedAt, { zone: 'utc' }).setZone(HKT).toISODate()!;
  const ex = classifyHkExhibit(html, { filedOn: hktDate }); // a release cannot report a period ending after acceptance

  if (ex.kind === 'results') {
    let id = findHkReportId(ctx.db, stock.code, ex.periodEnd);
    if (id == null) {
      const near = nearestUnreleasedHk(ctx.db, stock.code, hktDate, MOVE_WINDOW_DAYS);
      if (near && near.periodEnd === ex.periodEnd) id = near.id;
    }
    if (id == null) {
      // The release came before its calendar row: create the row when the release's period is the stock's latest
      // cadence period at the HKT date (a stale or off-cadence release still updates nothing).
      const p = hkPeriodFor(hktDate, stock.cadence, stock.fyEndMonth);
      if (p.periodEnd === ex.periodEnd) {
        id = upsertHkCalendarRow(ctx.db, {
          code: stock.code, name: stock.name, periodEnd: p.periodEnd, periodKind: p.kind, periodLabel: hkPeriodLabel(p.periodEnd, p.kind, stock.fyEndMonth),
          reportDate: hktDate, dateStatus: 'estimated',
        }, ctx.now());
      } else {
        console.log(`[hk-sec] ${stock.code}: ${f.form} ${f.accession} is results for ${ex.periodEnd}, no row with that period end`);
      }
    }
    if (id != null) {
      const rep = getHkReport(ctx.db, id)!;
      const unreleased = rep.releasedAt == null && rep.epsActual == null;
      // A confirmed date only moves earlier (a late filing is not a later release), and keeps its stated timing.
      const isConfirmed = rep.dateStatus === 'confirmed';
      const mayMove = isConfirmed ? hktDate < rep.reportDate : rep.reportDate !== hktDate;
      if (unreleased && mayMove && daysApart(rep.reportDate, hktDate) <= MOVE_WINDOW_DAYS) {
        moveHkReportDate(ctx.db, id, hktDate, { keepTiming: isConfirmed });
      }
      const reportDate = getHkReport(ctx.db, id)!.reportDate;
      const source = f.form.startsWith('8-K') ? 'sec-8k' : 'sec-6k';
      // A later filing for a period already released (an amendment, a re-filing) neither re-reads nor re-sources actuals.
      const laterFiling = rep.releasedAt != null && Date.parse(rep.releasedAt) < Date.parse(f.acceptedAt);
      let changed = recordHkRelease(ctx.db, id, f.acceptedAt, source, hkTimingFromAcceptance(reportDate, f.acceptedAt));
      if (!laterFiling && (gates.hkEps || gates.hkRevenue)) {
        const v = readHkRelease(html, { periodEnd: rep.periodEnd, kind: rep.periodKind }, { adrRatio: stock.adrRatio });
        const eps = gates.hkEps ? v.eps : null;
        const revenue = gates.hkRevenue ? v.revenue : null;
        if (eps != null || revenue != null) {
          changed = mergeHkActuals(ctx.db, id, {
            eps, epsCurrency: eps != null ? v.epsCurrency : null, epsBasis: eps != null ? v.epsBasis : null,
            revenue, revenueCurrency: revenue != null ? v.revenueCurrency : null, source: 'sec', docUrl,
          }, ctx.now()) || changed;
        }
      }
      if (changed) out.released.push(id);
    }
  } else if (ex.kind === 'date-notice' && ex.date >= hktDate) {
    // (A notice naming a date before it was filed is about a past release: ignored.)
    const p = hkPeriodFor(ex.date, stock.cadence, stock.fyEndMonth);
    const id = upsertHkCalendarRow(ctx.db, {
      code: stock.code, name: stock.name, periodEnd: p.periodEnd, periodKind: p.kind, periodLabel: hkPeriodLabel(p.periodEnd, p.kind, stock.fyEndMonth),
      reportDate: ex.date, dateStatus: 'confirmed', timing: ex.timing, timingSource: 'sec-notice',
    }, ctx.now());
    out.dated.push(id);
  }
  markSecSeen(ctx.db, f.accession, f.cik, ex.kind, ctx.now());
  return out;
}

/** HK as a market of the shared 6-K watcher and sweep. `onReleased` gets the released and re-dated ids. */
export function hkSixKMarket(ctx: HkJobContext, onReleased: (ids: number[]) => void): SixKMarket {
  return {
    name: 'hk',
    ciks: () => new Set(fullLevelByCik(ctx).keys()),
    // Domestic filers (YUMC, ONC) are full-level stocks reporting by 8-K Item 2.02.
    eightKCiks: () => new Set(fullLevelByCik(ctx).keys()),
    due: () => {
      // Ruling 11: a full-level report due between HK today-1 and today+3 and unreleased.
      const today = ctx.todayHKT();
      return hkReportsBetween(ctx.db, addDaysHKT(today, -1), addDaysHKT(today, 3))
        .some((r) => r.level === 'full' && !r.releasedAt && !r.hasActual);
    },
    seen: (accession) => secSeen(ctx.db, accession),
    handle: async (f) => {
      const r = await handleHkFiling(ctx, f);
      return [...new Set([...r.released, ...r.dated])];
    },
    onChanged: onReleased,
  };
}

/**
 * Watches the SEC "current 6-K" feed for full-level HK stocks and flips their reports the moment a results 6-K is
 * accepted; date notices confirm dates. Domestic filers (YUMC, ONC) arrive as 8-K 2.02 items from the US SecWatch
 * through `onUsFeed`. Filings are handled one at a time; `onReleased` gets the released and re-dated ids.
 * (The shared `SixKWatch` with the HK market alone.)
 */
export class HkSecWatch extends SixKWatch {
  constructor(ctx: HkJobContext, http: Http, onReleased: (ids: number[]) => void) {
    super([hkSixKMarket(ctx, onReleased)], http, ctx);
  }
}
