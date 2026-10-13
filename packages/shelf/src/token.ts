/**
 * Order confirmation tokens: HMAC-SHA256 over (user, store, items, total, expiry, nonce).
 * Format: base64url(JSON payload) "." base64url(signature). Stateless, so it works on Lambda.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OrderTokenPayload {
  v: 1;
  /** shopper id */
  u: string;
  /** store id */
  s: string;
  /** [variant id, qty] */
  i: [string, number][];
  /** total in cents, to detect price changes between preview and placement */
  t: number;
  /** expiry, epoch ms */
  e: number;
  /** nonce, makes every preview unique and lets us detect replays */
  n: string;
}

export const TOKEN_TTL_MS = 10 * 60 * 1000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function sign(body: string, secret: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function newNonce(): string {
  return randomBytes(9).toString('base64url');
}

export function signOrderToken(payload: OrderTokenPayload, secret: string | Buffer): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(sign(body, secret))}`;
}

export type TokenCheck =
  | { ok: true; payload: OrderTokenPayload }
  | { ok: false; code: 'token_invalid' | 'token_expired'; payload?: OrderTokenPayload };

function isPayload(x: unknown): x is OrderTokenPayload {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return (
    p.v === 1 && typeof p.u === 'string' && typeof p.s === 'string' && typeof p.t === 'number' &&
    typeof p.e === 'number' && typeof p.n === 'string' && Array.isArray(p.i) &&
    p.i.every((r) => Array.isArray(r) && typeof r[0] === 'string' && Number.isInteger(r[1]))
  );
}

export function verifyOrderToken(token: string, secret: string | Buffer, now = Date.now()): TokenCheck {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, code: 'token_invalid' };
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, code: 'token_invalid' };
  const [body, sig] = parts;
  const expected = sign(body, secret);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, code: 'token_invalid' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'token_invalid' };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'token_invalid' };
  }
  if (!isPayload(payload)) return { ok: false, code: 'token_invalid' };
  if (payload.e <= now) return { ok: false, code: 'token_expired', payload };
  return { ok: true, payload };
}
