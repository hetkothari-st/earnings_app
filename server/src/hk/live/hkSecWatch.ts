import { DateTime } from 'luxon';
import { config } from '../../config.js';
import { createFailover } from '../../sources/failover.js';
import type { Http } from '../../sources/http.js';
import { fetchSecFeed, parseFilingDocs, type SecFeedItem } from '../../sources/secFeed.js';
import {
  findHkReportId, getHkReport, hkReportsBetween, hkStocks, markSecSeen, mergeHkActuals, moveHkReportDate, nearestUnreleasedHk,
  recordHkRelease, secSeen, upsertHkCalendarRow, type HkStock,
} from '../db/hkRepo.js';
import { addDaysHKT, HKT, hkTimingFromAcceptance } from '../domain/hkCalendar.js';
import { hkPeriodFor, hkPeriodLabel } from '../domain/period.js';
import type { HkJobContext } from '../jobs/context.js';
import { readHkRelease } from '../sources/releaseHk.js';
import { classifyHkExhibit, pickReleaseDoc } from '../sources/sixK.js';

export interface HkFiling {
  cik: number;
  accession: string;
  indexUrl: string;
  acceptedAt: string; // ISO UTC
  form: string;
}

/** Ruling 11: the 6-K feed every 2 s while a full-level report is due (HK today-1..+3, unreleased), else every 30 s. */
const FAST_MS = 2_000;
const SLOW_MS = 30_000;
/** A filing whose documents keep failing is left to the 30-minute sweep after this many tries. */
const MAX_TRIES = 10;
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
 *   ±3 days of the acceptance's HKT date moves to that date. Acceptance proves BMO at most (Review Focus 3).
 *   Actuals are written only for the fields whose reader gate is open.
 * - Date notice: confirms the date of the period it announces, with the stated timing.
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
  const ex = classifyHkExhibit(html);
  const hktDate = DateTime.fromISO(f.acceptedAt, { zone: 'utc' }).setZone(HKT).toISODate()!;

  if (ex.kind === 'results') {
    let id = findHkReportId(ctx.db, stock.code, ex.periodEnd);
    if (id == null) {
      const near = nearestUnreleasedHk(ctx.db, stock.code, hktDate, MOVE_WINDOW_DAYS);
      if (near && near.periodEnd === ex.periodEnd) id = near.id;
      else console.log(`[hk-sec] ${stock.code}: ${f.form} ${f.accession} is results for ${ex.periodEnd}, no row with that period end`);
    }
    if (id != null) {
      const rep = getHkReport(ctx.db, id)!;
      const unreleased = rep.releasedAt == null && rep.epsActual == null;
      if (unreleased && rep.reportDate !== hktDate && daysApart(rep.reportDate, hktDate) <= MOVE_WINDOW_DAYS) moveHkReportDate(ctx.db, id, hktDate);
      const reportDate = getHkReport(ctx.db, id)!.reportDate;
      const source = f.form.startsWith('8-K') ? 'sec-8k' : 'sec-6k';
      let changed = recordHkRelease(ctx.db, id, f.acceptedAt, source, hkTimingFromAcceptance(reportDate, f.acceptedAt));
      if (gates.hkEps || gates.hkRevenue) {
        const v = readHkRelease(html, { periodEnd: rep.periodEnd, kind: rep.periodKind });
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
  } else if (ex.kind === 'date-notice') {
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

/** The title CIK can be wrong (first parenthesised digits); the index URL's CIK is authoritative (as in SecWatch). */
function cikOf(item: SecFeedItem): number {
  const fromUrl = item.indexUrl.match(/\/edgar\/data\/(\d+)\//)?.[1];
  return fromUrl ? Number(fromUrl) : item.cik;
}

/**
 * Watches the SEC "current 6-K" feed for full-level HK stocks and flips their reports the moment a results 6-K is
 * accepted; date notices confirm dates. Domestic filers (YUMC, ONC) arrive as 8-K 2.02 items from the US SecWatch
 * through `onUsFeed`. Filings are handled one at a time; `onReleased` gets the released and re-dated ids.
 */
export class HkSecWatch {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly queued = new Set<string>();
  private readonly tries = new Map<string, number>();
  private readonly gaveUp = new Set<string>();
  private readonly failover: ReturnType<typeof createFailover>;

  constructor(
    private readonly ctx: HkJobContext,
    private readonly http: Http,
    private readonly onReleased: (ids: number[]) => void,
  ) {
    this.failover = createFailover(ctx.db, () => Date.parse(ctx.now()));
  }

  /** Self-rescheduling: the delay is re-chosen after every tick (Ruling 11). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 2 s while a full-level report is due between HK today-1 and today+3 and unreleased, else 30 s. */
  intervalMs(): number {
    const today = this.ctx.todayHKT();
    const due = hkReportsBetween(this.ctx.db, addDaysHKT(today, -1), addDaysHKT(today, 3))
      .some((r) => r.level === 'full' && !r.releasedAt && !r.hasActual);
    return due ? FAST_MS : SLOW_MS;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => console.error(`[sec-6k-feed] ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.schedule());
    }, this.intervalMs());
    this.timer.unref?.();
  }

  /** One feed request; new filings of full-level CIKs are handled one at a time, oldest first. Returns changed ids. */
  async tick(): Promise<number[]> {
    const res = await this.failover({ name: 'sec-6k-feed', run: () => fetchSecFeed(this.http, '6-K') }, null);
    if (!res) return [];
    const byCik = fullLevelByCik(this.ctx);
    const items = res.value
      .filter((i) => byCik.has(cikOf(i)) && !this.gaveUp.has(i.accession) && !secSeen(this.ctx.db, i.accession))
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    const changed: number[] = [];
    for (const item of items) for (const id of await this.enqueue(item)) if (!changed.includes(id)) changed.push(id);
    return changed;
  }

  /** 8-K items from the US feed (at-least-once delivery): Item 2.02 filings of full-level CIKs are handled once. */
  onUsFeed(items: SecFeedItem[]): void {
    const byCik = fullLevelByCik(this.ctx);
    for (const item of items) {
      if (!item.form.startsWith('8-K') || !item.items.includes('2.02') || !byCik.has(cikOf(item))) continue;
      void this.enqueue(item);
    }
  }

  /** Filings go through one queue (never two at once); a filing already queued or seen is skipped. */
  private enqueue(item: SecFeedItem): Promise<number[]> {
    if (this.queued.has(item.accession)) return Promise.resolve([]);
    this.queued.add(item.accession);
    const run = this.queue.then(() => this.handle(item)).finally(() => this.queued.delete(item.accession));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(item: SecFeedItem): Promise<number[]> {
    if (secSeen(this.ctx.db, item.accession)) return [];
    const cik = cikOf(item);
    try {
      const r = await handleHkFiling(this.ctx, { cik, accession: item.accession, indexUrl: item.indexUrl, acceptedAt: item.acceptedAt, form: item.form });
      this.tries.delete(item.accession);
      const ids = [...new Set([...r.released, ...r.dated])];
      if (ids.length > 0) this.onReleased(ids);
      return ids;
    } catch (err) {
      const n = (this.tries.get(item.accession) ?? 0) + 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (n >= MAX_TRIES) {
        // Not marked seen: the sweep (fetchEarningsFilings) still picks it up.
        this.tries.delete(item.accession);
        this.gaveUp.add(item.accession);
        console.error(`[hk-sec] ${item.accession}: left to the sweep after ${n} tries: ${msg}`);
      } else {
        this.tries.set(item.accession, n);
        console.error(`[hk-sec] ${item.accession} (try ${n}): ${msg}`);
      }
      return [];
    }
  }
}
