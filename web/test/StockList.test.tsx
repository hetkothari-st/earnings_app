import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ReportDto } from '../../server/src/api/types';
import { StockList } from '../src/components/StockList';

const dto = (over: Partial<ReportDto>): ReportDto => ({
  id: 1, symbol: 'TSM', name: 'Taiwan Semiconductor', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026',
  releasedAt: null, timing: 'BMO', timingSource: 'nasdaq', sessionClose: '16:00', rescheduledFrom: null, exchange: 'NYSE',
  sector: 'Technology', industry: 'Semiconductors', marketCap: 2.31e12, marketCapAsOf: '2026-10-15',
  eps: { estimate: 4.45, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, basis: null, noOfEsts: 6, lastYear: 2.92, lastYearReportDate: '2025-10-16' },
  revenue: { estimate: 3.3e10, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, currency: 'USD' },
  expectedMove: null, liveMove: null, previousMove: null, sec: { check: null, acceptedAt: null, docUrl: null, indexUrl: null },
  fetched: { calendar: null, revenue: null, sec: null }, flags: [], ...over,
});

const rows = [
  dto({ id: 1, symbol: 'TSM' }),
  dto({ id: 2, symbol: 'SCHW', name: 'Charles Schwab', marketCap: 1.6e11,
    eps: { estimate: 1.66, actual: 1.71, surprisePct: 3, result: 'beat', preliminary: false, corrected: false, basis: null, noOfEsts: 10, lastYear: null, lastYearReportDate: null },
    previousMove: { pct: -2.5, reportDate: '2026-07-21', basis: 'assumed' } }),
  dto({ id: 3, symbol: 'AA', name: 'Alcoa', reportDate: '2026-10-16', timing: 'AMC', marketCap: 1e10,
    expectedMove: { movePct: 6.19, illiquid: false, expiry: '2026-10-17', strike: 40, callMid: 1.3, putMid: 1.2, underlying: 40, provisional: true, quoteDate: '2026-10-15', snapshotAt: 'x' },
    liveMove: { movePct: 6.5, changePp: 0.31, illiquid: false, quoteTime: '2026-10-16T11:03:00' } }),
];

function renderList(over: Partial<Parameters<typeof StockList>[0]> = {}) {
  const props = {
    rows, zone: 'Asia/Kolkata', expanded: new Set<string>(), sort: 'date' as const, onToggle: vi.fn(),
    notes: new Map(), onSaveNote: vi.fn(), ...over,
  };
  render(<StockList {...props} />);
  return props;
}

describe('StockList', () => {
  test('stocks are listed under their date, names only while collapsed', () => {
    renderList();
    const days = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(days).toEqual(['Thu, Oct 15, 2026', 'Fri, Oct 16, 2026']);
    const oct15 = screen.getByRole('region', { name: 'Thu, Oct 15, 2026' });
    expect(within(oct15).getAllByRole('button').map((b) => b.querySelector('.ticker')!.textContent)).toEqual(['TSM', 'SCHW']);
    expect(screen.queryByText('Market cap')).toBeNull();
  });
  test('clicking a stock expands it; others stay collapsed', () => {
    const props = renderList();
    fireEvent.click(screen.getByRole('button', { name: /SCHW/ }));
    expect(props.onToggle).toHaveBeenCalledWith('SCHW');
  });
  test('an expanded stock shows its details line by line', () => {
    renderList({ expanded: new Set(['SCHW']) });
    const item = screen.getByRole('button', { name: /SCHW/ }).closest('li')!;
    expect(screen.getByRole('button', { name: /SCHW/ }).getAttribute('aria-expanded')).toBe('true');
    const line = (label: string) => within(item).getByText(label).nextElementSibling!.textContent;
    expect(line('Stock')).toBe('SCHW Charles Schwab, NYSE');
    expect(line('Sector')).toBe('Technology (Semiconductors)');
    expect(line('Release')).toBe('BMO · before 9:30 AM ET');
    expect(line('Your time')).toBe('before 7:00 PM IST');
    expect(line('Result date')).toBe('Thu, Oct 15, 2026');
    expect(line('Previous move')).toContain('−2.5%');
    expect(line('EPS estimate / actual')).toBe('$1.66 / $1.71 ▲ (+3.0%)');
    expect(line('Market cap')).toBe('$160.0B');
    // the other stock stays collapsed
    const tsm = screen.getByRole('button', { name: /TSM/ });
    expect(tsm.getAttribute('aria-expanded')).toBe('false');
  });
  test('expected and live expected move lines', () => {
    renderList({ expanded: new Set(['AA']) });
    const item = screen.getByRole('button', { name: /AA/ }).closest('li')!;
    const line = (label: string) => within(item).getByText(label).nextElementSibling!.textContent;
    expect(line('Expected move')).toContain('≈±6.2%');
    expect(line('Live expected move')).toContain('±6.5%');
    expect(line('Live expected move')).toContain('+0.3');
  });
  test('sorting applies within each date', () => {
    renderList({ sort: 'cap', rows: [rows[1]!, rows[0]!, rows[2]!] });
    const oct15 = screen.getByRole('region', { name: 'Thu, Oct 15, 2026' });
    expect(within(oct15).getAllByRole('button').map((b) => b.querySelector('.ticker')!.textContent)).toEqual(['TSM', 'SCHW']);
  });
  test('revenue in a non-USD reporting currency is labelled, never shown as dollars', () => {
    renderList({ expanded: new Set(['TSM']), rows: [dto({ revenue: { estimate: 1.46e12, actual: null, surprisePct: null, result: null, preliminary: false, corrected: false, currency: 'TWD' } })] });
    const item = screen.getByRole('button', { name: /TSM/ }).closest('li')!;
    expect(within(item).getByText('Revenue estimate / actual').nextElementSibling!.textContent).toBe('NT$1.46T / —');
  });
  test('live price and change on the stock line and in the details', () => {
    renderList({ expanded: new Set(['TSM']), prices: { TSM: { price: 422.55, prevClose: 430, changePct: -1.73, time: 1792070000000 } } });
    const head = screen.getByRole('button', { name: /TSM/ });
    expect(within(head).getByText('$422.55')).toBeTruthy();
    expect(within(head).getByText('−1.73%').className).toContain('down');
    const item = head.closest('li')!;
    expect(within(item).getByText('Price').nextElementSibling!.textContent).toContain('$422.55');
  });
  test('stocks whose results just arrived are highlighted', () => {
    renderList({ highlight: new Set([2]) });
    expect(screen.getByRole('button', { name: /SCHW/ }).closest('li')!.className).toContain('just-updated');
  });
  test('empty state', () => {
    renderList({ rows: [] });
    expect(screen.getByText('No earnings reports match this range and filter.')).toBeTruthy();
  });

  test('preliminary and corrected tags render next to EPS', () => {
    renderList({
      expanded: new Set(['TSM', 'SCHW']),
      rows: [
        dto({ id: 1, symbol: 'TSM', eps: { estimate: 1.66, actual: 1.5, surprisePct: null, result: null, preliminary: true, corrected: false, basis: 'gaap', noOfEsts: 6, lastYear: null, lastYearReportDate: null },
          revenue: { estimate: 3e10, actual: 3.1e10, surprisePct: 3.3, result: 'beat', preliminary: true, corrected: false, currency: 'USD' } }),
        dto({ id: 2, symbol: 'SCHW', name: 'Charles Schwab',
          eps: { estimate: 1.66, actual: 1.71, surprisePct: 3, result: 'beat', preliminary: false, corrected: true, basis: null, noOfEsts: 10, lastYear: null, lastYearReportDate: null } }),
      ],
    });
    expect(screen.getAllByText('preliminary').length).toBe(2); // EPS and revenue of TSM
    expect(screen.getByText('GAAP').className).toContain('tag');
    expect(screen.getAllByText('corrected').length).toBe(1);
  });
});
