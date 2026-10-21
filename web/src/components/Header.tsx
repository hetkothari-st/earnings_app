import { DateTime } from 'luxon';
import { useAccount } from '../lib/account';
import type { View } from '../lib/ranges';
import type { SortKey } from '../lib/sort';
import type { Market } from '../lib/market';

export const CAP_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Any size', value: null },
  { label: '$300M and up', value: 3e8 },
  { label: '$2B and up', value: 2e9 },
  { label: '$10B and up', value: 1e10 },
  { label: '$200B and up', value: 2e11 },
];

const VIEWS: { id: View; label: string }[] = [
  { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' }, { id: 'custom', label: 'Range' },
];

interface Props {
  view: View; onView: (v: View) => void;
  range: { from: string; to: string };
  custom: { from: string; to: string }; onCustom: (r: { from: string; to: string }) => void;
  onShift: (dir: 1 | -1) => void; onToday: () => void;
  minCap: number | null; onMinCap: (v: number | null) => void;
  query: string; onQuery: (q: string) => void;
  sort: SortKey; onSort: (s: SortKey) => void;
  zone: string; zoneText: string; isOverride: boolean; onZone: (z: string | null) => void;
  market: Market; onMarket: (m: Market) => void;
  watchlist?: boolean; onWatchlist?: (on: boolean) => void;
}

const ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'UTC']; }
})();

function title(view: View, from: string, to: string): { main: string; sub: string } {
  const a = DateTime.fromISO(from).setLocale('en-US');
  const b = DateTime.fromISO(to).setLocale('en-US');
  switch (view) {
    case 'day': return { main: a.toFormat('cccc d LLLL'), sub: a.toFormat('yyyy') };
    case 'month': return { main: a.toFormat('LLLL'), sub: a.toFormat('yyyy') };
    case 'quarter': return { main: `Q${a.quarter} ${a.toFormat('yyyy')}`, sub: `${a.toFormat('d LLL')} to ${b.toFormat('d LLL')}` };
    default: return { main: `${a.toFormat('d LLL')} to ${b.toFormat('d LLL')}`, sub: b.toFormat('yyyy') };
  }
}

export function Header(p: Props) {
  const t = title(p.view, p.range.from, p.range.to);
  const account = useAccount();
  return (
    <header className="header">
      <div className="masthead">
        <div className="brand">
          <button
            id="market-us"
            className={`market-btn${p.market === 'US' ? ' on' : ''}`}
            onClick={() => p.onMarket('US')}
            aria-pressed={p.market === 'US'}
          >
            US
          </button>
          <button
            id="market-in"
            className={`market-btn${p.market === 'IN' ? ' on' : ''}`}
            onClick={() => p.onMarket('IN')}
            aria-pressed={p.market === 'IN'}
          >
            India
          </button>
        </div>
        <label className="zone">
          <span>Times shown in {p.zoneText}</span>
          <select value={p.isOverride ? p.zone : ''} onChange={(e) => p.onZone(e.target.value || null)} aria-label="Time zone">
            <option value="">Detect automatically</option>
            {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        {account && (
          <div className="zone">
            <span>{account.userId}</span>
            {account.isAdmin && <a href="/admin">Admin</a>}
            <button onClick={account.signOut}>Sign out</button>
          </div>
        )}
      </div>

      <div className="headline">
        <h1>{t.main} <span className="headline-sub">{t.sub}</span></h1>
        {p.view === 'custom' ? (
          <div className="custom">
            <input type="date" aria-label="From" value={p.custom.from} onChange={(e) => p.onCustom({ ...p.custom, from: e.target.value })} />
            <span>to</span>
            <input type="date" aria-label="To" value={p.custom.to} onChange={(e) => p.onCustom({ ...p.custom, to: e.target.value })} />
          </div>
        ) : (
          <div className="nav">
            <button className="icon" aria-label="Previous" onClick={() => p.onShift(-1)}>‹</button>
            <button onClick={p.onToday}>Today</button>
            <button className="icon" aria-label="Next" onClick={() => p.onShift(1)}>›</button>
          </div>
        )}
      </div>

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Period">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={p.view === v.id} className={p.view === v.id ? 'on' : ''} onClick={() => p.onView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        {p.onWatchlist && (
          <button className={`watch-toggle${p.watchlist ? ' on' : ''}`} aria-pressed={!!p.watchlist} onClick={() => p.onWatchlist!(!p.watchlist)}>
            Watchlist
          </button>
        )}
        <div className="filters">
          {p.market === 'US' && (
            <select value={p.minCap ?? ''} onChange={(e) => p.onMinCap(e.target.value === '' ? null : Number(e.target.value))} aria-label="Market cap">
              {CAP_OPTIONS.map((o) => <option key={o.label} value={o.value ?? ''}>{o.label}</option>)}
            </select>
          )}
          <input type="search" placeholder={p.market === 'IN' ? 'Find a symbol or company' : 'Find a ticker or company'} value={p.query} onChange={(e) => p.onQuery(e.target.value)} aria-label="Search" />
          <select value={p.sort} onChange={(e) => p.onSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="date">Sort by date</option>
            <option value="cap">Sort by market cap</option>
            <option value="gainers">Biggest previous rise first</option>
            <option value="losers">Biggest previous fall first</option>
          </select>
        </div>
      </div>
    </header>
  );
}
