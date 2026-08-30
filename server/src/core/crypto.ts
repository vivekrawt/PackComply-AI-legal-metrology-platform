import crypto from 'node:crypto';
import { config } from './config.js';

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Canonical JSON (sorted keys) so hashes are stable regardless of key order.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortValue((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

// Password hashing: Node built-in scrypt (no native/paid deps).
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// HMAC signing for short-lived asset URLs (no public/predictable evidence URLs).
export function signAssetUrl(assetId: string, expiresAtEpoch: number): string {
  return crypto.createHmac('sha256', config.secret).update(`${assetId}.${expiresAtEpoch}`).digest('hex');
}
export function verifyAssetSig(assetId: string, expiresAtEpoch: number, sig: string): boolean {
  if (Date.now() / 1000 > expiresAtEpoch) return false;
  const expected = signAssetUrl(assetId, expiresAtEpoch);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
