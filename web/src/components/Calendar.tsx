import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EarningsResponse, Timing } from '../../../server/src/api/types';
import type { InReportDto } from '../../../server/src/india/api/types';
import type { HkReportDto } from '../../../server/src/hk/api/types';
import { fetchEarnings, fetchHkEarnings, fetchHkPrices, fetchInEarnings, fetchInPrices, fetchNotes, fetchPrices, fetchReport, type HkEarningsResponse, type HkLivePriceDto, type HkMarketDto, type InEarningsResponse, type InLivePriceDto, type InMarket, type LivePrice, type Note, saveNote } from '../api';
import { useExpanded } from '../hooks/useExpanded';
import { useLiveResults } from '../hooks/useLiveResults';
import { useVisibleSymbols } from '../hooks/useVisibleSymbols';
import { useZone } from '../hooks/useZone';
import { useMarket } from '../hooks/useMarket';
import { useWatchlist } from '../hooks/useWatchlist';
import type { Market } from '../lib/market';
import { todayHkt } from '../lib/liveCap';
import { rangeFor, shiftAnchor, type View } from '../lib/ranges';
import { daySummary } from '../lib/session';
import type { SortKey } from '../lib/sort';
import { todayEt, zoneLabel } from '../lib/time';
import { DayStrip } from './DayStrip';
import { Header } from './Header';
import { HongKongMarketBar, IndiaMarketBar, LiveMarketBar } from './MarketBar';
import { HkStockList } from './HkStockList';
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

/** Today in the market's own zone. */
function todayFor(market: Market): string {
  return market === 'IN' ? todayIst() : market === 'HK' ? todayHkt() : todayEt();
}

export function Calendar() {
  const { market, setMarket } = useMarket();
  const today = todayFor(market);

  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState(today);
  const [custom, setCustom] = useState({ from: today, to: today });
  const [minCap, setMinCap] = useState<number | null>(2e9);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [notes, setNotes] = useState<Map<number, Note>>(new Map());
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [inPrices, setInPrices] = useState<Record<string, InLivePriceDto>>({});
  const [inIndices, setInIndices] = useState<InMarket[]>([]);
  const [load, setLoad] = useState<Load<EarningsResponse>>({ status: 'loading' });
  const [hkPrices, setHkPrices] = useState<Record<string, HkLivePriceDto>>({});
  const [hkIndices, setHkIndices] = useState<HkMarketDto[]>([]);
  const [hkLoad, setHkLoad] = useState<Load<HkEarningsResponse>>({ status: 'loading' });
  const [inLoad, setInLoad] = useState<Load<InEarningsResponse>>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [showWatch, setShowWatch] = useState(false);
  const watch = useWatchlist(market);
  useVisibleSymbols(market !== 'IN', market === 'HK' ? 'HK' : 'US');
  const onWatch = useCallback((symbol: string, on: boolean) => { (on ? watch.add(symbol) : watch.remove(symbol)).catch(() => {}); }, [watch.add, watch.remove]);

  // Reset anchor and switch to week view when market changes
  useEffect(() => {
    setAnchor(todayFor(market));
    if (market === 'IN' || market === 'HK') setView('week');
  }, [market]);

  // Live updates: ids are gathered for a moment, then only those reports are fetched and patched into the
  // rows on screen. A big burst, a report not on screen yet, or a failed fetch reloads the range once.
  const [watchKey, setWatchKey] = useState(0);
  const pending = useRef<Record<Market, Set<number>>>({ US: new Set(), IN: new Set(), HK: new Set() });
  const flushTimer = useRef<number | null>(null);
  const shown = useRef<Record<Market, Set<number>>>({ US: new Set(), IN: new Set(), HK: new Set() });
  const reload = () => setReloadKey((k) => k + 1);
  const patch = async (m: Market, ids: number[]) => {
    if (ids.length > MAX_PATCH || ids.some((id) => !shown.current[m].has(id))) return reload();
    try {
      const got = new Map((await Promise.all(ids.map((id) => fetchReport(m, id)))).filter((r) => r != null).map((r) => [r.id, r]));
      const swap = <T extends { id: number }>(rows: T[]) => rows.map((r) => (got.get(r.id) as T | undefined) ?? r);
      if (m === 'US') setLoad((prev) => (prev.status === 'ok' ? { status: 'ok', data: { ...prev.data, rows: swap(prev.data.rows) } } : prev));
      else if (m === 'HK') setHkLoad((prev) => (prev.status === 'ok' ? { status: 'ok', data: { ...prev.data, rows: swap(prev.data.rows) } } : prev));
      else setInLoad((prev) => (prev.status === 'ok' ? { status: 'ok', data: { ...prev.data, rows: swap(prev.data.rows) } } : prev));
    } catch {
      reload();
    }
  };
  const queue = (m: Market, ids: number[]) => {
    for (const id of ids) pending.current[m].add(id);
    flushTimer.current ??= window.setTimeout(() => {
      flushTimer.current = null;
      setWatchKey((k) => k + 1);
      for (const mk of ['US', 'IN', 'HK'] as const) {
        const list = [...pending.current[mk]];
        pending.current[mk].clear();
        if (list.length) void patch(mk, list);
      }
    }, PATCH_DELAY_MS);
  };
  const flash = (m: Market) => (ids: number[]) => {
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
      onIndices: (list) => setInIndices((prev) => [...prev.filter((m) => !list.some((n) => n.index === m.index)), ...list]),
    },
    () => {
      reload();
      setWatchKey((k) => k + 1);
      fetchPrices().then(setPrices).catch(() => {});
      fetchInPrices().then(setInPrices).catch(() => {});
      if (market === 'HK') fetchHkPrices().then(setHkPrices).catch(() => {});
    },
    {
      onIds: flash('HK'),
      onMoves: (ids) => queue('HK', ids),
      onPrices: (p) => setHkPrices((prev) => ({ ...prev, ...p })),
      onIndices: (list) => setHkIndices((prev) => [...prev.filter((m) => !list.some((n) => n.index === m.index)), ...list]),
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
    if (market === 'HK') fetchHkPrices().then(setHkPrices).catch(() => {});
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

  // Hong Kong market data
  useEffect(() => {
    if (market !== 'HK') return;
    if (customInvalid) return;
    const ac = new AbortController();
    if (reloadKey === 0) setHkLoad({ status: 'loading' });
    fetchHkEarnings({ from: range.from, to: range.to, q: query }, ac.signal)
      .then((data) => setHkLoad({ status: 'ok', data }))
      .catch((e: Error) => { if (!ac.signal.aborted) setHkLoad({ status: 'error', error: e.message }); });
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

  // Hong Kong rows
  const hkRows: HkReportDto[] = hkLoad.status === 'ok' ? hkLoad.data.rows : [];
  shown.current.HK = new Set(hkRows.map((r) => r.id));

  return (
    <div className="app">
      {market === 'IN' ? <IndiaMarketBar live={inIndices} /> : market === 'HK' ? <HongKongMarketBar live={hkIndices} /> : <LiveMarketBar />}
      <Header
        view={view} onView={setView} range={range} custom={custom} onCustom={setCustom}
        onShift={(dir) => setAnchor((a) => shiftAnchor(view, a, dir))} onToday={() => setAnchor(todayFor(market))}
        minCap={minCap} onMinCap={setMinCap} query={query} onQuery={setQuery}
        sort={sort} onSort={setSort}
        zone={zone} zoneText={zoneText} isOverride={isOverride} onZone={setZone}
        market={market} onMarket={setMarket} watchlist={showWatch} onWatchlist={setShowWatch}
      />

      {market === 'US' && load.status === 'ok' && <StaleBanner sources={load.data.sources} />}

      <main className="content">
        {watch.error && <p className="warn-text" role="alert">{watch.error}</p>}
        {showWatch && (
          <WatchlistView market={market} prices={market === 'IN' ? inPrices : market === 'HK' ? hkPrices : prices} watch={watch} reloadKey={reloadKey + watchKey} />
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

        {/* Hong Kong loading/error */}
        {!showWatch && market === 'HK' && !customInvalid && hkLoad.status === 'loading' && <p className="muted">Loading Hong Kong earnings…</p>}
        {!showWatch && market === 'HK' && hkLoad.status === 'error' && <p className="warn-text">Could not load data: {hkLoad.error}</p>}
        {!showWatch && market === 'HK' && hkLoad.status === 'ok' && (
          <HkStockList rows={hkRows} zone={zone} expanded={expanded} sort={sort} onToggle={toggle}
            notes={notes} onSaveNote={onSaveNote} highlight={highlight} prices={hkPrices}
            watched={watch.symbols} onWatch={onWatch} />
        )}
      </main>

      <footer className="footer muted">
        {market === 'US' && <span>Data from Nasdaq, Finnhub, SEC EDGAR and Cboe (delayed). Prototype, not trading advice.</span>}
        {market === 'IN' && <span>Data from NSE filings (RSS), Zerodha Kite and Yahoo Finance. Times in IST. Prototype, not trading advice.</span>}
        {market === 'HK' && <span>Data from SEC EDGAR, Cboe (delayed) and Yahoo Finance (delayed ~15 min). Times in HKT. Prototype, not trading advice.</span>}
        <a href="/status">Data source status</a>
      </footer>
    </div>
  );
}
