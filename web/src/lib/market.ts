/** Persists market preference in localStorage (overrides server pref for instant switch). */

export type Market = 'US' | 'IN' | 'HK' | 'JP' | 'UK' | 'EU';

export const isMarket = (v: unknown): v is Market =>
  v === 'US' || v === 'IN' || v === 'HK' || v === 'JP' || v === 'UK' || v === 'EU';

const KEY = 'market';

export function getStoredMarket(): Market | null {
  try {
    const v = localStorage.getItem(KEY);
    return isMarket(v) ? v : null;
  } catch {
    return null;
  }
}

export function setStoredMarket(m: Market): void {
  try { localStorage.setItem(KEY, m); } catch {}
}
