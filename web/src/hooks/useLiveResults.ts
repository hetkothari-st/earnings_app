import { useEffect, useRef } from 'react';
import type { HkLivePriceDto, HkMarketDto, InLivePriceDto, InMarket, LivePrice } from '../api';

/** India events: results and moves by report id, prices by NSE symbol. */
export interface IndiaLive {
  onIds?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
  onPrices?: (prices: Record<string, InLivePriceDto>) => void;
  /** Index levels (NIFTY 50, SENSEX, ...) as they tick. */
  onIndices?: (indices: InMarket[]) => void;
}

/** Hong Kong events: results and moves by report id, prices by 4-digit code. */
export interface HongKongLive {
  onIds?: (ids: number[]) => void;
  onMoves?: (ids: number[]) => void;
  onPrices?: (prices: Record<string, HkLivePriceDto>) => void;
  /** Index levels (HSI, HSCEI, Hang Seng Tech) as they tick. */
  onIndices?: (indices: HkMarketDto[]) => void;
}

/** Reconnect waits after a WebSocket closes: doubling from 1 s to 10 s. */
const WS_RETRY_MS = 1000;
const WS_RETRY_MAX_MS = 10_000;
/** Sockets that never open this many times in a row (blocked by a proxy): use the event stream instead. */
const WS_GIVE_UP_AFTER = 3;

/**
 * Listens to the server's live stream. `onIds` gets report ids whose results just arrived;
 * `onMoves` gets ids whose intraday expected move changed.
 *
 * A WebSocket (/api/ws) first: Cloudflare quick tunnels hold an event stream back for seconds but pass
 * WebSocket frames on at once. If sockets never open, the server-sent event stream (/api/stream) instead.
 */
export function useLiveResults(
  onIds: (ids: number[]) => void,
  onMoves?: (ids: number[]) => void,
  onPrices?: (prices: Record<string, LivePrice>) => void,
  india?: IndiaLive,
  /** The stream came back after a drop: events sent meanwhile were missed, so reload. */
  onReconnect?: () => void,
  hk?: HongKongLive,
): void {
  const cb = useRef({ onIds, onMoves, onPrices, india, onReconnect, hk });
  cb.current = { onIds, onMoves, onPrices, india, onReconnect, hk };
  useEffect(() => {
    const dispatch = (event: string, data: string) => {
      try {
        const body = JSON.parse(data) as { ids?: number[]; prices?: Record<string, unknown>; indices?: (InMarket | HkMarketDto)[] };
        const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : null;
        const prices = body.prices && typeof body.prices === 'object' ? body.prices : null;
        const c = cb.current;
        if (event === 'results' && ids) c.onIds(ids);
        else if (event === 'moves' && ids) c.onMoves?.(ids);
        else if (event === 'in-results' && ids) c.india?.onIds?.(ids);
        else if (event === 'in-moves' && ids) c.india?.onMoves?.(ids);
        else if (event === 'prices' && prices) c.onPrices?.(prices as Record<string, LivePrice>);
        else if (event === 'in-prices' && prices) c.india?.onPrices?.(prices as Record<string, InLivePriceDto>);
        else if (event === 'in-indices' && Array.isArray(body.indices)) c.india?.onIndices?.(body.indices as InMarket[]);
        else if (event === 'hk-results' && ids) c.hk?.onIds?.(ids);
        else if (event === 'hk-moves' && ids) c.hk?.onMoves?.(ids);
        else if (event === 'hk-prices' && prices) c.hk?.onPrices?.(prices as Record<string, HkLivePriceDto>);
        else if (event === 'hk-indices' && Array.isArray(body.indices)) c.hk?.onIndices?.(body.indices as HkMarketDto[]);
      } catch {
        // malformed frame: ignore
      }
    };

    let stopped = false;
    let cleanup = () => {};

    const startEventStream = () => {
      if (typeof EventSource === 'undefined') return;
      const source = new EventSource('/api/stream');
      let dropped = false;
      source.addEventListener('error', () => { dropped = true; });
      source.addEventListener('open', () => {
        if (dropped) cb.current.onReconnect?.();
        dropped = false;
      });
      for (const event of ['results', 'moves', 'in-results', 'in-moves', 'prices', 'in-prices', 'in-indices', 'hk-results', 'hk-moves', 'hk-prices', 'hk-indices']) {
        source.addEventListener(event, (e: MessageEvent) => dispatch(event, String(e.data)));
      }
      cleanup = () => source.close();
    };

    if (typeof WebSocket === 'undefined') {
      startEventStream();
      return () => cleanup();
    }

    let wait = WS_RETRY_MS;
    let failedOpens = 0;
    let everOpened = false;
    let timer: number | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        failedOpens = 0;
        wait = WS_RETRY_MS;
        if (everOpened) cb.current.onReconnect?.();
        everOpened = true;
      };
      ws.onmessage = (e: MessageEvent) => {
        const text = String(e.data);
        const nl = text.indexOf('\n');
        if (nl > 0) dispatch(text.slice(0, nl), text.slice(nl + 1));
      };
      ws.onclose = () => {
        if (stopped) return;
        if (!opened && ++failedOpens >= WS_GIVE_UP_AFTER && !everOpened) return startEventStream();
        timer = window.setTimeout(connect, wait);
        wait = Math.min(wait * 2, WS_RETRY_MAX_MS);
      };
      cleanup = () => { ws.onclose = null; ws.close(); };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(timer); cleanup(); };
  }, []);
}
