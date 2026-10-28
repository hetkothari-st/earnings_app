import type { DatabaseSync } from 'node:sqlite';
import { createFailover } from './failover.js';
import type { Http } from './http.js';
import { fetchSecFeed, type SecFeedItem } from './secFeed.js';
import type { SixKSession } from './sixKClassify.js';

/** One SEC filing of a full-level foreign stock, as handed to its market. */
export interface ForeignFiling {
  cik: number;
  accession: string;
  indexUrl: string;
  acceptedAt: string; // ISO UTC
  form: string;
  /**
   * The CIK's exchange session in this market, from `SixKMarket.sessionFor` (null: unknown). Absent for a market
   * without `sessionFor` (HK, Japan).
   */
  session?: SixKSession | null;
}

/** One market the shared 6-K watcher serves (HK, Japan, UK, Europe). */
export interface SixKMarket {
  name: 'hk' | 'jp' | 'uk' | 'eu';
  /** Full-level CIKs whose 6-Ks this market handles. */
  ciks(): Set<number>;
  /** Domestic filers whose 8-K Item 2.02 filings (from the US feed) this market handles. */
  eightKCiks(): Set<number>;
  /** True while a full-level report is due (local today-1..+3, unreleased): the feed then runs fast. */
  due(): boolean;
  seen(accession: string): boolean;
  /** Handles one filing; returns the changed report ids. Fetch errors throw (the watcher retries). */
  handle(f: ForeignFiling): Promise<number[]>;
  onChanged(ids: number[]): void;
  /** UK / Europe: the trading session of the CIK's stock in this market, handed on as `ForeignFiling.session`. */
  sessionFor?(cik: number): SixKSession | null;
}

/** The feed every 2 s while any market has a full-level report due, else every 30 s. */
const FAST_MS = 2_000;
const SLOW_MS = 30_000;
/** A filing whose documents keep failing is left to the per-CIK sweep after this many tries. */
const MAX_TRIES = 10;

/** The title CIK can be wrong (first parenthesised digits); the index URL's CIK is authoritative (as in SecWatch). */
export function cikOf(item: SecFeedItem): number {
  const fromUrl = item.indexUrl.match(/\/edgar\/data\/(\d+)\//)?.[1];
  return fromUrl ? Number(fromUrl) : item.cik;
}

/**
 * Watches the SEC "current 6-K" feed for every foreign market at once: one feed request per tick, each fresh item
 * routed to every market whose CIKs hold its index-URL CIK (HSBC is both HK and UK). Domestic filers arrive as 8-K
 * 2.02 items from the US SecWatch through `onUsFeed`, fanned out the same way. Filings of all markets go through one
 * queue, one (market, filing) job at a time; a job that keeps failing is left to that market's sweep after
 * `MAX_TRIES`. Jobs are keyed `${market.name}:${accession}`, so one market's failure or "seen" never affects another.
 */
export class SixKWatch {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly queued = new Set<string>();
  private readonly tries = new Map<string, number>();
  private readonly gaveUp = new Set<string>();
  private readonly failover: ReturnType<typeof createFailover>;

  constructor(
    private readonly markets: SixKMarket[],
    private readonly http: Http,
    base: { db: DatabaseSync; now(): string },
  ) {
    this.failover = createFailover(base.db, () => Date.parse(base.now()));
  }

  /** Self-rescheduling: the delay is re-chosen after every tick. */
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

  /** 2 s while any market has a full-level report due, else 30 s. */
  intervalMs(): number {
    return this.markets.some((m) => m.due()) ? FAST_MS : SLOW_MS;
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

  /** Every market whose CIK set holds `cik`, in the watcher's market order. */
  private static routeAll(markets: { market: SixKMarket; ciks: Set<number> }[], cik: number): SixKMarket[] {
    return markets.filter((m) => m.ciks.has(cik)).map((m) => m.market);
  }

  private static key(market: SixKMarket, accession: string): string {
    return `${market.name}:${accession}`;
  }

  /** One feed request; new filings of full-level CIKs are handled one at a time, oldest first. Returns changed ids. */
  async tick(): Promise<number[]> {
    const res = await this.failover({ name: 'sec-6k-feed', run: () => fetchSecFeed(this.http, '6-K') }, null);
    if (!res) return [];
    const byMarket = this.markets.map((market) => ({ market, ciks: market.ciks() }));
    const items = res.value
      .flatMap((item) => SixKWatch.routeAll(byMarket, cikOf(item)).map((market) => ({ item, market })))
      .filter((x) => !this.gaveUp.has(SixKWatch.key(x.market, x.item.accession)) && !x.market.seen(x.item.accession))
      .sort((a, b) => a.item.acceptedAt.localeCompare(b.item.acceptedAt));
    const changed: number[] = [];
    for (const { item, market } of items) for (const id of await this.enqueue(item, market)) if (!changed.includes(id)) changed.push(id);
    return changed;
  }

  /** 8-K items from the US feed (at-least-once delivery): Item 2.02 filings of a market's 8-K CIKs are handled once per market. */
  onUsFeed(items: SecFeedItem[]): void {
    const byMarket = this.markets.map((market) => ({ market, ciks: market.eightKCiks() }));
    for (const item of items) {
      if (!item.form.startsWith('8-K') || !item.items.includes('2.02')) continue;
      for (const market of SixKWatch.routeAll(byMarket, cikOf(item))) void this.enqueue(item, market);
    }
  }

  /** Jobs go through one queue (never two at once); a (market, filing) job already queued or seen is skipped. */
  private enqueue(item: SecFeedItem, market: SixKMarket): Promise<number[]> {
    const key = SixKWatch.key(market, item.accession);
    if (this.queued.has(key)) return Promise.resolve([]);
    this.queued.add(key);
    const run = this.queue.then(() => this.handle(item, market)).finally(() => this.queued.delete(key));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(item: SecFeedItem, market: SixKMarket): Promise<number[]> {
    if (market.seen(item.accession)) return [];
    const cik = cikOf(item);
    const key = SixKWatch.key(market, item.accession);
    try {
      const filing: ForeignFiling = { cik, accession: item.accession, indexUrl: item.indexUrl, acceptedAt: item.acceptedAt, form: item.form };
      // Each market times the release against its own session for the CIK (HSBC: HKEX for HK, LSE for UK).
      if (market.sessionFor) filing.session = market.sessionFor(cik);
      const ids = [...new Set(await market.handle(filing))];
      this.tries.delete(key);
      if (ids.length > 0) market.onChanged(ids);
      return ids;
    } catch (err) {
      const n = (this.tries.get(key) ?? 0) + 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (n >= MAX_TRIES) {
        // Not marked seen: the sweep (fetchEarningsFilings) still picks it up.
        this.tries.delete(key);
        this.gaveUp.add(key);
        console.error(`[${market.name}-sec] ${item.accession}: left to the sweep after ${n} tries: ${msg}`);
      } else {
        this.tries.set(key, n);
        console.error(`[${market.name}-sec] ${item.accession} (try ${n}): ${msg}`);
      }
      return [];
    }
  }
}
