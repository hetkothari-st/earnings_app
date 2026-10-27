import type { Db } from '../db/repo.js';
import type { Market } from '../india/api/types.js';

export type WatchMarket = Market;
export const MAX_WATCH = 200;

const ready = new WeakSet<Db>();

const WATCH_COLUMNS = `
      user_id TEXT NOT NULL,
      market TEXT NOT NULL CHECK (market IN ('US','IN','HK','JP')),
      symbol TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (user_id, market, symbol)
    `;

/** Older databases have a CHECK without 'HK' or 'JP'. Copy every row into a new table, then swap, all in one transaction. */
function rebuildWatchlists(db: Db): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DROP TABLE IF EXISTS watchlists_new;
      CREATE TABLE watchlists_new (${WATCH_COLUMNS});
      INSERT INTO watchlists_new (user_id, market, symbol, added_at) SELECT user_id, market, symbol, added_at FROM watchlists;
      DROP TABLE watchlists;
      ALTER TABLE watchlists_new RENAME TO watchlists;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function ensureWatchSchema(db: Db): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS watchlists (${WATCH_COLUMNS});`);
  const have = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'watchlists'").get() as { sql: string } | undefined)?.sql ?? '';
  if (!have.includes("'JP'")) rebuildWatchlists(db);
  ready.add(db);
}

/** The user's symbols in one market, oldest first. */
export function listWatch(db: Db, user: string, market: WatchMarket): string[] {
  ensureWatchSchema(db);
  return (db.prepare('SELECT symbol FROM watchlists WHERE user_id = ? AND market = ? ORDER BY added_at, symbol')
    .all(user, market) as { symbol: string }[]).map((r) => r.symbol);
}

/** Adds a symbol (no-op if already there). The 200-symbol limit is enforced by the route. */
export function addWatch(db: Db, user: string, market: WatchMarket, symbol: string, now: number): void {
  ensureWatchSchema(db);
  db.prepare('INSERT OR IGNORE INTO watchlists (user_id, market, symbol, added_at) VALUES (?, ?, ?, ?)')
    .run(user, market, symbol, new Date(now).toISOString());
}

export function removeWatch(db: Db, user: string, market: WatchMarket, symbol: string): void {
  ensureWatchSchema(db);
  db.prepare('DELETE FROM watchlists WHERE user_id = ? AND market = ? AND symbol = ?').run(user, market, symbol);
}

/** Every symbol any user watches in the market. */
export function allWatched(db: Db, market: WatchMarket): string[] {
  ensureWatchSchema(db);
  return (db.prepare('SELECT DISTINCT symbol FROM watchlists WHERE market = ? ORDER BY symbol').all(market) as { symbol: string }[])
    .map((r) => r.symbol);
}
