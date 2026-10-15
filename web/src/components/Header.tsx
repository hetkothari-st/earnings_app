import type { View } from '../lib/ranges';
import { formatDateHeading } from '../lib/format';

export const CAP_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'All', value: null },
  { label: '$300M+', value: 3e8 },
  { label: '$2B+', value: 2e9 },
  { label: '$10B+', value: 1e10 },
  { label: '$200B+', value: 2e11 },
];

const VIEWS: { id: View; label: string }[] = [
  { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' }, { id: 'custom', label: 'Custom' },
];

interface Props {
  view: View; onView: (v: View) => void;
  range: { from: string; to: string };
  custom: { from: string; to: string }; onCustom: (r: { from: string; to: string }) => void;
  onShift: (dir: 1 | -1) => void; onToday: () => void;
  minCap: number | null; onMinCap: (v: number | null) => void;
  query: string; onQuery: (q: string) => void;
  showHidden: boolean; hiddenCount: number; onShowHidden: (v: boolean) => void;
  zone: string; zoneText: string; isOverride: boolean; onZone: (z: string | null) => void;
}

const ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'UTC']; }
})();

export function Header(p: Props) {
  const label = p.range.from === p.range.to
    ? formatDateHeading(p.range.from)
    : `${formatDateHeading(p.range.from)} – ${formatDateHeading(p.range.to)}`;
  return (
    <header className="header">
      <div className="title-row">
        <h1>US Earnings Calendar</h1>
        <label className="zone">
          Your time zone: <strong>{p.zoneText}</strong>{' '}
          <select value={p.isOverride ? p.zone : ''} onChange={(e) => p.onZone(e.target.value || null)} aria-label="Time zone">
            <option value="">Detected ({p.isOverride ? 'auto' : p.zone})</option>
            {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
      </div>
      <div className="controls">
        <div className="seg" role="tablist">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={p.view === v.id} className={p.view === v.id ? 'on' : ''} onClick={() => p.onView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        {p.view === 'custom' ? (
          <div className="custom">
            <input type="date" aria-label="From" value={p.custom.from} onChange={(e) => p.onCustom({ ...p.custom, from: e.target.value })} />
            <span>to</span>
            <input type="date" aria-label="To" value={p.custom.to} onChange={(e) => p.onCustom({ ...p.custom, to: e.target.value })} />
          </div>
        ) : (
          <div className="nav">
            <button aria-label="Previous" onClick={() => p.onShift(-1)}>◀</button>
            <span className="range">{label}</span>
            <button aria-label="Next" onClick={() => p.onShift(1)}>▶</button>
            <button onClick={p.onToday}>Today</button>
          </div>
        )}
      </div>
      <div className="filters">
        <label>Market cap{' '}
          <select value={p.minCap ?? ''} onChange={(e) => p.onMinCap(e.target.value === '' ? null : Number(e.target.value))}>
            {CAP_OPTIONS.map((o) => <option key={o.label} value={o.value ?? ''}>{o.label}</option>)}
          </select>
        </label>
        <input type="search" placeholder="Search ticker or company" value={p.query} onChange={(e) => p.onQuery(e.target.value)} aria-label="Search" />
        <label className="check">
          <input type="checkbox" checked={p.showHidden} onChange={(e) => p.onShowHidden(e.target.checked)} /> Show hidden ({p.hiddenCount})
        </label>
      </div>
    </header>
  );
}
