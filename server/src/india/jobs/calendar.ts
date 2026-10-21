import { upsertInCalendarRow } from '../db/inRepo.js';
import { latestQuarterEndBefore, quarterLabel } from '../domain/quarter.js';
import { fetchNseRss, isXbrlLink, parseBoardMeetingDescription, type RssItem, symbolFromPdfLink } from '../sources/nseRss.js';
import { resolveSymbol } from '../sources/symbolMatch.js';
import { parsePriorIntimation } from '../sources/xbrl.js';
import { type InJobContext, trackIn } from './context.js';
import { type FoCache, getFoCache } from './stocks.js';

/** Notices already handled this process (the feed is a rolling window, re-read every run). */
const seen = new Set<string>();

/** True when a board-meeting purpose/agenda is about financial results. */
export function mentionsResults(text: string): boolean {
  return /financial\s+results?|quarterly\s+results?|\bresults\b/i.test(text);
}

const firstWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]/g, ' ').trim().split(/\s+/)[0] ?? '';

/**
 * Symbol for a PDF notice. The uploader prefix is usually the NSE symbol, but not always, so it is
 * trusted only when the company name agrees: the name resolves to the same symbol, or (for names
 * the matcher cannot place) starts with the same word as the F&O list name.
 */
export function pdfNoticeSymbol(item: Pick<RssItem, 'title' | 'link'>, fo: FoCache): string | null {
  const byName = resolveSymbol(item.title, fo.nameIndex);
  const byLink = symbolFromPdfLink(item.link);
  if (byName) return byLink && fo.symbols.has(byLink) && byLink !== byName ? null : byName;
  if (byLink && fo.symbols.has(byLink) && firstWord(fo.names.get(byLink) ?? '') === firstWord(item.title)) return byLink;
  return null;
}

/** "15-Oct-2026" → "2026-10-15". */
export function parseMeetingDate(raw: string): string | null {
  const m = raw.match(/(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})/);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = m ? months.indexOf(m[2]![0]!.toUpperCase() + m[2]!.slice(1).toLowerCase()) + 1 : 0;
  return m && mon > 0 ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

/** Result dates for F&O stocks from NSE's Board_Meetings feed (PDF notices and XBRL intimations). */
export async function refreshInCalendar(ctx: InJobContext): Promise<void> {
  const fo = getFoCache();
  if (!fo) return; // F&O list not loaded yet
  const items = await trackIn(ctx, 'nse-board-meetings', () => fetchNseRss(ctx.http, 'Board_Meetings'));
  if (!items) return;
  const now = ctx.now();
  // Oldest first, so a later notice (a reschedule) is applied last.
  for (const item of [...items].sort((a, b) => a.pubDate.toMillis() - b.pubDate.toMillis())) {
    const key = `${item.link}|${item.description}`;
    if (seen.has(key)) continue;
    try {
      let notice: { symbol: string; meetingDate: string; quarterEnd: string } | null = null;
      if (isXbrlLink(item.link)) {
        const pi = parsePriorIntimation(await ctx.http.text(item.link));
        if (pi.symbol && pi.meetingDate && fo.symbols.has(pi.symbol) && pi.purposes.some(mentionsResults)) {
          notice = { symbol: pi.symbol, meetingDate: pi.meetingDate, quarterEnd: pi.quarterEnd ?? latestQuarterEndBefore(pi.meetingDate) };
        }
      } else {
        const { purpose, meetingDate: raw } = parseBoardMeetingDescription(item.description);
        const meetingDate = raw ? parseMeetingDate(raw) : null;
        const symbol = pdfNoticeSymbol(item, fo);
        // Without a stated meeting date nothing is stored: the publication date is not the meeting date.
        if (symbol && meetingDate && mentionsResults(purpose)) {
          notice = { symbol, meetingDate, quarterEnd: latestQuarterEndBefore(meetingDate) };
        }
      }
      if (notice) {
        upsertInCalendarRow(ctx.db, {
          symbol: notice.symbol, name: item.title, quarterEnd: notice.quarterEnd,
          quarterLabel: quarterLabel(notice.quarterEnd), reportDate: notice.meetingDate,
        }, now);
      }
      seen.add(key);
    } catch (err) {
      // Not marked seen: retried next run.
      console.error('[india-calendar]', item.title, err instanceof Error ? err.message : err);
    }
  }
}
