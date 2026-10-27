import type { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
import { firstUsSessionAfterRelease, lastUsCloseBefore } from '../domain/adrSessions.js';
import type { LocalTiming } from '../domain/exchangeCalendar.js';
import { computeExpectedMove } from '../domain/expectedMove.js';
import { ET, todayET } from '../domain/marketCalendar.js';
import type { ExpectedMove, OptionChain } from '../types.js';

/** A full-level report with an ADR, not yet released, with no actual and no final snapshot. */
export interface AdrMoveRow {
  id: number;
  /** Local (HK / Tokyo) report date. */
  reportDate: string;
  timing: LocalTiming;
  releasedAt: string | null;
  adr: string;
}

/** What the shared ADR expected-move jobs need from one market (HK, Japan). */
export interface AdrMovesDeps {
  db: DatabaseSync;
  now(): string;                               // ISO UTC instant
  /** YYYY-MM-DD in the market's time zone. */
  todayLocal(): string;
  addDays(date: string, n: number): string;
  /** The ADR's option chain; null when blocked or failed (stored values are kept). The caller guards it. */
  optionChain(adr: string): Promise<OptionChain | null>;
  /** Candidate rows (see AdrMoveRow) dated in [from, to]. */
  candidates(from: string, to: string): AdrMoveRow[];
  stored(id: number): { quoteDate: string; final: boolean } | null;
  saveExpected(id: number, em: ExpectedMove & { adr: string; quoteDate: string }, final: boolean, now: string): boolean;
  saveLive(id: number, m: { movePct: number; illiquid: boolean; quoteTime: string | null }, now: string): boolean;
}

/** Candidates dated in [today, today+7] (local). */
const candidates = (d: AdrMovesDeps): AdrMoveRow[] => {
  const today = d.todayLocal();
  return d.candidates(today, d.addDays(today, 7));
};

/** One chain per ADR per run. */
function chainLoader(d: AdrMovesDeps) {
  const chains = new Map<string, Promise<OptionChain | null>>();
  return (adr: string) => {
    if (!chains.has(adr)) chains.set(adr, d.optionChain(adr));
    return chains.get(adr)!;
  };
}

/** Ruling 6: the straddle of the first expiry on or after the first US session that can react to the release. */
const moveFor = (chain: OptionChain, r: AdrMoveRow): ExpectedMove | null =>
  computeExpectedMove(chain, firstUsSessionAfterRelease(r.reportDate, r.timing, r.releasedAt), 'BMO');

/** True when the quotes were taken after the regular US close of their date (16:00 ET); else they may be intraday. */
function afterUsClose(chain: OptionChain, now: string): boolean {
  const day = chain.asOfDate!;
  if (chain.quoteTime) return chain.quoteTime >= `${day}T16:00:00`;
  return DateTime.fromISO(now).setZone(ET) >= DateTime.fromISO(`${day}T16:15:00`, { zone: ET });
}

/**
 * Expected-move snapshot from the ADR's option chain. Quotes dated after the last US close before the local date
 * already price in the release and are never used. Final when the quotes are from exactly that close.
 */
export async function snapshotAdrMoves(d: AdrMovesDeps): Promise<number[]> {
  const load = chainLoader(d);
  const now = d.now();
  const changed: number[] = [];
  for (const r of candidates(d)) {
    const chain = await load(r.adr);
    const lastClose = lastUsCloseBefore(r.reportDate);
    if (!chain?.asOfDate || chain.asOfDate > lastClose) continue;
    // Final only from the full last-close session: an intraday quote on that day stays provisional.
    const final = chain.asOfDate === lastClose && afterUsClose(chain, now);
    const stored = d.stored(r.id);
    // Nothing newer than what we have (a same-day quote only upgrades provisional to final).
    if (stored && (chain.asOfDate < stored.quoteDate || (chain.asOfDate === stored.quoteDate && !(final && !stored.final)))) continue;
    const em = moveFor(chain, r);
    if (!em) continue;
    if (d.saveExpected(r.id, { ...em, adr: r.adr, quoteDate: chain.asOfDate }, final, now)) changed.push(r.id);
  }
  return changed;
}

/** Live move (the US session before the local release is today in ET): same computation on the current quotes. */
export async function refreshAdrLiveMoves(d: AdrMovesDeps): Promise<number[]> {
  const usToday = todayET(new Date(d.now()));
  const load = chainLoader(d);
  const now = d.now();
  const changed: number[] = [];
  for (const r of candidates(d).filter((c) => lastUsCloseBefore(c.reportDate) === usToday)) {
    const chain = await load(r.adr);
    const em = chain && moveFor(chain, r);
    if (!chain || !em) continue;
    if (d.saveLive(r.id, { movePct: em.movePct, illiquid: em.illiquid, quoteTime: chain.quoteTime ?? null }, now)) changed.push(r.id);
  }
  return changed;
}
