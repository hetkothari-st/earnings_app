import type { Db } from '../db/repo.js';
import { ensureAuthSchema, listUsers, normalizeUserId, setAdmin, setUser, USER_ID_RULE } from './store.js';

const USAGE = [
  'Usage:',
  '  npm run users -w server -- set <id> <password>   create a user or change their password',
  '  npm run users -w server -- admin <id> on|off     grant or revoke admin',
  '  npm run users -w server -- list                  list user IDs',
].join('\n');

/** Runs one `users` CLI command against the DB. Returns the process exit code. */
export async function runUsersCommand(db: Db, args: string[], log: (line: string) => void): Promise<number> {
  ensureAuthSchema(db);
  const [cmd, id, arg] = args;
  if (cmd === 'list' && args.length === 1) {
    for (const u of listUsers(db)) log(`${u.id.padEnd(12)} created ${u.createdAt}${u.isAdmin ? '  admin' : ''}`);
    return 0;
  }
  if ((cmd === 'set' || cmd === 'admin') && args.length === 3 && id && arg) {
    const normalized = normalizeUserId(id);
    if (!normalized) {
      log(`${USER_ID_RULE}.`);
      return 1;
    }
    if (cmd === 'set') {
      const result = await setUser(db, normalized, arg, new Date().toISOString());
      log(result === 'created' ? `Created user ${normalized}` : `Updated password for ${normalized}`);
      return 0;
    }
    if (arg === 'on' || arg === 'off') {
      if (!setAdmin(db, normalized, arg === 'on')) {
        log(`No user ${normalized}`);
        return 1;
      }
      log(arg === 'on' ? `${normalized} is now an admin` : `${normalized} is no longer an admin`);
      return 0;
    }
  }
  log(USAGE);
  return 1;
}
