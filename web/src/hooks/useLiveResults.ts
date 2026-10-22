import { useEffect, useRef } from 'react';
import type { InLivePriceDto, LivePrice } from '../api';

/** India events: results and moves by report id, prices by NSE symbol. */
export interface IndiaLive {
  onIds?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
  onPrices?: (prices: Record<string, InLivePriceDto>) => void;
}

/**
 * Listens to the server's live stream. `onIds` gets report ids whose results just arrived;
 * `onMoves` gets ids whose intraday expected move changed.
 */
export function useLiveResults(
  onIds: (ids: number[]) => void,
  onMoves?: (ids: number[]) => void,
  onPrices?: (prices: Record<string, LivePrice>) => void,
  india?: IndiaLive,
  /** The stream came back after a drop: events sent meanwhile were missed, so reload. */
  onReconnect?: () => void,
): void {
  const cb = useRef({ onIds, onMoves, onPrices, india, onReconnect });
  cb.current = { onIds, onMoves, onPrices, india, onReconnect };
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/stream');
    let dropped = false;
    source.addEventListener('error', () => { dropped = true; });
    source.addEventListener('open', () => {
      if (dropped) cb.current.onReconnect?.();
      dropped = false;
    });
    const listen = (event: string, pick: () => ((ids: number[]) => void) | undefined) =>
      source.addEventListener(event, (e: MessageEvent) => {
        try {
          const { ids } = JSON.parse(e.data) as { ids: number[] };
          if (Array.isArray(ids) && ids.length) pick()?.(ids);
        } catch {
          // malformed frame: ignore
        }
      });
    listen('results', () => cb.current.onIds);
    listen('moves', () => cb.current.onMoves);
    listen('in-results', () => cb.current.india?.onIds);
    listen('in-moves', () => cb.current.india?.onMoves);
    const prices = <T,>(event: string, pick: () => ((p: Record<string, T>) => void) | undefined) =>
      source.addEventListener(event, (e: MessageEvent) => {
        try {
          const { prices: p } = JSON.parse(e.data) as { prices: Record<string, T> };
          if (p && typeof p === 'object') pick()?.(p);
        } catch {
          // malformed frame: ignore
        }
      });
    prices<LivePrice>('prices', () => cb.current.onPrices);
    prices<InLivePriceDto>('in-prices', () => cb.current.india?.onPrices);
    return () => source.close();
  }, []);
}
