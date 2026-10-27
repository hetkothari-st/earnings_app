import type { Db } from '../db/repo.js';
import { addDays } from '../domain/marketCalendar.js';
import type { CoverageRow } from '../api/types.js';

export type { CoverageRow };

type Market = 'US' | 'IN' | 'HK';

interface FieldDef { field: string; min: number; filled: string; withinWeek?: boolean; where?: string }

/** "Filled" per field, as SQL over the report alias `r` (and the stock alias `s` for India). */
const FIELDS: Record<Market, FieldDef[]> = {
  US: [
    { field: 'epsEstimate', min: 85, filled: 'r.eps_estimate IS NOT NULL' },
    { field: 'marketCap', min: 95, filled: 'r.market_cap IS NOT NULL' },
    { field: 'timing', min: 70, filled: "r.timing != 'UNKNOWN'" },
    { field: 'previousMove', min: 70, filled: 'r.prev_move_pct IS NOT NULL' },
    { field: 'expectedMove', min: 60, filled: 'EXISTS (SELECT 1 FROM expected_moves e WHERE e.report_id = r.id)', withinWeek: true },
  ],
  IN: [
    { field: 'epsEstimate', min: 60, filled: 'r.eps_estimate IS NOT NULL' },
    { field: 'marketCap', min: 95, filled: 's.market_cap IS NOT NULL' },
    { field: 'previousMove', min: 60, filled: 'r.prev_move_pct IS NOT NULL' },
    { field: 'expectedMove', min: 60, filled: 'EXISTS (SELECT 1 FROM in_expected_moves e WHERE e.report_id = r.id)', withinWeek: true },
  ],
  HK: [
    { field: 'epsEstimate', min: 40, filled: 'r.eps_estimate IS NOT NULL' },
    { field: 'marketCap', min: 95, filled: 's.market_cap IS NOT NULL' },
    { field: 'previousMove', min: 50, filled: 'r.prev_move_pct IS NOT NULL' },
    // Only full-level names have an ADR straddle.
    { field: 'expectedMove', min: 60, filled: 'EXISTS (SELECT 1 FROM hk_expected_moves e WHERE e.report_id = r.id)', withinWeek: true, where: "s.level = 'full'" },
  ],
};

/** How much of the next 14 days' reports (7 for expectedMove) have each field. `today` is the market's own date. */
/** Compares the exact share, not the rounded pct: 84.96% against a minimum of 85 fails. */
export function coverageOk(filled: number, total: number, min: number): boolean {
  return total > 0 && filled * 100 >= min * total;
}

export function computeCoverage(db: Db, market: Market, today: string): CoverageRow[] {
  const from = today;
  const to14 = addDays(today, 14);
  const to7 = addDays(today, 7);
  const source = market === 'US' ? 'reports r'
    : market === 'IN' ? 'in_reports r JOIN in_stocks s ON s.symbol = r.symbol AND s.active = 1'
    : 'hk_reports r JOIN hk_stocks s ON s.code = r.code AND s.active = 1';
  return FIELDS[market].map((f) => {
    const to = f.withinWeek ? to7 : to14;
    const row = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${f.filled} THEN 1 ELSE 0 END), 0) AS filled
        FROM ${source} WHERE r.report_date >= ? AND r.report_date <= ?${f.where ? ` AND ${f.where}` : ''}`).get(from, to) as unknown as { total: number; filled: number };
    const pct = row.total === 0 ? 0 : Math.round((row.filled / row.total) * 1000) / 10;
    // No reports in the window is itself a failure for a pre-demo check.
    return { field: f.field, filled: row.filled, total: row.total, pct, min: f.min, ok: coverageOk(row.filled, row.total, f.min) };
  });
}

export function coverageTable(label: string, rows: CoverageRow[]): string {
  const lines = [`${label}  field            filled/total     pct    min  status`];
  for (const r of rows) {
    lines.push(`${' '.repeat(label.length)}  ${r.field.padEnd(14)} ${`${r.filled}/${r.total}`.padStart(9)} ${`${r.pct}%`.padStart(8)} ${`${r.min}%`.padStart(6)}  ${r.ok ? 'ok' : 'BELOW MINIMUM'}`);
  }
  return lines.join('\n');
}

/** Prints the tables through `log`; returns the process exit code (1 when any field is below its minimum). */
export function runCoverageCheck(db: Db, todayUs: string, todayIn: string, todayHk: string, log: (line: string) => void): number {
  const us = computeCoverage(db, 'US', todayUs);
  const india = computeCoverage(db, 'IN', todayIn);
  log(coverageTable('US', us));
  const hk = computeCoverage(db, 'HK', todayHk);
  log(coverageTable('IN', india));
  log(coverageTable('HK', hk));
  return [...us, ...india, ...hk].every((r) => r.ok) ? 0 : 1;
}
