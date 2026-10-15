import type { FastifyInstance } from 'fastify';

type Listener = (frame: string) => void;

/** Fan-out of server-sent events to every open browser. */
export class Broadcaster {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const l of this.listeners) l(frame);
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** GET /api/stream: a server-sent event stream; `results` events carry the ids whose actuals just changed. */
export function registerStream(app: FastifyInstance, broadcaster: Broadcaster): void {
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const off = broadcaster.subscribe((frame) => reply.raw.write(frame));
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(keepAlive); off(); });
  });
}
