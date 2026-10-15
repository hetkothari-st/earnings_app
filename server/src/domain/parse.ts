const EMPTY = new Set(['', 'N/A', 'NA', '--', '-', '$']);

/** Parses vendor number strings like "$2,308,617,010,000", "$-0.76", "($0.76)". Missing -> null. */
export function parseNumber(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = input.trim();
  if (EMPTY.has(s.toUpperCase())) return null;
  const negative = s.includes('-') || (s.startsWith('(') && s.endsWith(')'));
  const digits = s.replace(/[^0-9.]/g, '');
  if (digits === '' || digits === '.') return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseIntOrNull(input: string | number | null | undefined): number | null {
  const n = parseNumber(input);
  return n == null ? null : Math.trunc(n);
}
