import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { type Db, openDb } from '../../src/db/repo.js';
import { SymbolIndex, type SymbolEntry } from '../../src/watchlist/search.js';
import { addWatch, allWatched, listWatch, removeWatch } from '../../src/watchlist/store.js';

const US: SymbolEntry[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Nasdaq' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway Inc', exchange: 'NYSE' },
  { symbol: 'REL', name: 'Relx Plc', exchange: 'NYSE' },
];
const IN: SymbolEntry[] = [
  { symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES', exchange: 'NSE' },
  { symbol: 'INFY', name: 'INFOSYS', exchange: 'NSE' },
  { symbol: 'M&M', name: 'MAHINDRA & MAHINDRA', exchange: 'NSE' },
  { symbol: 'AREL', name: 'RELIABLE CO', exchange: 'NSE' },
];

let db: Db;
let app: FastifyInstance;
let clock: number;
beforeEach(() => {
  db = openDb(':memory:');
  ensureAuthSchema(db);
  for (const id of ['1A', '2A']) db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)').run(id, 'x', '2026-10-01T00:00:00Z');
  clock = Date.parse('2026-10-15T12:00:00Z');
  const index = new SymbolIndex();
  index.set('US', US);
  index.set('IN', IN);
  app = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index } });
});

const as = (id: string) => ({ cookie: `session=${createSession(db, id, clock).token}` });
const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, headers: Record<string, string> = {}) => app.inject({ method, url, headers });

describe('watchlist store', () => {
  test('add, list, remove per user and per market', () => {
    addWatch(db, '1A', 'IN', 'INFY', clock);
    addWatch(db, '1A', 'IN', 'INFY', clock);
    addWatch(db, '1A', 'IN', 'RELIANCE', clock);
    addWatch(db, '2A', 'IN', 'TCS', clock);
    expect(listWatch(db, '1A', 'IN')).toEqual(['INFY', 'RELIANCE']);
    expect(listWatch(db, '2A', 'IN')).toEqual(['TCS']);
    expect(allWatched(db, 'IN')).toEqual(['INFY', 'RELIANCE', 'TCS']);
    removeWatch(db, '1A', 'IN', 'INFY');
    expect(listWatch(db, '1A', 'IN')).toEqual(['RELIANCE']);
    expect(listWatch(db, '2A', 'IN')).toEqual(['TCS']);
  });
});

describe('watchlist routes', () => {
  test('add, list, remove per user and per market', async () => {
    expect((await call('PUT', '/api/watchlist/IN/INFY', as('1A'))).statusCode).toBe(204);
    expect((await call('PUT', '/api/watchlist/IN/M%26M', as('1A'))).statusCode).toBe(204);
    expect((await call('PUT', '/api/watchlist/IN/INFY', as('2A'))).statusCode).toBe(204);
    expect((await call('GET', '/api/watchlist?market=IN', as('1A'))).json()).toEqual({ symbols: ['INFY', 'M&M'] });
    expect((await call('DELETE', '/api/watchlist/IN/INFY', as('1A'))).statusCode).toBe(204);
    expect((await call('GET', '/api/watchlist?market=IN', as('1A'))).json()).toEqual({ symbols: ['M&M'] });
    expect((await call('GET', '/api/watchlist?market=IN', as('2A'))).json()).toEqual({ symbols: ['INFY'] });
  });

  test('US and IN lists are separate', async () => {
    await call('PUT', '/api/watchlist/US/brk.b', as('1A'));
    await call('PUT', '/api/watchlist/IN/INFY', as('1A'));
    expect((await call('GET', '/api/watchlist?market=US', as('1A'))).json()).toEqual({ symbols: ['BRK-B'] });
    expect((await call('GET', '/api/watchlist?market=IN', as('1A'))).json()).toEqual({ symbols: ['INFY'] });
    expect((await call('PUT', '/api/watchlist/US/INFY', as('1A'))).statusCode).toBe(400);
  });

  test('unknown symbol 400; 201st symbol 409; no session 401', async () => {
    expect((await call('PUT', '/api/watchlist/IN/NOPE', as('1A'))).statusCode).toBe(400);
    expect((await call('PUT', '/api/watchlist/XX/INFY', as('1A'))).statusCode).toBe(400);
    for (let i = 0; i < 199; i++) addWatch(db, '1A', 'IN', `S${i}`, clock);
    addWatch(db, '1A', 'IN', 'RELIANCE', clock);
    expect((await call('PUT', '/api/watchlist/IN/INFY', as('1A'))).statusCode).toBe(409);
    expect((await call('PUT', '/api/watchlist/IN/RELIANCE', as('1A'))).statusCode).toBe(204); // already there: not a new one
    expect((await call('PUT', '/api/watchlist/IN/INFY')).statusCode).toBe(401);
    expect((await call('GET', '/api/watchlist?market=IN')).statusCode).toBe(401);
    expect((await call('DELETE', '/api/watchlist/IN/INFY')).statusCode).toBe(401);
    expect((await call('GET', '/api/symbols?market=IN&q=rel')).statusCode).toBe(401);
  });

  test('an empty index accepts only well-formed symbols', async () => {
    const index = new SymbolIndex();
    app = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index } });
    expect((await call('PUT', '/api/watchlist/IN/INFY', as('1A'))).statusCode).toBe(204);
    expect((await call('PUT', '/api/watchlist/IN/bad%20sym', as('1A'))).statusCode).toBe(400);
    expect((await call('GET', '/api/symbols?market=IN&q=inf', as('1A'))).json()).toEqual({ results: [] });
  });
});

describe('symbol search', () => {
  const search = async (market: string, q: string) => (await call('GET', `/api/symbols?market=${market}&q=${encodeURIComponent(q)}`, as('1A'))).json().results as SymbolEntry[];

  test('search: "REL" ranks RELIANCE first; "infosys" finds INFY by name', async () => {
    expect((await search('IN', 'REL')).map((r) => r.symbol)).toEqual(['RELIANCE', 'AREL']);
    expect((await search('IN', 'infosys'))[0]).toEqual({ symbol: 'INFY', name: 'INFOSYS', exchange: 'NSE' });
  });

  test('exact symbol beats prefix; US uses its own index; blank query is empty', async () => {
    expect((await search('US', 'rel')).map((r) => r.symbol)).toEqual(['REL']);
    expect((await search('US', 'berkshire'))[0]!.symbol).toBe('BRK-B');
    expect(await search('US', '')).toEqual([]);
  });
});
