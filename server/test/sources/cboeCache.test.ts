import { describe, expect, it, vi } from 'vitest';
import { cachedChains } from '../../src/sources/cboeCache.js';
import type { OptionChain } from '../../src/types.js';

const chain = { symbol: 'X' } as unknown as OptionChain;

describe('cachedChains', () => {
  it('second call within 15 min served from cache', async () => {
    let t = 0;
    const fetch = vi.fn(async () => chain);
    const get = cachedChains(fetch, { now: () => t });
    expect(await get('A')).toBe(chain);
    t = 899_999;
    expect(await get('A')).toBe(chain);
    expect(fetch).toHaveBeenCalledTimes(1);
    t = 900_000;
    await get('A');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caches null (no chain)', async () => {
    const fetch = vi.fn(async () => null);
    const get = cachedChains(fetch);
    expect(await get('A')).toBeNull();
    expect(await get('A')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls share one fetch', async () => {
    const fetch = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return chain; });
    const get = cachedChains(fetch);
    const out = await Promise.all([get('A'), get('A'), get('B')]);
    expect(out).toEqual([chain, chain, chain]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('errors not cached', async () => {
    const fetch = vi.fn<(a: string) => Promise<OptionChain | null>>()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce(chain);
    const get = cachedChains(fetch);
    await expect(get('A')).rejects.toThrow('429');
    expect(await get('A')).toBe(chain);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
