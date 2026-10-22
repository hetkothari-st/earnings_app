import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Broadcaster, registerStream } from '../../src/api/stream.js';

describe('Broadcaster', () => {
  test('sends each published event to every subscriber', () => {
    const b = new Broadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    const off = b.subscribe(c);
    b.publish('results', { ids: [1, 2] });
    expect(a).toHaveBeenCalledWith('results', '{"ids":[1,2]}');
    off();
    b.publish('results', { ids: [3] });
    expect(c).toHaveBeenCalledTimes(1);
    expect(b.size).toBe(1);
  });
});

describe('/api/ws', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; });

  async function start() {
    const app = Fastify();
    const live = new Broadcaster();
    registerStream(app, live, (cookie) => cookie === 'session=good');
    await app.listen({ port: 0, host: '127.0.0.1' });
    close = () => app.close();
    const { port } = app.server.address() as { port: number };
    return { live, url: `ws://127.0.0.1:${port}/api/ws` };
  }

  test('a signed-in socket gets every event as "<event>\\n<json>" the moment it is published', async () => {
    const { live, url } = await start();
    const ws = new WebSocket(url, { headers: { cookie: 'session=good' } } as never);
    await new Promise((r) => ws.addEventListener('open', r));
    const got = new Promise<string>((r) => ws.addEventListener('message', (e) => r(String(e.data))));
    live.publish('in-prices', { prices: { INFY: { price: 1146.25 } } });
    expect(await got).toBe('in-prices\n{"prices":{"INFY":{"price":1146.25}}}');
    ws.close();
  });

  test('without a session the upgrade is refused', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    const outcome = await new Promise<string>((r) => { ws.addEventListener('open', () => r('open')); ws.addEventListener('error', () => r('refused')); });
    expect(outcome).toBe('refused');
  });
});
