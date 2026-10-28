import type { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import {
  activeEuropeStocksByIsin, europeIssuerStocks, markSignalSeen, nearestUnreleasedEurope, recordEuropeRelease, releasedEuropeNear,
  setEuropeTiming, signalCountWithPrefix, signalSeen, type SignalOutcome,
} from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import { EXCHANGES, type ExchangeId } from '../exchanges.js';
import { isDilaResults, parseDilaArchiveStream } from '../sources/dila.js';
import { createIssuerIndex } from '../sources/issuerMatch.js';
import { isResultsTitle, prnReleaseKey, type PrnItem } from '../sources/prnewswire.js';
import { trackIn, type EuropeJobContext } from './context.js';

/**
 * Fast "results out" signals (Ruling 10, Review Focus 4): PR Newswire items and DILA AMF filings. A false positive
 * flips nothing: an item flips a row only for exactly one company, a results title (PRN) or a results type (DILA),
 * and a report row dated within ±3 days.
 */

/** A row is flipped only when its report date is within this many calendar days of the signal's local date. */
const WINDOW_DAYS = 3;

/**
 * PR Newswire's pubDate lags the issuer's own release by up to about 40 minutes (sourceUrls.ts). A timing is stated
 * only when the pubDate and the instant 40 minutes before it fall in the same session bucket, so a release that
 * went out before the open but reached the feed after it never reads as DMH.
 */
const PRN_LAG_MINUTES = 40;

interface IndexedStock { symbol: string; exchange: ExchangeId; lei: string | null }

/**
 * One issuer index over both markets (the UK and EU feeds share items): every active stock under its universe name
 * and, when different, its Yahoo profile name.
 */
function stocksIndex(db: DatabaseSync) {
  const bySymbol = new Map<string, IndexedStock>();
  const entries: { symbol: string; isin: string; name: string }[] = [];
  for (const r of europeIssuerStocks(db)) {
    if (!(r.exchange in EXCHANGES)) continue;
    bySymbol.set(r.symbol, { symbol: r.symbol, exchange: r.exchange, lei: r.lei });
    entries.push({ symbol: r.symbol, isin: r.isin ?? '', name: r.name });
    if (r.profileName && r.profileName !== r.name) entries.push({ symbol: r.symbol, isin: '', name: r.profileName });
  }
  return { index: createIssuerIndex(entries), bySymbol };
}

/** Symbols grouped into companies: share lines with one LEI (Nordic A/B classes) are one company. */
function companies(symbols: string[], bySymbol: Map<string, IndexedStock>): string[][] {
  const groups = new Map<string, string[]>();
  for (const s of symbols) {
    const key = bySymbol.get(s)?.lei ?? `symbol:${s}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()];
}

/** The issuer name a PRN item states: dc:contributor, else the title before the first " - " or ":". */
const prnIssuerName = (it: PrnItem): string => it.contributor?.trim() || it.title.split(/ - |:/)[0]!.trim();

/**
 * The report a signal at `at` (local day `day`) belongs to:
 * - `release`: the unreleased row nearest the day, else a released row whose recorded release is later than `at` (or
 *   that only an EPS figure marks): `recordEuropeRelease` moves the release earlier to the signal.
 * - `timing`: a row an earlier (or same-time) signal already released: the release is never moved, but a PRN item may
 *   still state the timing.
 */
function rowFor(db: DatabaseSync, symbol: string, day: string, at: string): { id: number; mode: 'release' | 'timing' } | null {
  const open = nearestUnreleasedEurope(db, symbol, day, WINDOW_DAYS);
  if (open) return { id: open.id, mode: 'release' };
  const atMs = Date.parse(at);
  const released = releasedEuropeNear(db, symbol, day, WINDOW_DAYS);
  const later = released.find((r) => r.releasedAt == null || Date.parse(r.releasedAt) > atMs);
  if (later) return { id: later.id, mode: 'release' };
  const earlier = released[0];
  return earlier ? { id: earlier.id, mode: 'timing' } : null;
}

/** Timing from a PRN pubDate in the exchange's zone, only when the 40-minute lag cannot change the bucket. */
function prnTiming(ex: ExchangeId, publishedAt: string): LocalTiming {
  const cal = calendarFor(ex);
  const local = DateTime.fromISO(publishedAt, { zone: 'utc' }).setZone(cal.zone);
  if (!local.isValid) return 'UNKNOWN';
  const early = local.minus({ minutes: PRN_LAG_MINUTES });
  // Across midnight the earlier instant is another day: no bucket can be stated.
  if (early.toISODate() !== local.toISODate()) return 'UNKNOWN';
  const a = cal.timingFromClock(local.toFormat('HH:mm'));
  return a === cal.timingFromClock(early.toFormat('HH:mm')) ? a : 'UNKNOWN';
}

/**
 * PR Newswire results-out. Each release is handled once across UK and EU (`prnReleaseKey`, `signal_seen` source
 * 'prn'), against one index over both markets, so the run that sees it first flips the matched row whichever market
 * holds it. Flips only when all hold: a results title; exactly one company by the stated issuer name, or else by
 * exactly one ISIN in the title and description (a name and an ISIN naming two companies is ambiguous); and a row of
 * that company within ±3 days of the item's local date. Every share line of the company with such a row flips.
 * A row an earlier signal already released keeps that release; the item only stamps its timing (outcome `timing`).
 * Returns the ids changed.
 */
export async function refreshPrnSignals(ctx: EuropeJobContext): Promise<number[]> {
  const items = await trackIn(ctx, 'prn', () => ctx.prnFeed());
  if (!items) return [];
  const { index, bySymbol } = stocksIndex(ctx.db);
  const now = ctx.now();
  const changed = new Set<number>();
  const sorted = [...items].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  for (const it of sorted) {
    const key = prnReleaseKey(it.link);
    if (signalSeen(ctx.db, 'prn', key)) continue;
    const mark = (outcome: SignalOutcome, symbol: string | null = null) => markSignalSeen(ctx.db, 'prn', key, symbol, outcome, now);
    if (!isResultsTitle(it.title)) { mark('not-results'); continue; }

    const byName = companies(index.byName(prnIssuerName(it)), bySymbol);
    const byIsin = companies(index.byIsinIn(`${it.title} ${it.description}`), bySymbol);
    if (byName.length > 1 || byIsin.length > 1) { mark('ambiguous'); continue; }
    if (byName.length === 1 && byIsin.length === 1 && !byName[0]!.some((s) => byIsin[0]!.includes(s))) { mark('ambiguous'); continue; }
    const company = byName[0] ?? byIsin[0] ?? null;
    if (!company) { mark('no-match'); continue; }

    let released = false;
    let timed = false;
    for (const symbol of company) {
      const ex = bySymbol.get(symbol)!.exchange;
      const day = DateTime.fromISO(it.publishedAt, { zone: 'utc' }).setZone(EXCHANGES[ex].zone).toISODate()!;
      const row = rowFor(ctx.db, symbol, day, it.publishedAt);
      if (!row) continue;
      const timing = prnTiming(ex, it.publishedAt);
      if (row.mode === 'release') {
        released = true;
        // recordEuropeRelease also stamps the PRN timing (setEuropeTiming 'prn') when it is known.
        if (recordEuropeRelease(ctx.db, row.id, { at: it.publishedAt, source: 'prn', timing, title: it.title, url: it.link })) changed.add(row.id);
      } else {
        timed = true;
        if (setEuropeTiming(ctx.db, row.id, timing, 'prn')) changed.add(row.id);
      }
    }
    mark(released ? 'flipped' : timed ? 'timing' : 'no-row', company[0]!);
  }
  return [...changed];
}

/** A batch that fails this many times in one (Paris) day is marked `error` for that day and not downloaded again. */
export const DILA_MAX_FAILURES_PER_DAY = 3;

/**
 * DILA AMF results-out (EU only; without `ctx.dila` a no-op). Each unseen batch of yesterday's and today's directory
 * (`signal_seen` 'dila-file') is streamed, never buffered whole. Yesterday's are listed too: a batch appears about an
 * hour after its HHMM name, so the evening (19:05) batch can land after the day's last run. A batch that fails is not
 * marked and is read again next run, up to DILA_MAX_FAILURES_PER_DAY times a day ('dila-file-fail' rows keyed
 * `day|file|n`); then 'dila-file-error' `day|file` is set and the batch is skipped for the rest of that day. Each
 * document is handled once across batches (by id). A results-type document whose ISIN is exactly one active EU stock
 * with a row within ±3 days of its filing day flips it (two lines with that ISIN: `ambiguous`). The ISIN match is
 * exact, so a non-French ISIN filed with the AMF (a Dutch-incorporated Paris listing) counts too (controller-accepted).
 * The filing time is the AMF's, so DILA never sets timing.
 */
export async function refreshDilaSignals(ctx: EuropeJobContext): Promise<number[]> {
  const dila = ctx.dila;
  if (ctx.market !== 'EU' || !dila) return [];
  const today = ctx.today();
  const yesterday = DateTime.fromISO(today, { zone: 'utc' }).minus({ days: 1 }).toISODate()!;
  const files = await trackIn(ctx, 'dila', async () => [...new Set([...(await dila.list(yesterday)), ...(await dila.list(today))])]);
  if (!files) return [];
  const changed: number[] = [];
  for (const file of files) {
    if (signalSeen(ctx.db, 'dila-file', file)) continue;
    const dayKey = `${today}|${file}`;
    if (signalSeen(ctx.db, 'dila-file-error', dayKey)) continue;
    const docs = await trackIn(ctx, 'dila', async () => parseDilaArchiveStream(await dila.archive(file)));
    if (!docs) {
      const failures = signalCountWithPrefix(ctx.db, 'dila-file-fail', `${dayKey}|`) + 1;
      markSignalSeen(ctx.db, 'dila-file-fail', `${dayKey}|${failures}`, null, 'failed', ctx.now());
      if (failures >= DILA_MAX_FAILURES_PER_DAY) {
        console.warn(`dila: ${file} failed ${failures} times today; skipped until tomorrow`);
        markSignalSeen(ctx.db, 'dila-file-error', dayKey, null, 'error', ctx.now());
      }
      continue;
    }
    const now = ctx.now();
    for (const d of docs) {
      if (signalSeen(ctx.db, 'dila', d.id)) continue;
      const mark = (outcome: SignalOutcome, symbol: string | null = null) => markSignalSeen(ctx.db, 'dila', d.id, symbol, outcome, now);
      if (!isDilaResults(d)) { mark('not-results'); continue; }
      const stocks = d.isin ? activeEuropeStocksByIsin(ctx.db, 'EU', d.isin).filter((s) => s.exchange in EXCHANGES) : [];
      if (stocks.length > 1) { mark('ambiguous'); continue; }
      const stock = stocks[0];
      if (!stock) { mark('no-match'); continue; }
      const day = DateTime.fromISO(d.filedAt, { zone: 'utc' }).setZone(EXCHANGES[stock.exchange].zone).toISODate()!;
      const row = rowFor(ctx.db, stock.symbol, day, d.filedAt);
      // An earlier signal already holds the release, and DILA states no timing: nothing to do.
      if (!row || row.mode === 'timing') { mark('no-row', stock.symbol); continue; }
      if (recordEuropeRelease(ctx.db, row.id, { at: d.filedAt, source: 'dila', timing: null, title: d.title, url: d.url })) changed.push(row.id);
      mark('flipped', stock.symbol);
    }
    markSignalSeen(ctx.db, 'dila-file', file, null, 'done', now);
  }
  return changed;
}
