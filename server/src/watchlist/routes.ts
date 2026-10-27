import { DateTime } from 'luxon';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { toDto } from '../api/dto.js';
import { type Db, listForSymbols } from '../db/repo.js';
import { ET } from '../domain/marketCalendar.js';
import { normalizeTicker } from '../domain/ticker.js';
import type { ReportDto, SymbolsResponse, WatchlistResponse, WatchHistoryDto, WatchRow, WatchRowsResponse } from '../api/types.js';
import { toInDto } from '../india/api/dto.js';
import { listInForSymbols } from '../india/db/inRepo.js';
import { IST } from '../india/domain/nseCalendar.js';
import type { InReportDto } from '../india/api/types.js';
import { toHkDto } from '../hk/api/dto.js';
import { listHkForSymbols } from '../hk/db/hkRepo.js';
import { HKT } from '../hk/domain/hkCalendar.js';
import type { HkReportDto } from '../hk/api/types.js';
import { toJpDto } from '../jp/api/dto.js';
import { listJpForSymbols } from '../jp/db/jpRepo.js';
import { JST } from '../jp/domain/jpCalendar.js';
import type { JpReportDto } from '../jp/api/types.js';
import { hkEntries, jpEntries, SymbolIndex } from './search.js';
import { addWatch, listWatch, MAX_WATCH, removeWatch, type WatchMarket } from './store.js';

export interface WatchlistOptions {
  /** Symbol lists to search and validate against; tests pass fixed ones. */
  index?: SymbolIndex;
  /** Called after a symbol is newly added to someone's list (not for re-adds). Errors are caught and logged. */
  onWatchAdded?: (market: WatchMarket, symbol: string) => void;
}

// Used only while a market's index has not loaded yet, so adding a symbol right after a restart still works.
const SYMBOL_FORMAT = /^[A-Z0-9&.\-]{1,24}$/;

const asMarket = (v: unknown): WatchMarket | null => (v === 'US' || v === 'IN' || v === 'HK' || v === 'JP' ? v : null);
const normalize = (market: WatchMarket, raw: string): string => {
  if (market === 'US') return normalizeTicker(raw);
  if (market === 'JP') return raw.trim().toUpperCase();
  if (market === 'HK') { const t = raw.trim(); return /^\d{1,4}$/.test(t) ? t.padStart(4, '0') : t; }
  return raw.trim().toUpperCase();
};
const JP_CODE = /^[0-9][0-9A-Z]{3}$/;

/** GET /api/symbols, GET /api/watchlist, PUT/DELETE /api/watchlist/:market/:symbol for the signed-in user. */
export function registerWatchlist(
  app: FastifyInstance, db: Db, currentUser: (req: FastifyRequest) => string | null, now: () => number, opts: WatchlistOptions = {},
): void {
  const index = opts.index ?? new SymbolIndex();
  // The HK list is the fixed universe: load it now, so non-universe codes are rejected even right after a restart.
  if (index.size('HK') === 0) index.set('HK', hkEntries(db));
  // Same for Japan, once jp_stocks has been filled; until then a code is checked by format.
  if (index.size('JP') === 0) index.set('JP', jpEntries(db));
  const NOT_SIGNED_IN = { error: 'Not signed in' };
  const BAD_MARKET = { error: 'market must be US, IN, HK or JP' };

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

  // Per watched symbol: the next upcoming report and the latest past one, for the watchlist view.
  app.get('/api/watchlist/rows', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send(NOT_SIGNED_IN);
    const m = asMarket((req.query as { market?: string }).market);
    if (!m) return reply.code(400).send(BAD_MARKET);
    const symbols = listWatch(db, user, m);
    const today = DateTime.fromMillis(now(), { zone: m === 'US' ? ET : m === 'IN' ? IST : m === 'HK' ? HKT : JST });
    const from = today.minus({ days: 400 }).toISODate()!;
    const to = today.plus({ days: 400 }).toISODate()!;
    type AnyDto = ReportDto | InReportDto | HkReportDto | JpReportDto;
    const bySymbol = new Map<string, AnyDto[]>();
    const add = (k: string, d: AnyDto) => bySymbol.set(k, [...(bySymbol.get(k) ?? []), d]);
    if (m === 'US') for (const r of listForSymbols(db, symbols, from, to)) add(r.symbolKey, toDto(r));
    else if (m === 'IN') for (const r of listInForSymbols(db, symbols, from, to)) add(r.symbol, toInDto(r));
    else if (m === 'HK') for (const r of listHkForSymbols(db, symbols, from, to)) add(r.code, toHkDto(r));
    else for (const r of listJpForSymbols(db, symbols, from, to)) add(r.code, toJpDto(r));
    const history = new Map<string, WatchHistoryDto>(); // latest Yahoo-backup quarter per US symbol
    if (m === 'US' && symbols.length) {
      const h = db.prepare(`SELECT symbol_key AS k, fiscal_quarter AS q, period_end AS p, eps_actual AS e FROM watch_history
          WHERE symbol_key IN (${symbols.map(() => '?').join(',')}) AND eps_actual IS NOT NULL ORDER BY period_end`).all(...symbols) as { k: string; q: string; p: string; e: number }[];
      for (const r of h) history.set(r.k, { source: 'yahoo', reportDate: null, fiscalQuarter: r.q, periodEnd: r.p, eps: { actual: r.e } });
    }
    const hasActual = (d: AnyDto) =>
      d.eps.actual != null || d.revenue.actual != null || ('profit' in d && d.profit.actual != null);
    const body: WatchRowsResponse = { rows: symbols.map((symbol): WatchRow => {
      const all = bySymbol.get(symbol) ?? []; // oldest first
      // Past = released or has an actual. Anything else is pending (even if dated before today), so it is `next`.
      const isPast = (d: AnyDto) => d.releasedAt != null || hasActual(d);
      return {
        symbol,
        name: all[all.length - 1]?.name ?? index.nameOf(m, symbol) ?? symbol,
        next: all.find((d) => !isPast(d)) ?? null,
        latest: [...all].reverse().find(isPast) ?? history.get(symbol) ?? null,
      };
    }) };
    return body;
  });

  app.put('/api/watchlist/:market/:symbol', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send(NOT_SIGNED_IN);
    const params = req.params as { market: string; symbol: string };
    const m = asMarket(params.market);
    if (!m) return reply.code(400).send(BAD_MARKET);
    const symbol = normalize(m, params.symbol);
    if (m === 'JP' && !JP_CODE.test(symbol)) return reply.code(400).send({ error: 'Unknown symbol' });
    const known = index.size(m) > 0 ? index.has(m, symbol) : SYMBOL_FORMAT.test(symbol);
    if (!known) return reply.code(400).send({ error: 'Unknown symbol' });
    const current = listWatch(db, user, m);
    if (!current.includes(symbol)) {
      if (current.length >= MAX_WATCH) return reply.code(409).send({ error: `Watchlists are limited to ${MAX_WATCH} symbols` });
      addWatch(db, user, m, symbol, now());
      try { opts.onWatchAdded?.(m, symbol); } catch (e) { console.warn('onWatchAdded:', e instanceof Error ? e.message : e); }
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
