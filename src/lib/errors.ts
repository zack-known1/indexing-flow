/**
 * Typed application errors.
 *
 * Every error that can reach a client carries three things:
 *
 *   • `status`   — the HTTP status to send
 *   • `code`     — a stable machine-readable string for API consumers
 *   • `message`  — text safe to show a customer
 *
 * The distinction that matters: `message` is public. Anything sensitive goes in
 * `internal`, which is logged and never serialised into a response. This is how
 * we avoid the classic leak where a database error string containing a query, a
 * hostname or a token ends up rendered in the browser.
 */

/** Stable error codes. API clients should branch on these, never on message text. */
export const ERROR_CODES = {
  // 400
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_URL: 'INVALID_URL',
  BAD_REQUEST: 'BAD_REQUEST',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',

  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  WORKSPACE_SUSPENDED: 'WORKSPACE_SUSPENDED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  CSRF_FAILED: 'CSRF_FAILED',
  PROPERTY_NOT_AUTHORIZED: 'PROPERTY_NOT_AUTHORIZED',

  // 404
  NOT_FOUND: 'NOT_FOUND',

  // 409
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // 402
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',

  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',

  // 423
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_LIMITED: 'QUOTA_LIMITED',

  // 500+
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  GOOGLE_API_ERROR: 'GOOGLE_API_ERROR',
  GOOGLE_AUTH_REVOKED: 'GOOGLE_AUTH_REVOKED',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppErrorOptions {
  /** Extra machine-readable context returned to the client. Must be non-sensitive. */
  details?: unknown;
  /** Logged, never sent. Put the real cause, query, hostname or token status here. */
  internal?: string;
  /** Underlying error, preserved for the log's stack chain. */
  cause?: unknown;
  /** Seconds the client should wait. Rendered as a Retry-After header. */
  retryAfter?: number;
  /** When false, the global handler logs at `warn` instead of `error`. */
  expected?: boolean;
}

export class AppError extends Error {
  override readonly name: string = 'AppError';
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly internal?: string;
  readonly retryAfter?: number;
  /**
   * True for errors that are part of normal operation (a wrong password, an
   * insufficient balance). These are logged at warn level and never paged on.
   * False for genuine faults.
   */
  readonly expected: boolean;
  readonly isAppError = true as const;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.internal = options.internal;
    this.retryAfter = options.retryAfter;
    this.expected = options.expected ?? status < 500;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /** The response body. Deliberately excludes `internal`. */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Constructors for the cases we raise often
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  override readonly name = 'ValidationError';
  constructor(message = 'The submitted data is invalid.', details?: unknown) {
    super(400, ERROR_CODES.VALIDATION_ERROR, message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  override readonly name = 'UnauthenticatedError';
  constructor(message = 'You need to sign in to continue.', code: ErrorCode = ERROR_CODES.UNAUTHENTICATED) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  override readonly name = 'ForbiddenError';
  constructor(
    message = 'You do not have permission to do that.',
    code: ErrorCode = ERROR_CODES.FORBIDDEN,
    options: AppErrorOptions = {},
  ) {
    super(403, code, message, options);
  }
}

/**
 * Used for both "does not exist" and "exists but belongs to another tenant".
 *
 * This is intentional and important: returning 403 for the second case would
 * confirm that a given id exists, which is an IDOR information leak. A caller
 * cannot distinguish the two, so they cannot enumerate other workspaces' ids.
 */
export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  constructor(resource = 'Resource', options: AppErrorOptions = {}) {
    super(404, ERROR_CODES.NOT_FOUND, `${resource} not found.`, options);
  }
}

export class ConflictError extends AppError {
  override readonly name = 'ConflictError';
  constructor(message: string, code: ErrorCode = ERROR_CODES.CONFLICT, details?: unknown) {
    super(409, code, message, { details });
  }
}

/**
 * HTTP 402. The API contract for a spent-out wallet, as specified.
 * `details` gives the client everything needed to render a useful prompt
 * without a second round trip.
 */
export class InsufficientCreditsError extends AppError {
  override readonly name = 'InsufficientCreditsError';
  constructor(required: number, available: number, options: { workspaceId?: string } = {}) {
    super(
      402,
      ERROR_CODES.INSUFFICIENT_CREDITS,
      `This operation needs ${required.toLocaleString()} credits but only ${available.toLocaleString()} are available.`,
      {
        details: {
          required,
          available,
          shortfall: Math.max(0, required - available),
          topUpPath: '/billing',
        },
        internal: options.workspaceId ? `workspace=${options.workspaceId}` : undefined,
        expected: true,
      },
    );
  }
}

export class RateLimitError extends AppError {
  override readonly name = 'RateLimitError';
  constructor(retryAfterSeconds: number, message = 'Too many requests. Please slow down.') {
    super(429, ERROR_CODES.RATE_LIMITED, message, {
      retryAfter: retryAfterSeconds,
      details: { retryAfterSeconds },
      expected: true,
    });
  }
}

/**
 * Raised when a Google API reports quota exhaustion.
 *
 * Distinct from RateLimitError because the remedy is different: the customer
 * cannot fix this by slowing down their own requests — the property's daily
 * Google quota is spent. Jobs move to QUOTA_LIMITED and are rescheduled after
 * the quota window resets, rather than burning retries.
 */
export class QuotaLimitedError extends AppError {
  override readonly name = 'QuotaLimitedError';
  constructor(
    readonly api: string,
    resetsAt: Date | null,
    message = 'The daily Google API quota for this property has been used up.',
  ) {
    super(429, ERROR_CODES.QUOTA_LIMITED, message, {
      details: { api, resetsAt: resetsAt?.toISOString() ?? null },
      retryAfter: resetsAt ? Math.max(60, Math.ceil((resetsAt.getTime() - Date.now()) / 1000)) : 3600,
      expected: true,
    });
  }
}

/** A Google OAuth grant is gone. The customer must re-consent; retrying is futile. */
export class GoogleAuthRevokedError extends AppError {
  override readonly name = 'GoogleAuthRevokedError';
  constructor(connectionId: string, detail?: string) {
    super(
      403,
      ERROR_CODES.GOOGLE_AUTH_REVOKED,
      'Access to this Google account has been revoked or has expired. Please reconnect it to continue.',
      {
        details: { connectionId, reconnectPath: '/properties' },
        internal: detail,
        expected: true,
      },
    );
  }
}

/** A URL is not eligible for the requested Google workflow. */
export class NotEligibleError extends AppError {
  override readonly name = 'NotEligibleError';
  constructor(message: string, details?: unknown) {
    super(422, ERROR_CODES.NOT_ELIGIBLE, message, { details, expected: true });
  }
}

export class UpstreamError extends AppError {
  override readonly name = 'UpstreamError';
  constructor(
    service: string,
    options: AppErrorOptions & { status?: number; code?: ErrorCode } = {},
  ) {
    super(
      options.status ?? 502,
      options.code ?? ERROR_CODES.UPSTREAM_ERROR,
      `${service} is not responding correctly right now. Please try again shortly.`,
      options,
    );
  }
}

export class NotConfiguredError extends AppError {
  override readonly name = 'NotConfiguredError';
  constructor(feature: string, envVars: string[]) {
    super(
      503,
      ERROR_CODES.NOT_CONFIGURED,
      `${feature} is not configured on this deployment.`,
      {
        details: { feature },
        internal: `Missing environment configuration: ${envVars.join(', ')}`,
      },
    );
  }
}

/**
 * Illegal job state transition. Raised by the job state machine rather than
 * silently accepted, because a job that jumps from ERROR back to SUBMITTED would
 * mean our credit accounting no longer matches reality.
 */
export class InvalidStateTransitionError extends AppError {
  override readonly name = 'InvalidStateTransitionError';
  constructor(from: string, to: string, jobId?: string) {
    super(
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      'That action is not valid for the current state of this job.',
      {
        details: { from, to },
        internal: jobId ? `job=${jobId} ${from}->${to}` : `${from}->${to}`,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isAppError?: boolean }).isAppError === true
  );
}

/** Prisma error codes we translate into meaningful client responses. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';
const PRISMA_FK_VIOLATION = 'P2003';
const PRISMA_NOT_FOUND = 'P2025';
const PRISMA_TXN_CONFLICT = 'P2034'; // write conflict / deadlock — retryable

interface PrismaLikeError {
  code?: string;
  meta?: { target?: string[] | string; cause?: string };
  message?: string;
}

/**
 * Convert an unknown thrown value into an AppError.
 *
 * The default is a 500 with a generic message and the real detail routed to
 * `internal`. That default is the security-relevant part: an unrecognised error
 * must never have its raw message forwarded to a client.
 */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const prismaError = error as PrismaLikeError;
    const target = Array.isArray(prismaError.meta?.target)
      ? prismaError.meta.target.join(', ')
      : prismaError.meta?.target;

    switch (prismaError.code) {
      case PRISMA_UNIQUE_VIOLATION:
        return new ConflictError(
          'That record already exists.',
          ERROR_CODES.ALREADY_EXISTS,
          target ? { field: target } : undefined,
        );
      case PRISMA_FK_VIOLATION:
        return new AppError(400, ERROR_CODES.BAD_REQUEST, 'A referenced record does not exist.', {
          internal: prismaError.message,
        });
      case PRISMA_NOT_FOUND:
        return new NotFoundError('Record', { internal: prismaError.message });
      case PRISMA_TXN_CONFLICT:
        return new AppError(
          409,
          ERROR_CODES.CONFLICT,
          'That request conflicted with another operation. Please try again.',
          { internal: prismaError.message, expected: true },
        );
      default:
        break;
    }
  }

  const internal =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Non-error thrown: ${String(error)}`;

  return new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'Something went wrong on our side.', {
    internal,
    cause: error,
    expected: false,
  });
}

/**
 * Is this worth retrying?
 *
 * Used by the worker to decide between scheduling another attempt and moving a
 * job to the dead-letter queue. Getting this wrong in the permissive direction
 * means retrying a permanent failure forever; in the strict direction it means
 * giving up on a transient blip. The list below errs towards "only retry things
 * that are plausibly transient".
 */
export function isRetryable(error: unknown): boolean {
  if (isAppError(error)) {
    if (error.code === ERROR_CODES.QUOTA_LIMITED) return true;
    if (error.code === ERROR_CODES.UPSTREAM_ERROR) return true;
    if (error.code === ERROR_CODES.GOOGLE_API_ERROR) return true;
    if (error.code === ERROR_CODES.DATABASE_ERROR) return true;
    if (error.code === ERROR_CODES.SERVICE_UNAVAILABLE) return true;
    if (error.code === ERROR_CODES.CONFLICT) return true;
    // Auth revoked, not eligible, insufficient credits, validation failures:
    // retrying cannot change the outcome.
    return false;
  }

  const code = (error as { code?: string } | null)?.code;
  const transientNetworkCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ESOCKETTIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    PRISMA_TXN_CONFLICT,
  ];
  if (code && transientNetworkCodes.includes(code)) return true;

  // An unknown error is treated as retryable exactly once by the attempt cap;
  // the backoff plus max_attempts bounds the damage either way.
  return true;
}
