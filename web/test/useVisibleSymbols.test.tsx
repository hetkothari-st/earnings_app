import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useVisibleSymbols } from '../src/hooks/useVisibleSymbols';

type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;
let cb: Cb;
let observed: Element[];
const fetchMock = vi.fn();

class FakeIO {
  constructor(c: Cb) { cb = c; observed = []; }
  observe(el: Element) { observed.push(el); }
  unobserve(el: Element) { observed = observed.filter((e) => e !== el); }
  disconnect() {}
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  useVisibleSymbols(enabled);
  return <ul>{['AAA', 'BBB', 'CCC'].map((s) => <li key={s} data-symbol={s} />)}</ul>;
}

const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
const see = (symbols: string[], on = true) => act(() => cb(observed.filter((e) => symbols.includes(e.getAttribute('data-symbol')!)).map((target) => ({ target, isIntersecting: on }))));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('sends the visible US symbols once, 500 ms after the last change', () => {
  render(<Probe />);
  see(['AAA']);
  act(() => { vi.advanceTimersByTime(300); });
  see(['BBB']);
  act(() => { vi.advanceTimersByTime(499); });
  expect(fetchMock).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/live/visible');
  expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PUT');
  expect(bodies()[0]).toEqual({ market: 'US', symbols: ['AAA', 'BBB'] });
});

test('rows scrolled out are dropped', () => {
  render(<Probe />);
  see(['AAA', 'BBB']);
  see(['AAA'], false);
  act(() => { vi.advanceTimersByTime(500); });
  expect(bodies()[0].symbols).toEqual(['BBB']);
});

test('re-sends at least every 60 s so the server does not expire a user who is not scrolling', () => {
  render(<Probe />);
  see(['AAA']);
  act(() => { vi.advanceTimersByTime(500); });
  fetchMock.mockClear();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(bodies()).toEqual([{ market: 'US', symbols: ['AAA'] }]);
});

test('does nothing when disabled, and tolerates a missing IntersectionObserver', () => {
  render(<Probe enabled={false} />);
  act(() => { vi.advanceTimersByTime(120_000); });
  expect(fetchMock).not.toHaveBeenCalled();
  cleanup();
  vi.stubGlobal('IntersectionObserver', undefined);
  expect(() => render(<Probe />)).not.toThrow();
});
