'use strict';

const logger = require('../utils/logger');

const REDIS_LOG_THROTTLE_MS = parseInt(process.env.REDIS_LOG_THROTTLE_MS || '60000', 10);
const REDIS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.REDIS_RECONNECT_MAX_ATTEMPTS || '8', 10);
const REDIS_RECONNECT_BASE_DELAY_MS = parseInt(process.env.REDIS_RECONNECT_BASE_DELAY_MS || '500', 10);
const REDIS_RECONNECT_MAX_DELAY_MS = parseInt(process.env.REDIS_RECONNECT_MAX_DELAY_MS || '30000', 10);

let client = null;
let lastRedisWarningAt = 0;
let status = {
  configured: Boolean(process.env.REDIS_HOST),
  connected: false,
  status: process.env.REDIS_HOST ? 'unavailable' : 'disabled',
  reason: null,
  lastUpdatedAt: new Date().toISOString(),
};

function _throttleRedisWarning(message, meta = {}) {
  const now = Date.now();
  if (now - lastRedisWarningAt < REDIS_LOG_THROTTLE_MS) {
    logger.debug('[RedisClient] Suppressed duplicate warning', { message, ...meta });
    return;
  }
  lastRedisWarningAt = now;
  logger.warn('[RedisClient] ' + message, meta);
}

function _updateStatus(newStatus, reason = null) {
  status = {
    configured: status.configured,
    connected: newStatus === 'ready',
    status: newStatus,
    reason: reason || status.reason,
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Shared reconnection policy used by every Redis consumer (queue, SSE pub/sub,
 * distributed locks, rate limiter, refresh-token store). Centralising it here
 * means all consumers reconnect with the same exponential backoff and treat the
 * same error codes as transient — Issue #83: "Reconnection policy consistent".
 *
 * Pass overrides for connection-specific requirements. BullMQ Worker/QueueEvents
 * connections, for example, require `maxRetriesPerRequest: null`.
 *
 * @param {object} [overrides] Merged over the shared defaults.
 */
function getRedisConnectionOptions(overrides = {}) {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    enableOfflineQueue: false,
    // Must be null: this single shared client is also handed to BullMQ
    // (transactionRetryQueue), whose blocking Worker/QueueEvents connections
    // throw "Your redis options maxRetriesPerRequest must be null" otherwise.
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
    retryStrategy(times) {
      if (times >= REDIS_RECONNECT_MAX_ATTEMPTS) {
        return null;
      }
      return Math.min(
        REDIS_RECONNECT_BASE_DELAY_MS * Math.pow(2, times - 1),
        REDIS_RECONNECT_MAX_DELAY_MS,
      );
    },
    reconnectOnError(err) {
      if (!err || !err.message) return false;
      const transientCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'];
      return transientCodes.some((code) => err.message.includes(code));
    },
    ...overrides,
  };
}

function getRedisConfig() {
  return getRedisConnectionOptions();
}

function createRedisClient() {
  if (!process.env.REDIS_HOST) {
    return null;
  }

  if (client) {
    return client;
  }

  try {
    const Redis = require('ioredis');
    client = new Redis(getRedisConfig());

    client.on('connect', () => {
      _updateStatus('connecting');
      logger.info('[RedisClient] connecting', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('ready', () => {
      _updateStatus('ready');
      status.reason = null;
      logger.info('[RedisClient] connected');
    });

    client.on('error', (err) => {
      _updateStatus('unavailable', err.message);
      _throttleRedisWarning('Redis unavailable', {
        error: err.message,
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('close', () => {
      _updateStatus('closed', 'connection closed');
      _throttleRedisWarning('Redis connection closed', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('end', () => {
      _updateStatus('ended', 'connection ended');
      _throttleRedisWarning('Redis connection ended', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('reconnecting', (delay) => {
      _updateStatus('reconnecting', `retrying in ${delay}ms`);
      logger.debug('[RedisClient] reconnecting', { delay });
    });
  } catch (err) {
    _updateStatus('unavailable', err.message);
    _throttleRedisWarning('Failed to create Redis client', { error: err.message });
    client = null;
  }

  return client;
}

function getRedisClient() {
  return client || createRedisClient();
}

function getRedisStatus() {
  return { ...status };
}

function isRedisReady() {
  return status.connected;
}

const REDIS_CHECK_TIMEOUT_MS = parseInt(process.env.REDIS_CHECK_TIMEOUT_MS || '2000', 10);

function isRedisRequired() {
  return process.env.REDIS_REQUIRED === 'true';
}

/**
 * Health check probe with bounded timeout.
 * Performs a ping operation against Redis to check live connectivity.
 *
 * @param {number} [timeoutMs=REDIS_CHECK_TIMEOUT_MS]
 * @returns {Promise<{ configured: boolean, status: string, latencyMs?: number, error?: string, required: boolean }>}
 */
async function checkRedis(timeoutMs = REDIS_CHECK_TIMEOUT_MS) {
  const configured = Boolean(process.env.REDIS_HOST);
  const required = isRedisRequired();

  if (!configured) {
    return {
      configured: false,
      status: 'disabled',
      required,
    };
  }

  const c = getRedisClient();
  if (!c) {
    return {
      configured: true,
      status: 'unreachable',
      error: 'Redis client could not be created',
      required,
    };
  }

  const start = Date.now();
  let timerHandle;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timerHandle = setTimeout(() => {
        reject(new Error(`Redis did not respond to PING within ${timeoutMs}ms`));
      }, timeoutMs);
      if (timerHandle.unref) timerHandle.unref();
    });

    await Promise.race([
      c.ping(),
      timeoutPromise,
    ]);

    const latencyMs = Date.now() - start;
    return {
      configured: true,
      status: 'ok',
      latencyMs,
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      required,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      configured: true,
      status: 'unreachable',
      error: err.message,
      latencyMs,
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      required,
    };
  } finally {
    clearTimeout(timerHandle);
  }
}


function resetRedisClient() {
  if (client) {
    try {
      client.quit().catch(() => logger.debug('[RedisClient] quit missed during reset'));
    } catch (_) {}
  }
  client = null;
  lastRedisWarningAt = 0;
  status = {
    configured: Boolean(process.env.REDIS_HOST),
    connected: false,
    status: process.env.REDIS_HOST ? 'unavailable' : 'disabled',
    reason: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

const WAIT_FOR_REDIS_DEFAULT_TIMEOUT_MS = parseInt(
  process.env.REDIS_STARTUP_TIMEOUT_MS || '30000',
  10,
);
const WAIT_FOR_REDIS_INITIAL_INTERVAL_MS = 500;
const WAIT_FOR_REDIS_MAX_INTERVAL_MS = 5000;

/**
 * Attempt to establish a Redis connection at startup with exponential backoff retries.
 *
 * This is intended for use during application startup to give Redis time to become
 * available before the app either proceeds in degraded mode or aborts (when
 * `REDIS_REQUIRED=true`). Unlike the health-check probe (`checkRedis`), this
 * function will actively wait and retry rather than returning immediately.
 *
 * Retry schedule:
 *   - Attempt 1: immediate
 *   - Attempt 2: wait 500 ms
 *   - Attempt 3: wait 1 000 ms
 *   - Attempt 4: wait 2 000 ms
 *   - Attempt 5+: wait 5 000 ms (capped)
 *   - Gives up once `timeoutMs` total elapsed time is exceeded.
 *
 * @param {number} [timeoutMs=WAIT_FOR_REDIS_DEFAULT_TIMEOUT_MS]
 *   Total wall-clock budget before giving up (default: `REDIS_STARTUP_TIMEOUT_MS`
 *   env var, falling back to 30 000 ms).
 * @param {number} [retryIntervalMs=WAIT_FOR_REDIS_INITIAL_INTERVAL_MS]
 *   Starting retry interval in milliseconds. Doubles on each attempt, capped at
 *   `WAIT_FOR_REDIS_MAX_INTERVAL_MS` (5 000 ms).
 * @returns {Promise<{ connected: boolean, attempts: number, reason?: string }>}
 *   - `connected`  — `true` if Redis responded to PING within the budget.
 *   - `attempts`   — total number of PING attempts made.
 *   - `reason`     — present only when `connected` is `false`; describes why the
 *                    last attempt failed (error message or timeout explanation).
 */
async function waitForRedis(
  timeoutMs = WAIT_FOR_REDIS_DEFAULT_TIMEOUT_MS,
  retryIntervalMs = WAIT_FOR_REDIS_INITIAL_INTERVAL_MS,
) {
  const configured = Boolean(process.env.REDIS_HOST);

  if (!configured) {
    logger.info('[RedisClient] waitForRedis: Redis not configured (REDIS_HOST unset); skipping startup wait', {
      timeoutMs,
    });
    return { connected: false, attempts: 0, reason: 'Redis not configured (REDIS_HOST unset)' };
  }

  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastReason = 'timeout exceeded before first attempt';
  let intervalMs = Math.max(retryIntervalMs, WAIT_FOR_REDIS_INITIAL_INTERVAL_MS);

  logger.info('[RedisClient] waitForRedis: starting startup Redis probe', {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
    timeoutMs,
    initialIntervalMs: intervalMs,
  });

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = deadline - Date.now();

    logger.debug('[RedisClient] waitForRedis: attempt', {
      attempt: attempts,
      remainingMs,
      intervalMs,
    });

    // Use a bounded PING timeout equal to the smaller of the remaining budget or
    // the standard health-check timeout, so we don't hang past the deadline.
    const pingTimeout = Math.min(remainingMs, REDIS_CHECK_TIMEOUT_MS);

    if (pingTimeout <= 0) {
      lastReason = `startup timeout of ${timeoutMs}ms exceeded after ${attempts} attempt(s)`;
      break;
    }

    const result = await checkRedis(pingTimeout);

    if (result.status === 'ok') {
      logger.info('[RedisClient] waitForRedis: Redis is ready', {
        attempts,
        latencyMs: result.latencyMs,
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
      return { connected: true, attempts };
    }

    lastReason = result.error || result.status || 'unknown error';

    logger.debug('[RedisClient] waitForRedis: attempt failed', {
      attempt: attempts,
      reason: lastReason,
      latencyMs: result.latencyMs,
      nextRetryMs: intervalMs,
    });

    // Check whether we still have enough budget for another wait + attempt.
    const timeAfterSleep = Date.now() + intervalMs;
    if (timeAfterSleep >= deadline) {
      lastReason = `startup timeout of ${timeoutMs}ms exceeded after ${attempts} attempt(s): ${lastReason}`;
      break;
    }

    // Wait before the next attempt, then double the interval (capped at max).
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    intervalMs = Math.min(intervalMs * 2, WAIT_FOR_REDIS_MAX_INTERVAL_MS);
  }

  logger.info('[RedisClient] waitForRedis: Redis unavailable after startup probe', {
    attempts,
    reason: lastReason,
    required: isRedisRequired(),
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
  });

  return { connected: false, attempts, reason: lastReason };
}

module.exports = {
  createRedisClient,
  getRedisClient,
  getRedisConfig,
  getRedisConnectionOptions,
  getRedisStatus,
  isRedisReady,
  isRedisRequired,
  checkRedis,
  waitForRedis,
  REDIS_CHECK_TIMEOUT_MS,
  WAIT_FOR_REDIS_DEFAULT_TIMEOUT_MS,
  resetRedisClient,
};
