/**
 * Structured logging.
 *
 * Two rules drive this file:
 *
 *  1. Logs are JSON in production. Pretty output is a development affordance
 *     only — grep-able JSON is what makes an incident tractable.
 *
 *  2. Secrets never reach a log sink. Redaction here is deliberately
 *     belt-and-braces: a `redact` path list for known field names, PLUS a
 *     recursive scrubber that matches suspicious key names and value shapes.
 *     The path list alone is not enough, because the day someone adds
 *     `googleTokens.refresh_token` to a log call is the day a refresh token ends
 *     up in a log aggregator that a wider group of people can read.
 */

import pino from 'pino';
import { env } from '../config/env';

/**
 * Exact paths scrubbed by pino itself. Fast, and covers the shapes we actually
 * log (request objects, Prisma models, provider payloads).
 */
const REDACT_PATHS = [
  // Request/response surfaces
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-api-secret"]',
  'req.headers["x-razorpay-signature"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.confirmPassword',
  'req.body.token',
  'req.body.apiSecret',
  'res.headers["set-cookie"]',

  // Our own model fields
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'currentPassword',
  'refreshToken',
  'refresh_token',
  'refreshTokenEnc',
  'refresh_token_enc',
  'accessToken',
  'access_token',
  'accessTokenEnc',
  'access_token_enc',
  'idToken',
  'id_token',
  'clientSecret',
  'client_secret',
  'secretHash',
  'secret_hash',
  'apiSecret',
  'apiKeySecret',
  'sessionSecret',
  'encryptionKey',
  'tokenHash',
  'token_hash',
  'signature',
  'webhookSecret',
  'authorization',
  'cookie',

  // Nested provider payloads
  '*.password',
  '*.refreshToken',
  '*.refresh_token',
  '*.accessToken',
  '*.access_token',
  '*.clientSecret',
  '*.client_secret',
  '*.signature',
  '*.apiSecret',
];

const REDACTED = '[REDACTED]';

/**
 * Key names that must never have their value logged, matched case-insensitively
 * as substrings. Catches `googleRefreshToken`, `stripe_secret_key`,
 * `x-api-secret`, and anything else a future contributor names sensibly.
 */
const SENSITIVE_KEY_PATTERN =
  /(pass|secret|token|credential|private[_-]?key|api[_-]?key|signature|authorization|cookie|session[_-]?id|otp|cvv|card[_-]?number)/i;

/**
 * Value shapes that are secrets regardless of their key name. The Google refresh
 * token and Razorpay key prefixes are here because a payload we did not
 * anticipate is exactly the case the key-name list misses.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^ya29\.[\w-]+/, // Google OAuth access token
  /^1\/\/[\w-]{20,}/, // Google OAuth refresh token
  /^GOCSPX-[\w-]+/, // Google client secret
  /^rzp_(test|live)_[\w]+/, // Razorpay key id
  /^sk_(test|live)_[\w]+/, // Stripe-style secret key
  /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, // JWT
  /^scrypt\$\d+\$/, // our own password hash format
  /^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/, // our AES-GCM envelope
];

const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 2000;

/**
 * Recursively scrub an object before it is logged.
 *
 * Also truncates very long strings: a 2 MB HTML body from a pre-check does not
 * belong in a log line, and unbounded log entries are their own availability
 * problem.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth > MAX_DEPTH) return '[Object: max depth]';

  if (typeof value === 'string') {
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) return REDACTED;
    }
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message, depth + 1),
      stack: env.isProduction ? undefined : value.stack,
      ...('code' in value ? { code: (value as { code?: unknown }).code } : {}),
    };
  }

  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;

  if (Array.isArray(value)) {
    // Cap array size so a 10,000-URL batch cannot become a 10,000-entry log line.
    const capped = value.slice(0, 50).map((item) => scrub(item, depth + 1));
    if (value.length > 50) capped.push(`… ${value.length - 50} more items`);
    return capped;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        // Keep a length hint: "the token was 103 chars" is often the useful part
        // of a debugging session, and reveals nothing.
        out[key] =
          typeof child === 'string' ? `${REDACTED} (${child.length} chars)` : REDACTED;
        continue;
      }
      out[key] = scrub(child, depth + 1);
    }
    return out;
  }

  return '[Unserialisable]';
}

const transport =
  env.LOG_PRETTY && !env.isProduction
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      }
    : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'indexflow',
    env: env.NODE_ENV,
  },
  redact: {
    paths: REDACT_PATHS,
    censor: REDACTED,
    remove: false,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Applied to every log call's merged object, so the recursive scrubber runs
  // even on fields the path list has never heard of.
  hooks: {
    logMethod(args, method) {
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        args[0] = scrub(args[0]) as object;
      }
      return method.apply(this, args as Parameters<typeof method>);
    },
  },
  ...(transport ? { transport } : {}),
});

/**
 * Child logger bound to a request, so every line from one request shares a
 * correlation id. `requestId` is what turns "a customer says their batch
 * failed" into a single grep.
 */
export function requestLogger(fields: {
  requestId: string;
  userId?: string | undefined;
  workspaceId?: string | undefined;
  apiKeyId?: string | undefined;
}) {
  return logger.child(fields);
}

/** Child logger for a queue worker, bound to the job it is processing. */
export function jobLogger(fields: {
  jobId: string;
  workspaceId: string;
  jobType: string;
  attempt: number;
  workerId: string;
}) {
  return logger.child(fields);
}

export type Logger = typeof logger;
