import { useEffect, useId, useRef, useState } from 'react';
import { searchSymbols } from '../api';
import type { Market } from '../lib/market';

interface Hit { symbol: string; name: string; exchange: string }

/** Type a ticker or company name, pick a match with the mouse or arrow keys and Enter. */
export function SymbolSearch({ market, onPick }: { market: Market; onPick: (symbol: string) => void }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    const id = ++seq.current;
    if (!q) { setHits([]); setActive(-1); return; }
    const timer = window.setTimeout(() => {
      searchSymbols(market, q)
        .then((r) => { if (id === seq.current) { setHits(r); setActive(r.length ? 0 : -1); setOpen(true); } })
        .catch(() => { if (id === seq.current) { setHits([]); setActive(-1); } });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [text, market]);

  const pick = (h: Hit) => { onPick(h.symbol); setText(''); setHits([]); setOpen(false); setActive(-1); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && open && hits[active]) { e.preventDefault(); pick(hits[active]!); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const shown = open && hits.length > 0;
  return (
    <div className="symbol-search">
      <input
        type="text" role="combobox" aria-label="Add a stock to your watchlist" aria-autocomplete="list"
        aria-expanded={shown} aria-controls={listId} aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={market === 'IN' ? 'Add a symbol or company' : 'Add a ticker or company'}
        value={text} onChange={(e) => { setText(e.target.value); setOpen(true); }} onKeyDown={onKey}
      />
      <ul id={listId} role="listbox" className="symbol-hits" hidden={!shown}>
        {hits.map((h, i) => (
          <li key={h.symbol} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : undefined}
            onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
            <span className="ticker">{h.symbol}</span>
            <span className="name">{h.name}</span>
            <span className="muted">{h.exchange}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
