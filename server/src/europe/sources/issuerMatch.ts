/**
 * Matching a free-text issuer name (a PR Newswire dc:contributor, a DILA ISO_NOM_SOC) or an ISIN in a text to
 * universe companies. Matching is exact on the normalised name, never fuzzy: "Shell Midstream Partners" is not
 * Shell plc. byName returns every company with that normalised name, and the caller acts only on exactly one
 * (two hits flip nothing). For a feed shared by the UK and EU markets, build one index over both, so one item
 * maps to at most one company overall.
 */

/** Legal-form and filler words removed from the end of a name (after dots are dropped and spaces collapsed). */
const SUFFIXES = [
  'ab publ', 'plc', 'limited', 'ltd', 'group', 'holding', 'holdings', 'se', 'nv', 'ag', 'sa', 'spa', 'asa',
  'ab', 'as', 'oyj', 'abp', 'sca', 'kgaa',
];

/** Letters that NFD does not split into a base letter and a mark. */
const FOLD: Record<string, string> = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i' };

/**
 * Lower case, accents folded, punctuation stripped, legal forms (plc, p.l.c., limited, ltd, group, holding(s),
 * se, n.v., ag, s.a., s.p.a., asa, ab (publ), ab, a/s, oyj, abp, sca, kgaa, & co) removed from the end and
 * "the" from the start. A name made only of such words keeps its last word.
 */
export function normaliseIssuer(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[øæœßłđðþı]/g, (c) => FOLD[c]!)
    .replace(/\s*&\s*co\b\.?/g, ' ')   // "& Co." (Henkel AG & Co. KGaA)
    .replace(/[.'’/]/g, '')         // p.l.c. → plc, s.p.a. → spa, a/s → as, o'neill → oneill
    .replace(/[^\p{L}\p{N}]+/gu, ' ')    // every other punctuation is a word break
    .trim();
  let words = s ? s.split(' ') : [];
  if (words.length > 1 && words[0] === 'the') words = words.slice(1);
  for (let changed = true; changed && words.length > 1;) {
    changed = false;
    for (const suf of SUFFIXES) {
      const sw = suf.split(' ');
      if (words.length > sw.length && words.slice(-sw.length).join(' ') === suf) {
        words = words.slice(0, -sw.length);
        changed = true;
        break;
      }
    }
  }
  return words.join(' ');
}

export interface IssuerIndex {
  /** Symbols whose normalised name equals the normalised `name` (none for an empty name). */
  byName(name: string): string[];
  /** Symbols whose ISIN appears in `text` as a whole token, in order of first appearance. */
  byIsinIn(text: string): string[];
}

export function createIssuerIndex(entries: { symbol: string; isin: string; name: string }[]): IssuerIndex {
  const names = new Map<string, string[]>();
  const isins = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, sym: string) => {
    const list = m.get(k);
    if (!list) m.set(k, [sym]);
    else if (!list.includes(sym)) list.push(sym);
  };
  for (const e of entries) {
    const n = normaliseIssuer(e.name);
    if (n) add(names, n, e.symbol);
    if (e.isin) add(isins, e.isin.toUpperCase(), e.symbol);
  }
  return {
    byName(name) {
      const n = normaliseIssuer(name);
      return n ? [...(names.get(n) ?? [])] : [];
    },
    byIsinIn(text) {
      const out: string[] = [];
      for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Z]{2}[A-Z0-9]{9}[0-9](?![A-Za-z0-9])/g)) {
        for (const sym of isins.get(m[0]) ?? []) if (!out.includes(sym)) out.push(sym);
      }
      return out;
    },
  };
}
