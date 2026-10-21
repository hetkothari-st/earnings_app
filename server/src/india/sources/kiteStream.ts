import { EventEmitter } from 'node:events';
import type { KiteSession } from './kiteLogin.js';

/** A single live price tick from the Kite WebSocket stream. */
export interface KiteTick {
  token: number;
  ltp: number;           // last traded price (rupees)
  close: number | null;  // previous close (rupees)
  isIndex: boolean;
}

/**
 * Parse one Kite binary frame: int16 packet count, then (int16 length, packet) pairs, big-endian.
 * Prices are in paise. Tradable packets: 0 token, 4 LTP, 40 close (quote/full mode, ≥ 44 bytes).
 * Index packets (token & 0xff === 9): 0 token, 4 LTP, 20 close (≥ 28 bytes). 1-byte frames are heartbeats.
 * LTP-only packets (8 bytes) carry no close and are skipped.
 */
export function parseKiteFrame(buf: ArrayBuffer): KiteTick[] {
  if (buf.byteLength < 2) return [];
  const view = new DataView(buf);
  const count = view.getInt16(0, false);
  const ticks: KiteTick[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > buf.byteLength) break;
    const len = view.getInt16(offset, false);
    offset += 2;
    if (len < 4 || offset + len > buf.byteLength) break;
    const token = view.getInt32(offset, false);
    const isIndex = (token & 0xff) === 9;
    if (isIndex && len >= 28) {
      const close = view.getInt32(offset + 20, false) / 100;
      ticks.push({ token, ltp: view.getInt32(offset + 4, false) / 100, close: close > 0 ? close : null, isIndex });
    } else if (!isIndex && len >= 44) {
      const close = view.getInt32(offset + 40, false) / 100;
      ticks.push({ token, ltp: view.getInt32(offset + 4, false) / 100, close: close > 0 ? close : null, isIndex });
    }
    offset += len;
  }
  return ticks;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Kite ticker over wss://ws.kite.trade in quote mode. Reconnects with backoff until `disconnect()`.
 * Events: 'tick' (KiteTick), 'open', 'close', 'error' (Error).
 */
export class KiteStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private tokens = new Set<number>();
  private stopped = false;
  private backoff = 2_000;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly session: () => KiteSession | null) {
    super();
  }

  connect(tokens: number[]): void {
    this.stopped = false;
    this.tokens = new Set(tokens);
    this.open();
  }

  /** Replace the subscription without reconnecting. */
  setTokens(tokens: number[]): void {
    const next = new Set(tokens);
    const drop = [...this.tokens].filter((t) => !next.has(t));
    const add = [...next].filter((t) => !this.tokens.has(t));
    this.tokens = next;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (drop.length) this.ws.send(JSON.stringify({ a: 'unsubscribe', v: drop }));
    if (add.length) this.subscribe(add);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    const s = this.session();
    if (!s) return this.retry();
    const ws = new WebSocket(`wss://ws.kite.trade?api_key=${encodeURIComponent(s.apiKey)}&access_token=${encodeURIComponent(s.accessToken)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoff = 2_000;
      this.subscribe([...this.tokens]);
      this.emit('open');
    });
    ws.addEventListener('message', (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return; // JSON text messages (order updates, errors)
      for (const t of parseKiteFrame(ev.data)) if (this.tokens.has(t.token)) this.emit('tick', t);
    });
    ws.addEventListener('error', () => this.emit('error', new Error('Kite WebSocket error')));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.emit('close');
      this.retry();
    });
  }

  private subscribe(tokens: number[]): void {
    if (!tokens.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ a: 'subscribe', v: tokens }));
    this.ws.send(JSON.stringify({ a: 'mode', v: ['quote', tokens] }));
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.open(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }
}
