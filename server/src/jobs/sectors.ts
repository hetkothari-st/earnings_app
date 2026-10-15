import { inTransaction, setSectors } from '../db/repo.js';
import { type JobContext, track } from './context.js';

/** Sector and industry for every stored symbol (Nasdaq screener, one call). */
export async function refreshSectors(ctx: JobContext): Promise<void> {
  const sectors = await track(ctx, 'nasdaq', () => ctx.sources.sectors());
  if (sectors) inTransaction(ctx.db, () => setSectors(ctx.db, sectors));
}
