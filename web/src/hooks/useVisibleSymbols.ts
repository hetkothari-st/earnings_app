import { useEffect } from 'react';
import { apiFetch } from '../api';

const DEBOUNCE_MS = 500;
const KEEPALIVE_MS = 60_000; // the server forgets a user after 2 minutes without a PUT
const MAX_SYMBOLS = 100;

/**
 * Tells the server which US rows are on screen (`[data-symbol]` elements in view), so those stocks
 * get live-price slots. Debounced; re-sent every minute while the page is open.
 */
export function useVisibleSymbols(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const watching = new Set<Element>();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let sentOnce = false;

    const send = () => {
      sentOnce = true;
      const symbols = [...visible].slice(0, MAX_SYMBOLS);
      apiFetch('/api/live/visible', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: 'US', symbols }),
      }).catch(() => {});
    };
    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(send, DEBOUNCE_MS);
    };

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const symbol = e.target.getAttribute('data-symbol');
        if (!symbol) continue;
        if (e.isIntersecting) visible.add(symbol); else visible.delete(symbol);
      }
      schedule();
    });

    const scan = () => {
      const now = new Set(document.querySelectorAll('[data-symbol]'));
      for (const el of now) if (!watching.has(el)) { watching.add(el); io.observe(el); }
      for (const el of watching) {
        if (now.has(el)) continue;
        watching.delete(el);
        io.unobserve(el);
        const symbol = el.getAttribute('data-symbol');
        if (symbol && visible.delete(symbol)) schedule();
      }
    };
    scan();
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(scan);
    mutations?.observe(document.body, { childList: true, subtree: true });
    const keepAlive = setInterval(() => { if (sentOnce) send(); }, KEEPALIVE_MS);

    return () => {
      clearTimeout(debounce);
      clearInterval(keepAlive);
      mutations?.disconnect();
      io.disconnect();
    };
  }, [enabled]);
}
