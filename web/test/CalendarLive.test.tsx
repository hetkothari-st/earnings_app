import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReportDto } from '../../server/src/api/types';
import { Calendar } from '../src/components/Calendar';

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.set(type, fn); }
  close() {}
  emit(type: string, data?: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data ?? {}) } as MessageEvent); }
}

const row = (over: Partial<ReportDto> = {}): ReportDto => ({
  id: 7, symbol: 'TSM', name: 'Taiwan Semiconductor', reportDate: '2026-10-22', fiscalQuarter: 'Sep/2026',
  releasedAt: null, timing: 'BMO', timingSource: 'nasdaq', sessionClose: '16:00', rescheduledFrom: null, dateStatus: 'confirmed', exchange: 'NYSE',
  sector: 'Technology', industry: 'Semiconductors', marketCap: 2.31e12, marketCapAsOf: '2026-10-15', sharesOutstanding: null,
  eps: { estimate: 4.45, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, basis: null, noOfEsts: 6, lastYear: 2.92, lastYearReportDate: '2025-10-16' },
  revenue: { estimate: 3.3e10, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, currency: 'USD' },
  expectedMove: null, liveMove: null, previousMove: null, sec: { check: null, acceptedAt: null, docUrl: null, indexUrl: null },
  fetched: { calendar: null, revenue: null, sec: null }, flags: [], ...over,
});

let paths: string[];
beforeEach(() => {
  paths = [];
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('WebSocket', undefined); // event-stream path
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0]!;
    paths.push(path);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === '/api/earnings') return json({ rows: [row()], sources: [] });
    if (path === '/api/earnings/7') return json(row({ releasedAt: '2026-10-22T10:30:05Z' }));
    if (path === '/api/prices' || path === '/api/in/prices') return json({ prices: {} });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const listLoads = () => paths.filter((p) => p === '/api/earnings').length;

test('a live update for a report on screen fetches only that report', async () => {
  render(<Calendar />);
  await waitFor(() => expect(listLoads()).toBe(1));
  act(() => { FakeSource.last!.emit('moves', { ids: [7] }); FakeSource.last!.emit('results', { ids: [7] }); });
  await waitFor(() => expect(paths.filter((p) => p === '/api/earnings/7')).toHaveLength(1)); // two events, one fetch
  expect(listLoads()).toBe(1);
});

test('an update for a report not on screen reloads the list once', async () => {
  render(<Calendar />);
  await waitFor(() => expect(listLoads()).toBe(1));
  act(() => FakeSource.last!.emit('results', { ids: [99] }));
  await waitFor(() => expect(listLoads()).toBe(2));
});

test('after the live stream drops and comes back, the list reloads', async () => {
  render(<Calendar />);
  await waitFor(() => expect(listLoads()).toBe(1));
  act(() => FakeSource.last!.emit('open'));
  expect(listLoads()).toBe(1); // first connect is not a reconnect
  act(() => { FakeSource.last!.emit('error'); FakeSource.last!.emit('open'); });
  await waitFor(() => expect(listLoads()).toBe(2));
});
