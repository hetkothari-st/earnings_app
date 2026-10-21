import type { KiteSession } from './kiteLogin.js';
import { type Http, makeHttp, SourceFormatError } from '../../sources/http.js';

const KITE_API = 'https://api.kite.trade';
/** /quote takes at most 500 instruments per call. */
export const QUOTE_BATCH = 500;

export interface KiteQuote {
  instrumentToken: number;
  lastPrice: number;
  prevClose: number | null;    // ohlc.close (previous session's close)
  bid: number;                 // best bid, 0 if none
  ask: number;                 // best ask, 0 if none
  timestamp: string | null;    // "YYYY-MM-DD HH:MM:SS" IST
}

export interface KiteCandle {
  date: string;   // YYYY-MM-DD (IST)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KiteApi {
  quotes(keys: string[]): Promise<Map<string, KiteQuote>>;
  candles(token: number, from: string, to: string): Promise<KiteCandle[]>;
}

interface RawQuote {
  instrument_token: number;
  last_price: number;
  ohlc?: { close?: number };
  depth?: { buy?: { price: number; quantity: number }[]; sell?: { price: number; quantity: number }[] };
  timestamp?: string;
}

export function parseKiteQuotes(body: unknown): Map<string, KiteQuote> {
  const b = body as { status?: string; data?: Record<string, RawQuote> };
  if (b?.status !== 'success' || !b.data || typeof b.data !== 'object') throw new SourceFormatError('Kite quote response malformed');
  const out = new Map<string, KiteQuote>();
  for (const [key, q] of Object.entries(b.data)) {
    if (typeof q?.last_price !== 'number') continue;
    // An empty level is sent as price 0 / quantity 0.
    const top = (side?: { price: number; quantity: number }[]) => (side?.[0] && side[0].quantity > 0 ? side[0].price : 0);
    out.set(key, {
      instrumentToken: q.instrument_token,
      lastPrice: q.last_price,
      prevClose: q.ohlc?.close && q.ohlc.close > 0 ? q.ohlc.close : null,
      bid: top(q.depth?.buy),
      ask: top(q.depth?.sell),
      timestamp: q.timestamp ?? null,
    });
  }
  return out;
}

export function parseKiteCandles(body: unknown): KiteCandle[] {
  const b = body as { status?: string; data?: { candles?: unknown } };
  if (b?.status !== 'success' || !Array.isArray(b.data?.candles)) throw new SourceFormatError('Kite historical response malformed');
  return (b.data.candles as [string, number, number, number, number, number][]).map(([ts, o, h, l, c, v]) => ({
    date: ts.slice(0, 10), open: o, high: h, low: l, close: c, volume: v,
  }));
}

/**
 * Kite REST with the documented limits (quote 1/s, historical 3/s). The Http clients are rebuilt
 * when the access token changes. Without a session every call throws.
 */
export function createKiteApi(session: () => KiteSession | null, fetchImpl: typeof fetch = fetch): KiteApi {
  let cached: { token: string; quote: Http; hist: Http } | null = null;
  const clients = () => {
    const s = session();
    if (!s) throw new Error('No Kite session');
    if (cached?.token !== s.accessToken) {
      const headers = { 'X-Kite-Version': '3', Authorization: `token ${s.apiKey}:${s.accessToken}` };
      cached = {
        token: s.accessToken,
        quote: makeHttp({ minIntervalMs: 1_050, headers, fetchImpl }),
        hist: makeHttp({ minIntervalMs: 350, headers, fetchImpl }),
      };
    }
    return cached;
  };
  return {
    async quotes(keys) {
      const out = new Map<string, KiteQuote>();
      for (let i = 0; i < keys.length; i += QUOTE_BATCH) {
        const batch = keys.slice(i, i + QUOTE_BATCH);
        const qs = batch.map((k) => `i=${encodeURIComponent(k)}`).join('&');
        for (const [k, q] of parseKiteQuotes(await clients().quote.json(`${KITE_API}/quote?${qs}`))) out.set(k, q);
      }
      return out;
    },
    async candles(token, from, to) {
      const url = `${KITE_API}/instruments/historical/${token}/day?from=${encodeURIComponent(`${from} 00:00:00`)}&to=${encodeURIComponent(`${to} 23:59:59`)}`;
      return parseKiteCandles(await clients().hist.json(url));
    },
  };
}
