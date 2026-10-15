import { useEffect, useRef } from 'react';
import type { LivePrice } from '../api';

/**
 * Listens to the server's live stream. `onIds` gets report ids whose results just arrived;
 * `onMoves` gets ids whose intraday expected move changed.
 */
export function useLiveResults(
  onIds: (ids: number[]) => void,
  onMoves?: (ids: number[]) => void,
  onPrices?: (prices: Record<string, LivePrice>) => void,
): void {
  const cb = useRef({ onIds, onMoves, onPrices });
  cb.current = { onIds, onMoves, onPrices };
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/stream');
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
    source.addEventListener('prices', (e: MessageEvent) => {
      try {
        const { prices } = JSON.parse(e.data) as { prices: Record<string, LivePrice> };
        if (prices && typeof prices === 'object') cb.current.onPrices?.(prices);
      } catch {
        // malformed frame: ignore
      }
    });
    return () => source.close();
  }, []);
}
