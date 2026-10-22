import { renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useLiveResults } from '../src/hooks/useLiveResults';

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent); }
}

afterEach(() => { vi.unstubAllGlobals(); });

test('calls back with the changed report ids and closes on unmount', () => {
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('WebSocket', undefined); // event-stream path
  const onIds = vi.fn();
  const { unmount } = renderHook(() => useLiveResults(onIds));
  expect(FakeSource.last!.url).toBe('/api/stream');
  FakeSource.last!.emit('results', { ids: [4, 9] });
  expect(onIds).toHaveBeenCalledWith([4, 9]);
  unmount();
  expect(FakeSource.last!.closed).toBe(true);
});

test('live expected-move updates call the second callback', () => {
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('WebSocket', undefined); // event-stream path
  const onMoves = vi.fn();
  renderHook(() => useLiveResults(vi.fn(), onMoves));
  FakeSource.last!.emit('moves', { ids: [2] });
  expect(onMoves).toHaveBeenCalledWith([2]);
});

test('live prices reach the third callback', () => {
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('WebSocket', undefined); // event-stream path
  const onPrices = vi.fn();
  renderHook(() => useLiveResults(vi.fn(), vi.fn(), onPrices));
  FakeSource.last!.emit('prices', { prices: { TSM: { price: 422.55, prevClose: 430, changePct: -1.73, time: 1 } } });
  expect(onPrices).toHaveBeenCalledWith({ TSM: { price: 422.55, prevClose: 430, changePct: -1.73, time: 1 } });
});

test('does nothing where EventSource is unavailable', () => {
  vi.stubGlobal('EventSource', undefined);
  expect(() => renderHook(() => useLiveResults(vi.fn()))).not.toThrow();
});

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close() { this.closed = true; }
}

test('WebSocket first: frames reach the callbacks; a reconnect after a drop calls onReconnect', () => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('EventSource', FakeSource);
  const onIds = vi.fn();
  const onPrices = vi.fn();
  const onReconnect = vi.fn();
  const { unmount } = renderHook(() => useLiveResults(onIds, vi.fn(), vi.fn(), { onPrices }, onReconnect));
  const first = FakeSocket.all[0]!;
  expect(first.url).toBe('ws://localhost:3000/api/ws');
  first.onopen!();
  first.onmessage!({ data: 'results\n{"ids":[4,9]}' });
  first.onmessage!({ data: 'in-prices\n{"prices":{"INFY":{"price":1146.25}}}' });
  expect(onIds).toHaveBeenCalledWith([4, 9]);
  expect(onPrices).toHaveBeenCalledWith({ INFY: { price: 1146.25 } });
  expect(onReconnect).not.toHaveBeenCalled();
  first.onclose!();
  vi.advanceTimersByTime(1000);
  FakeSocket.all[1]!.onopen!();
  expect(onReconnect).toHaveBeenCalledTimes(1);
  unmount();
  expect(FakeSocket.all[1]!.closed).toBe(true);
  vi.useRealTimers();
});

test('sockets that never open fall back to the event stream', () => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  FakeSource.last = null;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('EventSource', FakeSource);
  renderHook(() => useLiveResults(vi.fn()));
  for (let i = 0; i < 3; i++) { FakeSocket.all.at(-1)!.onclose!(); vi.advanceTimersByTime(10_000); }
  expect(FakeSocket.all).toHaveLength(3);
  expect(FakeSource.last!.url).toBe('/api/stream');
  vi.useRealTimers();
});
