import { DateTime } from 'luxon';
import { config } from '../../config.js';
import { parseFilingDocs } from '../../sources/secFeed.js';
import { classifySixK, pickReleaseDoc, type SixKExhibit, type SixKSession } from '../../sources/sixKClassify.js';
import type { ForeignFiling, SixKMarket } from '../../sources/sixKWatch.js';
import {
  confirmEuropePeriod, europeFullLevelStocks, europeReportsBetween, europeSecSeen, type EuropeStock, findEuropeReportId, getEuropeReport,
  markEuropeSecSeen, mergeEuropeActuals, moveEuropeReportDate, nearestUnreleasedEurope, recordEuropeRelease, setEuropeTiming,
  upsertEuropeCalendarRow,
} from '../db/europeRepo.js';
import { europePeriodFor, europePeriodLabel } from '../domain/period.js';
import { EXCHANGES } from '../exchanges.js';
import type { EuropeJobContext } from '../jobs/context.js';
import { addDaysEurope } from '../jobs/estimates.js';
import { readEuropeRelease } from '../sources/releaseEurope.js';
import { europeIssuerFor } from '../universe.js';

/** A row moves to the acceptance's local date only within this many days. */
const MOVE_WINDOW_DAYS = 3;

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

type Gates = { ukEps?: boolean; ukRevenue?: boolean; euEps?: boolean; euRevenue?: boolean };

/** Active full-level stocks of the market by CIK (both 6-K and 8-K filers). */
export function europeFullLevelByCik(ctx: Pick<EuropeJobContext, 'db' | 'market'>): Map<number, EuropeStock> {
  const map = new Map<number, EuropeStock>();
  for (const s of europeFullLevelStocks(ctx.db, ctx.market)) map.set(s.cik!, s);
  return map;
}

/** The stock's own exchange session (`europe/exchanges.ts`); null for an exchange the app does not know. */
export function europeSessionOf(stock: Pick<EuropeStock, 'exchange'>): SixKSession | null {
  const ex = EXCHANGES[stock.exchange];
  return ex ? { zone: ex.zone, openMin: ex.openMin, closeMin: ex.closeMin } : null;
}

/**
 * One 6-K (or 8-K Item 2.02) of a full-level UK / EU stock, as Japan's `handleJpFiling`:
 * - Classified with profile 'uk' / 'eu', `filedOn` = the acceptance's date in the stock's exchange zone, the stock's
 *   fiscal-year-end month and its exchange session (from the watcher's `sessionFor`, else looked up here; none →
 *   clock statements give UNKNOWN timing, never a default).
 * - Results: only the row with the release's period end flips (a row within ±3 days moves to the local date, a
 *   confirmed one only earlier and keeping its timing); with no row, one is created only when the release's period
 *   is the stock's latest period at that date. The period is confirmed (Ruling 7). The release is recorded with
 *   source `sec` and NO timing (Ruling 9: EDGAR opens after the 07:00 London release). Actuals come from
 *   `readEuropeRelease` behind the market's reader-gate flags, only from the earliest filing of the period, each side
 *   in the currency the release states.
 * - Date notice: confirms its date (period by rule, not confirmed) and sets the stated timing as `sec-notice`; a
 *   notice naming a date before its filing is ignored.
 * Always marks the accession seen for this market. Fetch errors throw (the caller retries).
 */
export async function handleEuropeFiling(
  ctx: EuropeJobContext, f: ForeignFiling, gates: Gates = config.fastFields,
): Promise<{ released: number[]; dated: number[] }> {
  const out = { released: [] as number[], dated: [] as number[] };
  const http = ctx.secHttp;
  const stock = europeFullLevelByCik(ctx).get(f.cik);
  if (!http || !stock) return out;
  const market = ctx.market;
  const profile = market === 'UK' ? 'uk' : 'eu';

  const docs = parseFilingDocs(await http.text(f.indexUrl), f.indexUrl);
  const picked = pickReleaseDoc(docs);
  if (!picked) {
    markEuropeSecSeen(ctx.db, market, f.accession, f.cik, 'other', ctx.now());
    return out;
  }
  const zone = EXCHANGES[stock.exchange]?.zone ?? (market === 'UK' ? 'Europe/London' : 'Europe/Paris');
  const localDate = DateTime.fromISO(f.acceptedAt, { zone: 'utc' }).setZone(zone).toISODate()!;
  const session = f.session !== undefined ? f.session : europeSessionOf(stock);
  const classify = (html: string): SixKExhibit => classifySixK(html, {
    profile, filedOn: localDate, fyEndMonth: stock.fyEndMonth ?? undefined, session: session ?? undefined,
  });
  let docUrl = picked;
  let html = await http.text(picked);
  let ex = classify(html);
  const main = docs.find((d) => /^[68]-K(\/A)?$/i.test(d.type))?.url;
  if (ex.kind === 'other' && main && main !== picked) {
    const mainHtml = await http.text(main);
    const mainEx = classify(mainHtml);
    if (mainEx.kind !== 'other') { docUrl = main; html = mainHtml; ex = mainEx; }
  }

  if (ex.kind === 'results') {
    let id = findEuropeReportId(ctx.db, stock.symbol, ex.periodEnd);
    if (id == null) {
      const near = nearestUnreleasedEurope(ctx.db, stock.symbol, localDate, MOVE_WINDOW_DAYS);
      if (near && near.periodEnd === ex.periodEnd) id = near.id;
    }
    if (id == null) {
      const p = stock.fyEndMonth != null ? europePeriodFor(localDate, stock.fyEndMonth) : null;
      if (p && p.periodEnd === ex.periodEnd) {
        id = upsertEuropeCalendarRow(ctx.db, market, {
          symbol: stock.symbol, name: stock.name, exchange: stock.exchange, period: p, periodLabel: europePeriodLabel(p),
          periodConfirmed: true, reportDate: localDate, dateStatus: 'estimated',
        }, ctx.now());
      } else {
        console.log(`[${profile}-sec] ${stock.symbol}: ${f.form} ${f.accession} is results for ${ex.periodEnd}, no row with that period end`);
      }
    }
    if (id != null) {
      const rep = getEuropeReport(ctx.db, id)!;
      const unreleased = rep.releasedAt == null && rep.epsActual == null && rep.epsDilutedActual == null;
      const isConfirmed = rep.dateStatus === 'confirmed';
      const mayMove = isConfirmed ? localDate < rep.reportDate : rep.reportDate !== localDate;
      let changed = false;
      if (unreleased && mayMove && daysApart(rep.reportDate, localDate) <= MOVE_WINDOW_DAYS) {
        moveEuropeReportDate(ctx.db, id, localDate, { keepTiming: isConfirmed });
        changed = true;
      }
      if (!rep.periodConfirmed) { confirmEuropePeriod(ctx.db, id); changed = true; }
      // A later filing for a period already released (an amendment) neither re-reads nor re-sources actuals.
      const laterFiling = rep.releasedAt != null && Date.parse(rep.releasedAt) < Date.parse(f.acceptedAt);
      changed = recordEuropeRelease(ctx.db, id, { at: f.acceptedAt, source: 'sec', timing: null, url: docUrl }) || changed;
      const epsGate = market === 'UK' ? gates.ukEps : gates.euEps;
      const revGate = market === 'UK' ? gates.ukRevenue : gates.euRevenue;
      if (!laterFiling && (epsGate || revGate)) {
        const read = (h: string) => readEuropeRelease(h, {
          periodEnd: rep.periodEnd, fiscalQuarter: rep.fiscalQuarter, profile, issuer: europeIssuerFor(stock.adr ?? stock.symbol),
        });
        let v = read(html);
        if (v.eps == null && v.epsDiluted == null && v.revenue == null && main && main !== docUrl) {
          const mainHtml = await http.text(main);
          const mainEx = classify(mainHtml);
          if (mainEx.kind === 'results' && mainEx.periodEnd === ex.periodEnd) {
            const mv = read(mainHtml);
            if (mv.eps != null || mv.epsDiluted != null || mv.revenue != null) { v = mv; docUrl = main; }
          }
        }
        if (v.span) {
          const eps = epsGate && v.eps != null && v.epsCurrency
            ? { basic: v.eps, diluted: v.epsDiluted, currency: v.epsCurrency, span: v.span, ytdMonths: v.ytdMonths }
            : null;
          const revenue = revGate && v.revenue != null && v.revenueCurrency
            ? { value: v.revenue, currency: v.revenueCurrency, span: v.span, ytdMonths: v.ytdMonths }
            : null;
          if (eps || revenue) changed = mergeEuropeActuals(ctx.db, id, { eps, revenue, source: 'sec', docUrl }, ctx.now()) || changed;
        }
      }
      if (changed) out.released.push(id);
    }
  } else if (ex.kind === 'date-notice' && ex.date >= localDate) {
    if (stock.fyEndMonth == null) {
      console.log(`[${profile}-sec] ${stock.symbol}: date notice ${f.accession} for ${ex.date}, no fiscal year end to name its period`);
    } else {
      const p = europePeriodFor(ex.date, stock.fyEndMonth);
      const id = upsertEuropeCalendarRow(ctx.db, market, {
        symbol: stock.symbol, name: stock.name, exchange: stock.exchange, period: p, periodLabel: europePeriodLabel(p),
        periodConfirmed: false, reportDate: ex.date, dateStatus: 'confirmed',
      }, ctx.now());
      setEuropeTiming(ctx.db, id, ex.timing, 'sec-notice');
      out.dated.push(id);
    }
  }
  // With no fiscal year end yet (a first boot sweeps SEC before Yahoo or ESEF supplied it), a notice or a results
  // 6-K that found no row cannot be placed: it stays unseen, so a later sweep (45 days back) handles it.
  const unplaced = stock.fyEndMonth == null && out.released.length === 0 && out.dated.length === 0
    && ((ex.kind === 'date-notice' && ex.date >= localDate) || ex.kind === 'results');
  if (!unplaced) markEuropeSecSeen(ctx.db, market, f.accession, f.cik, ex.kind, ctx.now());
  return out;
}

/** UK or Europe as a market of the shared 6-K watcher and sweep. `onChanged` gets the released and re-dated ids. */
export function europeSixKMarket(ctx: EuropeJobContext, onChanged: (ids: number[]) => void): SixKMarket {
  const ciksOf = (form: '6-K' | '8-K') => {
    const out = new Set<number>();
    for (const [cik, s] of europeFullLevelByCik(ctx)) if (s.secForm === form) out.add(cik);
    return out;
  };
  return {
    name: ctx.market === 'UK' ? 'uk' : 'eu',
    ciks: () => ciksOf('6-K'),
    eightKCiks: () => ciksOf('8-K'),
    due: () => {
      // A full-level report due between local today-1 and today+3 and unreleased.
      const today = ctx.today();
      return europeReportsBetween(ctx.db, ctx.market, addDaysEurope(ctx, today, -1), addDaysEurope(ctx, today, 3))
        .some((r) => r.level === 'full' && !r.releasedAt && !r.hasEps);
    },
    seen: (accession) => europeSecSeen(ctx.db, ctx.market, accession),
    handle: async (f) => {
      const r = await handleEuropeFiling(ctx, f);
      return [...new Set([...r.released, ...r.dated])];
    },
    onChanged,
    sessionFor: (cik) => {
      const s = europeFullLevelByCik(ctx).get(cik);
      return s ? europeSessionOf(s) : null;
    },
  };
}
