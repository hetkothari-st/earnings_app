import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/repo.js';
import { normalizeTicker } from '../domain/ticker.js';
import type { SymbolsResponse, WatchlistResponse } from '../api/types.js';
import { SymbolIndex } from './search.js';
import { addWatch, listWatch, MAX_WATCH, removeWatch, type WatchMarket } from './store.js';

export interface WatchlistOptions {
  /** Symbol lists to search and validate against; tests pass fixed ones. */
  index?: SymbolIndex;
}

// Used only while a market's index has not loaded yet, so adding a symbol right after a restart still works.
const SYMBOL_FORMAT = /^[A-Z0-9&.\-]{1,24}$/;

const asMarket = (v: unknown): WatchMarket | null => (v === 'US' || v === 'IN' ? v : null);
const normalize = (market: WatchMarket, raw: string): string => (market === 'US' ? normalizeTicker(raw) : raw.trim().toUpperCase());

/** GET /api/symbols, GET /api/watchlist, PUT/DELETE /api/watchlist/:market/:symbol for the signed-in user. */
export function registerWatchlist(
  app: FastifyInstance, db: Db, currentUser: (req: FastifyRequest) => string | null, now: () => number, opts: WatchlistOptions = {},
): void {
  const index = opts.index ?? new SymbolIndex();
  const NOT_SIGNED_IN = { error: 'Not signed in' };
  const BAD_MARKET = { error: 'market must be US or IN' };

  app.get('/api/symbols', async (req, reply) => {
    if (!currentUser(req)) return reply.code(401).send(NOT_SIGNED_IN);
    const { market, q } = req.query as { market?: string; q?: string };
    const m = asMarket(market);
    if (!m) return reply.code(400).send(BAD_MARKET);
    const body: SymbolsResponse = { results: index.search(m, typeof q === 'string' ? q : '') };
    return body;
  });

  app.get('/api/watchlist', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send(NOT_SIGNED_IN);
    const m = asMarket((req.query as { market?: string }).market);
    if (!m) return reply.code(400).send(BAD_MARKET);
    const body: WatchlistResponse = { symbols: listWatch(db, user, m) };
    return body;
  });

  app.put('/api/watchlist/:market/:symbol', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send(NOT_SIGNED_IN);
    const params = req.params as { market: string; symbol: string };
    const m = asMarket(params.market);
    if (!m) return reply.code(400).send(BAD_MARKET);
    const symbol = normalize(m, params.symbol);
    const known = index.size(m) > 0 ? index.has(m, symbol) : SYMBOL_FORMAT.test(symbol);
    if (!known) return reply.code(400).send({ error: 'Unknown symbol' });
    const current = listWatch(db, user, m);
    if (!current.includes(symbol)) {
      if (current.length >= MAX_WATCH) return reply.code(409).send({ error: `Watchlists are limited to ${MAX_WATCH} symbols` });
      addWatch(db, user, m, symbol, now());
    }
    return reply.code(204).send();
  });

  app.delete('/api/watchlist/:market/:symbol', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send(NOT_SIGNED_IN);
    const params = req.params as { market: string; symbol: string };
    const m = asMarket(params.market);
    if (!m) return reply.code(400).send(BAD_MARKET);
    removeWatch(db, user, m, normalize(m, params.symbol));
    return reply.code(204).send();
  });
}
