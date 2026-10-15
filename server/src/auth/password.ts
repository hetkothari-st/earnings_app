import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash for storage: `scrypt$N$r$p$salt$hash` (salt and hash base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

const isPow2 = (n: number) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

/** Constant-time check of a password against a stored hash. Malformed hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  // Bound the cost parameters so a tampered row cannot make verification hang or exhaust memory.
  if (!isPow2(n) || n > 1 << 17 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || expected.length < 16) return false;
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
