import Fastify, { type FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { counts, type Db, getReport, listRange, listSourceStatus } from '../db/repo.js';
import { registerAdmin } from '../auth/adminRoutes.js';
import { registerAuth } from '../auth/routes.js';
import { registerNotes } from '../notes/routes.js';
import { registerWatchlist, type WatchlistOptions } from '../watchlist/routes.js';
import { type InServerOptions, registerInRoutes } from '../india/api/routes.js';
import { type HkServerOptions, registerHkRoutes } from '../hk/api/routes.js';
import { type JpServerOptions, registerJpRoutes } from '../jp/api/routes.js';
import { type EuropeAdminSource, type EuropeServerOptions, registerEuropeAdmin, registerEuropeRoutes } from '../europe/api/routes.js';
import { marketToday } from '../europe/domain/calendars.js';
import { config } from '../config.js';
import { EU_SYMBOL, UK_SYMBOL } from '../watchlist/routes.js';
import { todayET } from '../domain/marketCalendar.js';
import { todayHKT } from '../hk/domain/hkCalendar.js';
import { todayJST } from '../jp/domain/jpCalendar.js';
import { todayIST } from '../india/domain/nseCalendar.js';
import { computeCoverage } from '../jobs/coverage.js';
import { normalizeTicker } from '../domain/ticker.js';
import { toDto } from './dto.js';
import { registerWebApp } from './static.js';
import type { IndexQuote } from '../sources/yahoo.js';
import type { EarningsResponse, MarketIndexDto, MarketsResponse, StatusResponse } from './types.js';

/** Five largest exchanges by listed market value plus India's two, each with its headline index. */
export const MARKET_INDICES = [
  { exchange: 'NYSE', index: 'S&P 500', symbol: '^GSPC' },
  { exchange: 'Nasdaq', index: 'Nasdaq Composite', symbol: '^IXIC' },
  { exchange: 'Shanghai', index: 'SSE Composite', symbol: '000001.SS' },
  { exchange: 'Tokyo', index: 'Nikkei 225', symbol: '^N225' },
  { exchange: 'Euronext', index: 'Euronext 100', symbol: '^N100' },
  // India, for the app's users
  { exchange: 'NSE', index: 'NIFTY 50', symbol: '^NSEI' },
  { exchange: 'BSE', index: 'SENSEX', symbol: '^BSESN' },
] as const;
const MARKETS_TTL_MS = 15_000;

export interface ServerOptions {
  indexQuote?: (symbol: string) => Promise<IndexQuote>;
  /** Require a signed-in session for data routes. Off by default so route tests need not log in. */
  requireAuth?: boolean;
  /** Clock for sessions and login rate limiting (ms since epoch). */
  now?: () => number;
  /** Folder with the built web app to serve (production). */
  webRoot?: string;
  /** Trust X-Forwarded-* from any proxy (hosted behind a platform proxy) instead of loopback only. */
  trustProxy?: boolean;
  /** Live price snapshot (real-time stream). */
  prices?: () => Record<string, unknown>;
  /** Records the US symbols a signed-in user currently sees (their price slots). */
  setVisible?: (userId: string, symbols: string[]) => void;
  /** India live data and Zerodha controls. */
  india?: InServerOptions;
  /** Hong Kong live data. */
  hk?: HkServerOptions;
  /** Japan live data. */
  jp?: JpServerOptions;
  /** UK and Europe live data, per market. */
  europe?: { UK?: EuropeServerOptions; EU?: EuropeServerOptions; admin?: EuropeAdminSource };
  /** Symbol index for the watchlist (search and validation). */
  watchlist?: WatchlistOptions;
}

const MAX_RANGE_DAYS = 400;
/** Admin source while the live Europe pieces are not running (tests): Tradegate as configured, never polled. */
const NO_EUROPE_LIVE: EuropeAdminSource = () => ({
  tradegate: { state: config.tradegatePrices ? 'on' : 'off-env', backoffUntil: null, lastPollAt: null },
});

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function buildServer(db: Db, opts: ServerOptions = {}): FastifyInstance {
  // The API listens on loopback behind a proxy; trust its X-Forwarded-* headers for client IP and protocol.
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ? true : 'loopback' });
  if (opts.webRoot) registerWebApp(app, opts.webRoot);
  const currentUser = registerAuth(app, db, { requireAuth: opts.requireAuth ?? false, now: opts.now });
  registerNotes(app, db, currentUser, opts.now ?? Date.now);
  registerWatchlist(app, db, currentUser, opts.now ?? Date.now, opts.watchlist);
  registerAdmin(app, db, currentUser, opts.now ?? Date.now);
  registerInRoutes(app, db, currentUser, opts.now ?? Date.now, opts.india);
  registerHkRoutes(app, db, currentUser, opts.now ?? Date.now, opts.hk);
  registerJpRoutes(app, db, currentUser, opts.now ?? Date.now, opts.jp);
  registerEuropeRoutes(app, db, 'UK', currentUser, opts.now ?? Date.now, opts.europe?.UK);
  registerEuropeRoutes(app, db, 'EU', currentUser, opts.now ?? Date.now, opts.europe?.EU);
  registerEuropeAdmin(app, db, opts.europe?.admin ?? NO_EUROPE_LIVE, currentUser);
  let marketsCache: { at: number; body: MarketsResponse } | null = null;

  app.get('/api/markets', async () => {
    if (marketsCache && Date.now() - marketsCache.at < MARKETS_TTL_MS) return marketsCache.body;
    const indices: MarketIndexDto[] = await Promise.all(MARKET_INDICES.map(async (m) => {
      try {
        if (!opts.indexQuote) throw new Error('index quotes not configured');
        const q = await opts.indexQuote(m.symbol);
        return { ...m, price: q.price, changePct: q.changePct, asOf: q.asOf, currency: q.currency };
      } catch {
        return { ...m, price: null, changePct: null, asOf: null, currency: null };
      }
    }));
    const body: MarketsResponse = { indices };
    marketsCache = { at: Date.now(), body };
    return body;
  });

  app.get('/api/prices', async () => ({ prices: opts.prices?.() ?? {} }));

  app.put('/api/live/visible', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    const body = (req.body ?? {}) as { market?: unknown; symbols?: unknown };
    if (body.market !== 'US' && body.market !== 'HK' && body.market !== 'JP' && body.market !== 'UK' && body.market !== 'EU') {
      return reply.code(400).send({ error: 'market must be US, HK, JP, UK or EU' });
    }
    if (!Array.isArray(body.symbols) || body.symbols.length > 100 || !body.symbols.every((s) => typeof s === 'string')) {
      return reply.code(400).send({ error: 'symbols must be an array of at most 100 strings' });
    }
    if (body.market === 'HK') {
      const codes = body.symbols as string[];
      if (!codes.every((c) => /^\d{4,5}$/.test(c))) return reply.code(400).send({ error: 'invalid symbol' });
      opts.hk?.setVisible?.(user, [...new Set(codes)]);
      return reply.code(204).send();
    }
    if (body.market === 'JP') {
      const codes = body.symbols as string[];
      if (!codes.every((c) => /^[0-9][0-9A-Z]{3}$/.test(c))) return reply.code(400).send({ error: 'invalid symbol' });
      opts.jp?.setVisible?.(user, [...new Set(codes)]);
      return reply.code(204).send();
    }
    if (body.market === 'UK' || body.market === 'EU') {
      // Ruling 2: Yahoo symbols upper-cased; UK takes `.L` only, EU the continental suffixes.
      const codes = (body.symbols as string[]).map((s) => s.trim().toUpperCase());
      const format = body.market === 'UK' ? UK_SYMBOL : EU_SYMBOL;
      if (!codes.every((c) => format.test(c))) return reply.code(400).send({ error: 'invalid symbol' });
      opts.europe?.[body.market]?.setVisible?.(user, [...new Set(codes)]);
      return reply.code(204).send();
    }
    const symbols = (body.symbols as string[]).map(normalizeTicker);
    if (!symbols.every((s) => /^[A-Z0-9.\-/]{1,12}$/.test(s))) return reply.code(400).send({ error: 'invalid symbol' });
    opts.setVisible?.(user, [...new Set(symbols)]);
    return reply.code(204).send();
  });

  app.get('/api/earnings', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!validDate(q.from) || !validDate(q.to) || q.from > q.to) {
      return reply.code(400).send({ error: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
    if (days > MAX_RANGE_DAYS) return reply.code(400).send({ error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    const minCap = q.minCap ? Number(q.minCap) : null;
    if (minCap != null && !Number.isFinite(minCap)) return reply.code(400).send({ error: 'minCap must be a number' });

    const rows = listRange(db, { from: q.from, to: q.to, minCap, q: q.q?.trim() || null }).map(toDto);
    const body: EarningsResponse = { rows, sources: listSourceStatus(db) };
    return body;
  });

  app.get('/api/earnings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? getReport(db, id) : undefined;
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return toDto(r);
  });

  app.get('/api/status', async () => {
    const body: StatusResponse = {
      sources: listSourceStatus(db), counts: counts(db),
      coverage: { US: computeCoverage(db, 'US', todayET()), IN: computeCoverage(db, 'IN', todayIST()), HK: computeCoverage(db, 'HK', todayHKT()), JP: computeCoverage(db, 'JP', todayJST()),
        UK: computeCoverage(db, 'UK', marketToday('UK')), EU: computeCoverage(db, 'EU', marketToday('EU')) },
    };
    return body;
  });

  return app;
}
