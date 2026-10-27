import type { DatabaseSync } from 'node:sqlite';
import { createFailover } from './failover.js';
import type { Http } from './http.js';
import { fetchSecFeed, type SecFeedItem } from './secFeed.js';

/** One SEC filing of a full-level foreign stock, as handed to its market. */
export interface ForeignFiling {
  cik: number;
  accession: string;
  indexUrl: string;
  acceptedAt: string; // ISO UTC
  form: string;
}

/** One market the shared 6-K watcher serves (HK, Japan). */
export interface SixKMarket {
  name: 'hk' | 'jp';
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
 * routed to the market whose CIKs hold its index-URL CIK. Domestic filers arrive as 8-K 2.02 items from the US
 * SecWatch through `onUsFeed`. Filings of all markets go through one queue, one at a time; a filing that keeps
 * failing is left to the market's sweep after `MAX_TRIES`.
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

  /** The market whose CIK set holds `cik`. */
  private static route(markets: { market: SixKMarket; ciks: Set<number> }[], cik: number): SixKMarket | undefined {
    return markets.find((m) => m.ciks.has(cik))?.market;
  }

  /** One feed request; new filings of full-level CIKs are handled one at a time, oldest first. Returns changed ids. */
  async tick(): Promise<number[]> {
    const res = await this.failover({ name: 'sec-6k-feed', run: () => fetchSecFeed(this.http, '6-K') }, null);
    if (!res) return [];
    const byMarket = this.markets.map((market) => ({ market, ciks: market.ciks() }));
    const items = res.value
      .map((item) => ({ item, market: SixKWatch.route(byMarket, cikOf(item)) }))
      .filter((x): x is { item: SecFeedItem; market: SixKMarket } =>
        x.market != null && !this.gaveUp.has(x.item.accession) && !x.market.seen(x.item.accession))
      .sort((a, b) => a.item.acceptedAt.localeCompare(b.item.acceptedAt));
    const changed: number[] = [];
    for (const { item, market } of items) for (const id of await this.enqueue(item, market)) if (!changed.includes(id)) changed.push(id);
    return changed;
  }

  /** 8-K items from the US feed (at-least-once delivery): Item 2.02 filings of a market's 8-K CIKs are handled once. */
  onUsFeed(items: SecFeedItem[]): void {
    const byMarket = this.markets.map((market) => ({ market, ciks: market.eightKCiks() }));
    for (const item of items) {
      if (!item.form.startsWith('8-K') || !item.items.includes('2.02')) continue;
      const market = SixKWatch.route(byMarket, cikOf(item));
      if (market) void this.enqueue(item, market);
    }
  }

  /** Filings go through one queue (never two at once); a filing already queued or seen is skipped. */
  private enqueue(item: SecFeedItem, market: SixKMarket): Promise<number[]> {
    if (this.queued.has(item.accession)) return Promise.resolve([]);
    this.queued.add(item.accession);
    const run = this.queue.then(() => this.handle(item, market)).finally(() => this.queued.delete(item.accession));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(item: SecFeedItem, market: SixKMarket): Promise<number[]> {
    if (market.seen(item.accession)) return [];
    const cik = cikOf(item);
    try {
      const ids = [...new Set(await market.handle({ cik, accession: item.accession, indexUrl: item.indexUrl, acceptedAt: item.acceptedAt, form: item.form }))];
      this.tries.delete(item.accession);
      if (ids.length > 0) market.onChanged(ids);
      return ids;
    } catch (err) {
      const n = (this.tries.get(item.accession) ?? 0) + 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (n >= MAX_TRIES) {
        // Not marked seen: the sweep (fetchEarningsFilings) still picks it up.
        this.tries.delete(item.accession);
        this.gaveUp.add(item.accession);
        console.error(`[${market.name}-sec] ${item.accession}: left to the sweep after ${n} tries: ${msg}`);
      } else {
        this.tries.set(item.accession, n);
        console.error(`[${market.name}-sec] ${item.accession} (try ${n}): ${msg}`);
      }
      return [];
    }
  }
}
