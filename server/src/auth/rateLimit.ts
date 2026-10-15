/**
 * In-memory sliding-window limiter for failed logins, keyed separately by user ID and by client IP.
 * Resets on restart, which is acceptable for a small private app.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly max = 5, private readonly windowMs = 15 * 60_000) {}

  /** Milliseconds until another attempt is allowed, or null if not blocked. */
  check(id: string, ip: string, now: number): number | null {
    let wait = 0;
    for (const key of [`id:${id}`, `ip:${ip}`]) {
      const recent = this.recent(key, now);
      if (recent.length >= this.max) wait = Math.max(wait, recent[recent.length - this.max]! + this.windowMs - now);
    }
    return wait > 0 ? wait : null;
  }

  fail(id: string, ip: string, now: number): void {
    for (const key of [`id:${id}`, `ip:${ip}`]) this.failures.set(key, [...this.recent(key, now), now]);
    if (this.failures.size > 10_000) this.prune(now);
  }

  succeed(id: string): void {
    this.failures.delete(`id:${id}`);
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }

  private prune(now: number): void {
    for (const key of this.failures.keys()) {
      const r = this.recent(key, now);
      if (r.length) this.failures.set(key, r);
      else this.failures.delete(key);
    }
  }
}
