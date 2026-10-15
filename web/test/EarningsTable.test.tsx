import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ReportDto } from '../../server/src/api/types';
import { DetailPanel } from '../src/components/DetailPanel';
import { EarningsTable } from '../src/components/EarningsTable';

const dto = (over: Partial<ReportDto>): ReportDto => ({
  id: 1, symbol: 'TSM', name: 'Taiwan Semiconductor', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026',
  timing: 'BMO', timingSource: 'nasdaq', sessionClose: '16:00', rescheduledFrom: null, exchange: 'NYSE', sector: 'Technology', industry: 'Semiconductors',
  marketCap: 2.31e12, marketCapAsOf: '2026-10-15',
  eps: { estimate: 4.45, actual: null, surprisePct: null, result: null, noOfEsts: 6, lastYear: null, lastYearReportDate: null },
  revenue: { estimate: null, actual: null, surprisePct: null, result: null },
  expectedMove: null, previousMove: null, sec: { check: null, acceptedAt: null, docUrl: null, indexUrl: null },
  fetched: { calendar: null, revenue: null, sec: null }, flags: [], ...over,
});

const rows = [
  dto({ id: 1, symbol: 'AMCCO', name: 'After Co', timing: 'AMC' }),
  dto({ id: 2, symbol: 'TSM' }),
  dto({ id: 3, symbol: 'SCHW', name: 'Schwab', eps: { estimate: 1.66, actual: 1.71, surprisePct: 3, result: 'beat', noOfEsts: 10, lastYear: 1.31, lastYearReportDate: '2025-10-16' } }),
];

function renderTable(over: Partial<Parameters<typeof EarningsTable>[0]> = {}) {
  const props = {
    rows, zone: 'Asia/Kolkata', hidden: new Set<string>(), showHidden: false,
    onToggleHidden: vi.fn(), onSelect: vi.fn(), ...over,
  };
  render(<EarningsTable {...props} />);
  return props;
}

describe('EarningsTable', () => {
  test('groups BMO before AMC and shows ET and local time side by side', () => {
    renderTable();
    const groups = screen.getAllByRole('rowheader').map((h) => h.querySelector('.group-name')!.textContent);
    expect(groups).toEqual(['Before open', 'After close']);
    const tsm = screen.getByText('TSM').closest('tr')!;
    expect(within(tsm).getByText('BMO · before 9:30 AM')).toBeTruthy();
    expect(within(tsm).getByText('before 7:00 PM')).toBeTruthy();
  });
  test('hidden rows are omitted unless showHidden, then shown greyed', () => {
    renderTable({ hidden: new Set(['TSM']) });
    expect(screen.queryByText('TSM')).toBeNull();
  });
  test('showHidden reveals hidden rows with is-hidden class', () => {
    renderTable({ hidden: new Set(['TSM']), showHidden: true });
    expect(screen.getByText('TSM').closest('tr')!.className).toContain('is-hidden');
  });
  test('checkbox toggles hidden without opening the detail panel', () => {
    const props = renderTable();
    fireEvent.click(screen.getByLabelText('Hide TSM'));
    expect(props.onToggleHidden).toHaveBeenCalledWith('TSM');
    expect(props.onSelect).not.toHaveBeenCalled();
  });
  test('beat shows ▲ and clicking a row selects it', () => {
    const props = renderTable();
    const schw = screen.getByText('SCHW').closest('tr')!;
    expect(within(schw).getByText(/\$1\.71 ▲/)).toBeTruthy();
    fireEvent.click(schw);
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'SCHW' }));
  });
  test('flags render a ⚠ with the reason', () => {
    render(<EarningsTable rows={[dto({ timing: 'UNKNOWN', flags: [{ field: 'timing', message: 'Time not announced' }] })]}
      zone="Asia/Kolkata" hidden={new Set()} showHidden={false} onToggleHidden={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByLabelText('Time not announced').textContent).toBe('⚠');
  });
  test('row carries its session edge and the move renders as a proportional range', () => {
    render(<EarningsTable rows={[dto({ timing: 'AMC', expectedMove: { movePct: 7.5, illiquid: false, expiry: '2026-10-16', strike: 100, callMid: 4, putMid: 3.5, underlying: 100, snapshotAt: '2026-10-15T20:20:00Z' } })]}
      zone="Asia/Kolkata" hidden={new Set()} showHidden={false} onToggleHidden={vi.fn()} onSelect={vi.fn()} />);
    const tr = screen.getByText('TSM').closest('tr')!;
    expect(tr.className).toContain('s-amc');
    expect(within(tr).getByText('±7.5%')).toBeTruthy();
    expect((tr.querySelector('.move-range') as HTMLElement).style.width).toBe('50%');
  });
  test('separate symbol, name, sector and date columns; previous move signed and coloured; provisional move marked', () => {
    render(<EarningsTable rows={[dto({ previousMove: { pct: -2.5, reportDate: '2026-07-16' },
      expectedMove: { movePct: 4.05, illiquid: false, expiry: '2026-10-16', strike: 97, callMid: 1.9, putMid: 2.1, underlying: 97, optionsVolume: 29599, provisional: true, quoteDate: '2026-10-14', snapshotAt: '2026-10-14T20:20:00Z' } })]}
      zone="Asia/Kolkata" hidden={new Set()} showHidden={false} onToggleHidden={vi.fn()} onSelect={vi.fn()} />);
    const tr = screen.getByText('TSM').closest('tr')!;
    expect(within(tr).getByText('Taiwan Semiconductor')).toBeTruthy();
    expect(within(tr).getByText('15 Oct')).toBeTruthy();
    expect(within(tr).getByText('−2.5%').className).toContain('down');
    expect(within(tr).getByText('Technology').getAttribute('title')).toBe('Semiconductors');
    expect(within(tr).getByText('≈±4.1%')).toBeTruthy();
    expect(within(tr).queryByText('29,599')).toBeNull();
  });
  test('group header shows how many reports it holds', () => {
    renderTable();
    expect(document.getElementById('group-2026-10-15-BMO')!.textContent).toContain('2 reports');
  });
  test('empty state', () => {
    renderTable({ rows: [] });
    expect(screen.getByText('No earnings reports match this range and filter.')).toBeTruthy();
  });
});

describe('DetailPanel', () => {
  test('shows last year same-quarter EPS', () => {
    render(<DetailPanel r={rows[2]!} zone="Asia/Kolkata" onClose={vi.fn()} />);
    expect(screen.getByText('reported Thu, Oct 16, 2025', { exact: false }).parentElement!.textContent).toBe('$1.31 reported Thu, Oct 16, 2025');
  });
});
