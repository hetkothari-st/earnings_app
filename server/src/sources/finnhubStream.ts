import type { Trade } from '../domain/priceBook.js';

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: { code?: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
};
type SocketCtor = new (url: string) => SocketLike;

const OPEN = 1;
const STABLE_MS = 60_000;
export const toFinnhub = (s: string) => s.trim().toUpperCase().replace(/[/-]/g, '.'); // keys are normalized (BRK-B); Finnhub writes BRK.B

/**
 * Finnhub's free real-time US trade stream (WebSocket). Keeps the subscription in line with the wanted
 * symbols, reconnects after drops, and reports trades with the app's own symbol spelling.
 */
export class FinnhubStream {
  private socket: SocketLike | null = null;
  private wanted = new Set<string>();      // our spelling
  private subscribed = new Set<string>();  // Finnhub spelling
  private toOurs = new Map<string, string>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly Ctor: SocketCtor;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  /** Next wait before reconnecting. Doubles after a connect that failed or dropped within a minute (Finnhub
   * answers 429 to repeated connects, and retrying fast keeps it there); back to reconnectMs after a minute open. */
  private waitMs: number;

  constructor(
    private readonly token: string,
    private readonly onTrades: (trades: Trade[]) => void,
    opts: { WebSocketImpl?: SocketCtor; reconnectMs?: number; maxReconnectMs?: number } = {},
  ) {
    this.Ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketCtor);
    this.reconnectMs = opts.reconnectMs ?? 5000;
    this.maxReconnectMs = opts.maxReconnectMs ?? 300_000;
    this.waitMs = this.reconnectMs;
  }

  setSymbols(symbols: string[]): void {
    this.wanted = new Set(symbols);
    this.toOurs = new Map(symbols.map((s) => [toFinnhub(s), s]));
    if (!this.socket) this.connect();
    else this.sync();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped || !this.token) return;
    const ws = new this.Ctor(`wss://ws.finnhub.io?token=${this.token}`);
    this.socket = ws;
    this.subscribed = new Set();
    let openedAt: number | null = null;
    ws.onopen = () => { openedAt = Date.now(); console.log('[prices] stream connected'); this.sync(); };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string; data?: { s: string; p: number; t: number }[] };
        if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
        const trades = msg.data
          .filter((d) => typeof d.p === 'number' && typeof d.t === 'number')
          .map((d) => ({ s: this.toOurs.get(d.s) ?? d.s, p: d.p, t: d.t }));
        if (trades.length) this.onTrades(trades);
      } catch {
        // malformed frame: ignore
      }
    };
    ws.onclose = (e) => {
      if (openedAt != null && Date.now() - openedAt >= STABLE_MS) this.waitMs = this.reconnectMs;
      const wait = this.waitMs;
      this.waitMs = Math.min(this.waitMs * 2, this.maxReconnectMs);
      console.log(`[prices] stream closed ${e?.code ?? ''} ${e?.reason ?? ''}`.trim() + `, retry in ${Math.round(wait / 1000)}s`);
      if (this.socket === ws) this.socket = null;
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
  }

  private sync(): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== OPEN) return;
    const target = new Set([...this.wanted].map(toFinnhub));
    for (const s of this.subscribed) {
      if (!target.has(s)) { ws.send(JSON.stringify({ type: 'unsubscribe', symbol: s })); this.subscribed.delete(s); }
    }
    for (const s of target) {
      if (!this.subscribed.has(s)) { ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); this.subscribed.add(s); }
    }
  }
}

/** Finnhub /quote: { c: current, pc: previous close, t: epoch seconds }. Unknown symbols are all zeros. */
export function parseQuote(json: unknown): { price: number; prevClose: number; time: number } | null {
  const q = json as { c?: unknown; pc?: unknown; t?: unknown } | null;
  if (!q || typeof q.c !== 'number' || typeof q.pc !== 'number' || typeof q.t !== 'number' || q.c <= 0) return null;
  return { price: q.c, prevClose: q.pc, time: q.t * 1000 };
}

/**
 * The quote re-based for today's change. Before today's session Finnhub's c is the last close and pc the
 * close before it (live TSM pre-open: c 430, pc 445.12), so today's reference must be c.
 */
export function todaysReference(
  q: { price: number; prevClose: number; time: number }, todayEt: string,
): { price: number; prevClose: number; time: number } {
  const quoteDay = new Date(q.time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return quoteDay < todayEt ? { ...q, prevClose: q.price } : q;
}
