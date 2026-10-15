import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/repo.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { hashPassword, verifyPassword } from './password.js';
import { LoginLimiter } from './rateLimit.js';
import {
  createSession, deleteSession, ensureAuthSchema, findSessionUser, getHidden, getPasswordHash, normalizeUserId,
  SESSION_TTL_MS, setHidden,
} from './store.js';

export const SESSION_COOKIE = 'session';
const WRONG = { error: 'Wrong user ID or password' };
const NOT_SIGNED_IN = { error: 'Not signed in' };
/** Reachable without a session. */
const PUBLIC_PATHS = new Set(['/api/login', '/api/logout', '/api/me']);
const MAX_HIDDEN = 2000;
const MAX_SYMBOL_LEN = 12;

export interface AuthOptions {
  /** Require a session for every /api route except login, logout and me. */
  requireAuth: boolean;
  now?: () => number;
  limiter?: LoginLimiter;
}

export function registerAuth(app: FastifyInstance, db: Db, opts: AuthOptions): void {
  ensureAuthSchema(db);
  const now = opts.now ?? Date.now;
  const limiter = opts.limiter ?? new LoginLimiter();
  const users = new WeakMap<FastifyRequest, string>();
  // Unknown IDs are still checked against a real hash so response time does not reveal which IDs exist.
  let dummyHash: Promise<string> | null = null;

  const tokenOf = (req: FastifyRequest) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const userOf = (req: FastifyRequest): string | null => {
    const token = tokenOf(req);
    return token ? findSessionUser(db, token, now()) : null;
  };
  const isHttps = (req: FastifyRequest) => req.protocol === 'https';

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!.toLowerCase();
    if (!path.startsWith('/api') || PUBLIC_PATHS.has(path)) return;
    const user = userOf(req);
    if (user) users.set(req, user);
    else if (opts.requireAuth || path === '/api/hidden') return reply.code(401).send(NOT_SIGNED_IN);
  });

  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: unknown; password?: unknown };
    const id = normalizeUserId(body.id) ?? '';
    const ip = req.ip;
    const wait = limiter.check(id, ip, now());
    if (wait != null) {
      const minutes = Math.max(1, Math.ceil(wait / 60_000));
      return reply.code(429).send({ error: `Too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}` });
    }
    const password = typeof body.password === 'string' ? body.password : '';
    const stored = id ? getPasswordHash(db, id) : null;
    const ok = await verifyPassword(password, stored ?? await (dummyHash ??= hashPassword('dummy-password')));
    if (!stored || !ok || !password) {
      limiter.fail(id, ip, now());
      return reply.code(401).send(WRONG);
    }
    limiter.succeed(id);
    const { token } = createSession(db, id, now());
    reply.header('set-cookie', serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_MS / 1000, secure: isHttps(req) }));
    return reply.code(204).send();
  });

  app.post('/api/logout', async (req, reply) => {
    const token = tokenOf(req);
    if (token) deleteSession(db, token);
    reply.header('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: isHttps(req) }));
    return reply.code(204).send();
  });

  app.get('/api/me', async (req, reply) => {
    const user = userOf(req);
    return user ? { id: user } : reply.code(401).send(NOT_SIGNED_IN);
  });

  const requireUser = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const user = users.get(req) ?? null;
    if (!user) void reply.code(401).send(NOT_SIGNED_IN);
    return user;
  };

  app.get('/api/hidden', async (req, reply) => {
    const user = requireUser(req, reply);
    return user ? { symbols: getHidden(db, user) } : reply;
  });

  app.put('/api/hidden', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const symbols = (req.body as { symbols?: unknown } | null)?.symbols;
    if (!Array.isArray(symbols) || symbols.length > MAX_HIDDEN
      || !symbols.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_SYMBOL_LEN)) {
      return reply.code(400).send({ error: `symbols must be an array of up to ${MAX_HIDDEN} strings of 1-${MAX_SYMBOL_LEN} characters` });
    }
    const unique = [...new Set(symbols as string[])];
    setHidden(db, user, unique, new Date(now()).toISOString());
    return { symbols: unique };
  });
}
