import type { OptionChain } from '../types.js';

/**
 * Wraps a Cboe chain fetch: an ADR chain (or its absence, `null`) is kept for `ttlMs`, and concurrent calls for
 * one ADR share one request. Cboe answers 429 after about 35 requests a minute from one IP. A thrown error is
 * never cached; calls already waiting on that request get the same error.
 */
export function cachedChains(
  fetch: (adr: string) => Promise<OptionChain | null>,
  o: { ttlMs?: number; now?: () => number } = {},
): (adr: string) => Promise<OptionChain | null> {
  const ttlMs = o.ttlMs ?? 900_000;
  const now = o.now ?? Date.now;
  const done = new Map<string, { at: number; chain: OptionChain | null }>();
  const inflight = new Map<string, Promise<OptionChain | null>>();
  return (adr) => {
    const hit = done.get(adr);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.chain);
    const pending = inflight.get(adr);
    if (pending) return pending;
    const p = fetch(adr).then(
      (chain) => {
        done.set(adr, { at: now(), chain });
        inflight.delete(adr);
        return chain;
      },
      (err) => {
        inflight.delete(adr);
        throw err;
      },
    );
    inflight.set(adr, p);
    return p;
  };
}
