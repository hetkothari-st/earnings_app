import { DateTime } from 'luxon';
import { mergeInFiling, recordRelease, reportOnDate } from '../db/inRepo.js';
import { addDaysIST, IST } from '../domain/nseCalendar.js';
import { quarterLabel } from '../domain/quarter.js';
import { fetchNseRss, isResultSubject, parseAnnouncementDescription, resolveIntegratedFilingUrl } from '../sources/nseRss.js';
import { resolveSymbol } from '../sources/symbolMatch.js';
import { parseIntegratedFiling } from '../sources/xbrl.js';
import { type InJobContext, trackIn } from './context.js';
import { getFoCache } from './stocks.js';

/** The XBRL file appears ~15–20 minutes after the feed item; keep trying for two hours. */
const GIVE_UP_MS = 2 * 3_600_000;

/** Filing links handled (done) or still waiting for their file (first seen at). */
const filings = new Map<string, { firstSeen: number; done: boolean }>();
const announcements = new Set<string>();

/** For tests: forget what was handled. */
export function resetInResultsState(): void {
  filings.clear();
  announcements.clear();
}

/** A reporting period of one quarter (89–92 days), so year-to-date or annual figures are never used. */
function isQuarter(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const days = DateTime.fromISO(end).diff(DateTime.fromISO(start), 'days').days + 1;
  return days >= 89 && days <= 92;
}

/**
 * Actuals from NSE's Integrated_Filing feed, and release times from it and from
 * Online_announcements (earliest wins). Each run handles only new items; a filing whose file is not
 * up yet is retried on later runs. Returns ids whose actuals or timing changed.
 */
export async function refreshInResults(ctx: InJobContext): Promise<number[]> {
  const fo = getFoCache();
  if (!fo) return [];
  const now = ctx.now();
  const changed = new Set<number>();

  const items = await trackIn(ctx, 'nse-integrated-filing', () => fetchNseRss(ctx.http, 'Integrated_Filing'));
  for (const item of items ?? []) {
    if (!/financials/i.test(item.description)) continue; // governance etc.
    const state = filings.get(item.link) ?? { firstSeen: Date.parse(now), done: false };
    filings.set(item.link, state);
    if (state.done) continue;
    let xml: string;
    try {
      xml = await ctx.http.text(resolveIntegratedFilingUrl(item.link));
    } catch {
      if (Date.parse(now) - state.firstSeen > GIVE_UP_MS) state.done = true;
      continue; // not up yet
    }
    try {
      const f = parseIntegratedFiling(xml);
      state.done = true;
      if (!fo.symbols.has(f.symbol) || !f.periodEnd || !isQuarter(f.periodStart, f.periodEnd)) continue;
      const { id, changed: actualsChanged } = mergeInFiling(ctx.db, {
        symbol: f.symbol, name: f.companyName, quarterEnd: f.periodEnd, quarterLabel: quarterLabel(f.periodEnd),
        reportDate: f.reportDate,
        // Banks file no revenue from operations; their total income is shown, labelled as such.
        revenueActual: f.isBank ? f.totalIncome : f.revenueFromOperations,
        revenueKind: f.revenueKind, pnlActual: f.profitLoss, epsActual: f.eps, nature: f.nature,
      }, now);
      if (actualsChanged) changed.add(id);
      // A revision is filed later; its time says nothing about when results came out.
      if (!/revision/i.test(item.description) && recordRelease(ctx.db, id, item.pubDate.toUTC().toISO()!, 'nse-filing')) changed.add(id);
    } catch (err) {
      // A file that is there but unreadable will not get better: record it and move on.
      state.done = true;
      console.error('[india-results]', item.title, err instanceof Error ? err.message : err);
    }
  }

  const ann = await trackIn(ctx, 'nse-online-announcements', () => fetchNseRss(ctx.http, 'Online_announcements'));
  for (const item of ann ?? []) {
    const key = `${item.link}|${item.pubDateRaw}`;
    if (announcements.has(key)) continue;
    announcements.add(key);
    const { text, subject } = parseAnnouncementDescription(item.description);
    if (!isResultSubject(subject) || !/financial\s+results?|results?\s+for\s+the\s+(quarter|period)/i.test(`${subject} ${text}`)) continue;
    const symbol = resolveSymbol(item.title, fo.nameIndex);
    if (!symbol) continue;
    const day = item.pubDate.setZone(IST).toISODate()!;
    // Same-day release, or one just after midnight for a meeting the day before.
    const id = reportOnDate(ctx.db, symbol, day) ?? reportOnDate(ctx.db, symbol, addDaysIST(day, -1));
    if (id != null && recordRelease(ctx.db, id, item.pubDate.toUTC().toISO()!, 'nse-announcement')) changed.add(id);
  }

  // Keep memory bounded: links older than a day are gone from the feeds.
  for (const [k, v] of filings) if (Date.parse(now) - v.firstSeen > 24 * 3_600_000) filings.delete(k);
  if (announcements.size > 5000) announcements.clear();
  return [...changed];
}
