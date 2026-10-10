/**
 * Prisma client singleton.
 *
 * Two things happen here beyond constructing a client:
 *
 *  1. HMR safety in development. `tsx watch` re-evaluates modules on change; a
 *     fresh PrismaClient per reload exhausts the database's connection limit
 *     within a few saves. Caching on `globalThis` avoids that.
 *
 *  2. A tenant-isolation tripwire. A Prisma `$extends` query hook inspects every
 *     query against a workspace-scoped model and throws if no `workspaceId`
 *     appears in the filter. This is a defence-in-depth net under the explicit
 *     scoping that services already do — the kind of bug it catches (a
 *     `findMany` that forgot its where clause and returns every tenant's URLs)
 *     is exactly the bug that is easy to write and catastrophic to ship.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Models whose rows belong to exactly one workspace. Any read or write against
 * these must be filtered by workspaceId.
 *
 * Kept as a literal list rather than derived from the schema so that adding a
 * new tenant table is a conscious decision that shows up in review.
 */
const TENANT_SCOPED_MODELS = new Set<string>([
  'Url',
  'UrlJob',
  'UrlBatch',
  'CreditLedgerEntry',
  'Payment',
  'ApiKey',
  'ApiUsage',
  'SearchConsoleProperty',
  'OAuthConnection',
  'GoogleQuotaUsage',
  'Subscription',
  'WorkspaceInvite',
]);

/**
 * Operations that read or mutate an unbounded set of rows and therefore need a
 * tenant filter. Single-row operations addressed by primary key (`findUnique`,
 * `update` with an id) are excluded: services fetch by id and then assert
 * ownership, which the guard cannot see, so flagging them would produce noise
 * rather than safety. `assertTenantOwnership` below is the check for that path.
 */
const GUARDED_OPERATIONS = new Set<string>([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Recursively look for a workspaceId constraint anywhere in a Prisma `where`
 * clause, including inside AND / OR / NOT and inside relation filters such as
 * `{ workspace: { id: ... } }` or `{ url: { workspaceId: ... } }`.
 */
function hasWorkspaceFilter(where: unknown, depth = 0): boolean {
  if (depth > 6 || where === null || typeof where !== 'object') return false;

  if (Array.isArray(where)) {
    return where.some((entry) => hasWorkspaceFilter(entry, depth + 1));
  }

  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'workspaceId' && value !== undefined) return true;
    // A filter on a unique id is as narrow as a workspace filter, and services
    // assert ownership afterwards.
    if (key === 'id' && typeof value === 'string') return true;
    if (
      (key === 'AND' || key === 'OR' || key === 'NOT' || key === 'workspace') &&
      hasWorkspaceFilter(value, depth + 1)
    ) {
      return true;
    }
    // Relation traversal: urls -> workspaceId, job -> workspaceId, etc.
    if (typeof value === 'object' && value !== null && hasWorkspaceFilter(value, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Escape hatch for the legitimately cross-tenant callers: the platform admin
 * panel, the retention/maintenance workers and the reconciliation script.
 *
 * Requiring an explicit opt-in means a cross-tenant query is always visible at
 * the call site and grep-able in review — `withGlobalScope` is the one string an
 * auditor needs to search for to find every place tenant isolation is bypassed.
 */
const globalScopeDepth = { value: 0 };

export async function withGlobalScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  globalScopeDepth.value += 1;
  try {
    logger.debug({ reason }, 'Entering cross-tenant query scope');
    return await fn();
  } finally {
    globalScopeDepth.value -= 1;
  }
}

function buildClient() {
  const base = new PrismaClient({
    log: env.isDevelopment
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
    errorFormat: env.isProduction ? 'minimal' : 'pretty',
  });

  base.$on('warn' as never, (event: Prisma.LogEvent) => {
    logger.warn({ prisma: event.message }, 'Prisma warning');
  });

  base.$on('error' as never, (event: Prisma.LogEvent) => {
    logger.error({ prisma: event.message }, 'Prisma error');
  });

  if (env.isDevelopment) {
    base.$on('query' as never, (event: Prisma.QueryEvent) => {
      // Slow-query visibility in development, without drowning the log in noise.
      if (event.duration >= 200) {
        logger.debug(
          { durationMs: event.duration, query: event.query.slice(0, 500) },
          'Slow query',
        );
      }
    });
  }

  return base.$extends({
    name: 'tenant-isolation-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (
            globalScopeDepth.value === 0 &&
            model &&
            TENANT_SCOPED_MODELS.has(model) &&
            GUARDED_OPERATIONS.has(operation)
          ) {
            const where = (args as { where?: unknown }).where;
            if (!hasWorkspaceFilter(where)) {
              const message =
                `Tenant isolation guard: ${model}.${operation}() was called without a workspaceId filter. ` +
                `Scope the query by workspace, or wrap a deliberately cross-tenant call in withGlobalScope('reason', ...).`;

              // In production, refusing the query is safer than serving another
              // tenant's rows. In development we also want the stack trace.
              logger.error({ model, operation }, message);
              throw new Error(message);
            }
          }
          return query(args);
        },
      },
    },
  });
}

type ExtendedPrismaClient = ReturnType<typeof buildClient>;

const globalForPrisma = globalThis as unknown as {
  __indexflowPrisma?: ExtendedPrismaClient;
};

export const prisma: ExtendedPrismaClient =
  globalForPrisma.__indexflowPrisma ?? buildClient();

if (!env.isProduction) {
  globalForPrisma.__indexflowPrisma = prisma;
}

/**
 * Isolation level for money-touching transactions.
 *
 * Serializable is the level at which Postgres guarantees the outcome is
 * equivalent to running the transactions one at a time. For the credit wallet
 * that is not a nicety: at ReadCommitted, two concurrent reservations can each
 * read the same balance and both succeed, which is the double-spend the spec
 * calls out as a critical test. Serializable makes one of them abort with a
 * retryable P2034, which `runSerializable` below then retries.
 */
export const SERIALIZABLE = Prisma.TransactionIsolationLevel.Serializable;

/**
 * Run a transaction at Serializable isolation, retrying on serialization
 * failures with jittered backoff.
 *
 * Serialization failures are expected under contention, not exceptional — the
 * correct response is to retry the whole transaction, which is safe precisely
 * because it was aborted with no effect.
 */
export async function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxRetries?: number; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await (prisma as any).$transaction(fn, {
        isolationLevel: SERIALIZABLE,
        timeout: timeoutMs,
        maxWait: 5_000,
      });
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      // P2034: transaction conflict / deadlock. 40001: serialization failure.
      // 40P01: deadlock detected.
      const isSerializationFailure =
        code === 'P2034' ||
        code === '40001' ||
        code === '40P01' ||
        /write conflict|deadlock|could not serialize/i.test(
          (error as Error)?.message ?? '',
        );

      if (!isSerializationFailure || attempt === maxRetries) throw error;

      // Full jitter. Without jitter, two conflicting workers retry in lockstep
      // and collide again at the same moment.
      const backoff = Math.min(500, 2 ** attempt * 10) * Math.random();
      logger.debug(
        { attempt, maxRetries, label: options.label, backoffMs: Math.round(backoff) },
        'Serialization conflict, retrying transaction',
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError;
}

/**
 * Assert that a fetched row belongs to the caller's workspace.
 *
 * Deliberately throws a 404-shaped error, not a 403: telling an attacker "this
 * id exists but is not yours" is an IDOR oracle that lets them enumerate other
 * tenants' identifiers.
 */
export function assertTenantOwnership<T extends { workspaceId: string } | null | undefined>(
  row: T,
  workspaceId: string,
  resourceName = 'Resource',
): NonNullable<T> {
  if (!row || row.workspaceId !== workspaceId) {
    // Imported lazily to avoid a cycle between errors.ts and prisma.ts.
    const { NotFoundError } = require('./errors') as typeof import('./errors');
    throw new NotFoundError(resourceName, {
      internal: row
        ? `Cross-tenant access attempt: row workspace=${row.workspaceId} caller workspace=${workspaceId}`
        : 'Row does not exist',
    });
  }
  return row as NonNullable<T>;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export { Prisma };
