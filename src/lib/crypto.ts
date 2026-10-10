/**
 * Encryption at rest for secrets we must be able to read back:
 * Google OAuth refresh tokens, and cached access tokens.
 *
 * Algorithm: AES-256-GCM. Authenticated encryption matters here — with plain
 * CBC/CTR an attacker with write access to the database could flip bits in a
 * stored token; GCM's tag makes tampering a decryption failure instead.
 *
 * Ciphertext format (dot-separated, all base64url except the version):
 *
 *   v1.<keyId>.<iv>.<authTag>.<ciphertext>
 *      │        │     │         └─ the encrypted payload
 *      │        │     └─ 16-byte GCM authentication tag
 *      │        └─ 12-byte random IV, fresh for every single encryption
 *      └─ 8-hex-char fingerprint of the key used, so we can rotate keys
 *         without a downtime migration
 *
 * KEY ROTATION: put the new key in ENCRYPTION_KEY and move the old one into
 * ENCRYPTION_KEY_PREVIOUS. New writes use the new key; old ciphertext still
 * decrypts. `scripts/rotate-encryption-key.ts` then re-wraps everything and you
 * can drop the old key. `needsRewrap()` tells you which rows are still on an
 * old key.
 */

import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits — the size GCM is specified and optimised for
const TAG_BYTES = 16;
const VERSION = 'v1';

/** Key fingerprint → key material, for decrypting anything we ever wrote. */
const keyRing = new Map<string, Buffer>();

function fingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

for (const key of env.encryptionKeys) {
  keyRing.set(fingerprint(key), key);
}

const activeKey = env.encryptionKeys[0];
if (!activeKey) {
  // Unreachable: env validation guarantees at least one key. Kept as a hard
  // assertion because silently encrypting with `undefined` would be catastrophic.
  throw new Error('No encryption key available — env validation should have prevented boot');
}
const safeActiveKey: Buffer = activeKey;
const activeKeyId = fingerprint(safeActiveKey);

const b64 = (buf: Buffer): string => buf.toString('base64url');
const unb64 = (str: string): Buffer => Buffer.from(str, 'base64url');

export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
  constructor(
    message: string,
    readonly reason:
      | 'malformed'
      | 'unknown_key'
      | 'unsupported_version'
      | 'auth_failed',
  ) {
    super(message);
  }
}

/**
 * Encrypt a UTF-8 string. Returns the self-describing envelope above.
 *
 * Every call generates a fresh random IV. Reusing an IV with the same key in
 * GCM is a catastrophic failure that leaks plaintext, so it is never derived
 * from the data or a counter.
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() expects a string');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, safeActiveKey, iv, {
    authTagLength: TAG_BYTES,
  });

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, activeKeyId, b64(iv), b64(tag), b64(ciphertext)].join('.');
}

/**
 * Decrypt an envelope produced by `encrypt`.
 *
 * Throws DecryptionError with a machine-readable `reason` rather than a generic
 * error, so callers can distinguish "this row predates a key we no longer have"
 * (operational, actionable) from "this ciphertext was tampered with" (a
 * security event worth alerting on).
 */
export function decrypt(envelope: string): string {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new DecryptionError('Ciphertext is empty', 'malformed');
  }

  const parts = envelope.split('.');
  if (parts.length !== 5) {
    throw new DecryptionError(
      `Malformed ciphertext: expected 5 segments, found ${parts.length}`,
      'malformed',
    );
  }

  const [version, keyId, ivPart, tagPart, dataPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new DecryptionError(`Unsupported ciphertext version "${version}"`, 'unsupported_version');
  }

  const key = keyRing.get(keyId);
  if (!key) {
    throw new DecryptionError(
      `No encryption key matching fingerprint "${keyId}". If you rotated ENCRYPTION_KEY, add the previous value to ENCRYPTION_KEY_PREVIOUS.`,
      'unknown_key',
    );
  }

  let iv: Buffer;
  let tag: Buffer;
  let data: Buffer;
  try {
    iv = unb64(ivPart);
    tag = unb64(tagPart);
    data = unb64(dataPart);
  } catch {
    throw new DecryptionError('Ciphertext segments are not valid base64url', 'malformed');
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('Ciphertext IV or auth tag has the wrong length', 'malformed');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM tag mismatch. Either the key is wrong or the data was modified.
    // Never include the ciphertext in the message — it may still be recoverable
    // with the right key and does not belong in a log.
    throw new DecryptionError(
      'Authentication failed while decrypting. The data may have been modified, or the wrong key was used.',
      'auth_failed',
    );
  }
}

/** Decrypt, returning null instead of throwing. For best-effort read paths. */
export function tryDecrypt(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  try {
    return decrypt(envelope);
  } catch {
    return null;
  }
}

/** True when this ciphertext was written with a key that is no longer active. */
export function needsRewrap(envelope: string): boolean {
  const keyId = envelope.split('.')[1];
  return keyId !== activeKeyId;
}

export function activeEncryptionKeyId(): string {
  return activeKeyId;
}

// ---------------------------------------------------------------------------
// Token generation and hashing
// ---------------------------------------------------------------------------

/**
 * Cryptographically secure random token, base64url so it is URL- and
 * cookie-safe with no escaping.
 *
 * 32 bytes = 256 bits. Far beyond brute-force reach, and the reason we can
 * store only a fast SHA-256 hash of these rather than a slow KDF: unlike a
 * human password, there is no dictionary to attack.
 */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Numeric-ish opaque id for public identifiers (API key ids, references). */
export function generateId(bytes = 12): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * SHA-256 hash used for storing high-entropy secrets: email verification
 * tokens, password reset tokens, invite tokens and API key secrets.
 *
 * Deliberately NOT used for passwords — see lib/password.ts, which uses scrypt.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison. Always use this for secrets.
 *
 * `a === b` on strings short-circuits at the first differing byte, which leaks
 * how much of a guess was correct and makes byte-by-byte recovery possible.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hash both to a fixed 32 bytes first so the comparison is always the same
  // amount of work regardless of input length.
  const digestA = crypto.createHash('sha256').update(bufA).digest();
  const digestB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/** Constant-time comparison of two hex digests of known equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** HMAC-SHA256 hex digest. Used for payment webhook signature verification. */
export function hmacSha256(secret: string, payload: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** SHA-256 of arbitrary bytes, for payload fingerprints and dedupe keys. */
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
