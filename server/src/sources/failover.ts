import { type Db, recordSourceError, recordSourceSuccess } from '../db/repo.js';

/** The source refused us (rate limit, challenge page). Back off instead of retrying hard. */
export class BlockedError extends Error {
  constructor(public readonly source: string, reason: string) {
    super(`${source} blocked: ${reason}`);
    this.name = 'BlockedError';
  }
}

const BLOCK_MARKERS = ['Request Rate Threshold Exceeded', 'Access Denied', 'cf-challenge', 'Just a moment...'];

/** True for 403/429, or a 200 whose body is a block/challenge page (or HTML when JSON/XML was expected). */
export function looksBlocked(status: number, body: string, expectHtml = false): boolean {
  if (status === 403 || status === 429) return true;
  if (BLOCK_MARKERS.some((m) => body.includes(m))) return true;
  return expectHtml && /<html/i.test(body);
}

const BACKOFF_MINUTES = [1, 2, 5, 15, 30];
const FAILURES_BEFORE_BACKOFF = 3;

type Step<T> = { name: string; run: () => Promise<T> };
type State = 'ok' | 'failing' | 'blocked' | 'backup';

export function createFailover(db: Db, now: () => number) {
  const failures = new Map<string, number>();
  const blockSteps = new Map<string, number>();

  const iso = (ms: number) => new Date(ms).toISOString();
  const setState = (source: string, state: State, blockedUntil: string | null | undefined) => {
    if (blockedUntil === undefined) {
      db.prepare(`INSERT INTO source_status (source, state) VALUES (?, ?)
          ON CONFLICT (source) DO UPDATE SET state = excluded.state`).run(source, state);
    } else {
      db.prepare(`INSERT INTO source_status (source, state, blocked_until) VALUES (?, ?, ?)
          ON CONFLICT (source) DO UPDATE SET state = excluded.state, blocked_until = excluded.blocked_until`)
        .run(source, state, blockedUntil);
    }
  };
  const blockedUntil = (source: string): number => {
    const row = db.prepare('SELECT blocked_until AS b FROM source_status WHERE source = ?').get(source) as { b: string | null } | undefined;
    return row?.b ? Date.parse(row.b) : 0;
  };
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  return async function failover<T>(fast: Step<T>, backup: Step<T> | null): Promise<{ value: T; via: 'fast' | 'backup' } | null> {
    let fastState: State = 'failing';
    let fastBlockedUntil: string | null | undefined;

    if (blockedUntil(fast.name) > now()) {
      fastState = 'blocked';
    } else {
      try {
        const value = await fast.run();
        failures.delete(fast.name);
        blockSteps.delete(fast.name);
        recordSourceSuccess(db, fast.name, iso(now()));
        setState(fast.name, 'ok', null);
        return { value, via: 'fast' };
      } catch (err) {
        recordSourceError(db, fast.name, message(err), iso(now()));
        if (err instanceof BlockedError) {
          const step = blockSteps.get(fast.name) ?? 0;
          blockSteps.set(fast.name, step + 1);
          fastBlockedUntil = iso(now() + BACKOFF_MINUTES[Math.min(step, BACKOFF_MINUTES.length - 1)]! * 60_000);
          fastState = 'blocked';
        } else {
          const n = (failures.get(fast.name) ?? 0) + 1;
          failures.set(fast.name, n);
          if (n >= FAILURES_BEFORE_BACKOFF) fastBlockedUntil = iso(now() + 60_000);
        }
      }
    }

    if (backup) {
      try {
        const value = await backup.run();
        recordSourceSuccess(db, backup.name, iso(now()));
        setState(fast.name, 'backup', fastBlockedUntil);
        return { value, via: 'backup' };
      } catch (err) {
        recordSourceError(db, backup.name, message(err), iso(now()));
      }
    }
    setState(fast.name, fastState, fastBlockedUntil);
    return null;
  };
}
