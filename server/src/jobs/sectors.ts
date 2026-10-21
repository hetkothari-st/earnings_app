import { inTransaction, setSectors } from '../db/repo.js';
import { type JobContext, guarded } from './context.js';

/** Sector and industry for every stored symbol (Nasdaq screener, one call). */
export async function refreshSectors(ctx: JobContext): Promise<void> {
  const sectors = (await guarded(ctx, { name: 'nasdaq', run: () => ctx.sources.sectors() }))?.value;
  if (sectors) inTransaction(ctx.db, () => setSectors(ctx.db, sectors));
}
