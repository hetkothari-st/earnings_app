import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import type { DatabaseSync } from 'node:sqlite';
import type { IndexQuote } from '../../sources/yahoo.js';
import { getJpReport, listJpRange } from '../db/jpRepo.js';
import { JP_INDICES } from '../universe.js';
import { toJpDto } from './dto.js';
import type { JpEarningsResponse, JpLivePriceDto, JpMarketDto } from './types.js';

const MAX_RANGE_DAYS = 400;
const MARKETS_TTL_MS = 15_000;

/** Live parts supplied by the running server (absent in route tests). */
export interface JpServerOptions {
  prices?: () => Record<string, JpLivePriceDto>;
  /** Index levels already known to the server; used when non-empty. */
  indices?: () => JpMarketDto[];
  /** Fallback: a Yahoo quote per JP_INDICES symbol. */
  indexQuote?: (yahooSymbol: string) => Promise<IndexQuote>;
}

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

/** The Japan read routes (`/api/admin/jp` is registered separately). */
export function registerJpRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  _currentUser: (req: FastifyRequest) => string | null,
  nowFn: () => number = Date.now,
  opts: JpServerOptions = {},
): void {
  app.get('/api/jp/earnings', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!validDate(q.from) || !validDate(q.to) || q.from > q.to) {
      return reply.code(400).send({ error: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
    if (days > MAX_RANGE_DAYS) return reply.code(400).send({ error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    const body: JpEarningsResponse = { rows: listJpRange(db, { from: q.from, to: q.to, q: q.q?.trim() || null }).map(toJpDto) };
    return body;
  });

  app.get('/api/jp/earnings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? getJpReport(db, id) : undefined;
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return toJpDto(r);
  });

  app.get('/api/jp/prices', async () => ({ prices: opts.prices?.() ?? {} }));

  let marketsCache: { at: number; body: { indices: JpMarketDto[] } } | null = null;
  app.get('/api/jp/markets', async () => {
    const known = opts.indices?.() ?? [];
    if (known.length > 0) return { indices: known };
    if (marketsCache && nowFn() - marketsCache.at < MARKETS_TTL_MS) return marketsCache.body;
    const indices = await Promise.all(JP_INDICES.map(async (m): Promise<JpMarketDto> => {
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
