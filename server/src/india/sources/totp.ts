import * as crypto from 'node:crypto';

/**
 * RFC 6238 TOTP implementation.
 * secretBase32: the secret in Base32 encoding (no spaces).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Uint8Array {
  const str = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  // If all characters are valid Base32, decode normally
  const isBase32 = [...str].every((c) => BASE32_ALPHABET.includes(c));
  if (!isBase32) {
    // Zerodha sometimes uses raw alphanumeric secrets — treat as UTF-8 bytes directly
    return new TextEncoder().encode(input.trim());
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of str) {
    const val = BASE32_ALPHABET.indexOf(char);
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Generate a TOTP code (6 digits) from a Base32 secret at a given epoch second.
 * Default: current time with 30-second window (standard TOTP).
 */
export async function generateTotp(secretBase32: string, epochSeconds?: number): Promise<string> {
  const now = epochSeconds ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / 30);

  const keyBytes = base32Decode(secretBase32);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);

  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  // Write counter as 64-bit big-endian
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);

  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
  const offset = hmac[19]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    1_000_000;
  return String(code).padStart(6, '0');
}
