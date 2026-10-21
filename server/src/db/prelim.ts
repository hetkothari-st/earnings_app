import { config } from '../config.js';
import type { Db } from './repo.js';

export interface PrelimValues { epsAdjusted: number | null; epsGaap: number | null; revenue: number | null }
export type FastGates = typeof config.fastFields;

interface PrelimRow {
  eps_actual: number | null; revenue_actual: number | null;
  eps_prelim: number | null; eps_prelim_basis: string | null; revenue_prelim: number | null;
}

const SELECT = 'SELECT eps_actual, revenue_actual, eps_prelim, eps_prelim_basis, revenue_prelim FROM reports WHERE id = ?';

/**
 * Store fast-read values from the press release, only for fields whose gate is open. Never replaces an
 * existing prelim or an official actual. Adjusted EPS is stored when its gate is open and it was read;
 * otherwise GAAP EPS (basis 'gaap') if that gate is open. Returns true when anything was stored.
 */
export function savePrelim(db: Db, id: number, v: PrelimValues, at: string, gates: FastGates = config.fastFields): boolean {
  const r = db.prepare(SELECT).get(id) as unknown as PrelimRow | undefined;
  if (!r) return false;

  let eps: number | null = null;
  let basis: 'adjusted' | 'gaap' | null = null;
  if (r.eps_actual == null && r.eps_prelim == null) {
    if (gates.usEpsAdjusted && v.epsAdjusted != null) { eps = v.epsAdjusted; basis = 'adjusted'; }
    else if (gates.usEpsGaap && v.epsGaap != null) { eps = v.epsGaap; basis = 'gaap'; }
  }
  const revenue = gates.usRevenue && r.revenue_actual == null && r.revenue_prelim == null ? v.revenue : null;
  if (eps == null && revenue == null) return false;

  db.prepare(`UPDATE reports SET
      eps_prelim = COALESCE(?, eps_prelim), eps_prelim_basis = COALESCE(?, eps_prelim_basis),
      revenue_prelim = COALESCE(?, revenue_prelim), prelim_at = ? WHERE id = ?`)
    .run(eps, basis, revenue, at, id);
  return true;
}

/**
 * Called after an official actual is written. A match (EPS within 0.01, revenue within 0.5%) clears the
 * prelim; a mismatch marks the field corrected, then clears it. A GAAP prelim is a different basis from the
 * official figure, so it is cleared without a correction.
 */
export function confirmPrelim(db: Db, id: number): void {
  const r = db.prepare(SELECT).get(id) as unknown as PrelimRow | undefined;
  if (!r) return;
  const clearEps = r.eps_prelim != null && r.eps_actual != null;
  const clearRev = r.revenue_prelim != null && r.revenue_actual != null;
  if (!clearEps && !clearRev) return;
  const epsCorrected = clearEps && r.eps_prelim_basis !== 'gaap' && Math.abs(r.eps_actual! - r.eps_prelim!) > 0.01 + 1e-9;
  const revCorrected = clearRev && Math.abs(r.revenue_actual! - r.revenue_prelim!) > Math.abs(r.revenue_actual!) * 0.005 + 1e-9;
  const stillEps = r.eps_prelim != null && !clearEps;
  const stillRev = r.revenue_prelim != null && !clearRev;
  db.prepare(`UPDATE reports SET
      eps_prelim = CASE WHEN ? THEN NULL ELSE eps_prelim END,
      eps_prelim_basis = CASE WHEN ? THEN NULL ELSE eps_prelim_basis END,
      revenue_prelim = CASE WHEN ? THEN NULL ELSE revenue_prelim END,
      eps_corrected = CASE WHEN ? THEN 1 ELSE eps_corrected END,
      revenue_corrected = CASE WHEN ? THEN 1 ELSE revenue_corrected END,
      prelim_at = CASE WHEN ? THEN prelim_at ELSE NULL END
    WHERE id = ?`)
    .run(clearEps ? 1 : 0, clearEps ? 1 : 0, clearRev ? 1 : 0, epsCorrected ? 1 : 0, revCorrected ? 1 : 0, stillEps || stillRev ? 1 : 0, id);
}
