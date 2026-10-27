import { BROWSER_UA, type Http, HttpError } from './http.js';
import { openYahooSession } from './yahooEarnings.js';
import { createSlotLimiter, type SlotLimiter } from './yahooLimiter.js';

/** Yahoo Finance with one session (cookie + crumb) and one rate limit shared by GET and POST. */
export interface YahooClient extends Http {
  postJson(url: string, body: unknown): Promise<unknown>;
}

type Session = { crumb: string; headers: Record<string, string> };

const TIMEOUT_MS = 20_000;

/**
 * One Yahoo client: the session is opened on first use, reused, and renewed once when Yahoo answers
 * 401/403. The crumb is appended to every URL; every request (GET and POST together) waits for one
 * limiter slot, at most one per `minIntervalMs` (default 1 s), or one of `limiter` when given (a budget shared
 * with other Yahoo callers). Opening the session (fc.yahoo.com and
 * getcrumb) is not counted by the limiter; it happens once and again only on renewal.
 * Errors name the URL as given by the caller, never the crumb.
 */
export function createYahooClient(o: {
  minIntervalMs?: number;
  session?: () => Promise<Session>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  limiter?: SlotLimiter;
} = {}): YahooClient {
  const minIntervalMs = o.minIntervalMs ?? 1000;
  const open = o.session ?? openYahooSession;
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;

  let session: Promise<Session> | null = null;
  const limiter = o.limiter ?? createSlotLimiter(minIntervalMs, now);
  const waitSlot = (): Promise<void> => limiter.wait();

  const withCrumb = (url: string, crumb: string): string =>
    `${url}${url.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(crumb)}`;

  async function request(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const current = (session ??= open());
      let s: Session;
      try {
        s = await current;
      } catch (err) {
        if (session === current) session = null;
        throw err;
      }
      await waitSlot();
      let res: Response;
      try {
        res = await doFetch(withCrumb(url, s.crumb), {
          method: init.method,
          headers: {
            'User-Agent': BROWSER_UA,
            ...s.headers,
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Network errors and timeouts: say which URL, never repeat the underlying text (it may hold the crumb).
        const name = err instanceof Error ? err.name : 'Error';
        throw new Error(`Yahoo request failed (${name}) for ${url}`);
      }
      if (res.ok) return res;
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        if (session === current) session = null;
        continue;
      }
      throw new HttpError(res.status, url);
    }
  }

  return {
    json: async (url) => (await request(url, { method: 'GET' })).json(),
    text: async (url) => (await request(url, { method: 'GET' })).text(),
    postJson: async (url, body) => (await request(url, { method: 'POST', body: JSON.stringify(body) })).json(),
  };
}
