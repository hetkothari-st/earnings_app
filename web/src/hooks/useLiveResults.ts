import { useEffect, useRef } from 'react';

/**
 * Listens to the server's live stream. `onIds` gets report ids whose results just arrived;
 * `onMoves` gets ids whose intraday expected move changed.
 */
export function useLiveResults(onIds: (ids: number[]) => void, onMoves?: (ids: number[]) => void): void {
  const cb = useRef({ onIds, onMoves });
  cb.current = { onIds, onMoves };
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
    return () => source.close();
  }, []);
}
