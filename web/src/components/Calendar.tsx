import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EarningsResponse, Timing } from '../../../server/src/api/types';
import { fetchEarnings, fetchNotes, fetchPrices, type LivePrice, type Note, saveNote } from '../api';
import { useExpanded } from '../hooks/useExpanded';
import { useLiveResults } from '../hooks/useLiveResults';
import { useZone } from '../hooks/useZone';
import { rangeFor, shiftAnchor, type View } from '../lib/ranges';
import { daySummary } from '../lib/session';
import type { SortKey } from '../lib/sort';
import { todayEt, zoneLabel } from '../lib/time';
import { DayStrip } from './DayStrip';
import { Header } from './Header';
import { LiveMarketBar } from './MarketBar';
import { SessionBand } from './SessionBand';
import { StaleBanner } from './StaleBanner';
import { StockList } from './StockList';

type Load = { status: 'loading' } | { status: 'ok'; data: EarningsResponse } | { status: 'error'; error: string };

export function Calendar() {
  const today = todayEt();
  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(today);
  const [custom, setCustom] = useState({ from: today, to: today });
  const [minCap, setMinCap] = useState<number | null>(2e9);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [notes, setNotes] = useState<Map<number, Note>>(new Map());
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  useLiveResults((ids) => {
    setHighlight(new Set(ids));
    setReloadKey((k) => k + 1);
    window.setTimeout(() => setHighlight(new Set()), 6000);
  }, () => setReloadKey((k) => k + 1), (p) => setPrices((prev) => ({ ...prev, ...p })));
  const { expanded, toggle } = useExpanded();
  const { zone, isOverride, setZone } = useZone();

  useEffect(() => {
    fetchPrices().then(setPrices).catch(() => {});
  }, []);
  useEffect(() => {
    fetchNotes().then((list) => setNotes(new Map(list.map((n) => [n.reportId, n])))).catch(() => {});
  }, []);
  const onSaveNote = useCallback(async (reportId: number, text: string) => {
    const saved = await saveNote(reportId, text);
    setNotes((prev) => {
      const next = new Map(prev);
      if (saved) next.set(reportId, saved);
      else next.delete(reportId);
      return next;
    });
  }, []);

  const range = useMemo(() => (view === 'custom' ? custom : rangeFor(view, anchor)), [view, anchor, custom]);
  const customInvalid = view === 'custom' && (!custom.from || !custom.to || custom.from > custom.to);

  useEffect(() => {
    if (customInvalid) return;
    const ac = new AbortController();
    // Live refreshes keep showing the current table until fresh data arrives.
    if (reloadKey === 0) setLoad({ status: 'loading' });
    fetchEarnings({ ...range, minCap, q: query }, ac.signal)
      .then((data) => setLoad({ status: 'ok', data }))
      .catch((e: Error) => { if (!ac.signal.aborted) setLoad({ status: 'error', error: e.message }); });
    return () => ac.abort();
  }, [range.from, range.to, minCap, query, customInvalid, reloadKey]);

  const zoneText = zoneLabel(zone, range.from);
  const rows = load.status === 'ok' ? load.data.rows : [];
  const days = daySummary(rows, new Set());
  const jump = (timing: Timing) =>
    document.querySelector(`[data-date="${range.from}"][data-timing="${timing}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const openDay = (date: string) => { setView('day'); setAnchor(date); };

  return (
    <div className="app">
      <LiveMarketBar />
      <Header
        view={view} onView={setView} range={range} custom={custom} onCustom={setCustom}
        onShift={(dir) => setAnchor((a) => shiftAnchor(view, a, dir))} onToday={() => setAnchor(today)}
        minCap={minCap} onMinCap={setMinCap} query={query} onQuery={setQuery}
        sort={sort} onSort={setSort}
        zone={zone} zoneText={zoneText} isOverride={isOverride} onZone={setZone}
      />
      {load.status === 'ok' && <StaleBanner sources={load.data.sources} />}
      <main className="content">
        {load.status === 'ok' && view === 'day' && rows.length > 0 && (
          <SessionBand date={range.from} sessionClose={rows[0]!.sessionClose} zone={zone} zoneText={zoneText}
            counts={days[0] ?? { bmo: 0, amc: 0, other: 0 }} onJump={jump} />
        )}
        {load.status === 'ok' && view !== 'day' && <DayStrip days={days} onPick={openDay} />}
        {customInvalid && <p className="warn-text">Pick a valid From and To date.</p>}
        {!customInvalid && load.status === 'loading' && <p className="muted">Loading…</p>}
        {load.status === 'error' && <p className="warn-text">Could not load data: {load.error}</p>}
        {load.status === 'ok' && (
          <StockList rows={load.data.rows} zone={zone} expanded={expanded} sort={sort} onToggle={toggle}
            notes={notes} onSaveNote={onSaveNote} highlight={highlight} prices={prices} />
        )}
      </main>
      <footer className="footer muted">
        <span>Data from Nasdaq, Finnhub, SEC EDGAR and Cboe (delayed). Prototype, not trading advice.</span>
        <a href="/status">Data source status</a>
      </footer>
    </div>
  );
}
