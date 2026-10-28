/**
 * Graceful shutdown on SIGTERM / SIGINT (Railway sends SIGTERM on every redeploy): every poller and cron task is
 * stopped, then the HTTP server and the database are closed in order, then the process exits 0. A step that throws
 * is logged and skipped; a close that does not settle within `closeTimeoutMs` (Fastify's close waits for every open
 * WebSocket/SSE client) is given up so the database still closes; a second signal while shutting down does nothing.
 */
export function installShutdown(o: {
  /** Synchronous stops (pollers, cron tasks); each runs even when an earlier one throws. */
  stops: (() => unknown)[];
  /** Closed in order after the stops (HTTP server, then the database). */
  closes: (() => unknown)[];
  on?: (signal: 'SIGTERM' | 'SIGINT', fn: () => void) => void;
  exit?: (code: number) => void;
  /** How long one close may take before it is given up (default 3 s; Railway sends SIGKILL after 10 s). */
  closeTimeoutMs?: number;
}): void {
  const on = o.on ?? ((signal, fn) => { process.once(signal, fn); });
  const exit = o.exit ?? ((code) => process.exit(code));
  const closeTimeoutMs = o.closeTimeoutMs ?? 3_000;
  let started = false;
  const run = async (signal: string) => {
    if (started) return;
    started = true;
    console.log(`${signal}: shutting down`);
    for (const stop of o.stops) {
      try { stop(); } catch (err) { console.warn('shutdown: stop failed:', err instanceof Error ? err.message : err); }
    }
    for (const close of o.closes) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), closeTimeoutMs); timer.unref(); });
      try {
        if ((await Promise.race([Promise.resolve(close()), timeout])) === 'timeout') console.warn('shutdown: a close timed out; continuing');
      } catch (err) { console.warn('shutdown: close failed:', err instanceof Error ? err.message : err); } finally { clearTimeout(timer); }
    }
    exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) on(signal, () => { void run(signal); });
}
