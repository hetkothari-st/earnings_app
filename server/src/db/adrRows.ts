import type { DatabaseSync } from 'node:sqlite';
import { normalizeTicker } from '../domain/ticker.js';

/** The ADR's rows in the US `reports` table (read-only), for converting to a home-market date (HK, Japan). */
export function usAdrRows(
  db: DatabaseSync, adr: string, from: string, to: string,
): { reportDate: string; timing: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN' }[] {
  return db.prepare(`SELECT report_date AS reportDate, timing FROM reports
    WHERE symbol_key = ? AND report_date BETWEEN ? AND ? ORDER BY report_date`)
    .all(normalizeTicker(adr), from, to) as unknown as { reportDate: string; timing: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN' }[];
}
