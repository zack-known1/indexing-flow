/**
 * Password hashing and policy.
 *
 * Algorithm: scrypt (RFC 7914), via Node's built-in crypto.
 *
 * Why scrypt and not bcrypt or argon2: both of those require a native module,
 * which turns `npm install` into a compiler problem on Windows and on slim
 * container images, and is the single most common reason a self-hosted deploy
 * fails. scrypt is memory-hard, in Node's standard library, and — configured as
 * below — meets OWASP's Password Storage guidance. The parameters are stored
 * inside each hash, so they can be raised later and old hashes silently upgrade
 * on the user's next successful login.
 *
 * Stored format:
 *   scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
 *
 * Nothing here ever logs, returns or echoes a plaintext password.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/**
 * Cost parameters.
 *
 * N=65536, r=8, p=2 costs 128 * N * r = 64 MiB of memory per hash and roughly
 * 150–250 ms of CPU on typical 2020s server hardware. That is deliberately slow:
 * it makes offline brute force of a leaked hash economically painful, while
 * staying fast enough that a login feels instant.
 *
 * The memory cost is the point — it is what defeats GPU and ASIC attacks that
 * make plain SHA-family hashing worthless for passwords.
 */
const SCRYPT_N = 65536; // CPU/memory cost, must be a power of two
const SCRYPT_R = 8; // block size
const SCRYPT_P = 2; // parallelisation
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * Node defaults maxmem to 32 MiB and throws above it. Our parameters need
 * 128*N*r = 64 MiB, so raise the ceiling with headroom for p.
 */
const MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

/** Minimum length. Length beats character-class rules for real-world strength. */
export const MIN_PASSWORD_LENGTH = 12;
/**
 * Upper bound. Not a security limit — a guard against someone posting a 10 MB
 * body and pinning a CPU core in a memory-hard KDF. This is a real DoS vector
 * in password hashing and is why the cap exists.
 */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Hash a password for storage.
 * @throws if the password violates the length policy (validate first for a
 *         friendly error; this throw is a backstop, not the user-facing path).
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string') {
    throw new TypeError('Password must be a string');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(
    // Normalise Unicode so a password typed with a composed vs decomposed
    // accent (é vs e + ́) still authenticates on a different OS or keyboard.
    password.normalize('NFKC'),
    salt,
    KEY_LENGTH,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM },
  );

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export interface VerifyResult {
  valid: boolean;
  /**
   * True when the stored hash used weaker parameters than we now use. The caller
   * should re-hash the (already verified) password and store the upgrade — this
   * is how cost parameters get raised over time without forcing a reset.
   */
  needsRehash: boolean;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns a result object rather than throwing, and never distinguishes
 * "malformed hash" from "wrong password" to the caller's timing — a malformed
 * record still pays the dummy-hash cost below.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<VerifyResult> {
  // Guard against an oversized body burning CPU before we do anything else.
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return { valid: false, needsRehash: false };
  }

  // No password set (OAuth-only account) or a corrupt record. Still perform a
  // real hash so the response time matches a genuine failed login and cannot be
  // used to enumerate which accounts have passwords.
  if (!storedHash) {
    await dummyHash(password);
    return { valid: false, needsRehash: false };
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await dummyHash(password);
    return { valid: false, needsRehash: false };
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4] as string;
  const hashB64 = parts[5] as string;

  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 1024 ||
    // Refuse absurd stored parameters: a tampered record could otherwise ask us
    // to allocate gigabytes and take the process down.
    N > 1_048_576 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    await dummyHash(password);
    return { valid: false, needsRehash: false };
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    await dummyHash(password);
    return { valid: false, needsRehash: false };
  }

  if (salt.length === 0 || expected.length === 0) {
    await dummyHash(password);
    return { valid: false, needsRehash: false };
  }

  let derived: Buffer;
  try {
    derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(MAXMEM, 128 * N * r * 2),
    });
  } catch {
    return { valid: false, needsRehash: false };
  }

  // Constant-time. Lengths are equal by construction (we derived `expected.length`).
  const valid = crypto.timingSafeEqual(derived, expected);

  const needsRehash = valid && (N < SCRYPT_N || r < SCRYPT_R || p < SCRYPT_P);

  return { valid, needsRehash };
}

/**
 * Burn an equivalent amount of work on a throwaway salt.
 *
 * This is the defence against user enumeration by timing: whether the email
 * exists, has no password, or has a corrupt hash, the request takes the same
 * time as a real failed login.
 */
async function dummyHash(password: string): Promise<void> {
  try {
    await scryptAsync(password.normalize('NFKC'), crypto.randomBytes(SALT_BYTES), KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAXMEM,
    });
  } catch {
    // Intentionally swallowed — this call exists only for its timing.
  }
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

/**
 * The most-breached passwords, plus product-specific guesses.
 *
 * A short curated list catches the overwhelming majority of terrible choices.
 * For a stricter deployment, wire in a k-anonymity check against Have I Been
 * Pwned's range API — see docs/SECURITY_CHECKLIST.md. We do not ship that call
 * enabled by default because it sends a hash prefix to a third party, which
 * some customers cannot accept without a DPA.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'passwordpassword',
  '123456789012', '1234567890', '123456789', 'qwertyuiop',
  'qwerty123456', 'letmein12345', 'iloveyou1234', 'welcome12345',
  'administrator', 'adminadmin', 'admin1234567', 'changeme1234',
  'monkeymonkey', 'dragondragon', 'football1234', 'baseball1234',
  'trustno1trust', 'superman1234', 'starwars1234', 'whatever1234',
  'indexflow123', 'indexflow1234', 'seotools1234', 'googleindex1',
]);

export interface PasswordStrength {
  ok: boolean;
  /** 0–4, in the familiar zxcvbn-style scale. */
  score: 0 | 1 | 2 | 3 | 4;
  label: 'very weak' | 'weak' | 'fair' | 'strong' | 'very strong';
  /** Ordered, actionable. The first entry is shown as the form error. */
  problems: string[];
  suggestions: string[];
}

/**
 * Validate a password against policy and estimate its strength.
 *
 * `context` should carry the user's email and name. Rejecting a password that
 * contains the user's own identifiers matters more than any character-class
 * rule, because those are the first things an attacker tries.
 */
export function checkPasswordStrength(
  password: string,
  context: { email?: string; name?: string; workspaceName?: string } = {},
): PasswordStrength {
  const problems: string[] = [];
  const suggestions: string[] = [];

  if (typeof password !== 'string' || password.length === 0) {
    return {
      ok: false,
      score: 0,
      label: 'very weak',
      problems: ['Password is required.'],
      suggestions: [`Use at least ${MIN_PASSWORD_LENGTH} characters.`],
    };
  }

  const pwd = password.normalize('NFKC');
  const lower = pwd.toLowerCase();

  // ---- Hard requirements ----
  if (pwd.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  if (pwd.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Password must be no more than ${MAX_PASSWORD_LENGTH} characters long.`);
  }
  if (/^\s|\s$/.test(pwd)) {
    problems.push('Password cannot begin or end with a space.');
  }

  const classes = {
    lower: /[a-z]/.test(pwd),
    upper: /[A-Z]/.test(pwd),
    digit: /[0-9]/.test(pwd),
    symbol: /[^A-Za-z0-9]/.test(pwd),
  };
  const classCount = Object.values(classes).filter(Boolean).length;

  // Three of four classes, rather than all four. Requiring every class is what
  // pushes people towards "Password1!" — predictable, and weaker than a long
  // passphrase that happens to omit symbols.
  if (classCount < 3) {
    problems.push(
      'Use at least three of: lowercase letters, uppercase letters, numbers, symbols.',
    );
  }

  if (COMMON_PASSWORDS.has(lower)) {
    problems.push('This password appears in lists of commonly breached passwords.');
  }

  // A single repeated character or a pure sequence — long but worthless.
  if (/^(.)\1+$/.test(pwd)) {
    problems.push('Password cannot be a single repeated character.');
  }
  if (isSequential(lower)) {
    problems.push('Password cannot be a simple sequence like "abcdefghijkl" or "123456789012".');
  }

  // ---- Contains the user's own identity ----
  const identityFragments: string[] = [];
  if (context.email) {
    const local = context.email.split('@')[0];
    if (local && local.length >= 4) identityFragments.push(local.toLowerCase());
    const domain = context.email.split('@')[1]?.split('.')[0];
    if (domain && domain.length >= 4) identityFragments.push(domain.toLowerCase());
  }
  for (const source of [context.name, context.workspaceName]) {
    if (!source) continue;
    for (const word of source.toLowerCase().split(/\s+/)) {
      if (word.length >= 4) identityFragments.push(word);
    }
  }
  if (identityFragments.some((fragment) => lower.includes(fragment))) {
    problems.push('Password must not contain your name, email address or company name.');
  }

  // ---- Strength estimate ----
  // A rough entropy proxy: effective alphabet size × length, penalised for
  // repetition. Not a substitute for zxcvbn, but honest about what it measures
  // and good enough to drive a meter.
  const alphabet =
    (classes.lower ? 26 : 0) +
    (classes.upper ? 26 : 0) +
    (classes.digit ? 10 : 0) +
    (classes.symbol ? 33 : 0);
  const uniqueRatio = new Set(pwd).size / pwd.length;
  const bits = alphabet > 1 ? Math.log2(alphabet) * pwd.length * uniqueRatio : 0;

  let score: 0 | 1 | 2 | 3 | 4;
  if (bits < 40) score = 0;
  else if (bits < 60) score = 1;
  else if (bits < 80) score = 2;
  else if (bits < 110) score = 3;
  else score = 4;

  // Any hard failure caps the displayed score, so the meter can never say
  // "strong" about a password we are about to reject.
  if (problems.length > 0 && score > 1) score = 1;

  const labels = ['very weak', 'weak', 'fair', 'strong', 'very strong'] as const;

  if (score < 3) {
    if (pwd.length < 16) {
      suggestions.push('Longer is stronger — try a passphrase of four or more unrelated words.');
    }
    if (!classes.symbol) suggestions.push('Adding a symbol or two helps.');
    if (uniqueRatio < 0.6) suggestions.push('Avoid repeating the same few characters.');
  }

  return {
    ok: problems.length === 0,
    score,
    label: labels[score]!,
    problems,
    suggestions,
  };
}

/** Detects ascending or descending runs across the keyboard rows and alphabet. */
function isSequential(value: string): boolean {
  const runs = [
    'abcdefghijklmnopqrstuvwxyz',
    '01234567890',
    'qwertyuiop',
    'asdfghjkl',
    'zxcvbnm',
  ];
  for (const run of runs) {
    const reversed = [...run].reverse().join('');
    if (run.includes(value) || reversed.includes(value)) return true;
  }
  return false;
}

/**
 * A strong random password, offered in the UI as a "generate" affordance.
 * Uses an unambiguous alphabet (no O/0, l/1/I) so it can be read aloud or
 * transcribed without errors.
 */
export function generateStrongPassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  // Rejection sampling keeps the distribution uniform; naive modulo would bias
  // towards the start of the alphabet.
  const limit = 256 - (256 % alphabet.length);
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const byte = bytes[i]!;
    if (byte >= limit) continue;
    out += alphabet[byte % alphabet.length];
  }
  return out.length === length ? out : out + generateStrongPassword(length - out.length);
}
