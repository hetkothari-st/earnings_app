/**
 * GLEIF legal names for issuer LEIs (Ruling 4: the GLEIF name comes first).
 *
 * Verified live (Task 1): one GET with `filter[lei]` = 200 comma-separated LEIs and `page[size]=200` returns all 200
 * records (`data[].attributes.entity.legalName.name`). No rate-limit headers are sent; the caller's Http keeps the
 * documented 60 requests per minute (a 1 s gap).
 */

import type { Http } from '../../sources/http.js';
import { UNIVERSE_URLS } from '../exchanges.js';

const BATCH = 200;
const LEI_RE = /^[A-Z0-9]{20}$/;

/** LEI → legal name. Malformed LEIs are skipped; a failed batch leaves its LEIs absent (never a guess). */
export async function fetchLegalNames(http: Http, leis: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(leis.filter((l) => LEI_RE.test(l)))];
  const out = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH);
    const asked = new Set(batch);
    const url = `${UNIVERSE_URLS.gleif}?filter%5Blei%5D=${batch.join('%2C')}&page%5Bsize%5D=${BATCH}`;
    let json: unknown;
    try {
      json = await http.json(url);
    } catch (err) {
      console.warn(`gleif: batch ${i / BATCH + 1} failed: ${(err as Error).message}`);
      continue;
    }
    const data = (json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) continue;
    for (const d of data as { attributes?: { lei?: unknown; entity?: { legalName?: { name?: unknown } } } }[]) {
      const lei = d?.attributes?.lei;
      const name = d?.attributes?.entity?.legalName?.name;
      if (typeof lei === 'string' && asked.has(lei) && typeof name === 'string' && name.trim()) out.set(lei, name.trim());
    }
  }
  return out;
}
