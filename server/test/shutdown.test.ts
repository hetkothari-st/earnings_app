import { describe, expect, it, vi } from 'vitest';
import { installShutdown } from '../src/shutdown.js';

describe('installShutdown', () => {
  it('on SIGTERM or SIGINT: stops every poller, then closes in order, then exits 0; runs once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const order: string[] = [];
    const handlers = new Map<string, () => void>();
    let exited: (code: number) => void = () => {};
    const done = new Promise<number>((r) => { exited = r; });
    installShutdown({
      stops: [() => order.push('stop-a'), () => { throw new Error('boom'); }, () => order.push('stop-c')],
      closes: [async () => { order.push('close-app'); }, () => { order.push('close-db'); }],
      on: (signal, fn) => handlers.set(signal, fn),
      exit: (code) => { order.push(`exit-${code}`); exited(code); },
    });
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!(); // a second signal while shutting down does nothing more
    expect(await done).toBe(0);
    expect(order).toEqual(['stop-a', 'stop-c', 'close-app', 'close-db', 'exit-0']);
    log.mockRestore();
  });

  it('a close that fails still lets the later ones run and the process exit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const handlers = new Map<string, () => void>();
    let exited: (code: number) => void = () => {};
    const done = new Promise<number>((r) => { exited = r; });
    installShutdown({
      stops: [],
      closes: [async () => { throw new Error('app close failed'); }, () => { order.push('close-db'); }],
      on: (signal, fn) => handlers.set(signal, fn),
      exit: exited,
    });
    handlers.get('SIGINT')!();
    expect(await done).toBe(0);
    expect(order).toEqual(['close-db']);
    log.mockRestore();
    warn.mockRestore();
  });

  it('a close that never settles (an open WebSocket/SSE client) is given up after the timeout; later closes still run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const handlers = new Map<string, () => void>();
    let exited: (code: number) => void = () => {};
    const done = new Promise<number>((r) => { exited = r; });
    installShutdown({
      stops: [],
      closes: [() => new Promise<void>(() => {}), () => { order.push('close-db'); }],
      on: (signal, fn) => handlers.set(signal, fn),
      exit: exited,
      closeTimeoutMs: 20,
    });
    handlers.get('SIGTERM')!();
    expect(await done).toBe(0);
    expect(order).toEqual(['close-db']);
    log.mockRestore();
    warn.mockRestore();
  });
});
