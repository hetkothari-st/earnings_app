import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EarningsResponse, Timing } from '../../../server/src/api/types';
import type { InReportDto } from '../../../server/src/india/api/types';
import { fetchEarnings, fetchInEarnings, fetchInPrices, fetchNotes, fetchPrices, fetchReport, type InEarningsResponse, type InLivePriceDto, type LivePrice, type Note, saveNote } from '../api';
import { useExpanded } from '../hooks/useExpanded';
import { useLiveResults } from '../hooks/useLiveResults';
import { useVisibleSymbols } from '../hooks/useVisibleSymbols';
import { useZone } from '../hooks/useZone';
import { useMarket } from '../hooks/useMarket';
import { useWatchlist } from '../hooks/useWatchlist';
import { rangeFor, shiftAnchor, type View } from '../lib/ranges';
import { daySummary } from '../lib/session';
import type { SortKey } from '../lib/sort';
import { todayEt, zoneLabel } from '../lib/time';
import { DayStrip } from './DayStrip';
import { Header } from './Header';
import { IndiaMarketBar, LiveMarketBar } from './MarketBar';
import { SessionBand } from './SessionBand';
import { StaleBanner } from './StaleBanner';
import { StockList } from './StockList';
import { InStockList } from './InStockList';
import { WatchlistView } from './WatchlistView';

/** Live updates are gathered this long before fetching; more ids than MAX_PATCH reload the range instead. */
const PATCH_DELAY_MS = 250;
const MAX_PATCH = 25;

type Load<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: string };

/** Today in IST, for India calendar anchor. */
function todayIst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function Calendar() {
  const { market, setMarket } = useMarket();
  const today = market === 'IN' ? todayIst() : todayEt();

  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(today);
  const [custom, setCustom] = useState({ from: today, to: today });
  const [minCap, setMinCap] = useState<number | null>(2e9);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [notes, setNotes] = useState<Map<number, Note>>(new Map());
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [inPrices, setInPrices] = useState<Record<string, InLivePriceDto>>({});
  const [load, setLoad] = useState<Load<EarningsResponse>>({ status: 'loading' });
  const [inLoad, setInLoad] = useState<Load<InEarningsResponse>>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [showWatch, setShowWatch] = useState(false);
  const watch = useWatchlist(market);
  useVisibleSymbols(market === 'US');
  const onWatch = useCallback((symbol: string, on: boolean) => { (on ? watch.add(symbol) : watch.remove(symbol)).catch(() => {}); }, [watch.add, watch.remove]);

  // Reset anchor and switch to week view when market changes
  useEffect(() => {
    setAnchor(market === 'IN' ? todayIst() : todayEt());
    if (market === 'IN') setView('week');
  }, [market]);

  // Live updates: ids are gathered for a moment, then only those reports are fetched and patched into the
  // rows on screen. A big burst, a report not on screen yet, or a failed fetch reloads the range once.
  const [watchKey, setWatchKey] = useState(0);
  const pending = useRef({ US: new Set<number>(), IN: new Set<number>() });
  const flushTimer = useRef<number | null>(null);
  const shown = useRef({ US: new Set<number>(), IN: new Set<number>() });
  const reload = () => setReloadKey((k) => k + 1);
  const patch = async (m: 'US' | 'IN', ids: number[]) => {
    if (ids.length > MAX_PATCH || ids.some((id) => !shown.current[m].has(id))) return reload();
    try {
      const got = new Map((await Promise.all(ids.map((id) => fetchReport(m, id)))).filter((r) => r != null).map((r) => [r.id, r]));
      const swap = <T extends { id: number }>(rows: T[]) => rows.map((r) => (got.get(r.id) as T | undefined) ?? r);
      if (m === 'US') setLoad((prev) => (prev.status === 'ok' ? { status: 'ok', data: { ...prev.data, rows: swap(prev.data.rows) } } : prev));
      else setInLoad((prev) => (prev.status === 'ok' ? { status: 'ok', data: { ...prev.data, rows: swap(prev.data.rows) } } : prev));
    } catch {
      reload();
    }
  };
  const queue = (m: 'US' | 'IN', ids: number[]) => {
    for (const id of ids) pending.current[m].add(id);
    flushTimer.current ??= window.setTimeout(() => {
      flushTimer.current = null;
      setWatchKey((k) => k + 1);
      for (const mk of ['US', 'IN'] as const) {
        const list = [...pending.current[mk]];
        pending.current[mk].clear();
        if (list.length) void patch(mk, list);
      }
    }, PATCH_DELAY_MS);
  };
  const flash = (m: 'US' | 'IN') => (ids: number[]) => {
    setHighlight(new Set(ids));
    queue(m, ids);
    window.setTimeout(() => setHighlight(new Set()), 6000);
  };
  useLiveResults(
    flash('US'),
    (ids) => queue('US', ids),
    (p) => setPrices((prev) => ({ ...prev, ...p })),
    {
      onIds: flash('IN'),
      onMoves: (ids) => queue('IN', ids),
      onPrices: (p) => setInPrices((prev) => ({ ...prev, ...p })),
    },
    () => {
      reload();
      setWatchKey((k) => k + 1);
      fetchPrices().then(setPrices).catch(() => {});
      fetchInPrices().then(setInPrices).catch(() => {});
    },
  );
  const { expanded, toggle } = useExpanded();
  const { zone, isOverride, setZone } = useZone();

  useEffect(() => {
    fetchPrices().then(setPrices).catch(() => {});
  }, []);
  useEffect(() => {
    if (market === 'IN') fetchInPrices().then(setInPrices).catch(() => {});
  }, [market]);
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

  // US market data
  useEffect(() => {
    if (market !== 'US') return;
    if (customInvalid) return;
    const ac = new AbortController();
    if (reloadKey === 0) setLoad({ status: 'loading' });
    fetchEarnings({ ...range, minCap, q: query }, ac.signal)
      .then((data) => setLoad({ status: 'ok', data }))
      .catch((e: Error) => { if (!ac.signal.aborted) setLoad({ status: 'error', error: e.message }); });
    return () => ac.abort();
  }, [market, range.from, range.to, minCap, query, customInvalid, reloadKey]);

  // India market data
  useEffect(() => {
    if (market !== 'IN') return;
    if (customInvalid) return;
    const ac = new AbortController();
    if (reloadKey === 0) setInLoad({ status: 'loading' });
    fetchInEarnings({ from: range.from, to: range.to, q: query }, ac.signal)
      .then((data) => setInLoad({ status: 'ok', data }))
      .catch((e: Error) => { if (!ac.signal.aborted) setInLoad({ status: 'error', error: e.message }); });
    return () => ac.abort();
  }, [market, range.from, range.to, query, customInvalid, reloadKey]);

  const zoneText = zoneLabel(zone, range.from);

  // US calendar
  const usRows = load.status === 'ok' ? load.data.rows : [];
  shown.current.US = new Set(usRows.map((r) => r.id));
  const days = daySummary(usRows, new Set());
  const jump = (timing: Timing) =>
    document.querySelector(`[data-date="${range.from}"][data-timing="${timing}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const openDay = (date: string) => { setView('day'); setAnchor(date); };

  // India rows
  const inRows: InReportDto[] = inLoad.status === 'ok' ? inLoad.data.rows : [];
  shown.current.IN = new Set(inRows.map((r) => r.id));

  return (
    <div className="app">
      {market === 'IN' ? <IndiaMarketBar /> : <LiveMarketBar />}
      <Header
        view={view} onView={setView} range={range} custom={custom} onCustom={setCustom}
        onShift={(dir) => setAnchor((a) => shiftAnchor(view, a, dir))} onToday={() => setAnchor(market === 'IN' ? todayIst() : todayEt())}
        minCap={minCap} onMinCap={setMinCap} query={query} onQuery={setQuery}
        sort={sort} onSort={setSort}
        zone={zone} zoneText={zoneText} isOverride={isOverride} onZone={setZone}
        market={market} onMarket={setMarket} watchlist={showWatch} onWatchlist={setShowWatch}
      />

      {market === 'US' && load.status === 'ok' && <StaleBanner sources={load.data.sources} />}

      <main className="content">
        {watch.error && <p className="warn-text" role="alert">{watch.error}</p>}
        {showWatch && (
          <WatchlistView market={market} prices={market === 'IN' ? inPrices : prices} watch={watch} reloadKey={reloadKey + watchKey} />
        )}
        {/* US day view: session band */}
        {!showWatch && market === 'US' && load.status === 'ok' && view === 'day' && usRows.length > 0 && (
          <SessionBand date={range.from} sessionClose={usRows[0]!.sessionClose} zone={zone} zoneText={zoneText}
            counts={days[0] ?? { bmo: 0, amc: 0, other: 0 }} onJump={jump} />
        )}
        {/* Multi-day strip (US only; India day-strip is same component) */}
        {!showWatch && market === 'US' && load.status === 'ok' && view !== 'day' && <DayStrip days={days} onPick={openDay} />}

        {!showWatch && customInvalid && <p className="warn-text">Pick a valid From and To date.</p>}

        {/* US loading/error */}
        {!showWatch && market === 'US' && !customInvalid && load.status === 'loading' && <p className="muted">Loading…</p>}
        {!showWatch && market === 'US' && load.status === 'error' && <p className="warn-text">Could not load data: {load.error}</p>}
        {!showWatch && market === 'US' && load.status === 'ok' && (
          <StockList rows={usRows} zone={zone} expanded={expanded} sort={sort} onToggle={toggle}
            notes={notes} onSaveNote={onSaveNote} highlight={highlight} prices={prices}
            watched={watch.symbols} onWatch={onWatch} />
        )}

        {/* India loading/error */}
        {!showWatch && market === 'IN' && !customInvalid && inLoad.status === 'loading' && <p className="muted">Loading India earnings…</p>}
        {!showWatch && market === 'IN' && inLoad.status === 'error' && <p className="warn-text">Could not load data: {inLoad.error}</p>}
        {!showWatch && market === 'IN' && inLoad.status === 'ok' && (
          <InStockList rows={inRows} zone={zone} expanded={expanded} sort={sort} onToggle={toggle}
            notes={notes} onSaveNote={onSaveNote} highlight={highlight} prices={inPrices}
            watched={watch.symbols} onWatch={onWatch} />
        )}
      </main>

      <footer className="footer muted">
        {market === 'US' && <span>Data from Nasdaq, Finnhub, SEC EDGAR and Cboe (delayed). Prototype, not trading advice.</span>}
        {market === 'IN' && <span>Data from NSE filings (RSS), Zerodha Kite and Yahoo Finance. Times in IST. Prototype, not trading advice.</span>}
        <a href="/status">Data source status</a>
      </footer>
    </div>
  );
}
