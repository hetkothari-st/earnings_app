import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import type { DatabaseSync } from 'node:sqlite';
import { isAdmin } from '../../auth/store.js';
import { config } from '../../config.js';
import type { IndexQuote } from '../../sources/yahoo.js';
import { getEuropeReport, lastEsefAt, lastEuropeSecSeenAt, lastSignalAt, listEuropeRange } from '../db/europeRepo.js';
import { exchangesOf, type EuropeMarket, type ExchangeId } from '../exchanges.js';
import { EUROPE_INDICES } from '../sources/yahooEurope.js';
import { toEuropeDto } from './dto.js';
import type { EuropeAdminDto, EuropeEarningsResponse, EuropeLivePriceDto, EuropeMarketAdmin, EuropeMarketDto } from './types.js';

const MAX_RANGE_DAYS = 400;
const MARKETS_TTL_MS = 15_000;

/** Live parts supplied by the running server (absent in route tests). As `JpServerOptions`, with the Europe DTOs. */
export interface EuropeServerOptions {
  prices?: () => Record<string, EuropeLivePriceDto>;
  /** Index levels already known to the server; used when non-empty. */
  indices?: () => EuropeMarketDto[];
  /** Fallback: a Yahoo quote per EUROPE_INDICES symbol of the market. */
  indexQuote?: (yahooSymbol: string) => Promise<IndexQuote>;
  /** Records the symbols of this market a signed-in user currently sees (their price slots). */
  setVisible?: (userId: string, symbols: string[]) => void;
}

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

/** The read routes of one market: `/api/uk/*` or `/api/eu/*`. */
export function registerEuropeRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  market: EuropeMarket,
  _currentUser: (req: FastifyRequest) => string | null,
  nowFn: () => number = Date.now,
  opts: EuropeServerOptions = {},
): void {
  const base = `/api/${market === 'UK' ? 'uk' : 'eu'}`;
  const exchanges = new Set<string>(exchangesOf(market));

  app.get(`${base}/earnings`, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!validDate(q.from) || !validDate(q.to) || q.from > q.to) {
      return reply.code(400).send({ error: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
    if (days > MAX_RANGE_DAYS) return reply.code(400).send({ error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    const exchange = q.exchange?.trim().toUpperCase() || null;
    if (exchange && !exchanges.has(exchange)) {
      return reply.code(400).send({ error: `exchange must be one of ${[...exchanges].join(', ')}` });
    }
    const rows = listEuropeRange(db, market, { from: q.from, to: q.to, q: q.q?.trim() || null, exchange: exchange as ExchangeId | null });
    const body: EuropeEarningsResponse = { rows: rows.map(toEuropeDto) };
    return body;
  });

  app.get(`${base}/earnings/:id`, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? getEuropeReport(db, id) : undefined;
    if (!r || r.market !== market) return reply.code(404).send({ error: 'Not found' });
    return toEuropeDto(r);
  });

  app.get(`${base}/prices`, async () => ({ prices: opts.prices?.() ?? {} }));

  let marketsCache: { at: number; body: { indices: EuropeMarketDto[] } } | null = null;
  app.get(`${base}/markets`, async () => {
    const known = opts.indices?.() ?? [];
    if (known.length > 0) return { indices: known };
    if (marketsCache && nowFn() - marketsCache.at < MARKETS_TTL_MS) return marketsCache.body;
    const indices = await Promise.all(EUROPE_INDICES[market].map(async (m): Promise<EuropeMarketDto> => {
      try {
        if (!opts.indexQuote) throw new Error('index quotes not configured');
        const iq = await opts.indexQuote(m.yahoo);
        return { index: m.name, price: iq.price, changePct: iq.changePct, asOf: iq.asOf };
      } catch {
        return { index: m.name, price: null, changePct: null, asOf: null };
      }
    }));
    marketsCache = { at: nowFn(), body: { indices } };
    return marketsCache.body;
  });
}

/**
 * What only the running server knows for the admin page: the Tradegate poller and, once a universe build has run in
 * this process, its left-out count and time per market (not stored; null until then).
 */
export type EuropeAdminSource = () => Pick<EuropeAdminDto, 'tradegate'> & {
  universe?: Partial<Record<EuropeMarket, { leftOut: number; at: string }>>;
};

function marketAdmin(db: DatabaseSync, market: EuropeMarket, universe: { leftOut: number; at: string } | undefined): EuropeMarketAdmin {
  const c = db.prepare(`SELECT COALESCE(SUM(active = 1 AND level = 'full'), 0) AS full, COALESCE(SUM(active = 1 AND level != 'full'), 0) AS basic,
      COALESCE(SUM(active = 0), 0) AS inactive FROM europe_stocks WHERE market = ?`).get(market) as { full: number; basic: number; inactive: number };
  return {
    full: c.full, basic: c.basic, inactive: c.inactive,
    leftOut: universe?.leftOut ?? null, lastUniverseAt: universe?.at ?? null,
    lastSixKAt: lastEuropeSecSeenAt(db, market),
    // One PR Newswire feed serves both markets; DILA (the AMF) is EU only.
    lastPrnAt: lastSignalAt(db, 'prn'),
    lastDilaAt: market === 'EU' ? lastSignalAt(db, 'dila') : null,
    lastEsefAt: lastEsefAt(db, market),
    readerOn: market === 'UK' ? !!(config.fastFields.ukEps || config.fastFields.ukRevenue) : !!(config.fastFields.euEps || config.fastFields.euRevenue),
  };
}

/** `GET /api/admin/europe`: both markets' counts and source times, Tradegate and key settings. Admins only. Never includes a key. */
export function registerEuropeAdmin(
  app: FastifyInstance, db: DatabaseSync, admin: EuropeAdminSource, currentUser: (req: FastifyRequest) => string | null,
): void {
  app.get('/api/admin/europe', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    if (!isAdmin(db, user)) return reply.code(403).send({ error: 'Admins only' });
    const live = admin();
    const body: EuropeAdminDto = {
      UK: marketAdmin(db, 'UK', live.universe?.UK),
      EU: marketAdmin(db, 'EU', live.universe?.EU),
      tradegate: { state: live.tradegate.state, backoffUntil: live.tradegate.backoffUntil, lastPollAt: live.tradegate.lastPollAt },
      secConfigured: !!config.secUserAgent,
      openFigiConfigured: !!config.openFigiApiKey,
    };
    return body;
  });
}
