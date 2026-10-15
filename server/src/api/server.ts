import Fastify, { type FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { counts, type Db, getReport, listRange, listSourceStatus } from '../db/repo.js';
import { registerAdmin } from '../auth/adminRoutes.js';
import { registerAuth } from '../auth/routes.js';
import { registerNotes } from '../notes/routes.js';
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
const MARKETS_TTL_MS = 60_000;

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
}

const MAX_RANGE_DAYS = 400;

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function buildServer(db: Db, opts: ServerOptions = {}): FastifyInstance {
  // The API listens on loopback behind a proxy; trust its X-Forwarded-* headers for client IP and protocol.
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ? true : 'loopback' });
  if (opts.webRoot) registerWebApp(app, opts.webRoot);
  const currentUser = registerAuth(app, db, { requireAuth: opts.requireAuth ?? false, now: opts.now });
  registerNotes(app, db, currentUser, opts.now ?? Date.now);
  registerAdmin(app, db, currentUser, opts.now ?? Date.now);
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
    const body: StatusResponse = { sources: listSourceStatus(db), counts: counts(db) };
    return body;
  });

  return app;
}
