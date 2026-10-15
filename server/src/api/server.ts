import Fastify, { type FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { counts, type Db, getReport, listRange, listSourceStatus } from '../db/repo.js';
import { toDto } from './dto.js';
import type { EarningsResponse, StatusResponse } from './types.js';

const MAX_RANGE_DAYS = 400;

function validDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function buildServer(db: Db): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/earnings', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!validDate(q.from) || !validDate(q.to) || q.from > q.to) {
      return reply.code(400).send({ error: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
    if (days > MAX_RANGE_DAYS) return reply.code(400).send({ error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    const minCap = q.minCap ? Number(q.minCap) : null;
    if (minCap != null && !Number.isFinite(minCap)) return reply.code(400).send({ error: 'minCap must be a number' });

    const rows = listRange(db, { from: q.from, to: q.to, minCap, q: q.q?.trim() || null }).map(toDto);
    const body: EarningsResponse = { rows, sources: listSourceStatus(db) };
    return body;
  });

  app.get('/api/earnings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? getReport(db, id) : undefined;
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return toDto(r);
  });

  app.get('/api/status', async () => {
    const body: StatusResponse = { sources: listSourceStatus(db), counts: counts(db) };
    return body;
  });

  return app;
}
