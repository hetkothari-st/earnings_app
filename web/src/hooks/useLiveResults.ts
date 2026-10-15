import { useEffect, useRef } from 'react';

/** Listens to the server's live stream; calls back with report ids whose results just arrived. */
export function useLiveResults(onIds: (ids: number[]) => void): void {
  const cb = useRef(onIds);
  cb.current = onIds;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/stream');
    source.addEventListener('results', (e: MessageEvent) => {
      try {
        const { ids } = JSON.parse(e.data) as { ids: number[] };
        if (Array.isArray(ids) && ids.length) cb.current(ids);
      } catch {
        // malformed frame: ignore
      }
    });
    return () => source.close();
  }, []);
}
