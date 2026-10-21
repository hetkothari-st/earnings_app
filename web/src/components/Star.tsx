/** Add or remove a stock from the watchlist; filled when watched. */
export function Star({ symbol, on, onToggle }: { symbol: string; on: boolean; onToggle: (symbol: string, on: boolean) => void }) {
  return (
    <button className={`star${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      onClick={() => onToggle(symbol, !on)}>
      {on ? '★' : '☆'}
    </button>
  );
}
