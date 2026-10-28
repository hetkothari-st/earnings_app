import type { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import {
  markSignalSeen, nearestUnreleasedEurope, recordEuropeRelease, setEuropeTiming, signalSeen, type SignalOutcome,
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
  const rows = db.prepare('SELECT symbol, exchange, isin, lei, name, profile_name FROM europe_stocks WHERE active = 1').all() as
    { symbol: string; exchange: string; isin: string | null; lei: string | null; name: string; profile_name: string | null }[];
  const bySymbol = new Map<string, IndexedStock>();
  const entries: { symbol: string; isin: string; name: string }[] = [];
  for (const r of rows) {
    if (!(r.exchange in EXCHANGES)) continue;
    bySymbol.set(r.symbol, { symbol: r.symbol, exchange: r.exchange as ExchangeId, lei: r.lei });
    entries.push({ symbol: r.symbol, isin: r.isin ?? '', name: r.name });
    if (r.profile_name && r.profile_name !== r.name) entries.push({ symbol: r.symbol, isin: '', name: r.profile_name });
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
 * The report a signal at `at` (local day `day`) belongs to: the unreleased row nearest the day, else a row already
 * flipped by a later signal (its release is moved earlier by `recordEuropeRelease`; an earlier one is never moved).
 */
function rowFor(db: DatabaseSync, symbol: string, day: string, at: string): { id: number } | null {
  const open = nearestUnreleasedEurope(db, symbol, day, WINDOW_DAYS);
  if (open) return open;
  const later = (db.prepare(`SELECT id, released_at FROM europe_reports
      WHERE symbol = ? AND released_at IS NOT NULL AND abs(julianday(report_date) - julianday(?)) <= ?
      ORDER BY abs(julianday(report_date) - julianday(?)), report_date`).all(symbol, day, WINDOW_DAYS, day) as
    { id: number; released_at: string }[]).find((r) => Date.parse(r.released_at) > Date.parse(at));
  return later ? { id: later.id } : null;
}

/** Timing from a PRN pubDate in the exchange's zone, only when the 40-minute lag cannot change the bucket. */
function prnTiming(ex: ExchangeId, publishedAt: string): LocalTiming {
  const cal = calendarFor(ex);
  const local = DateTime.fromISO(publishedAt, { zone: 'utc' }).setZone(cal.zone);
  if (!local.isValid) return 'UNKNOWN';
  const late = cal.timingFromClock(local.toFormat('HH:mm'));
  const early = cal.timingFromClock(local.minus({ minutes: PRN_LAG_MINUTES }).toFormat('HH:mm'));
  // Across midnight the earlier instant is another day: no bucket can be stated.
  if (local.minus({ minutes: PRN_LAG_MINUTES }).toISODate() !== local.toISODate()) return 'UNKNOWN';
  return late === early ? late : 'UNKNOWN';
}

/**
 * PR Newswire results-out. Each release is handled once across UK and EU (`prnReleaseKey`, `signal_seen` source
 * 'prn'), against one index over both markets, so the run that sees it first flips the matched row whichever market
 * holds it. Flips only when all hold: a results title; exactly one company by the stated issuer name, or else by
 * exactly one ISIN in the title and description (a name and an ISIN naming two companies is ambiguous); and a row of
 * that company within ±3 days of the item's local date. Every share line of the company with such a row flips.
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
    let company: string[] | null = null;
    if (byName.length > 1 || byIsin.length > 1) { mark('ambiguous'); continue; }
    if (byName.length === 1 && byIsin.length === 1 && !byName[0]!.some((s) => byIsin[0]!.includes(s))) { mark('ambiguous'); continue; }
    company = byName[0] ?? byIsin[0] ?? null;
    if (!company) { mark('no-match'); continue; }

    let flipped = false;
    for (const symbol of company) {
      const ex = bySymbol.get(symbol)!.exchange;
      const day = DateTime.fromISO(it.publishedAt, { zone: 'utc' }).setZone(EXCHANGES[ex].zone).toISODate()!;
      const row = rowFor(ctx.db, symbol, day, it.publishedAt);
      if (!row) continue;
      flipped = true;
      const timing = prnTiming(ex, it.publishedAt);
      if (recordEuropeRelease(ctx.db, row.id, { at: it.publishedAt, source: 'prn', timing, title: it.title, url: it.link })) changed.add(row.id);
      // The item states the time even when an earlier signal already holds the release.
      const stored = ctx.db.prepare('SELECT timing FROM europe_reports WHERE id = ?').get(row.id) as { timing: string };
      if (stored.timing === 'UNKNOWN' && setEuropeTiming(ctx.db, row.id, timing, 'prn')) changed.add(row.id);
    }
    mark(flipped ? 'flipped' : 'no-row', company[0]!);
  }
  return [...changed];
}

/**
 * DILA AMF results-out (EU only; without `ctx.dila` a no-op). Each unseen batch of today's directory (`signal_seen`
 * 'dila-file') is streamed, never buffered whole; a batch that fails is not marked and is read again next run. Each
 * document is handled once across batches (by id). A results-type document whose ISIN is an active EU stock with a
 * row within ±3 days of its filing day flips it. The ISIN match is exact, so a non-French ISIN filed with the AMF
 * (a Dutch-incorporated Paris listing) counts too. The filing time is the AMF's, so DILA never sets timing.
 */
export async function refreshDilaSignals(ctx: EuropeJobContext): Promise<number[]> {
  const dila = ctx.dila;
  if (ctx.market !== 'EU' || !dila) return [];
  const files = await trackIn(ctx, 'dila', () => dila.list(ctx.today()));
  if (!files) return [];
  const changed: number[] = [];
  for (const file of files) {
    if (signalSeen(ctx.db, 'dila-file', file)) continue;
    const docs = await trackIn(ctx, 'dila', async () => parseDilaArchiveStream(await dila.archive(file)));
    if (!docs) continue;
    const now = ctx.now();
    for (const d of docs) {
      if (signalSeen(ctx.db, 'dila', d.id)) continue;
      const mark = (outcome: SignalOutcome, symbol: string | null = null) => markSignalSeen(ctx.db, 'dila', d.id, symbol, outcome, now);
      if (!isDilaResults(d)) { mark('not-results'); continue; }
      const stock = d.isin
        ? ctx.db.prepare(`SELECT symbol, exchange FROM europe_stocks WHERE market = 'EU' AND active = 1 AND isin = ?`).get(d.isin) as
          { symbol: string; exchange: string } | undefined
        : undefined;
      if (!stock || !(stock.exchange in EXCHANGES)) { mark('no-match'); continue; }
      const day = DateTime.fromISO(d.filedAt, { zone: 'utc' }).setZone(EXCHANGES[stock.exchange as ExchangeId].zone).toISODate()!;
      const row = rowFor(ctx.db, stock.symbol, day, d.filedAt);
      if (!row) { mark('no-row', stock.symbol); continue; }
      if (recordEuropeRelease(ctx.db, row.id, { at: d.filedAt, source: 'dila', timing: null, title: d.title, url: d.url })) changed.push(row.id);
      mark('flipped', stock.symbol);
    }
    markSignalSeen(ctx.db, 'dila-file', file, null, 'done', now);
  }
  return changed;
}
