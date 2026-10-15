import { beforeEach, expect, test } from 'vitest';
import { runUsersCommand } from '../../src/auth/cli.js';
import { getPasswordHash } from '../../src/auth/store.js';
import { verifyPassword } from '../../src/auth/password.js';
import { type Db, openDb } from '../../src/db/repo.js';

let db: Db;
let out: string[];
const log = (s: string) => { out.push(s); };
beforeEach(() => { db = openDb(':memory:'); out = []; });

test('set creates, then changes, a user; list shows IDs only', async () => {
  expect(await runUsersCommand(db, ['set', '1a', '00000000'], log)).toBe(0);
  expect(out).toEqual(['Created user 1A']);
  expect(await verifyPassword('00000000', getPasswordHash(db, '1A')!)).toBe(true);

  expect(await runUsersCommand(db, ['set', '1A', 'n3w-pass'], log)).toBe(0);
  expect(out[1]).toBe('Updated password for 1A');
  expect(await verifyPassword('n3w-pass', getPasswordHash(db, '1A')!)).toBe(true);

  await runUsersCommand(db, ['set', '2A', '00000000'], log);
  out = [];
  expect(await runUsersCommand(db, ['list'], log)).toBe(0);
  expect(out.map((l) => l.split(/\s+/)[0])).toEqual(['1A', '2A']);
  expect(out.join('\n')).not.toMatch(/scrypt|00000000/);
});

test('bad usage prints help and fails', async () => {
  for (const args of [[], ['set', '1A'], ['set', 'a b', 'pw'], ['nope']]) {
    out = [];
    expect(await runUsersCommand(db, args, log)).toBe(1);
    expect(out.join('\n')).toMatch(/Usage|User ID/);
  }
});
