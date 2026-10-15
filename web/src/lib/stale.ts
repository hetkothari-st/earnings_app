import type { SourceStatusDto } from '../../../server/src/api/types';

const NAMES: Record<string, string> = { nasdaq: 'Nasdaq', finnhub: 'Finnhub', sec: 'SEC EDGAR', cboe: 'Cboe options' };

export function staleSources(sources: SourceStatusDto[], nowMs: number): { source: string; message: string }[] {
  const out: { source: string; message: string }[] = [];
  for (const s of sources) {
    const name = NAMES[s.source] ?? s.source;
    const ok = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : null;
    const err = s.lastErrorAt ? Date.parse(s.lastErrorAt) : null;
    if (err == null || (ok != null && ok >= err)) continue;
    if (ok == null) {
      out.push({ source: s.source, message: `${name} data never loaded (${s.lastError})` });
    } else {
      const hours = Math.max(1, Math.round((nowMs - ok) / 3_600_000));
      out.push({ source: s.source, message: `${name} data last updated ${hours}h ago (latest attempt failed: ${s.lastError})` });
    }
  }
  return out;
}
