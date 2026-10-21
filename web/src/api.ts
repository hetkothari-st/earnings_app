import type { EarningsResponse, StatusResponse } from '../../server/src/api/types';
import type { InEarningsResponse, InLivePriceDto, KiteStatusDto } from '../../server/src/india/api/types';

/** Fired on window whenever an API call answers 401, so the app can show the login page. */
export const UNAUTHORIZED_EVENT = 'auth:unauthorized';

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return res;
}

export async function fetchEarnings(
  p: { from: string; to: string; minCap: number | null; q: string },
  signal: AbortSignal,
): Promise<EarningsResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.minCap != null) qs.set('minCap', String(p.minCap));
  if (p.q.trim()) qs.set('q', p.q.trim());
  const res = await apiFetch(`/api/earnings?${qs}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<EarningsResponse>;
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await apiFetch('/api/status');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<StatusResponse>;
}

/** The signed-in user, or null when there is no valid session. */
export async function fetchMe(): Promise<{ id: string } | null> {
  const res = await fetch('/api/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

/** Returns null on success, otherwise a message to show the user. */
export async function login(id: string, password: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }),
    });
  } catch {
    return 'Could not reach the server. Try again.';
  }
  if (res.ok) return null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Fall through to a generic message.
  }
  return `Sign in failed (server returned ${res.status})`;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

export async function fetchExpanded(signal?: AbortSignal): Promise<string[]> {
  const res = await apiFetch('/api/expanded', { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { symbols: string[] }).symbols;
}

export async function saveExpanded(symbols: string[]): Promise<void> {
  const res = await apiFetch('/api/expanded', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols }),
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
}

export interface Note {
  reportId: number;
  text: string;
  updatedAt: string;
  deleteAt: string;
}

export async function fetchNotes(): Promise<Note[]> {
  const res = await apiFetch('/api/notes');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { notes: Note[] }).notes;
}

/** Saves a note; blank text deletes it. Returns the saved note, or null when deleted. */
export async function saveNote(reportId: number, text: string): Promise<Note | null> {
  const res = await apiFetch(`/api/notes/${reportId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as Note;
}

export interface LivePrice {
  price: number;
  prevClose: number | null;
  changePct: number | null;
  time: number;
  source?: 'stream' | 'poll' | 'backup';
}

export async function fetchPrices(): Promise<Record<string, LivePrice>> {
  const res = await apiFetch('/api/prices');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { prices: Record<string, LivePrice> }).prices;
}

export type { InEarningsResponse, InLivePriceDto, KiteStatusDto };

export async function fetchInEarnings(
  p: { from: string; to: string; q: string },
  signal: AbortSignal,
): Promise<InEarningsResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.q.trim()) qs.set('q', p.q.trim());
  const res = await apiFetch(`/api/in/earnings?${qs}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<InEarningsResponse>;
}

export async function fetchInPrices(): Promise<Record<string, InLivePriceDto>> {
  const res = await apiFetch('/api/in/prices');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { prices: Record<string, InLivePriceDto> }).prices;
}

export type { SymbolsResponse, WatchHistoryDto, WatchRow, WatchRowsResponse } from '../../server/src/api/types';

export async function fetchWatchlist(market: 'US' | 'IN'): Promise<string[]> {
  const res = await apiFetch(`/api/watchlist?market=${market}`);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { symbols: string[] }).symbols;
}

const watchUrl = (market: 'US' | 'IN', symbol: string) => `/api/watchlist/${market}/${encodeURIComponent(symbol)}`;

/** An API failure that keeps the HTTP status, so callers can word the message. */
export class HttpError extends Error {
  constructor(public status: number) { super(`Server returned ${status}`); }
}

export async function putWatch(market: 'US' | 'IN', symbol: string): Promise<void> {
  const res = await apiFetch(watchUrl(market, symbol), { method: 'PUT' });
  if (!res.ok) throw new HttpError(res.status);
}

export async function deleteWatch(market: 'US' | 'IN', symbol: string): Promise<void> {
  const res = await apiFetch(watchUrl(market, symbol), { method: 'DELETE' });
  if (!res.ok) throw new HttpError(res.status);
}

export async function searchSymbols(market: 'US' | 'IN', q: string, signal?: AbortSignal): Promise<{ symbol: string; name: string; exchange: string }[]> {
  const res = await apiFetch(`/api/symbols?market=${market}&q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return ((await res.json()) as { results: { symbol: string; name: string; exchange: string }[] }).results;
}

export async function fetchWatchRows(market: 'US' | 'IN', signal?: AbortSignal): Promise<import('../../server/src/api/types').WatchRowsResponse> {
  const res = await apiFetch(`/api/watchlist/rows?market=${market}`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<import('../../server/src/api/types').WatchRowsResponse>;
}
