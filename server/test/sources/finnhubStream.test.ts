import { describe, expect, test, vi } from 'vitest';
import { FinnhubStream, parseQuote, todaysReference } from '../../src/sources/finnhubStream.js';

class FakeSocket {
  static last: FakeSocket;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) { FakeSocket.last = this; }
  send(m: string) { this.sent.push(m); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}

describe('FinnhubStream', () => {
  test('subscribes the wanted symbols once open, Finnhub spelling for class shares', () => {
    const s = new FinnhubStream('tok', vi.fn(), { WebSocketImpl: FakeSocket as never });
    s.setSymbols(['TSM', 'BRK/B']);
    expect(FakeSocket.last.url).toBe('wss://ws.finnhub.io?token=tok');
    FakeSocket.last.open();
    expect(FakeSocket.last.sent.map((m) => JSON.parse(m))).toEqual([
      { type: 'subscribe', symbol: 'TSM' }, { type: 'subscribe', symbol: 'BRK.B' },
    ]);
  });
  test('changing the list unsubscribes removed symbols and subscribes new ones', () => {
    const s = new FinnhubStream('tok', vi.fn(), { WebSocketImpl: FakeSocket as never });
    s.setSymbols(['A', 'B']);
    FakeSocket.last.open();
    FakeSocket.last.sent = [];
    s.setSymbols(['B', 'C']);
    expect(FakeSocket.last.sent.map((m) => JSON.parse(m))).toEqual([
      { type: 'unsubscribe', symbol: 'A' }, { type: 'subscribe', symbol: 'C' },
    ]);
  });
  test('trade messages reach the callback with our symbol spelling; pings are ignored', () => {
    const onTrades = vi.fn();
    const s = new FinnhubStream('tok', onTrades, { WebSocketImpl: FakeSocket as never });
    s.setSymbols(['BRK/B']);
    FakeSocket.last.open();
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'ping' }) });
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'trade', data: [{ s: 'BRK.B', p: 480.1, t: 5, v: 10 }] }) });
    expect(onTrades).toHaveBeenCalledTimes(1);
    expect(onTrades).toHaveBeenCalledWith([{ s: 'BRK/B', p: 480.1, t: 5 }]);
  });
  test('reconnects after the connection drops and resubscribes', () => {
    vi.useFakeTimers();
    const s = new FinnhubStream('tok', vi.fn(), { WebSocketImpl: FakeSocket as never, reconnectMs: 1000 });
    s.setSymbols(['A']);
    const first = FakeSocket.last;
    first.open();
    first.close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.last).not.toBe(first);
    FakeSocket.last.open();
    expect(FakeSocket.last.sent.map((m) => JSON.parse(m))).toEqual([{ type: 'subscribe', symbol: 'A' }]);
    s.stop();
    vi.useRealTimers();
  });
  test('failed connects (HTTP 429) back off, doubling to the cap; a minute open resets the wait', () => {
    vi.useFakeTimers();
    const s = new FinnhubStream('tok', vi.fn(), { WebSocketImpl: FakeSocket as never, reconnectMs: 1000, maxReconnectMs: 4000 });
    s.setSymbols(['A']);
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const sock = FakeSocket.last;
      sock.close(); // never opened
      let waited = 0;
      while (FakeSocket.last === sock) { vi.advanceTimersByTime(500); waited += 500; }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 4000]);
    const flap = FakeSocket.last;
    flap.open();
    vi.advanceTimersByTime(10_000);
    flap.close(); // dropped within a minute: still backing off
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.last).toBe(flap);
    vi.advanceTimersByTime(3000);
    const stable = FakeSocket.last;
    expect(stable).not.toBe(flap);
    stable.open();
    vi.advanceTimersByTime(60_000);
    stable.close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.last).not.toBe(stable);
    s.stop();
    vi.useRealTimers();
  });
});

describe('parseQuote', () => {
  test('Finnhub /quote: current price, previous close, time', () => {
    expect(parseQuote({ c: 422.55, pc: 430, t: 1792008000, d: -7.45, dp: -1.73 }))
      .toEqual({ price: 422.55, prevClose: 430, time: 1792008000000 });
  });
  test('unknown symbol (all zeros) gives null', () => {
    expect(parseQuote({ c: 0, pc: 0, t: 0 })).toBeNull();
  });
});

describe('todaysReference', () => {
  // Live TSM before the open on 2026-10-15: c = 430 (Oct 14 close), pc = 445.12 (Oct 13 close).
  const q = { price: 430, prevClose: 445.12, time: Date.parse('2026-10-14T20:00:00Z') };
  test('before the session of the day the reference is the last close (c), not the one before', () => {
    expect(todaysReference(q, '2026-10-15')).toEqual({ price: 430, prevClose: 430, time: q.time });
  });
  test('during or after the session pc is the previous close', () => {
    const live = { price: 425, prevClose: 430, time: Date.parse('2026-10-15T15:00:00Z') };
    expect(todaysReference(live, '2026-10-15')).toEqual(live);
  });
});
