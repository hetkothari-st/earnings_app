/**
 * Graceful shutdown on SIGTERM / SIGINT (Railway sends SIGTERM on every redeploy): every poller and cron task is
 * stopped, then the HTTP server and the database are closed in order, then the process exits 0. A step that throws
 * is logged and skipped; a second signal while shutting down does nothing.
 */
export function installShutdown(o: {
  /** Synchronous stops (pollers, cron tasks); each runs even when an earlier one throws. */
  stops: (() => unknown)[];
  /** Closed in order after the stops (HTTP server, then the database). */
  closes: (() => unknown)[];
  on?: (signal: 'SIGTERM' | 'SIGINT', fn: () => void) => void;
  exit?: (code: number) => void;
}): void {
  const on = o.on ?? ((signal, fn) => { process.once(signal, fn); });
  const exit = o.exit ?? ((code) => process.exit(code));
  let started = false;
  const run = async (signal: string) => {
    if (started) return;
    started = true;
    console.log(`${signal}: shutting down`);
    for (const stop of o.stops) {
      try { stop(); } catch (err) { console.warn('shutdown: stop failed:', err instanceof Error ? err.message : err); }
    }
    for (const close of o.closes) {
      try { await close(); } catch (err) { console.warn('shutdown: close failed:', err instanceof Error ? err.message : err); }
    }
    exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) on(signal, () => { void run(signal); });
}
