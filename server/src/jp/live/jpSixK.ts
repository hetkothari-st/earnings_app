import { DateTime } from 'luxon';
import { config } from '../../config.js';
import { parseFilingDocs } from '../../sources/secFeed.js';
import { classifySixK, pickReleaseDoc, type SixKExhibit } from '../../sources/sixKClassify.js';
import type { ForeignFiling, SixKMarket } from '../../sources/sixKWatch.js';
import {
  findJpReportId, getJpReport, type JpStock, jpFullLevelStocks, jpReportsBetween, jpSecSeen, markJpSecSeen, mergeJpActuals, moveJpReportDate,
  nearestUnreleasedJp, recordJpRelease, upsertJpCalendarRow,
} from '../db/jpRepo.js';
import { addDaysJST, JST } from '../domain/jpCalendar.js';
import { jpPeriodFor, jpPeriodLabel } from '../domain/period.js';
import type { JpJobContext } from '../jobs/context.js';
import { readJpRelease } from '../sources/releaseJp.js';
import { jpIssuerFor } from '../universe.js';

/** A row moves to the acceptance's JST date only within this many days. */
const MOVE_WINDOW_DAYS = 3;

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Active full-level Japan stocks by CIK. */
export function jpFullLevelByCik(ctx: JpJobContext): Map<number, JpStock> {
  const map = new Map<number, JpStock>();
  for (const s of jpFullLevelStocks(ctx.db)) map.set(s.cik!, s);
  return map;
}

/**
 * One 6-K of a full-level Japan stock (Ruling 15): fetch the index, then the release document, then classify it
 * (profile 'jp', `filedOn` = the JST date of acceptance). When the picked exhibit is not a release or a notice, the
 * 6-K main document is classified too (Takeda files its results summary as the 6-K itself); when the picked
 * document is a release for the period but reads all blank, the distinct main document of the same period is read
 * and, if it gives a value, is the `secDocUrl`.
 * - Results: only the row with the release's period end flips. An unreleased row dated within ±3 days of the JST
 *   date moves to it (a confirmed row only earlier, keeping its timing). With no row, one is created only when the
 *   release's period is the stock's latest period at the JST date. Timing is never taken from acceptance (Ruling 7:
 *   EDGAR opens after the Tokyo close). Actuals come from `readJpRelease` behind the `jpEps` / `jpRevenue` gates,
 *   only from the earliest filing of the period, and merge as source `sec` (SEC > EDINET > Yahoo).
 * - Date notice: confirms the date of the period it announces, with the stated timing; a notice naming a date
 *   before its filing is about a past release and is ignored.
 * Always marks the accession seen. Fetch errors throw (the caller retries).
 */
export async function handleJpFiling(
  ctx: JpJobContext, f: ForeignFiling, gates: { jpEps?: boolean; jpRevenue?: boolean } = config.fastFields,
): Promise<{ released: number[]; dated: number[] }> {
  const out = { released: [] as number[], dated: [] as number[] };
  const http = ctx.secHttp;
  const stock = jpFullLevelByCik(ctx).get(f.cik);
  if (!http || !stock) return out;

  const docs = parseFilingDocs(await http.text(f.indexUrl), f.indexUrl);
  const picked = pickReleaseDoc(docs);
  if (!picked) {
    markJpSecSeen(ctx.db, f.accession, f.cik, 'other', ctx.now());
    return out;
  }
  const jstDate = DateTime.fromISO(f.acceptedAt, { zone: 'utc' }).setZone(JST).toISODate()!;
  const classify = (html: string): SixKExhibit => classifySixK(html, { profile: 'jp', filedOn: jstDate });
  let docUrl = picked;
  let html = await http.text(picked);
  let ex = classify(html);
  const main = docs.find((d) => /^6-K(\/A)?$/i.test(d.type))?.url;
  if (ex.kind === 'other') {
    if (main && main !== picked) {
      const mainHtml = await http.text(main);
      const mainEx = classify(mainHtml);
      if (mainEx.kind !== 'other') { docUrl = main; html = mainHtml; ex = mainEx; }
    }
  }

  if (ex.kind === 'results') {
    let id = findJpReportId(ctx.db, stock.code, ex.periodEnd);
    if (id == null) {
      const near = nearestUnreleasedJp(ctx.db, stock.code, jstDate, MOVE_WINDOW_DAYS);
      if (near && near.periodEnd === ex.periodEnd) id = near.id;
    }
    if (id == null) {
      // The release came before its calendar row: create the row when the release's period is the stock's latest
      // period at the JST date (a stale release, or a stock without a fiscal year end, updates nothing).
      const p = stock.fyEndMonth != null ? jpPeriodFor(jstDate, stock.fyEndMonth) : null;
      if (p && p.periodEnd === ex.periodEnd) {
        id = upsertJpCalendarRow(ctx.db, {
          code: stock.code, name: stock.name, period: p, periodLabel: jpPeriodLabel(p), reportDate: jstDate, dateStatus: 'estimated',
        }, ctx.now());
      } else {
        console.log(`[jp-sec] ${stock.code}: ${f.form} ${f.accession} is results for ${ex.periodEnd}, no row with that period end`);
      }
    }
    if (id != null) {
      const rep = getJpReport(ctx.db, id)!;
      const unreleased = rep.releasedAt == null && rep.epsActual == null;
      // A confirmed date only moves earlier (a late filing is not a later release), and keeps its stated timing.
      const isConfirmed = rep.dateStatus === 'confirmed';
      const mayMove = isConfirmed ? jstDate < rep.reportDate : rep.reportDate !== jstDate;
      if (unreleased && mayMove && daysApart(rep.reportDate, jstDate) <= MOVE_WINDOW_DAYS) {
        moveJpReportDate(ctx.db, id, jstDate, { keepTiming: isConfirmed });
      }
      // A later filing for a period already released (an amendment, a re-filing) neither re-reads nor re-sources actuals.
      const laterFiling = rep.releasedAt != null && Date.parse(rep.releasedAt) < Date.parse(f.acceptedAt);
      let changed = recordJpRelease(ctx.db, id, f.acceptedAt, null);
      if (!laterFiling && (gates.jpEps || gates.jpRevenue)) {
        const read = (h: string) => readJpRelease(h, { periodEnd: rep.periodEnd, fiscalQuarter: rep.fiscalQuarter, issuer: jpIssuerFor(stock.code) });
        let v = read(html);
        // Takeda: the picked exhibit (an appendix) may be classed as the release yet read blank; the 6-K tanshin of
        // the same period carries the figures.
        if (v.eps == null && v.epsDiluted == null && v.revenue == null && main && main !== docUrl) {
          const mainHtml = await http.text(main);
          const mainEx = classify(mainHtml);
          if (mainEx.kind === 'results' && mainEx.periodEnd === ex.periodEnd) {
            const mv = read(mainHtml);
            if (mv.eps != null || mv.epsDiluted != null || mv.revenue != null) { v = mv; docUrl = main; }
          }
        }
        const currency = v.currency;
        const span = v.span;
        if (currency && span) {
          const eps = gates.jpEps && v.eps != null
            ? { basic: v.eps, diluted: v.epsDiluted, currency, span, ytdMonths: v.ytdMonths }
            : null;
          const revenue = gates.jpRevenue && v.revenue != null
            ? { value: v.revenue, currency, span, ytdMonths: v.ytdMonths }
            : null;
          if (eps || revenue) changed = mergeJpActuals(ctx.db, id, { eps, revenue, source: 'sec', docUrl }, ctx.now()) || changed;
        }
      }
      if (changed) out.released.push(id);
    }
  } else if (ex.kind === 'date-notice' && ex.date >= jstDate) {
    // (A notice naming a date before it was filed is about a past release: ignored.)
    if (stock.fyEndMonth == null) {
      console.log(`[jp-sec] ${stock.code}: date notice ${f.accession} for ${ex.date}, no fiscal year end to name its period`);
    } else {
      const p = jpPeriodFor(ex.date, stock.fyEndMonth);
      const id = upsertJpCalendarRow(ctx.db, {
        code: stock.code, name: stock.name, period: p, periodLabel: jpPeriodLabel(p), reportDate: ex.date, dateStatus: 'confirmed',
        timing: ex.timing, timingSource: 'sec-notice',
      }, ctx.now());
      out.dated.push(id);
    }
  }
  markJpSecSeen(ctx.db, f.accession, f.cik, ex.kind, ctx.now());
  return out;
}

/** Japan as a market of the shared 6-K watcher and sweep. `onChanged` gets the released and re-dated ids. */
export function jpSixKMarket(ctx: JpJobContext, onChanged: (ids: number[]) => void): SixKMarket {
  return {
    name: 'jp',
    ciks: () => new Set(jpFullLevelByCik(ctx).keys()),
    // No Japan full-level company files 8-Ks.
    eightKCiks: () => new Set(),
    due: () => {
      // Ruling 16: a full-level report due between JST today-1 and today+3 and unreleased.
      const today = ctx.todayJST();
      return jpReportsBetween(ctx.db, addDaysJST(today, -1), addDaysJST(today, 3))
        .some((r) => r.level === 'full' && !r.releasedAt && !r.hasEps);
    },
    seen: (accession) => jpSecSeen(ctx.db, accession),
    handle: async (f) => {
      const r = await handleJpFiling(ctx, f);
      return [...new Set([...r.released, ...r.dated])];
    },
    onChanged,
  };
}
