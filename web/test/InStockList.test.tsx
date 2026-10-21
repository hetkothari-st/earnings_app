import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { InReportDto } from '../../server/src/india/api/types';
import { InStockList } from '../src/components/InStockList';
import { formatEpsInr, formatInrCr } from '../src/lib/format';

const dto = (over: Partial<InReportDto>): InReportDto => ({
  id: 1_000_000_001, market: 'IN', symbol: 'TATACOMM', name: 'Tata Communications Limited', reportDate: '2026-10-15',
  dateStatus: 'confirmed', fiscalQuarter: 'Sep/2026', quarterEnd: '2026-09-30', timing: 'AMC', timingSource: 'nse-filing',
  releasedAt: '2026-10-15T12:03:55.000Z', rescheduledFrom: null, sector: 'Communication Services', industry: 'Telecom Services',
  marketCap: 5.4e11, marketCapAsOf: '2026-10-15', basis: 'consolidated',
  eps: { estimate: 11, analysts: 5, actual: 11.96, surprisePct: 8.7, result: 'beat' },
  revenue: { estimate: 6e10, analysts: 4, actual: 66_878_900_000, kind: 'revenue-from-ops', surprisePct: 11.5, result: 'beat' },
  profit: { actual: 3_356_100_000 }, expectedMove: null, liveMove: null, previousMove: null, ...over,
});

describe('InStockList', () => {
  test('opens by the IN: key and shows rupee figures with their basis', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<InStockList rows={[dto({})]} zone="Asia/Kolkata" expanded={new Set()} sort="date"
      onToggle={onToggle} notes={new Map()} onSaveNote={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /TATACOMM/ }));
    expect(onToggle).toHaveBeenCalledWith('IN:TATACOMM');
    rerender(<InStockList rows={[dto({})]} zone="Asia/Kolkata" expanded={new Set(['IN:TATACOMM'])} sort="date"
      onToggle={onToggle} notes={new Map()} onSaveNote={vi.fn()} />);
    expect(screen.getByText('₹11.96 ▲').className).toContain('beat');
    expect(screen.getByText('₹6,687.89 Cr ▲')).toBeTruthy();
    expect(screen.getByText(/After close, 5:33 pm IST/i)).toBeTruthy();
    expect(screen.getByText(/confirmed by NSE filing/)).toBeTruthy();
  });

  test('a bank shows total income without colour', () => {
    render(<InStockList rows={[dto({ symbol: 'UCOBANK', basis: 'standalone',
      eps: { estimate: 0.5, analysts: 2, actual: 0.63, surprisePct: null, result: null },
      revenue: { estimate: 7e10, analysts: 2, actual: 81_740_800_000, kind: 'total-income', surprisePct: null, result: null } })]}
      zone="Asia/Kolkata" expanded={new Set(['IN:UCOBANK'])} sort="date" onToggle={vi.fn()} notes={new Map()} onSaveNote={vi.fn()} />);
    expect(screen.getByText('Total income estimate / actual')).toBeTruthy();
    expect(screen.getByText('₹8,174.08 Cr').className).toBe('act ');
  });
});

describe('INR formatting', () => {
  test('crore with Indian grouping and a true minus', () => {
    expect(formatInrCr(1_234_567_890_000)).toBe('₹1,23,456.79 Cr');
    expect(formatInrCr(-125_000_000)).toBe('−₹12.5 Cr');
    expect(formatEpsInr(-0.5)).toBe('−₹0.50');
  });
});
