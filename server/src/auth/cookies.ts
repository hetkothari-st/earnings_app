/** Minimal Cookie header parser: first occurrence of each name wins; malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeCookie(
  name: string, value: string, o: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${o.maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}
