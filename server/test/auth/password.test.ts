import { describe, expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password hashing', () => {
  test('hash is scrypt$N$r$p$salt$hash with a random 16-byte salt and no plaintext', async () => {
    const h = await hashPassword('00000000');
    const parts = h.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16);
    expect(h).not.toContain('00000000');
    expect(await hashPassword('00000000')).not.toBe(h);
  });

  test('verifies the right password and rejects wrong ones', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', h)).toBe(true);
    expect(await verifyPassword('s3cret-pasS', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  test('malformed stored hashes never verify and never throw', async () => {
    for (const bad of ['', 'plain', 'scrypt$x$8$1$AAAA$BBBB', 'bcrypt$1$2$3$4$5', 'scrypt$16384$8$1$$', 'scrypt$1048576$64$64$AAAAAAAAAAAAAAAAAAAAAA==$AAAA']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});
