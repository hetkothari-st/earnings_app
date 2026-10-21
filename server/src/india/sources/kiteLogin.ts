import * as crypto from 'node:crypto';
import { generateTotp } from './totp.js';

/** Kite credentials read from environment (never stored). */
export interface KiteCredentials {
  apiKey: string;
  apiSecret: string;
  userId: string;
  password: string;
  totpSecret: string;
}

export function getKiteCredentials(): KiteCredentials | null {
  const { KITE_API_KEY, KITE_API_SECRET, KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET } = process.env;
  if (!KITE_API_KEY || !KITE_API_SECRET || !KITE_USER_ID || !KITE_PASSWORD || !KITE_TOTP_SECRET) return null;
  return {
    apiKey: KITE_API_KEY,
    apiSecret: KITE_API_SECRET,
    userId: KITE_USER_ID,
    password: KITE_PASSWORD,
    totpSecret: KITE_TOTP_SECRET,
  };
}

/** In-memory Kite session (access token is never persisted). */
export interface KiteSession {
  apiKey: string;
  accessToken: string;
  expiresAt: number;   // epoch ms
}

/** Shown on the admin page. Never contains credentials or the token. */
export interface KiteStatus {
  configured: boolean;
  connected: boolean;
  lastLoginAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

let _session: KiteSession | null = null;
const _status: Omit<KiteStatus, 'configured' | 'connected'> = { lastLoginAt: null, lastError: null, lastErrorAt: null };

export function getSession(): KiteSession | null {
  if (_session && Date.now() < _session.expiresAt) return _session;
  _session = null;
  return null;
}

export function clearSession(): void {
  _session = null;
}

export function kiteStatus(): KiteStatus {
  return { configured: getKiteCredentials() != null, connected: getSession() != null, ..._status };
}

/** Kite access tokens expire at 06:00 IST the next morning. */
export function tokenExpiry(nowMs: number): number {
  const IST_OFFSET = 5.5 * 3_600_000;
  const ist = new Date(nowMs + IST_OFFSET);
  const six = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6) - IST_OFFSET;
  return six > nowMs ? six : six + 86_400_000;
}

/** Unofficial Kite login using user_id/password/TOTP. */
export async function loginKite(creds: KiteCredentials, fetchImpl: typeof fetch = fetch): Promise<string> {
  const fetch = fetchImpl;
  // Step 1: POST /api/login
  const loginRes = await fetchImpl('https://kite.zerodha.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
    body: new URLSearchParams({ user_id: creds.userId, password: creds.password }).toString(),
    redirect: 'manual',
  });
  const loginBody = (await loginRes.json()) as { data?: { request_id?: string; twofa_type?: string } };
  const requestId = loginBody.data?.request_id;
  const tfaType = loginBody.data?.twofa_type ?? 'totp';
  if (!requestId) throw new Error('Kite login step 1 failed: no request_id');

  // Step 2: TOTP 2FA — use exactly the twofa_type Zerodha specified
  const totp = await generateTotp(creds.totpSecret);
  const tfaRes = await fetchImpl('https://kite.zerodha.com/api/twofa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
    body: new URLSearchParams({
      user_id: creds.userId,
      request_id: requestId,
      twofa_value: totp,
      twofa_type: tfaType,   // totp | app_code | sms — whatever Zerodha returned
    }).toString(),
    redirect: 'manual',
  });
  if (!tfaRes.ok) throw new Error(`Kite login: 2FA rejected (HTTP ${tfaRes.status})`);
  // Collect cookies from the 2FA response
  const cookies = tfaRes.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

  // Step 3: Follow connect/login redirect to extract request_token
  let requestToken: string | null = null;
  let nextUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${creds.apiKey}`;
  for (let hops = 0; hops < 10; hops++) {
    const r = await fetchImpl(nextUrl, {
      headers: { Cookie: cookieHeader },
      redirect: 'manual',
    });
    const loc = r.headers.get('location') ?? '';
    const m = loc.match(/[?&]request_token=([^&]+)/);
    if (m) { requestToken = m[1]!; break; }
    if (!loc) break;
    nextUrl = loc.startsWith('http') ? loc : `https://kite.zerodha.com${loc}`;
  }
  if (!requestToken) throw new Error('Kite login: could not extract request_token from redirect');

  // Step 4: Exchange request_token for access_token
  const checksum = crypto.createHash('sha256')
    .update(creds.apiKey + requestToken + creds.apiSecret)
    .digest('hex');
  const tokenRes = await fetchImpl('https://api.kite.trade/session/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
    body: new URLSearchParams({ api_key: creds.apiKey, request_token: requestToken, checksum }).toString(),
  });
  const tokenBody = (await tokenRes.json()) as { data?: { access_token?: string } };
  const accessToken = tokenBody.data?.access_token;
  if (!accessToken) throw new Error('Kite login: session/token exchange failed');

  _session = { apiKey: creds.apiKey, accessToken, expiresAt: tokenExpiry(Date.now()) };
  return accessToken;
}

/**
 * Logs in (forced, or only when there is no valid session), retrying up to `attempts` times
 * `retryMs` apart. Errors are kept for the admin page; never thrown.
 */
export async function ensureSession(
  creds: KiteCredentials | null,
  opts: { force?: boolean; attempts?: number; retryMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<KiteSession | null> {
  if (!creds) return null;
  if (!opts.force && getSession()) return getSession();
  const attempts = opts.attempts ?? 1;
  for (let i = 0; i < attempts; i++) {
    try {
      await loginKite(creds, opts.fetchImpl);
      _status.lastLoginAt = new Date().toISOString();
      _status.lastError = null;
      return getSession();
    } catch (err) {
      // Messages are ours (no response bodies), so they never echo credentials.
      _status.lastError = err instanceof Error ? err.message : String(err);
      _status.lastErrorAt = new Date().toISOString();
      console.error('[kite-login]', _status.lastError);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.retryMs ?? 5 * 60_000));
    }
  }
  return null;
}
