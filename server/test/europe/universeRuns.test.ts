import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { openDb } from '../../src/db/repo.js';
import type { EuropeAdminDto } from '../../src/europe/api/types.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { refreshEuropeStocks } from '../../src/europe/jobs/stocks.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';

const NOW = '2026-10-26T05:00:00.000Z';
const down = async (): Promise<never> => { throw new Error('source down'); };

const ENTRY: EuropeUniverseEntry = {
  market: 'UK', symbol: 'AZN.L', isin: 'GB0009895292', lei: null, name: 'AstraZeneca PLC', exchange: 'LSE', mic: 'XLON', country: 'GB',
  currency: 'GBp', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function ctxFor(db: ReturnType<typeof openDb>, build: Awaited<ReturnType<EuropeJobContext['buildUniverse']>>, now = NOW): EuropeJobContext {
  return {
    db, market: 'UK', now: () => now, today: () => now.slice(0, 10),
    yahooCalendar: down, yahooSummary: down, yahooQuotes: down, yahooCloses: down, buildUniverse: async () => build, bankHolidaysJson: down,
    esef: { recent: down, facts: down }, prnFeed: down, dila: null, optionChain: down, secHttp: null, tierA: () => [],
  };
}

async function admin(db: ReturnType<typeof openDb>): Promise<EuropeAdminDto> {
  const clock = Date.parse(NOW);
  // A fresh server on the same database: a restart. No live universe state is passed.
  const app = buildServer(db, { requireAuth: true, now: () => clock });
  const cookie = `session=${createSession(db, 'ADM', clock).token}`;
  const res = await app.inject({ url: '/api/admin/europe', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as EuropeAdminDto;
}

describe('last complete universe build, stored', () => {
  it('a restart shows the stored left-out count and time; null when no complete build was recorded', async () => {
    const db = openDb(':memory:');
    ensureAuthSchema(db);
    db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 1)').run('ADM', 'x', '2026-10-01T00:00:00Z');

    // Never built: null, never 0.
    let body = await admin(db);
    expect(body.UK).toMatchObject({ leftOut: null, lastUniverseAt: null });

    // An incomplete build is not synced and records nothing.
    await refreshEuropeStocks(ctxFor(db, { entries: [ENTRY], leftOut: 9, complete: false }));
    body = await admin(db);
    expect(body.UK).toMatchObject({ leftOut: null, lastUniverseAt: null });

    // A complete, synced build is recorded and survives the restart.
    await refreshEuropeStocks(ctxFor(db, { entries: [ENTRY], leftOut: 42, complete: true }));
    body = await admin(db);
    expect(body.UK).toMatchObject({ leftOut: 42, lastUniverseAt: NOW });
    expect(body.EU).toMatchObject({ leftOut: null, lastUniverseAt: null });

    // A later incomplete build keeps the stored values.
    await refreshEuropeStocks(ctxFor(db, { entries: [ENTRY], leftOut: 1, complete: false }, '2026-11-02T05:00:00.000Z'));
    body = await admin(db);
    expect(body.UK).toMatchObject({ leftOut: 42, lastUniverseAt: NOW });
  });
});
