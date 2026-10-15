import { useEffect, useMemo, useState } from 'react';
import type { EarningsResponse, ReportDto } from '../../../server/src/api/types';
import { fetchEarnings } from '../api';
import { useHidden } from '../hooks/useHidden';
import { useZone } from '../hooks/useZone';
import { rangeFor, shiftAnchor, type View } from '../lib/ranges';
import { todayEt, zoneLabel } from '../lib/time';
import { DetailPanel } from './DetailPanel';
import { EarningsTable } from './EarningsTable';
import { Header } from './Header';
import { StaleBanner } from './StaleBanner';

type Load = { status: 'loading' } | { status: 'ok'; data: EarningsResponse } | { status: 'error'; error: string };

export function Calendar() {
  const today = todayEt();
  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(today);
  const [custom, setCustom] = useState({ from: today, to: today });
  const [minCap, setMinCap] = useState<number | null>(2e9);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<ReportDto | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const { hidden, toggle } = useHidden();
  const { zone, isOverride, setZone } = useZone();

  const range = useMemo(() => (view === 'custom' ? custom : rangeFor(view, anchor)), [view, anchor, custom]);
  const customInvalid = view === 'custom' && (!custom.from || !custom.to || custom.from > custom.to);

  useEffect(() => {
    if (customInvalid) return;
    const ac = new AbortController();
    setLoad({ status: 'loading' });
    fetchEarnings({ ...range, minCap, q: query }, ac.signal)
      .then((data) => setLoad({ status: 'ok', data }))
      .catch((e: Error) => { if (!ac.signal.aborted) setLoad({ status: 'error', error: e.message }); });
    return () => ac.abort();
  }, [range.from, range.to, minCap, query, customInvalid]);

  return (
    <div className="app">
      <Header
        view={view} onView={setView} range={range} custom={custom} onCustom={setCustom}
        onShift={(dir) => setAnchor((a) => shiftAnchor(view, a, dir))} onToday={() => setAnchor(today)}
        minCap={minCap} onMinCap={setMinCap} query={query} onQuery={setQuery}
        showHidden={showHidden} hiddenCount={hidden.size} onShowHidden={setShowHidden}
        zone={zone} zoneText={`${zoneLabel(zone, range.from)} (${zone})`} isOverride={isOverride} onZone={setZone}
      />
      {load.status === 'ok' && <StaleBanner sources={load.data.sources} />}
      <main className="content">
        {customInvalid && <p className="warn-text">Pick a valid From and To date.</p>}
        {!customInvalid && load.status === 'loading' && <p className="muted">Loading…</p>}
        {load.status === 'error' && <p className="warn-text">Could not load data: {load.error}</p>}
        {load.status === 'ok' && (
          <EarningsTable rows={load.data.rows} zone={zone} hidden={hidden} showHidden={showHidden}
            onToggleHidden={toggle} onSelect={setSelected} />
        )}
      </main>
      {selected && <DetailPanel r={selected} zone={zone} onClose={() => setSelected(null)} />}
      <footer className="footer muted">
        Data: Nasdaq, Finnhub, SEC EDGAR, Cboe (delayed). Prototype — not for trading decisions. <a href="/status">Data status</a>
      </footer>
    </div>
  );
}
