import { useEffect, useState } from 'react';
import type { ReportDto } from '../../../server/src/api/types';
import { fetchWatchRows, type LivePrice, type Note, type WatchRow } from '../api';
import type { Watchlist } from '../hooks/useWatchlist';
import type { SortKey } from '../lib/sort';
import { StockList } from './StockList';
import { SymbolSearch } from './SymbolSearch';

interface Props {
  watch: Watchlist;
  zone: string;
  expanded: Set<string>;
  sort: SortKey;
  onToggle: (symbol: string) => void;
  notes: Map<number, Note>;
  onSaveNote: (reportId: number, text: string) => Promise<void>;
  highlight?: Set<number>;
  prices: Record<string, LivePrice>;
  /** The header's find box; narrows the picked stocks by ticker or name. */
  query: string;
  /** Changes whenever results or moves arrive on the live stream. */
  reloadKey?: number;
}

/** A US report row for a pick: its next report, or else its latest dated one. Yahoo-only history has no row. */
function reportOf(r: WatchRow): ReportDto | null {
  if (r.next) return r.next as ReportDto;
  return r.latest && 'id' in r.latest ? (r.latest as ReportDto) : null;
}

/**
 * US "My stocks" view: only the stocks the user picked, in the same rows as the full calendar, whatever their
 * date. The picks are the user's saved US watchlist, so they stay until removed (star, Remove, or Remove all).
 */
export function MyStocksView({ watch, zone, expanded, sort, onToggle, notes, onSaveNote, highlight, prices, query, reloadKey = 0 }: Props) {
  const [rows, setRows] = useState<WatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetchWatchRows('US', ac.signal)
      .then((r) => { setRows(r.rows); setError(null); })
      .catch((e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [watch.version, reloadKey]);

  const q = query.trim().toLowerCase();
  const picked = (rows ?? []).filter((r) => watch.symbols.has(r.symbol))
    .filter((r) => !q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const dated: ReportDto[] = [];
  const undated: WatchRow[] = [];
  for (const r of picked) {
    const report = reportOf(r);
    if (report) dated.push(report); else undated.push(r);
  }
  const remove = (symbol: string) => { watch.remove(symbol).catch(() => {}); };
  const onWatch = (symbol: string, on: boolean) => { (on ? watch.add(symbol) : watch.remove(symbol)).catch(() => {}); };
  const removeAll = () => {
    setConfirming(false);
    for (const s of watch.symbols) remove(s);
  };
  const count = watch.symbols.size;

  return (
    <section className="my-stocks" aria-label="My stocks">
      <div className="my-tools">
        <SymbolSearch market="US" onPick={(s) => { watch.add(s).catch(() => {}); }} />
        {count > 0 && !confirming && <button onClick={() => setConfirming(true)}>Remove all</button>}
        {confirming && (
          <span className="my-confirm" role="group" aria-label="Confirm remove all">
            <span>Remove all {count} stocks from your list?</span>
            <button className="danger" onClick={removeAll}>{`Yes, remove all ${count}`}</button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
      </div>
      {error && <p className="warn-text">Could not load your stocks: {error}</p>}
      {!error && rows === null && count > 0 && <p className="muted">Loading…</p>}
      {count === 0 && <p className="empty">No stocks added yet. Search above to add one; your list is saved to your account.</p>}
      {dated.length > 0 && (
        <StockList rows={dated} zone={zone} expanded={expanded} sort={sort} onToggle={onToggle}
          notes={notes} onSaveNote={onSaveNote} highlight={highlight} prices={prices}
          watched={watch.symbols} onWatch={onWatch} />
      )}
      {undated.length > 0 && (
        <ul className="stocks my-undated">
          {undated.map((r) => (
            <li key={r.symbol} className="stock" data-symbol={r.symbol}>
              <span className="ticker">{r.symbol}</span>
              <span className="name">{r.name}</span>
              <span className="muted">No earnings date yet</span>
              <button className="icon" aria-label={`Remove ${r.symbol}`} onClick={() => remove(r.symbol)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
