import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import type { DatabaseSync } from 'node:sqlite';
import { isAdmin } from '../../auth/store.js';
import { getInPref, getInReport, listInRange, setInPref } from '../db/inRepo.js';
import { toInDto } from './dto.js';
import type { InEarningsResponse, InLivePriceDto, InMarketDto, KiteStatusDto } from './types.js';

const MAX_RANGE_DAYS = 400;
const MARKETS_TTL_MS = 60_000;

/** Live parts supplied by the running server (absent in route tests). */
export interface InServerOptions {
  prices?: () => Record<string, InLivePriceDto>;
  /** Index levels from the Kite ticker, by index name. */
  indices?: () => Map<string, InLivePriceDto>;
  /** Fallback when Kite has no tick: Yahoo index quote. */
  yahooIndex?: (index: string) => Promise<{ price: number; prevClose: number | null } | null>;
  indexNames?: string[];
  kiteStatus?: () => KiteStatusDto;
  kiteLogin?: () => Promise<void>;
  /** Backup login on Zerodha's own page: the URL to send the admin to, and the callback's token exchange. */
  kiteBrowserStart?: () => string;
  kiteBrowserComplete?: (requestToken: string, state: string) => Promise<boolean>;
}

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function registerInRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  currentUser: (req: FastifyRequest) => string | null,
  nowFn: () => number = Date.now,
  opts: InServerOptions = {},
): void {
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const user = currentUser(req);
    if (!user) void reply.code(401).send({ error: 'Not signed in' });
    else if (!isAdmin(db, user)) void reply.code(403).send({ error: 'Admins only' });
    else return true;
    return false;
  };

  app.get('/api/in/earnings', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!validDate(q.from) || !validDate(q.to) || q.from > q.to) {
      return reply.code(400).send({ error: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
    if (days > MAX_RANGE_DAYS) return reply.code(400).send({ error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    const body: InEarningsResponse = { rows: listInRange(db, { from: q.from, to: q.to, q: q.q?.trim() || null }).map(toInDto) };
    return body;
  });

  app.get('/api/in/earnings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? getInReport(db, id) : undefined;
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return toInDto(r);
  });

  app.get('/api/in/prices', async () => ({ prices: opts.prices?.() ?? {} }));

  let marketsCache: { at: number; body: { indices: InMarketDto[] } } | null = null;
  app.get('/api/in/markets', async () => {
    const kite = opts.indices?.() ?? new Map<string, InLivePriceDto>();
    const names = opts.indexNames ?? [];
    // Kite ticks are live; only a missing one needs the (cached) Yahoo fallback.
    if (names.every((n) => kite.has(n)) || !marketsCache || nowFn() - marketsCache.at >= MARKETS_TTL_MS) {
      const indices = await Promise.all(names.map(async (index): Promise<InMarketDto> => {
        const k = kite.get(index);
        if (k) return { index, price: k.price, changePct: k.changePct, asOf: k.at, source: 'kite' };
        const y = await opts.yahooIndex?.(index).catch(() => null);
        if (!y) return { index, price: null, changePct: null, asOf: null, source: null };
        const changePct = y.prevClose ? Math.round(((y.price - y.prevClose) / y.prevClose) * 10000) / 100 : null;
        return { index, price: y.price, changePct, asOf: new Date(nowFn()).toISOString(), source: 'yahoo' };
      }));
      marketsCache = { at: nowFn(), body: { indices } };
    }
    return marketsCache.body;
  });

  app.get('/api/prefs', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    return { market: getInPref(db, user) };
  });

  app.put('/api/prefs', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    const body = (req.body ?? {}) as { market?: unknown };
    if (body.market !== 'US' && body.market !== 'IN' && body.market !== 'HK' && body.market !== 'JP' && body.market !== 'UK' && body.market !== 'EU') {
      return reply.code(400).send({ error: 'market must be "US", "IN", "HK", "JP", "UK" or "EU"' });
    }
    setInPref(db, user, body.market, new Date(nowFn()).toISOString());
    return reply.code(204).send();
  });

  /** Zerodha connection for the admin page. Never includes credentials or the access token. */
  app.get('/api/admin/kite', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const body: KiteStatusDto = opts.kiteStatus?.() ?? { configured: false, connected: false, lastLoginAt: null, lastError: null, lastErrorAt: null };
    return body;
  });

  app.post('/api/admin/kite/login', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!opts.kiteLogin) return reply.code(400).send({ error: 'Automatic login is off. Use "Log in on the Zerodha page".' });
    await opts.kiteLogin();
    return opts.kiteStatus?.() ?? {};
  });

  app.post('/api/admin/kite/browser-login', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!opts.kiteBrowserStart) return reply.code(400).send({ error: 'Zerodha is not configured' });
    return { url: opts.kiteBrowserStart() };
  });

  /** Zerodha redirects here after the admin logs in on its page (set this URL as the app's redirect URL on Kite). */
  app.get('/api/admin/kite/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    // Which step failed, without the token itself.
    console.log(`[kite-callback] signed in: ${!!currentUser(req)}, status: ${q.status ?? '-'}, token: ${!!q.request_token}, state: ${!!q.state}`);
    if (!requireAdmin(req, reply)) return reply;
    const ok = !!opts.kiteBrowserComplete && q.status === 'success' && !!q.request_token && !!q.state
      && await opts.kiteBrowserComplete(q.request_token, q.state);
    return reply.redirect(`/admin?kite=${ok ? 'ok' : 'error'}`);
  });
}
