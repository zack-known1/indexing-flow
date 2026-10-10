/**
 * Environment configuration — validated once, at boot, then frozen.
 *
 * Why fail-fast: a SaaS handling payments and OAuth tokens must never start in a
 * half-configured state. A missing ENCRYPTION_KEY discovered at 3am when the
 * first customer connects Google is a much worse outcome than refusing to boot.
 *
 * Nothing else in the codebase reads `process.env` directly. Import `env` from
 * here so every value is typed, parsed and range-checked exactly once.
 */

import { z } from 'zod';
import crypto from 'node:crypto';

/** Coerce "true"/"1"/"yes" style values into real booleans. */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

/** Integer from env with bounds, so a typo cannot set concurrency to 100000. */
const intish = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? defaultValue : Number(v)))
    .pipe(
      z
        .number({ invalid_type_error: 'must be a number' })
        .int('must be a whole number')
        .min(min)
        .max(max),
    );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const schema = z
  .object({
    // ---- Core ----
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intish(3000, 1, 65535),
    APP_URL: z
      .string()
      .url('APP_URL must be an absolute URL, e.g. https://app.example.com')
      // A trailing slash silently breaks OAuth redirect URI matching, which
      // produces a confusing redirect_uri_mismatch from Google. Strip it.
      .transform((v) => v.replace(/\/+$/, '')),
    APP_NAME: z.string().min(1).default('IndexFlow'),
    TRUST_PROXY: boolish(false),

    // ---- Data stores ----
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a PostgreSQL connection string',
      }),
    DATABASE_POOL_SIZE: intish(10, 1, 100),
    REDIS_URL: z
      .string()
      .min(1, 'REDIS_URL is required — the job queue and rate limiter depend on it')
      .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
        message: 'REDIS_URL must start with redis:// or rediss://',
      }),
    REDIS_PREFIX: z.string().min(1).default('indexflow'),

    // ---- Secrets ----
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters')
      .refine((v) => !/^replace_me/i.test(v), {
        message: 'SESSION_SECRET still holds the placeholder from .env.example',
      }),
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => /^[0-9a-fA-F]{64}$/.test(v), {
        message:
          'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      }),
    ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0),
      )
      .refine((keys) => keys.every((k) => /^[0-9a-fA-F]{64}$/.test(k)), {
        message: 'Every ENCRYPTION_KEY_PREVIOUS entry must be 64 hex characters',
      }),

    // ---- Google ----
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REDIRECT_URI: optionalString,
    GOOGLE_INDEXING_API_ENABLED: boolish(false),
    GOOGLE_INSPECTION_DAILY_QUOTA: intish(2000, 1, 1_000_000),
    GOOGLE_INSPECTION_PER_MINUTE_QUOTA: intish(600, 1, 100_000),
    GOOGLE_INDEXING_DAILY_QUOTA: intish(200, 1, 1_000_000),

    // ---- Payments ----
    PAYMENT_PROVIDER: z.enum(['razorpay', 'none']).default('none'),
    PAYMENT_PROVIDER_KEY: optionalString,
    PAYMENT_PROVIDER_SECRET: optionalString,
    PAYMENT_WEBHOOK_SECRET: optionalString,
    BILLING_CURRENCY: z.string().length(3).default('INR'),
    BILLING_TAX_PERCENT: intish(0, 0, 100),
    BILLING_COMPANY_NAME: optionalString,
    BILLING_COMPANY_ADDRESS: optionalString,
    BILLING_GSTIN: optionalString,

    // ---- Email ----
    EMAIL_DRIVER: z.enum(['smtp', 'console', 'none']).default('console'),
    EMAIL_FROM: z.string().min(3).default('IndexFlow <no-reply@localhost>'),
    EMAIL_SMTP_HOST: optionalString,
    EMAIL_SMTP_PORT: intish(587, 1, 65535),
    EMAIL_SMTP_SECURE: boolish(false),
    EMAIL_SMTP_USER: optionalString,
    EMAIL_PROVIDER_KEY: optionalString,

    // ---- Admin ----
    ADMIN_EMAIL: z.string().email('ADMIN_EMAIL must be a valid email address'),
    ADMIN_INITIAL_PASSWORD: optionalString,

    // ---- Product limits (runtime-overridable from the admin panel) ----
    CREDIT_COST_SUBMIT: intish(1, 0, 1000),
    CREDIT_COST_STATUS_CHECK: intish(1, 0, 1000),
    CREDIT_COST_PRECHECK: intish(0, 0, 1000),
    SIGNUP_BONUS_CREDITS: intish(100, 0, 1_000_000),
    MAX_BULK_URLS: intish(10_000, 1, 500_000),
    MAX_DAILY_URLS_PER_WORKSPACE: intish(25_000, 1, 5_000_000),
    MAX_CONCURRENT_JOBS_PER_WORKSPACE: intish(5, 1, 200),
    MAX_UPLOAD_SIZE_MB: intish(10, 1, 200),
    JOB_MAX_ATTEMPTS: intish(5, 1, 20),
    JOB_BACKOFF_BASE_MS: intish(30_000, 1000, 3_600_000),
    WORKER_CONCURRENCY: intish(5, 1, 100),
    DATA_RETENTION_DAYS: intish(365, 0, 3650),

    // ---- Observability ----
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    LOG_PRETTY: boolish(false),
    SENTRY_DSN: optionalString,
    METRICS_TOKEN: optionalString,
  })
  // ---- Cross-field rules: things that only make sense together ----
  .superRefine((v, ctx) => {
    const isProd = v.NODE_ENV === 'production';

    // Google is optional as a whole, but partial configuration is a trap: the
    // OAuth button would appear and then fail. Demand all three or none.
    const googleParts = [v.GOOGLE_CLIENT_ID, v.GOOGLE_CLIENT_SECRET, v.GOOGLE_REDIRECT_URI];
    const googleSet = googleParts.filter(Boolean).length;
    if (googleSet > 0 && googleSet < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_CLIENT_ID'],
        message:
          'Google OAuth is partially configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI together, or leave all three blank to disable Google features.',
      });
    }

    // A redirect URI that does not live under APP_URL will always be rejected by
    // Google. Catch it here rather than after a confusing round trip.
    if (v.GOOGLE_REDIRECT_URI && !v.GOOGLE_REDIRECT_URI.startsWith(v.APP_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_REDIRECT_URI'],
        message: `GOOGLE_REDIRECT_URI (${v.GOOGLE_REDIRECT_URI}) must begin with APP_URL (${v.APP_URL}), and must be registered verbatim in the Google Cloud console.`,
      });
    }

    // Same trap for payments: keys without a webhook secret means we could take
    // money and never credit the customer, because settlement is webhook-driven.
    if (v.PAYMENT_PROVIDER !== 'none') {
      for (const key of ['PAYMENT_PROVIDER_KEY', 'PAYMENT_PROVIDER_SECRET', 'PAYMENT_WEBHOOK_SECRET'] as const) {
        if (!v[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when PAYMENT_PROVIDER=${v.PAYMENT_PROVIDER}. Credits are only granted from a signature-verified webhook, so this cannot be skipped.`,
          });
        }
      }
    }

    if (v.EMAIL_DRIVER === 'smtp' && !v.EMAIL_SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_SMTP_HOST'],
        message: 'EMAIL_SMTP_HOST is required when EMAIL_DRIVER=smtp',
      });
    }

    // ---- Production-only guards ----
    if (isProd) {
      if (v.APP_URL.startsWith('http://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_URL'],
          message:
            'APP_URL must use https:// in production. Session cookies are set Secure, so the app is unusable over plain HTTP.',
        });
      }
      if (/^replace_me/i.test(v.ENCRYPTION_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENCRYPTION_KEY'],
          message: 'ENCRYPTION_KEY is still the example placeholder',
        });
      }
      // A weak session secret in production undermines every logged-in session.
      if (new Set(v.SESSION_SECRET).size < 12) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message:
            'SESSION_SECRET has very low entropy. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
        });
      }
      if (v.LOG_PRETTY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOG_PRETTY'],
          message: 'LOG_PRETTY must be false in production so logs stay machine-parseable',
        });
      }
      if (v.ADMIN_INITIAL_PASSWORD && /changeme/i.test(v.ADMIN_INITIAL_PASSWORD)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_INITIAL_PASSWORD'],
          message: 'ADMIN_INITIAL_PASSWORD is still the example placeholder',
        });
      }
    }
  });

type RawEnv = z.infer<typeof schema>;

function loadEnv(): RawEnv {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    // Deliberately verbose. This message is the operator's entire debugging
    // experience for a misconfigured deploy, so make it actionable and never
    // echo the offending value (it may be a secret).
    const lines = parsed.error.issues.map((issue) => {
      const field = issue.path.join('.') || '(root)';
      return `  • ${field}: ${issue.message}`;
    });
    const message = [
      '',
      '════════════════════════════════════════════════════════════════════',
      ' IndexFlow cannot start — invalid environment configuration',
      '════════════════════════════════════════════════════════════════════',
      ...lines,
      '',
      ' Fix these in your .env file (copy .env.example if you have not yet):',
      '   cp .env.example .env',
      '',
      ' Values are never printed here, only field names, so this output is',
      ' safe to paste into a bug report.',
      '════════════════════════════════════════════════════════════════════',
      '',
    ].join('\n');

    // Bypass the logger: it is not constructed yet, and it depends on this file.
    process.stderr.write(message);
    process.exit(1);
  }

  return parsed.data;
}

const raw = loadEnv();

/**
 * Derived, convenience-shaped configuration.
 *
 * `Object.freeze` is not just decoration — it means a compromised or careless
 * module cannot mutate, say, the encryption key or a credit cost at runtime.
 */
export const env = Object.freeze({
  ...raw,

  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',

  /** Feature availability, computed once so route guards stay readable. */
  features: Object.freeze({
    google: Boolean(raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET && raw.GOOGLE_REDIRECT_URI),
    /**
     * Google's Indexing API officially supports only JobPosting and
     * BroadcastEvent URLs. Even with this flag on, a property must
     * independently opt in and declare its content type. See
     * src/services/google/indexing.ts for the per-request gate.
     */
    indexingApi:
      raw.GOOGLE_INDEXING_API_ENABLED &&
      Boolean(raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET),
    payments: raw.PAYMENT_PROVIDER !== 'none',
    email: raw.EMAIL_DRIVER !== 'none',
    metrics: Boolean(raw.METRICS_TOKEN),
  }),

  /** Encryption keys, newest first. Index 0 is used for all new ciphertext. */
  encryptionKeys: Object.freeze(
    [raw.ENCRYPTION_KEY, ...raw.ENCRYPTION_KEY_PREVIOUS].map((hex) =>
      Buffer.from(hex, 'hex'),
    ),
  ),

  /** Stable short id for the active key, embedded in ciphertext for rotation. */
  activeKeyId: crypto
    .createHash('sha256')
    .update(Buffer.from(raw.ENCRYPTION_KEY, 'hex'))
    .digest('hex')
    .slice(0, 8),

  uploadMaxBytes: raw.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
});

export type Env = typeof env;
