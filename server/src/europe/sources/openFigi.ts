/**
 * OpenFIGI mapping: ISIN + exchCode → the exchange's tickers (Ruling 5).
 *
 * Limits: without a key 25 requests per 60 s and 10 jobs per request (verified live, `ratelimit-policy: 25;w=60`), so
 * one request every 2.5 s. With a key, the published limits: 25 requests per 6 s and 100 jobs per request, so one
 * request every 250 ms. An unknown ISIN answers `{ warning }` and a malformed one `{ error }`: both mean no ticker.
 * The key travels only in the `X-OPENFIGI-APIKEY` header; it is never put in a URL, a body, a log or an error.
 *
 * One failed request (5xx, a 429 after its retries, a network error, a malformed answer) loses only its own jobs:
 * they come back `failed: true` with no tickers, and `figiRunComplete` is false, so the caller must not cache them as
 * "no ticker" nor treat the run as complete. A 401/403 (bad key) fails every request alike, so it throws.
 */

import { SourceFormatError } from '../../sources/http.js';
import { UNIVERSE_URLS } from '../exchanges.js';
import { EUROPE_UA } from './sourceUrls.js';

export interface FigiAnswer {
  isin: string;
  exchCode: string;
  /** Distinct tickers OpenFIGI lists for the ISIN on that exchCode (empty on a warning or error). */
  tickers: string[];
  /** The request carrying this job failed: no answer, not "no ticker". */
  failed?: true;
}

/** False when any job's request failed (the run is incomplete). */
export const figiRunComplete = (answers: readonly FigiAnswer[]): boolean => answers.every((a) => !a.failed);

/** A failure that ends the whole run (the key is refused), as opposed to one request's failure. */
class OpenFigiAuthError extends Error {
  constructor(status: number) {
    super(`OpenFIGI HTTP ${status}`);
    this.name = 'OpenFigiAuthError';
  }
}

const KEYLESS = { jobs: 10, gapMs: 2_500 } as const;
const KEYED = { jobs: 100, gapMs: 250 } as const;
/** On a 429, wait out the window and try again, at most this many times per request. */
const MAX_429_RETRIES = 2;

export function createOpenFigi(o: { key?: string; fetchImpl?: typeof fetch; now?: () => number }): {
  map(jobs: { isin: string; exchCode: string }[]): Promise<FigiAnswer[]>;
} {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const limits = o.key ? KEYED : KEYLESS;
  let next = 0;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  async function slot(): Promise<void> {
    const t = now();
    const at = Math.max(t, next);
    next = at + limits.gapMs;
    if (at > t) await sleep(at - t);
  }

  async function post(jobs: { isin: string; exchCode: string }[]): Promise<FigiAnswer[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': EUROPE_UA };
    if (o.key) headers['X-OPENFIGI-APIKEY'] = o.key;
    const body = JSON.stringify(jobs.map((j) => ({ idType: 'ID_ISIN', idValue: j.isin, exchCode: j.exchCode })));
    for (let attempt = 0; ; attempt++) {
      await slot();
      let res: Response;
      try {
        res = await fetchImpl(UNIVERSE_URLS.openFigi, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        // A network error message carries no header values; keep only its name and message.
        throw new Error(`OpenFIGI request failed: ${(err as Error)?.message ?? 'network error'}`);
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        next = Math.max(next, now() + (o.key ? 6_000 : 60_000));
        continue;
      }
      // The status only: the answer body is never echoed into the error.
      if (res.status === 401 || res.status === 403) throw new OpenFigiAuthError(res.status);
      if (!res.ok) throw new Error(`OpenFIGI HTTP ${res.status}`);
      const json: unknown = await res.json();
      if (!Array.isArray(json) || json.length !== jobs.length) throw new SourceFormatError('OpenFIGI: answer does not match the jobs');
      return jobs.map((j, i) => {
        const data = (json[i] as { data?: unknown } | null)?.data;
        const tickers = Array.isArray(data)
          ? [...new Set(data.flatMap((d: { ticker?: unknown; exchCode?: unknown }) =>
            (typeof d?.ticker === 'string' && d.ticker && (d.exchCode == null || d.exchCode === j.exchCode) ? [d.ticker] : [])))]
          : [];
        return { isin: j.isin, exchCode: j.exchCode, tickers };
      });
    }
  }

  return {
    async map(jobs) {
      const out: FigiAnswer[] = [];
      for (let i = 0; i < jobs.length; i += limits.jobs) {
        const batch = jobs.slice(i, i + limits.jobs);
        try {
          out.push(...(await post(batch)));
        } catch (err) {
          if (err instanceof OpenFigiAuthError) throw err;
          console.warn(`openfigi: request for jobs ${i + 1}-${i + batch.length} failed: ${(err as Error).message}`);
          out.push(...batch.map((j): FigiAnswer => ({ isin: j.isin, exchCode: j.exchCode, tickers: [], failed: true })));
        }
      }
      return out;
    },
  };
}
