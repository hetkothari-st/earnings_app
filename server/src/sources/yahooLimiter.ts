/** Hands out request slots at most one per `minIntervalMs`, in call order. */
export interface SlotLimiter {
  wait(): Promise<void>;
}

export function createSlotLimiter(minIntervalMs: number, now: () => number = Date.now): SlotLimiter {
  let nextSlot = 0;
  return {
    async wait() {
      const t = now();
      const slot = Math.max(t, nextSlot);
      nextSlot = slot + minIntervalMs;
      if (slot > t) await new Promise<void>((r) => setTimeout(r, slot - t));
    },
  };
}

/**
 * The one cross-market Yahoo budget: Japan (the shared `YahooClient`), the Hong Kong and India quoteSummary
 * fetchers, past dates (HK, India) and HK daily closes all wait for a slot here, so their total stays at most one
 * request per second from this process.
 */
export const yahooLimiter: SlotLimiter = createSlotLimiter(1000);
