import { distinctSymbolKeys, reportsNeedingSec, setExchange, setSecResult } from '../db/repo.js';
import { addDays } from '../domain/marketCalendar.js';
import { checkTiming, deriveFromAcceptance } from '../domain/secTiming.js';
import type { Filing } from '../types.js';
import { type JobContext, track } from './context.js';

/** Nightly: primary exchange for every symbol, then SEC timing check for past reports (spec 6.6). */
export async function secSync(ctx: JobContext): Promise<void> {
  const tickers = await track(ctx, 'sec', () => ctx.sources.secTickers());
  if (!tickers) return;
  for (const key of distinctSymbolKeys(ctx.db)) setExchange(ctx.db, key, tickers.get(key)?.exchange ?? null);

  const today = ctx.today();
  const filingsByCik = new Map<number, Filing[]>();

  for (const p of reportsNeedingSec(ctx.db, today, addDays(today, -5))) {
    const t = tickers.get(p.symbolKey);
    if (!t) {
      setSecResult(ctx.db, p.id, { check: 'unverifiable', timing: p.timing, timingSource: p.timingSource, acceptedAt: null, docUrl: null, indexUrl: null }, ctx.now());
      continue;
    }

    let filings = filingsByCik.get(t.cik);
    if (!filings) {
      filings = await track(ctx, 'sec', () => ctx.sources.secEarningsFilings(t.cik));
      if (!filings) continue;
      filingsByCik.set(t.cik, filings);
    }

    const inWindow = filings.filter((f) => f.filingDate >= p.reportDate && f.filingDate <= addDays(p.reportDate, 4));
    const candidates = inWindow.filter((f) => f.form === '8-K');
    // Foreign issuers file 6-Ks, which say nothing about their contents: link it, never use it for timing.
    const sixK = inWindow.find((f) => f.form === '6-K' && f.filingDate <= addDays(p.reportDate, 1));
    let best: { acceptedAt: string; filing: Filing } | null = null;
    let fetchFailed = false;
    for (const f of candidates) {
      const acceptedAt = await track(ctx, 'sec', () => ctx.sources.secAcceptance(t.cik, f.accession));
      if (acceptedAt === undefined) { fetchFailed = true; continue; }
      if (acceptedAt.slice(0, 10) !== p.reportDate) continue;
      if (!best || acceptedAt < best.acceptedAt) best = { acceptedAt, filing: f };
    }
    if (fetchFailed) continue; // retry next run: a missing header could be the earliest filing

    const derived = best ? deriveFromAcceptance(p.reportDate, best.acceptedAt) : null;
    const result = checkTiming(p.timing, derived);
    setSecResult(ctx.db, p.id, {
      check: result.check,
      timing: result.timing,
      timingSource: result.timing !== p.timing ? 'sec' : p.timingSource,
      acceptedAt: best?.acceptedAt ?? null,
      docUrl: best?.filing.docUrl ?? sixK?.docUrl ?? null,
      indexUrl: best?.filing.indexUrl ?? sixK?.indexUrl ?? null,
    }, ctx.now());
  }
}
