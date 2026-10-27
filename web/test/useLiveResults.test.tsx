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

test('hk-results and hk-prices reach the hk group', () => {
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('WebSocket', undefined); // event-stream path
  const hk = { onIds: vi.fn(), onMoves: vi.fn(), onPrices: vi.fn(), onIndices: vi.fn() };
  const onIds = vi.fn();
  renderHook(() => useLiveResults(onIds, undefined, undefined, undefined, undefined, hk));
  FakeSource.last!.emit('hk-results', { ids: [2000000001] });
  FakeSource.last!.emit('hk-moves', { ids: [2000000002] });
  const price = { price: 512.5, prevClose: 510, changePct: 0.49, at: '2026-10-27T02:00:00Z' };
  FakeSource.last!.emit('hk-prices', { prices: { '0700': price } });
  const idx = [{ index: 'HSI', price: 25000, changePct: 0.1, asOf: null }];
  FakeSource.last!.emit('hk-indices', { indices: idx });
  expect(hk.onIds).toHaveBeenCalledWith([2000000001]);
  expect(hk.onMoves).toHaveBeenCalledWith([2000000002]);
  expect(hk.onPrices).toHaveBeenCalledWith({ '0700': price });
  expect(hk.onIndices).toHaveBeenCalledWith(idx);
  expect(onIds).not.toHaveBeenCalled();
});

test('jp-results and jp-prices reach the jp group', () => {
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('WebSocket', undefined); // event-stream path
  const jp = { onIds: vi.fn(), onMoves: vi.fn(), onPrices: vi.fn(), onIndices: vi.fn() };
  const onIds = vi.fn();
  renderHook(() => useLiveResults(onIds, undefined, undefined, undefined, undefined, undefined, jp));
  FakeSource.last!.emit('jp-results', { ids: [3000000001] });
  FakeSource.last!.emit('jp-moves', { ids: [3000000002] });
  const price = { price: 2845.5, prevClose: 2800, changePct: 1.62, at: '2026-10-27T02:00:00Z' };
  FakeSource.last!.emit('jp-prices', { prices: { '7203': price } });
  const idx = [{ index: 'Nikkei 225', price: 64000, changePct: 0.1, asOf: null }];
  FakeSource.last!.emit('jp-indices', { indices: idx });
  expect(jp.onIds).toHaveBeenCalledWith([3000000001]);
  expect(jp.onMoves).toHaveBeenCalledWith([3000000002]);
  expect(jp.onPrices).toHaveBeenCalledWith({ '7203': price });
  expect(jp.onIndices).toHaveBeenCalledWith(idx);
  expect(onIds).not.toHaveBeenCalled();
});
