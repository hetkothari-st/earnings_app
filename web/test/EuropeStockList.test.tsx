import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { EuropeFigureDto, EuropeReportDto } from '../../server/src/europe/api/types';
import { EuropeStockList } from '../src/components/EuropeStockList';

const fig: EuropeFigureDto = {
  estimate: null, analysts: null, estimateCurrency: null, estimateSpan: null, actual: null, actualCurrency: null,
  actualSource: null, actualSpan: null, ytdMonths: null, surprisePct: null, result: null,
};
const dto = (over: Partial<EuropeReportDto>): EuropeReportDto => ({
  id: 4_000_000_001, market: 'UK', symbol: 'AZN.L', isin: 'GB0009895292', name: 'AstraZeneca', exchange: 'LSE',
  exchangeName: 'London Stock Exchange (Main Market + AIM)', country: 'GB', level: 'full', adrTicker: 'AZN', adrRatio: 1,
  reportDate: '2026-11-06', dateStatus: 'confirmed', period: 'Q3 FY26', periodEnd: '2026-09-30', fiscalQuarter: 3, fyEnd: '2026-12-31',
  timing: 'BMO', timingSource: 'prn', releasedAt: null, releasedSource: null, signal: null, rescheduledFrom: null,
  sector: 'Healthcare', industry: 'Drug Manufacturers', marketCap: 48.04e9, marketCapCurrency: 'GBP', marketCapAsOf: '2026-11-05',
  secDocUrl: null, esefUrl: null, eps: { ...fig }, epsDiluted: null, revenue: { ...fig },
  expectedMove: null, liveMove: null, previousMove: null, ...over,
});

const sapRow = (over: Partial<EuropeReportDto> = {}) => dto({
  market: 'EU', symbol: 'SAP.DE', name: 'SAP', exchange: 'XET', exchangeName: 'Xetra', country: 'DE', level: 'basic', adrTicker: null, adrRatio: null, ...over,
});
const lvmhRow = () => dto({
  id: 4_000_000_003, market: 'EU', symbol: 'MC.PA', name: 'LVMH', exchange: 'PAR', exchangeName: 'Euronext Paris', country: 'FR', level: 'basic', adrTicker: null, adrRatio: null,
});

const mount = (rows: EuropeReportDto[], expanded: string[] = [], extra: Partial<React.ComponentProps<typeof EuropeStockList>> = {}) =>
  render(<EuropeStockList market="UK" rows={rows} zone="Europe/London" expanded={new Set(expanded)} sort="date" onToggle={vi.fn()}
    notes={new Map()} onSaveNote={vi.fn()} {...extra} />);

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('EuropeStockList', () => {
  test('Tradegate price labelled Real-time · Tradegate · EUR; Yahoo price labelled Delayed ~15 min', () => {
    const bt = dto({ id: 4_000_000_002, symbol: 'BT-A.L', name: 'BT Group', level: 'basic', adrTicker: null, adrRatio: null });
    mount([dto({}), bt], [], {
      prices: {
        'AZN.L': { price: 145.3, prevClose: 144, changePct: 0.9, at: '2026-11-05T10:00:00.000Z', currency: 'EUR', venue: 'tradegate' },
        'BT-A.L': { price: 1234.5, prevClose: 1240, changePct: -0.44, at: '2026-11-05T10:00:00.000Z', currency: 'GBp', venue: 'yahoo' },
      },
    });
    const azn = document.querySelector<HTMLElement>('[data-symbol="AZN.L"]')!;
    expect(azn.textContent).toContain('€145.30');
    expect(within(azn).getByText('Real-time · Tradegate · EUR')).toBeTruthy();
    expect(azn.textContent).not.toContain('Delayed');
    const btRow = document.querySelector<HTMLElement>('[data-symbol="BT-A.L"]')!;
    // Pence stay pence: never shown as £12.35.
    expect(btRow.textContent).toContain('1,234.5p');
    expect(btRow.textContent).not.toContain('£');
    expect(within(btRow).getByText('Delayed ~15 min').className).toContain('delayed');
    expect(btRow.textContent).not.toContain('Tradegate');
    const tags = screen.getAllByText('Basic data');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute('title')).toBe('Only Yahoo, ESEF and news-feed data is available for this stock: no SEC results or option data');
  });

  test('GBp EPS vs GBP estimate shows both, no colour, not-compared note', () => {
    const r = dto({
      eps: { ...fig, estimate: 0.118, analysts: 5, estimateCurrency: 'GBP', estimateSpan: 'quarter', actual: 12.3, actualCurrency: 'GBp', actualSource: 'yahoo', actualSpan: 'quarter' },
    });
    mount([r], ['UK:AZN.L']);
    const eps = screen.getByText('EPS estimate / actual').nextElementSibling!;
    expect(eps.textContent).toContain('£0.12');
    expect(eps.textContent).toContain('12.3p');
    expect(eps.textContent).not.toMatch(/[▲▼]/);
    expect(eps.textContent).toContain('different currency, basis or span from the estimate: not compared');
    expect(eps.textContent).toContain('from Yahoo');
    expect(document.querySelector('.act.beat, .act.miss')).toBeNull();
    expect(screen.getByText('Market cap').nextElementSibling!.textContent).toContain('£48.04B');
  });

  test('unconfirmed period shows Period not stated', () => {
    mount([dto({ period: null })], ['UK:AZN.L']);
    expect(screen.getByText('Period').nextElementSibling!.textContent).toBe('Period not stated');
  });

  test('PR Newswire results out shows source, local time and title link', () => {
    const r = sapRow({
      releasedAt: '2026-11-05T06:02:00.000Z', releasedSource: 'prn',
      signal: { title: 'SAP Announces Q3 2026 Results', url: 'https://www.prnewswire.com/news-releases/sap-q3.html' },
    });
    mount([r], ['EU:SAP.DE'], { market: 'EU' });
    const dd = screen.getByText('Release').nextElementSibling as HTMLElement;
    // 06:02 UTC is 07:02 in Berlin (CET), the exchange's zone.
    expect(dd.textContent).toContain('Results out · PR Newswire 07:02');
    const link = within(dd).getByRole('link', { name: 'SAP Announces Q3 2026 Results' });
    expect(link.getAttribute('href')).toBe('https://www.prnewswire.com/news-releases/sap-q3.html');
    expect(screen.getByText('Stock').nextElementSibling!.textContent).toContain('SAP.DE SAP · Xetra');
  });

  test('UNKNOWN timing tooltip text', () => {
    mount([dto({ timing: 'UNKNOWN', timingSource: null })]);
    const when = screen.getByText('Time not announced');
    expect(when.getAttribute('title')).toBe('UK/EU companies usually release at 07:00 local; not confirmed for this row.');
  });

  test('EU exchange filter narrows rows and survives a localStorage throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    mount([sapRow(), lvmhRow()], [], { market: 'EU' });
    const select = screen.getByLabelText('Exchange') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['All exchanges', 'Euronext Paris (FR)', 'Xetra (DE)']);
    expect(document.querySelector('[data-symbol="SAP.DE"]')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'PAR' } });
    expect(document.querySelector('[data-symbol="SAP.DE"]')).toBeNull();
    expect(document.querySelector('[data-symbol="MC.PA"]')).toBeTruthy();
    fireEvent.change(select, { target: { value: '' } });
    expect(document.querySelector('[data-symbol="SAP.DE"]')).toBeTruthy();
  });

  test('EU exchange choice is kept in localStorage; UK has no filter', () => {
    localStorage.setItem('eu-exchange', 'XET');
    const { unmount } = mount([sapRow(), lvmhRow()], [], { market: 'EU' });
    expect(document.querySelector('[data-symbol="MC.PA"]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Exchange'), { target: { value: 'PAR' } });
    expect(localStorage.getItem('eu-exchange')).toBe('PAR');
    unmount();
    mount([dto({})]);
    expect(screen.queryByLabelText('Exchange')).toBeNull();
  });

  test('expanded key is EU:<symbol>', () => {
    const onToggle = vi.fn();
    const { rerender } = mount([sapRow()], ['SAP.DE'], { market: 'EU', onToggle });
    expect(screen.queryByText('EPS estimate / actual')).toBeNull();
    fireEvent.click(document.querySelector('.stock-head')!);
    expect(onToggle).toHaveBeenCalledWith('EU:SAP.DE');
    rerender(<EuropeStockList market="EU" rows={[sapRow()]} zone="Europe/London" expanded={new Set(['EU:SAP.DE'])} sort="date" onToggle={vi.fn()}
      notes={new Map()} onSaveNote={vi.fn()} />);
    expect(screen.getByText('EPS estimate / actual')).toBeTruthy();
  });

  test('full level: ADR line and 6-K note while unreleased; ESEF actual source', () => {
    const r = dto({
      revenue: { ...fig, actual: 54e9, actualCurrency: 'EUR', actualSource: 'esef', actualSpan: 'ytd', ytdMonths: 12 },
    });
    mount([r], ['UK:AZN.L']);
    expect(screen.getByText('Stock').nextElementSibling!.textContent).toContain('· ADR AZN (1 ADS = 1 share)');
    expect(screen.getByText(/SEC 6-K usually arrives within hours of the 07:00 release/)).toBeTruthy();
    const rev = screen.getByText('Revenue estimate / actual').nextElementSibling!.textContent;
    expect(rev).toContain('€54B');
    expect(rev).toContain('from ESEF annual report');
    expect(rev).toContain('YTD (12 months)');
  });
});
