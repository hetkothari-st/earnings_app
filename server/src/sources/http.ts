export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** The source answered, but not in the shape we know. Never store anything from it. */
export class SourceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFormatError';
  }
}

export interface Http {
  json(url: string): Promise<unknown>;
  text(url: string): Promise<string>;
}

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class RateLimiter {
  private next = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.minIntervalMs;
    if (slot > now) await sleep(slot - now);
  }
}

export function makeHttp(opts: {
  headers?: Record<string, string>;
  minIntervalMs: number;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  /** A limiter shared with other clients (e.g. the cross-market Yahoo budget) instead of one per client. */
  limiter?: { wait(): Promise<void> };
}): Http {
  const { headers = {}, minIntervalMs, timeoutMs = 20_000, retries = 2, backoffMs = 2_000, fetchImpl = fetch } = opts;
  const limiter = opts.limiter ?? new RateLimiter(minIntervalMs);

  async function get(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await limiter.wait();
      try {
        const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        if (attempt >= retries) throw err;
      }
      await sleep(backoffMs * (attempt + 1));
    }
  }

  return {
    json: async (url) => (await get(url)).json(),
    text: async (url) => (await get(url)).text(),
  };
}
