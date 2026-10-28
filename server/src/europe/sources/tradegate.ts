import { createSlotLimiter, type SlotLimiter } from '../../sources/yahooLimiter.js';
import { robotsAllows } from './robots.js';
import { EUROPE_UA, TRADEGATE_REFRESH, TRADEGATE_ROBOTS } from './sourceUrls.js';

/**
 * Tradegate real-time quotes (`/refresh.php` only; the `/json/` path is never used). Formats and the `close`
 * semantics are in the sourceUrls.ts header: prices are JSON numbers or German strings ("213,10") in one answer,
 * `close` is the previous close and rolls once a day, so the change is computed only from one answer's values.
 */

export interface TradegateQuote {
  isin: string;
  last: number | null;
  close: number | null;
  bid: number | null;
  ask: number | null;
  /** Percent, (last - close) / close * 100, from this one answer; null unless both are numbers and close > 0. */
  changePct: number | null;
  /** Fetch time, ISO. */
  at: string;
}

export type TradegateState = 'on' | 'off-env' | 'off-robots' | 'backoff';

const BACKOFF_MS = 3_600_000;
const TIMEOUT_MS = 15_000;

/** A JSON number, or a German-format string ("213,10", "1.234,56"); anything else is null. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function parseTradegate(json: unknown, isin: string, at: string): TradegateQuote | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const last = num(o['last']);
  const close = num(o['close']);
  if (last === null && close === null) return null;
  const changePct = last !== null && close !== null && close > 0 ? ((last - close) / close) * 100 : null;
  return { isin, last, close, bid: num(o['bid']), ask: num(o['ask']), changePct, at };
}

/** One limiter for the whole process, so every Tradegate caller shares the 1 request/s budget. */
const processLimiter: SlotLimiter = createSlotLimiter(1000);

export function createTradegate(o: {
  enabled: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  limiter?: SlotLimiter;
}): {
  quote(isin: string): Promise<TradegateQuote | null>;
  checkRobots(): Promise<void>;
  state(): TradegateState;
  backoffUntil(): string | null;
  lastPollAt(): string | null;
} {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const limiter = o.limiter ?? processLimiter;
  const headers = { 'User-Agent': EUROPE_UA, Accept: 'application/json' };

  let backoffEnd = 0;
  /** Fail-closed: null (never checked) behaves as disallowed until a check has passed. */
  let robotsOk: boolean | null = null;
  let lastPoll: string | null = null;

  const inBackoff = (): boolean => now() < backoffEnd;
  const startBackoff = (): void => {
    backoffEnd = now() + BACKOFF_MS;
  };
  const isBlock = (status: number): boolean => status === 429 || status === 403;

  async function get(url: string, gated: boolean): Promise<Response | null> {
    await limiter.wait();
    // a sibling queued ahead of us may have been told to back off while we waited for our slot
    if (gated && (robotsOk !== true || inBackoff())) return null;
    try {
      return await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return null;
    }
  }

  return {
    async quote(isin) {
      if (!o.enabled || robotsOk !== true || inBackoff()) return null;
      const res = await get(`${TRADEGATE_REFRESH}?isin=${encodeURIComponent(isin)}`, true);
      if (!res) return null;
      if (isBlock(res.status)) {
        startBackoff();
        return null;
      }
      if (!res.ok) return null;
      const at = new Date(now()).toISOString();
      let body: string;
      try {
        body = await res.text();
      } catch {
        return null;
      }
      if (body.trim() === '') return null; // an unknown ISIN: Tradegate does not quote it
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return null;
      }
      lastPoll = at;
      return parseTradegate(json, isin, at);
    },

    async checkRobots() {
      if (!o.enabled || inBackoff()) return;
      const res = await get(TRADEGATE_ROBOTS, false);
      if (res && isBlock(res.status)) {
        startBackoff();
        if (robotsOk === null) robotsOk = false;
        return;
      }
      if (!res || !res.ok) {
        // a failed fetch keeps the previous verdict; with none yet, stay off
        if (robotsOk === null) robotsOk = false;
        return;
      }
      try {
        robotsOk = robotsAllows(await res.text(), '/refresh.php', EUROPE_UA);
      } catch {
        if (robotsOk === null) robotsOk = false;
      }
    },

    state() {
      if (!o.enabled) return 'off-env';
      if (robotsOk !== true) return 'off-robots'; // includes never checked
      if (inBackoff()) return 'backoff';
      return 'on';
    },

    backoffUntil() {
      return inBackoff() ? new Date(backoffEnd).toISOString() : null;
    },

    lastPollAt() {
      return lastPoll;
    },
  };
}
