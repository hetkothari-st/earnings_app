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
  const onMoves = vi.fn();
  renderHook(() => useLiveResults(vi.fn(), onMoves));
  FakeSource.last!.emit('moves', { ids: [2] });
  expect(onMoves).toHaveBeenCalledWith([2]);
});

test('live prices reach the third callback', () => {
  vi.stubGlobal('EventSource', FakeSource);
  const onPrices = vi.fn();
  renderHook(() => useLiveResults(vi.fn(), vi.fn(), onPrices));
  FakeSource.last!.emit('prices', { prices: { TSM: { price: 422.55, prevClose: 430, changePct: -1.73, time: 1 } } });
  expect(onPrices).toHaveBeenCalledWith({ TSM: { price: 422.55, prevClose: 430, changePct: -1.73, time: 1 } });
});

test('does nothing where EventSource is unavailable', () => {
  vi.stubGlobal('EventSource', undefined);
  expect(() => renderHook(() => useLiveResults(vi.fn()))).not.toThrow();
});
