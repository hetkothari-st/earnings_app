import type { Http } from '../../sources/http.js';
import type { SlotLimiter } from '../../sources/yahooLimiter.js';
import { listDilaFiles } from '../sources/dila.js';
import type { FirdsShare } from '../sources/firds.js';
import { parseSixList } from '../sources/sixList.js';
import { DILA_BASE, EUROPE_UA } from '../sources/sourceUrls.js';
import type { EuropeJobContext, EuropeUniverseSources } from './context.js';

/** A complete FIRDS read and a parseable SIX list are reused for this long, then evicted. */
export const UNIVERSE_REUSE_MS = 6 * 3_600_000;

/**
 * The universe sources with reuse: both markets' builds read the same FIRDS sets and SIX list (the UK-first tie-break
 * needs every line), so a complete FIRDS read and a SIX list that parses to at least one share are kept for 6 h and
 * then dropped from memory (the UK and EU weekly runs download them once). An incomplete FIRDS read or an
 * unparseable SIX list is never kept.
 */
export function reusedUniverseSources(
  src: EuropeUniverseSources,
  o: { now?: () => number; ttlMs?: number; evict?: (fn: () => void, ms: number) => void } = {},
): EuropeUniverseSources {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? UNIVERSE_REUSE_MS;
  const evict = o.evict ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const firds = new Map<string, { at: number; shares: FirdsShare[]; files: number }>();
  let six: { at: number; text: string } | null = null;
  return {
    ...src,
    async firds(source, mics, onShare) {
      const key = `${source}:${[...mics].sort().join(',')}`;
      const hit = firds.get(key);
      if (hit && now() - hit.at < ttl) {
        for (const s of hit.shares) onShare(s);
        return { files: hit.files, complete: true };
      }
      firds.delete(key);
      const shares: FirdsShare[] = [];
      const r = await src.firds(source, mics, (s) => { shares.push(s); onShare(s); });
      if (r.complete) {
        const entry = { at: now(), shares, files: r.files };
        firds.set(key, entry);
        evict(() => { if (firds.get(key) === entry) firds.delete(key); }, ttl);
      }
      return r;
    },
    async sixList() {
      if (six && now() - six.at < ttl) return six.text;
      six = null;
      const text = await src.sixList();
      let ok = false;
      try { ok = parseSixList(text).length > 0; } catch { ok = false; }
      if (ok) {
        const entry = { at: now(), text };
        six = entry;
        evict(() => { if (six === entry) six = null; }, ttl);
      }
      return text;
    },
  };
}

/**
 * DILA AMF (EU only): the day's batch names from the `DILA_BASE` listing, and one batch as the fetch body stream
 * (never buffered: a results-season batch is 200-660 MB of gzip). Both requests wait on `limiter`, the 1 s budget
 * shared with the other non-SEC, non-Yahoo Europe requests.
 */
export function createDilaClient(o: {
  http: Http; limiter: SlotLimiter; fetchImpl?: typeof fetch; timeoutMs?: number;
}): NonNullable<EuropeJobContext['dila']> {
  const doFetch = o.fetchImpl ?? fetch;
  return {
    list: async (day) => listDilaFiles(await o.http.text(DILA_BASE), day),
    archive: async (name) => {
      if (!/^amf-gz_\d{8}_\d{4}\.tar\.gz$/.test(name)) throw new Error(`unexpected DILA batch name ${name}`);
      await o.limiter.wait();
      const res = await doFetch(`${DILA_BASE}${name}`, {
        headers: { 'User-Agent': EUROPE_UA }, signal: AbortSignal.timeout(o.timeoutMs ?? 30 * 60_000),
      });
      if (!res.ok || !res.body) throw new Error(`DILA ${name}: HTTP ${res.status}`);
      return res.body as unknown as AsyncIterable<Uint8Array>;
    },
  };
}
