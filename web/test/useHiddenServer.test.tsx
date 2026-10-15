import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useHidden } from '../src/hooks/useHidden';

/** Fake /api/hidden backed by an in-memory list; records every PUT body. */
function fakeServer(initial: string[]) {
  let stored = [...initial];
  const puts: string[][] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/hidden') return new Response(null, { status: 404 });
    if (init?.method === 'PUT') {
      stored = (JSON.parse(String(init.body)) as { symbols: string[] }).symbols;
      puts.push(stored);
      return new Response(JSON.stringify({ symbols: stored }), { status: 200 });
    }
    return new Response(JSON.stringify({ symbols: stored }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { puts, get stored() { return stored; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

test('loads the signed-in user\'s list from the server', async () => {
  fakeServer(['AAPL', 'TSM']);
  const { result } = renderHook(() => useHidden());
  await waitFor(() => expect([...result.current.hidden].sort()).toEqual(['AAPL', 'TSM']));
});

test('migrates the browser list when the server list is empty, then clears the local copy', async () => {
  localStorage.setItem('hiddenTickers', JSON.stringify(['NVDA', 'MSFT']));
  const server = fakeServer([]);
  const { result } = renderHook(() => useHidden());
  await waitFor(() => expect(server.puts).toEqual([['NVDA', 'MSFT']]));
  expect([...result.current.hidden]).toEqual(['NVDA', 'MSFT']);
  expect(localStorage.getItem('hiddenTickers')).toBeNull();
});

test('a non-empty server list wins over the browser list, with no upload', async () => {
  localStorage.setItem('hiddenTickers', JSON.stringify(['NVDA']));
  const server = fakeServer(['AAPL']);
  const { result } = renderHook(() => useHidden());
  await waitFor(() => expect([...result.current.hidden]).toEqual(['AAPL']));
  expect(server.puts).toEqual([]);
  expect(localStorage.getItem('hiddenTickers')).toBeNull();
});

test('toggles are saved to the server in order, not to the browser', async () => {
  const server = fakeServer(['AAPL']);
  const { result } = renderHook(() => useHidden());
  await waitFor(() => expect(result.current.hidden.has('AAPL')).toBe(true));
  act(() => result.current.toggle('TSM'));
  act(() => result.current.toggle('AAPL'));
  expect([...result.current.hidden]).toEqual(['TSM']);
  await waitFor(() => expect(server.stored).toEqual(['TSM']));
  expect(server.puts).toEqual([['AAPL', 'TSM'], ['TSM']]);
  expect(localStorage.getItem('hiddenTickers')).toBeNull();
});

test('falls back to the browser list when the server cannot be reached', async () => {
  localStorage.setItem('hiddenTickers', JSON.stringify(['NVDA']));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  const { result } = renderHook(() => useHidden());
  expect(result.current.hidden.has('NVDA')).toBe(true);
  act(() => result.current.toggle('TSM'));
  expect(JSON.parse(localStorage.getItem('hiddenTickers')!)).toEqual(['NVDA', 'TSM']);
});
