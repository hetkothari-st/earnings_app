import type { Db } from '../db/repo.js';
import { ensureAuthSchema, listUsers, normalizeUserId, setUser } from './store.js';

const USAGE = [
  'Usage:',
  '  npm run users -w server -- set <id> <password>   create a user or change their password',
  '  npm run users -w server -- list                  list user IDs',
].join('\n');

/** Runs one `users` CLI command against the DB. Returns the process exit code. */
export async function runUsersCommand(db: Db, args: string[], log: (line: string) => void): Promise<number> {
  ensureAuthSchema(db);
  const [cmd, id, password] = args;
  if (cmd === 'list' && args.length === 1) {
    for (const u of listUsers(db)) log(`${u.id.padEnd(12)} created ${u.createdAt}`);
    return 0;
  }
  if (cmd === 'set' && args.length === 3 && id && password) {
    const normalized = normalizeUserId(id);
    if (!normalized) {
      log('User ID must be 1-32 letters, digits, dot, dash or underscore.');
      return 1;
    }
    const result = await setUser(db, normalized, password, new Date().toISOString());
    log(result === 'created' ? `Created user ${normalized}` : `Updated password for ${normalized}`);
    return 0;
  }
  log(USAGE);
  return 1;
}
