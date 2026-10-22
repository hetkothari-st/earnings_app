import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';

type Listener = (event: string, json: string) => void;

/** Fan-out of live events to every open browser (server-sent events and WebSockets). */
export class Broadcaster {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: string, data: unknown): void {
    const json = JSON.stringify(data);
    for (const l of this.listeners) l(event, json);
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** A socket with more than this waiting to go out is too slow to keep up: it is closed and reconnects. */
const MAX_BUFFERED = 1_000_000;

/**
 * GET /api/stream: a server-sent event stream; `results` events carry the ids whose actuals just changed.
 * /api/ws: the same events over a WebSocket, one text frame each as "<event>\n<json>". Proxies that
 * hold back event streams (Cloudflare quick tunnels do) pass WebSocket frames straight through.
 * `authorized` gets the upgrade request's Cookie header.
 */
export function registerStream(
  app: FastifyInstance, broadcaster: Broadcaster, authorized: (cookie: string | undefined) => boolean = () => true,
): void {
  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.url?.split('?')[0] !== '/api/ws') return socket.destroy();
    if (!authorized(req.headers.cookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const off = broadcaster.subscribe((event, json) => {
        if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
        ws.send(`${event}\n${json}`);
      });
      const keepAlive = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 25_000);
      ws.on('close', () => { clearInterval(keepAlive); off(); });
      ws.on('error', () => ws.terminate());
    });
  });
  app.addHook('onClose', async () => { for (const c of wss.clients) c.terminate(); wss.close(); });

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // proxies must pass each event on at once
    });
    reply.raw.write(': connected\n\n');
    const off = broadcaster.subscribe((event, json) => reply.raw.write(`event: ${event}\ndata: ${json}\n\n`));
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(keepAlive); off(); });
  });
}
