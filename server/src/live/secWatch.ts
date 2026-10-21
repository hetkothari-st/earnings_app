import { DateTime } from 'luxon';
import { hasReleasedNear, markReleased, reportForRelease } from '../db/repo.js';
import { ET } from '../domain/marketCalendar.js';
import type { JobContext } from '../jobs/context.js';
import { createFailover } from '../sources/failover.js';
import type { Http } from '../sources/http.js';
import { fetchSecFeed, parseFilingIndex } from '../sources/secFeed.js';
import type { SecFeedItem } from '../sources/secFeed.js';

const SEEN_LIMIT = 5000;

/** Polls the SEC "current 8-K" feed and flips US reports to released the moment their Item 2.02 filing appears. */
export class SecWatch {
  private seen = new Set<string>();
  private byCik: { day: string; map: Map<number, string[]> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly failover: ReturnType<typeof createFailover>;

  constructor(
    private readonly ctx: JobContext,
    private http: Http,
    private readonly onReleased: (ids: number[]) => void,
    private readonly reader?: (exhibitUrl: string, reportId: number) => Promise<void>,
  ) {
    this.failover = createFailover(ctx.db, () => Date.parse(ctx.now()));
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // never overlap
      this.running = true;
      this.tick().catch((err) => console.error(`[sec-feed] ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number[]> {
    const res = await this.failover({ name: 'sec-feed', run: () => fetchSecFeed(this.http) }, null);
    if (!res) return [];
    const fresh = res.value.filter((i) => !this.seen.has(i.accession));
    const targets = fresh.filter((i) => i.items.includes('2.02'));
    // Only mark accessions seen once handled, so a transient failure below retries them next tick.
    const markSeen = () => { for (const i of fresh) this.seen.add(i.accession); this.trimSeen(); };
    if (targets.length === 0) { markSeen(); return []; }
    const byCik = await this.cikMap();

    const changed: number[] = [];
    const reads: { url: string; id: number; indexUrl: string }[] = [];
    // Oldest first, so the earliest filing of a report is the one that sticks.
    for (const item of [...targets].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))) {
      const cik = cikOf(item);
      const etDate = DateTime.fromISO(item.acceptedAt, { zone: 'utc' }).setZone(ET).toISODate()!;
      for (const key of byCik.get(cik) ?? []) {
        const hit = reportForRelease(this.ctx.db, key, etDate);
        if (!hit) {
          if (!hasReleasedNear(this.ctx.db, key, etDate)) console.log(`[sec-feed] ${key}: 2.02 filing ${item.accession} matches no report within 3 days`);
          continue;
        }
        if (markReleased(this.ctx.db, hit.id, item.acceptedAt, 'sec-8k')) {
          if (!changed.includes(hit.id)) changed.push(hit.id);
          reads.push({ url: item.indexUrl, id: hit.id, indexUrl: item.indexUrl });
        }
      }
    }
    markSeen();
    if (changed.length > 0) this.onReleased(changed);
    if (this.reader) for (const r of reads) void this.read(r.indexUrl, r.id);
    return changed;
  }

  /** Fetch the filing index and hand the press release to the reader. Never blocks or throws into the tick. */
  private async read(indexUrl: string, id: number): Promise<void> {
    try {
      const { exhibit991Url } = parseFilingIndex(await this.http.text(indexUrl), indexUrl);
      if (exhibit991Url) await this.reader!(exhibit991Url, id);
    } catch (err) {
      console.error(`[sec-feed] reader for report ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cikMap(): Promise<Map<number, string[]>> {
    const day = this.ctx.today();
    if (this.byCik?.day === day) return this.byCik.map;
    const map = new Map<number, string[]>();
    for (const [key, t] of await this.ctx.sources.secTickers()) {
      const list = map.get(t.cik);
      if (list) list.push(key); else map.set(t.cik, [key]);
    }
    this.byCik = { day, map };
    return map;
  }

  private trimSeen(): void {
    if (this.seen.size <= SEEN_LIMIT) return;
    const drop = this.seen.size - SEEN_LIMIT;
    let n = 0;
    for (const a of this.seen) { if (n++ >= drop) break; this.seen.delete(a); }
  }
}

/** The title CIK can be wrong (first parenthesised digits); the index URL's CIK is authoritative. */
function cikOf(item: SecFeedItem): number {
  const fromUrl = item.indexUrl.match(/\/edgar\/data\/(\d+)\//)?.[1];
  return fromUrl ? Number(fromUrl) : item.cik;
}
