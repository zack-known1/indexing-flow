/**
 * Redis connections.
 *
 * Three logically separate clients, because they have incompatible needs:
 *
 *  • `redis`          — general commands: rate limiting, caches, locks.
 *  • `sessionRedis`   — the session store. Separated so a `FLUSHDB` on the cache
 *                       during an incident does not log every customer out.
 *  • `queueRedis`     — BullMQ. Requires `maxRetriesPerRequest: null`, which is
 *                       wrong for request-path clients (it makes a request hang
 *                       forever instead of failing fast), hence its own client.
 *
 * Availability posture: Redis being down must degrade, not destroy. The queue
 * reports unhealthy so the load balancer stops sending traffic, and sessions
 * become unreadable — which logs people out but does not corrupt anything.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/** Namespaced key, so several environments can share one Redis instance safely. */
export function key(...parts: (string | number)[]): string {
  return [env.REDIS_PREFIX, ...parts].join(':');
}

function baseOptions(name: string): RedisOptions {
  return {
    connectionName: `indexflow:${name}`,
    lazyConnect: true,
    enableReadyCheck: true,
    // Bounded exponential backoff. Without a cap, a long outage pushes the retry
    // delay into the minutes and recovery looks like a hang.
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5_000);
      if (times === 1 || times % 10 === 0) {
        logger.warn({ client: name, attempt: times, delayMs: delay }, 'Reconnecting to Redis');
      }
      return delay;
    },
    reconnectOnError(error: Error) {
      // A failover to a replica surfaces as READONLY; reconnecting picks up the
      // new primary instead of failing every write until a restart.
      return error.message.includes('READONLY');
    },
    // rediss:// needs TLS. Managed providers commonly present a certificate for
    // a hostname that differs from the connection host, so allow the operator to
    // keep verification on by default and document the override.
    ...(env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}),
  };
}

function createClient(name: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(env.REDIS_URL, { ...baseOptions(name), ...overrides });

  client.on('error', (error: Error) => {
    // Connection errors arrive repeatedly during an outage. Log at warn and let
    // the health endpoint be the signal, rather than filling the log with
    // identical error lines.
    logger.warn({ client: name, err: error.message }, 'Redis connection error');
  });
  client.on('ready', () => {
    logger.info({ client: name }, 'Redis connected');
  });
  client.on('end', () => {
    logger.warn({ client: name }, 'Redis connection closed');
  });

  return client;
}

const globalForRedis = globalThis as unknown as {
  __indexflowRedis?: Redis;
  __indexflowSessionRedis?: Redis;
  __indexflowQueueRedis?: Redis;
};

export const redis: Redis = globalForRedis.__indexflowRedis ?? createClient('general');

export const sessionRedis: Redis =
  globalForRedis.__indexflowSessionRedis ?? createClient('session');

/**
 * BullMQ's connection. `maxRetriesPerRequest: null` is mandated by BullMQ:
 * blocking commands such as BRPOPLPUSH must not be aborted mid-wait.
 */
export const queueRedis: Redis =
  globalForRedis.__indexflowQueueRedis ??
  createClient('queue', { maxRetriesPerRequest: null, enableReadyCheck: false });

if (!env.isProduction) {
  globalForRedis.__indexflowRedis = redis;
  globalForRedis.__indexflowSessionRedis = sessionRedis;
  globalForRedis.__indexflowQueueRedis = queueRedis;
}

export async function connectRedis(): Promise<void> {
  await Promise.all(
    [redis, sessionRedis, queueRedis].map(async (client) => {
      if (client.status !== 'wait') return;
      try {
        await client.connect();
      } catch (error) {
        logger.warn(
          { err: (error as Error).message },
          'Redis unavailable at startup; continuing and retrying in the background',
        );
      }
    }),
  );
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), sessionRedis.quit(), queueRedis.quit()]);
}

export function isRedisHealthy(): boolean {
  return redis.status === 'ready';
}

export async function pingRedis(timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis ping timeout')), timeoutMs);
      }),
    ]);
    return result === 'PONG';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Distributed lock
// ---------------------------------------------------------------------------

/**
 * Single-instance Redlock-style mutex.
 *
 * Used for operations that must not run concurrently across worker processes:
 * subscription renewal grants, quota-window resets, retention sweeps.
 *
 * The release path uses a Lua compare-and-delete against a random token. A plain
 * `DEL` would let a process whose lock had already expired delete a *different*
 * process's freshly acquired lock — a classic and very confusing bug.
 *
 * Honest scope note: this is safe against process crashes and races, but it is
 * not a consensus algorithm. It is not safe under a Redis primary failover that
 * loses writes. Every caller here is idempotent, so a rare double execution is
 * tolerable; do not use it to guard something that is not.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface Lock {
  release(): Promise<void>;
  /** Extend the lease. Returns false if the lock was already lost. */
  extend(ttlMs: number): Promise<boolean>;
}

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export async function acquireLock(
  name: string,
  ttlMs = 30_000,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<Lock | null> {
  const lockKey = key('lock', name);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const retries = options.retries ?? 0;
  const retryDelay = options.retryDelayMs ?? 100;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      return {
        async release() {
          try {
            await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
          } catch (error) {
            logger.warn({ lock: name, err: error }, 'Failed to release lock; it will expire');
          }
        },
        async extend(newTtlMs: number) {
          const result = await redis.eval(EXTEND_SCRIPT, 1, lockKey, token, String(newTtlMs));
          return result === 1;
        },
      };
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  return null;
}

/** Run `fn` while holding a lock, or skip it entirely if the lock is taken. */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lock = await acquireLock(name, ttlMs);
  if (!lock) {
    logger.debug({ lock: name }, 'Lock held elsewhere; skipping');
    return null;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Small cache helper
// ---------------------------------------------------------------------------

/**
 * Read-through cache with a short TTL. Used for system settings and public
 * pricing, which are read on nearly every request but change rarely.
 *
 * Cache misses are never fatal: any Redis failure falls through to the loader,
 * so a Redis outage makes the app slower, not broken.
 */
export async function cached<T>(
  cacheKey: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const fullKey = key('cache', cacheKey);
  try {
    const hit = await redis.get(fullKey);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (error) {
    logger.debug({ cacheKey, err: error }, 'Cache read failed; falling through to loader');
  }

  const value = await loader();

  try {
    await redis.set(fullKey, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    logger.debug({ cacheKey, err: error }, 'Cache write failed');
  }

  return value;
}

export async function invalidateCache(cacheKey: string): Promise<void> {
  try {
    await redis.del(key('cache', cacheKey));
  } catch (error) {
    logger.warn({ cacheKey, err: error }, 'Cache invalidation failed');
  }
}
