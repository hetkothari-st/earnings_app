import { BlockedError, createFailover, looksBlocked } from '../../sources/failover.js';
import { HttpError, type Http } from '../../sources/http.js';
import { handleAnnouncements } from '../jobs/results.js';
import type { InJobContext } from '../jobs/context.js';
import { getFoCache } from '../jobs/stocks.js';
import { fetchNseRss, type RssItem } from '../sources/nseRss.js';

const SOURCE = 'nse-announcements-fast';

/**
 * Polls NSE's Online_announcements feed every few seconds and flips India reports to released the
 * moment a results announcement appears. The 1-minute india-results job stays as the backup path.
 */
export class NseWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly failover: ReturnType<typeof createFailover>;

  constructor(
    private readonly ctx: InJobContext,
    private readonly onReleased: (ids: number[]) => void,
    private readonly reader?: (pdfUrl: string, reportId: number) => Promise<void>,
  ) {
    this.failover = createFailover(ctx.db, () => Date.parse(ctx.now()));
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // never overlap
      this.running = true;
      this.tick().catch((err) => console.error(`[nse-watch] ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number[]> {
    if (!getFoCache()) return []; // F&O list not loaded yet
    const res = await this.failover({ name: SOURCE, run: () => this.fetchFeed() }, null);
    if (!res) return [];
    const flipped: { pdfUrl: string; id: number }[] = [];
    const changed = handleAnnouncements(this.ctx, res.value, (item, id) => {
      if (/\.pdf$/i.test(item.link)) flipped.push({ pdfUrl: item.link, id });
    });
    if (changed.length === 0) return [];
    this.onReleased(changed);
    if (this.reader) for (const f of flipped) void this.read(f.pdfUrl, f.id);
    return changed;
  }

  /** The feed fetch; a refusal (403/429 or a block page served as 200) becomes a BlockedError. */
  private async fetchFeed(): Promise<RssItem[]> {
    const inner = this.ctx.http;
    const http: Http = {
      json: (url) => inner.json(url),
      text: async (url) => {
        let body: string;
        try {
          body = await inner.text(url);
        } catch (err) {
          if (err instanceof HttpError && looksBlocked(err.status, '')) throw new BlockedError(SOURCE, `HTTP ${err.status}`);
          throw err;
        }
        if (looksBlocked(200, body)) throw new BlockedError(SOURCE, 'block page instead of RSS');
        return body;
      },
    };
    return fetchNseRss(http, 'Online_announcements');
  }

  /** Never blocks or throws into the tick. */
  private async read(pdfUrl: string, id: number): Promise<void> {
    try {
      await this.reader!(pdfUrl, id);
    } catch (err) {
      console.error(`[nse-watch] reader for report ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
