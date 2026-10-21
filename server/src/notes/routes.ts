import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Db, getReport } from '../db/repo.js';
import { getInReport } from '../india/db/inRepo.js';
import { listNotes, MAX_NOTE_LENGTH, setNote } from './store.js';

/** GET /api/notes and PUT /api/notes/:reportId for the signed-in user. */
export function registerNotes(
  app: FastifyInstance, db: Db, currentUser: (req: FastifyRequest) => string | null, now: () => number,
): void {
  app.get('/api/notes', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    return { notes: listNotes(db, user, now()) };
  });

  app.put('/api/notes/:reportId', async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    const reportId = Number((req.params as { reportId: string }).reportId);
    if (!Number.isInteger(reportId) || !(getReport(db, reportId) ?? getInReport(db, reportId))) return reply.code(404).send({ error: 'Report not found' });
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.length > MAX_NOTE_LENGTH) {
      return reply.code(400).send({ error: `text must be a string of up to ${MAX_NOTE_LENGTH} characters` });
    }
    const note = setNote(db, user, reportId, text, new Date(now()).toISOString());
    return note ?? reply.code(204).send();
  });
}
