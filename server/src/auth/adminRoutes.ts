import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/repo.js';
import { countAdmins, deleteUser, existingIds, getUser, insertUsers, updateUser, type UserChange } from './adminStore.js';
import { hashPassword } from './password.js';
import { isAdmin, listUsers, normalizeUserId, USER_ID_RULE } from './store.js';

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
export const MAX_BULK = 200;
const PASSWORD_RULE = `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`;

const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= MIN_PASSWORD && p.length <= MAX_PASSWORD;
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const lastAdmin = (id: string) => `${id} is the last admin; make someone else an admin first`;

/** GET/POST /api/admin/users, POST /api/admin/users/bulk, PATCH and DELETE /api/admin/users/:id. Admins only. */
export function registerAdmin(
  app: FastifyInstance, db: Db, currentUser: (req: FastifyRequest) => string | null, now: () => number,
): void {
  /** The signed-in admin, or null after sending 401/403. Rights are read from the DB on every request. */
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const user = currentUser(req);
    if (!user) void reply.code(401).send({ error: 'Not signed in' });
    else if (!isAdmin(db, user)) void reply.code(403).send({ error: 'Admins only' });
    else return user;
    return null;
  };
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
  const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const targetOf = (req: FastifyRequest) => normalizeUserId((req.params as { id: string }).id);

  app.get('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    // Sorted by ID so the table reads the same regardless of creation order.
    return listUsers(db).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const b = body(req);
    const id = normalizeUserId(b.id);
    if (!id) return bad(reply, USER_ID_RULE);
    if (!validPassword(b.password)) return bad(reply, PASSWORD_RULE);
    if (b.isAdmin !== undefined && typeof b.isAdmin !== 'boolean') return bad(reply, 'isAdmin must be true or false');
    if (existingIds(db, [id]).length) return reply.code(409).send({ error: `User ${id} already exists` });
    const hash = await hashPassword(b.password);
    if (existingIds(db, [id]).length) return reply.code(409).send({ error: `User ${id} already exists` });
    insertUsers(db, [{ id, hash, isAdmin: b.isAdmin === true }], new Date(now()).toISOString());
    return reply.code(201).send(getUser(db, id));
  });

  app.post('/api/admin/users/bulk', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const b = body(req);
    const prefix = b.prefix ?? '';
    const suffix = b.suffix ?? '';
    if (typeof prefix !== 'string') return bad(reply, 'prefix must be text');
    if (typeof suffix !== 'string') return bad(reply, 'suffix must be text');
    if (!isWhole(b.start) || b.start < 0) return bad(reply, 'start must be a whole number, 0 or more');
    if (!isWhole(b.count) || b.count < 1 || b.count > MAX_BULK) return bad(reply, `count must be a whole number from 1 to ${MAX_BULK}`);
    if (!validPassword(b.password)) return bad(reply, PASSWORD_RULE);
    const ids: string[] = [];
    for (let n = b.start; n < b.start + b.count; n++) {
      const id = normalizeUserId(`${prefix}${n}${suffix}`);
      if (!id) return bad(reply, `${USER_ID_RULE} (${prefix}${n}${suffix} is not valid)`);
      ids.push(id);
    }
    const conflict = (existing: string[]) =>
      reply.code(409).send({ error: `These user IDs already exist: ${existing.join(', ')}`, existing });
    let existing = existingIds(db, ids);
    if (existing.length) return conflict(existing);
    const password = b.password;
    const hashes = await Promise.all(ids.map(() => hashPassword(password)));
    existing = existingIds(db, ids); // someone may have added one while we were hashing
    if (existing.length) return conflict(existing);
    insertUsers(db, ids.map((id, i) => ({ id, hash: hashes[i]!, isAdmin: false })), new Date(now()).toISOString());
    return reply.code(201).send(ids.map((id) => getUser(db, id)));
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return reply;
    const id = targetOf(req);
    if (!id) return bad(reply, USER_ID_RULE);
    const b = body(req);
    if (b.password === undefined && b.newId === undefined && b.isAdmin === undefined) {
      return bad(reply, 'Nothing to change: send password, newId or isAdmin');
    }
    if (b.password !== undefined && !validPassword(b.password)) return bad(reply, PASSWORD_RULE);
    if (b.isAdmin !== undefined && typeof b.isAdmin !== 'boolean') return bad(reply, 'isAdmin must be true or false');
    let newId: string | undefined;
    if (b.newId !== undefined) {
      const n = normalizeUserId(b.newId);
      if (!n) return bad(reply, `New ID: ${USER_ID_RULE}`);
      newId = n;
    }
    const user = getUser(db, id);
    if (!user) return reply.code(404).send({ error: `No user ${id}` });
    if (b.isAdmin === false && user.isAdmin) {
      if (countAdmins(db) <= 1) return reply.code(409).send({ error: lastAdmin(id) });
      if (id === me) return reply.code(409).send({ error: 'You cannot remove your own admin role' });
    }
    if (newId !== undefined && newId !== id && existingIds(db, [newId]).length) {
      return reply.code(409).send({ error: `User ${newId} already exists` });
    }
    const change: UserChange = { newId };
    if (typeof b.isAdmin === 'boolean') change.isAdmin = b.isAdmin;
    if (typeof b.password === 'string') change.hash = await hashPassword(b.password);
    const changedMeanwhile = () => reply.code(409).send({ error: 'The user changed in the meantime; reload and try again' });
    // The target may have been renamed or deleted, or the new ID taken, while the password was hashing.
    if (!getUser(db, id)) return changedMeanwhile();
    try {
      updateUser(db, id, change);
    } catch {
      return changedMeanwhile();
    }
    return getUser(db, newId ?? id);
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return reply;
    const id = targetOf(req);
    if (!id) return bad(reply, USER_ID_RULE);
    const user = getUser(db, id);
    if (!user) return reply.code(404).send({ error: `No user ${id}` });
    if (user.isAdmin && countAdmins(db) <= 1) return reply.code(409).send({ error: lastAdmin(id) });
    if (id === me) return reply.code(409).send({ error: 'You cannot delete your own account' });
    deleteUser(db, id);
    return reply.code(204).send();
  });
}
