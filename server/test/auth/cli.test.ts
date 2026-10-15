import { beforeEach, expect, test } from 'vitest';
import { runUsersCommand } from '../../src/auth/cli.js';
import { getPasswordHash, isAdmin } from '../../src/auth/store.js';
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

test('admin on|off grants and revokes admin; list marks admins', async () => {
  await runUsersCommand(db, ['set', '1A', '00000000'], log);
  await runUsersCommand(db, ['set', '2A', '00000000'], log);
  out = [];
  expect(await runUsersCommand(db, ['admin', '1a', 'on'], log)).toBe(0);
  expect(out).toEqual(['1A is now an admin']);
  expect(isAdmin(db, '1A')).toBe(true);
  expect(isAdmin(db, '2A')).toBe(false);
  out = [];
  await runUsersCommand(db, ['list'], log);
  expect(out[0]).toMatch(/^1A\s.*admin/);
  expect(out[1]).not.toMatch(/admin/);
  out = [];
  expect(await runUsersCommand(db, ['admin', '1A', 'off'], log)).toBe(0);
  expect(out).toEqual(['1A is no longer an admin']);
  expect(isAdmin(db, '1A')).toBe(false);
});

test('admin for an unknown user fails without creating it', async () => {
  expect(await runUsersCommand(db, ['admin', '9Z', 'on'], log)).toBe(1);
  expect(out).toEqual(['No user 9Z']);
  expect(getPasswordHash(db, '9Z')).toBeNull();
});

test('set accepts email-style IDs', async () => {
  expect(await runUsersCommand(db, ['set', 'jane@example.com', '00000000'], log)).toBe(0);
  expect(out).toEqual(['Created user JANE@EXAMPLE.COM']);
});

test('bad usage prints help and fails', async () => {
  for (const args of [[], ['set', '1A'], ['set', 'a b', 'pw'], ['nope'], ['admin', '1A'], ['admin', '1A', 'yes'], ['admin', 'a b', 'on']]) {
    out = [];
    expect(await runUsersCommand(db, args, log)).toBe(1);
    expect(out.join('\n')).toMatch(/Usage|User ID/);
  }
});
