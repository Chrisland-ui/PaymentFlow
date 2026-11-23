'use strict';

/**
 * Cache module with multi-tier Redis support and safe degradation policy.
 *
 * Degradation Policy:
 *   - Redis is used as distributed primary cache when configured and ready.
 *   - Local NodeCache acts as fallback / L1 in-memory tier.
 *   - If Redis times out, disconnects, or errors, the cache gracefully degrades
 *     to local in-memory storage without throwing or failing caller requests.
 *   - Metrics explicitly distinguish normal cache misses (key not present) from
 *     outage degradations (Redis unavailable/failed).
 */

const NodeCache = require('node-cache');
const logger = require('./utils/logger').child('Cache');

let redisClientModule = null;
try {
  redisClientModule = require('./config/redisClient');
} catch (_) {}

let metrics = null;
try {
  metrics = require('./metrics');
} catch (_) {}

// stdTTL: default TTL in seconds (0 = no expiry)
// checkperiod: how often (seconds) to check for expired keys
const cache = new NodeCache({ stdTTL: 0, checkperiod: 60, useClones: false });

const REDIS_CACHE_TIMEOUT_MS = parseInt(process.env.REDIS_CACHE_TIMEOUT_MS || '1000', 10);

const TTL = {
  ACCEPTED_ASSETS: 3600, // static config — 1 hour
  FEES: 300,             // fee structures change rarely — 5 min
  STUDENTS: 60,          // student list — 1 min
  STUDENT: 60,           // single student — 1 min
  SCHOOL: 300,           // school lookup — 5 min
  BALANCE: 30,           // balance aggregation — 30 sec
  PAYMENTS: 30,          // payment list — 30 sec
  OVERPAYMENTS: 30,
  SUSPICIOUS: 30,
  PENDING: 30,
  REPORT: 300,           // report aggregation — 5 min (short for data freshness)
  REPORT_ASYNC: 3600,   // async report artifacts — 1 hour before cleanup
};

// Cache key builders
const KEYS = {
  acceptedAssets: () => 'accepted_assets',
  feesAll: () => 'fees:all',
  feeByClass: (className) => `fees:${className}`,
  studentsAll: () => 'students:all',
  student: (studentId) => `student:${studentId}`,
  school: (schoolIdOrSlug) => `school:${schoolIdOrSlug}`,
  balance: (studentId) => `balance:${studentId}`,
  payments: (studentId) => `payments:${studentId}`,
  overpayments: () => 'overpayments',
  suspicious: () => 'suspicious',
  pending: () => 'pending',
  report: (schoolId, startDate, endDate, dataVersion = '', timezone = 'UTC') => `report:${schoolId}:${startDate || ''}:${endDate || ''}:${timezone}:v${dataVersion || 'latest'}`,
};

/**
 * Record cache hit metric.
 */
function recordHit(cacheName = 'default') {
  if (metrics && typeof metrics.recordCacheHit === 'function') {
    metrics.recordCacheHit(cacheName);
  }
}

/**
 * Record normal cache miss metric.
 */
function recordMiss(cacheName = 'default') {
  if (metrics && typeof metrics.recordCacheMiss === 'function') {
    metrics.recordCacheMiss(cacheName);
  }
}

/**
 * Record cache outage degradation metric.
 */
function recordOutage(cacheName = 'default') {
  if (metrics && typeof metrics.recordCacheOutage === 'function') {
    metrics.recordCacheOutage(cacheName);
  }
}

/**
 * Synchronous get from local cache.
 * Returns undefined on miss.
 */
function get(key, cacheName = 'default') {
  const val = cache.get(key);
  if (val !== undefined) {
    recordHit(cacheName);
    return val;
  }
  recordMiss(cacheName);
  return undefined;
}

/**
 * Asynchronous get with Redis support and safe degradation.
 * If Redis is down/times out, safely falls back to local cache without throwing.
 *
 * @param {string} key
 * @param {object} [options]
 * @param {string} [options.cacheName='default']
 * @param {number} [options.timeoutMs=1000]
 * @returns {Promise<any>}
 */
async function asyncGet(key, options = {}) {
  const cacheName = options.cacheName || 'default';
  const timeoutMs = options.timeoutMs || REDIS_CACHE_TIMEOUT_MS;

  const isReady = redisClientModule && typeof redisClientModule.isRedisReady === 'function' && redisClientModule.isRedisReady();

  if (isReady) {
    const client = redisClientModule.getRedisClient();
    if (client) {
      let timerHandle;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timerHandle = setTimeout(() => reject(new Error(`Redis cache get timed out after ${timeoutMs}ms`)), timeoutMs);
          if (timerHandle.unref) timerHandle.unref();
        });

        const raw = await Promise.race([
          client.get(`cache:${key}`),
          timeoutPromise,
        ]);

        if (raw !== null && raw !== undefined) {
          recordHit(cacheName);
          try {
            return JSON.parse(raw);
          } catch (_) {
            return raw;
          }
        }
        // Normal miss in Redis — continue to local tier
      } catch (err) {
        // Redis outage / timeout degradation
        recordOutage(cacheName);
        logger.warn('[Cache] Redis outage during read — degraded to local cache', { key, error: err.message });
      } finally {
        clearTimeout(timerHandle);
      }
    }
  }

  // Fallback to local in-memory cache
  const localVal = cache.get(key);
  if (localVal !== undefined) {
    recordHit(cacheName);
    return localVal;
  }

  recordMiss(cacheName);
  return undefined;
}

/**
 * Safe get with fallback loader.
 * Executes fallbackFn on miss or outage, safely caching the result.
 *
 * @param {string} key
 * @param {Function} fallbackFn Async loader returning data to cache
 * @param {object} [options]
 * @param {number} [options.ttl=60]
 * @param {string} [options.cacheName='default']
 */
async function getSafe(key, fallbackFn, options = {}) {
  const cacheName = options.cacheName || 'default';
  const ttl = options.ttl || 60;

  const cached = await asyncGet(key, { cacheName });
  if (cached !== undefined) {
    return cached;
  }

  try {
    const fresh = await fallbackFn();
    if (fresh !== undefined && fresh !== null) {
      await asyncSet(key, fresh, ttl, { cacheName });
    }
    return fresh;
  } catch (err) {
    logger.error('[Cache] Fallback loader failed', { key, error: err.message });
    throw err;
  }
}

/**
 * Set a value in local cache, and asynchronously propagate to Redis if available.
 */
function set(key, value, ttl) {
  cache.set(key, value, ttl);

  const isReady = redisClientModule && typeof redisClientModule.isRedisReady === 'function' && redisClientModule.isRedisReady();
  if (isReady) {
    const client = redisClientModule.getRedisClient();
    if (client) {
      const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const args = [`cache:${key}`, serialized];
      if (ttl && ttl > 0) {
        args.push('EX', ttl);
      }
      client.set(...args).catch((err) => {
        recordOutage('default');
        logger.warn('[Cache] Redis write failed — degraded to local only', { key, error: err.message });
      });
    }
  }
}

/**
 * Asynchronous set with explicit error isolation.
 */
async function asyncSet(key, value, ttl, options = {}) {
  const cacheName = options.cacheName || 'default';
  cache.set(key, value, ttl);

  const isReady = redisClientModule && typeof redisClientModule.isRedisReady === 'function' && redisClientModule.isRedisReady();
  if (isReady) {
    const client = redisClientModule.getRedisClient();
    if (client) {
      try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        const args = [`cache:${key}`, serialized];
        if (ttl && ttl > 0) {
          args.push('EX', ttl);
        }
        await client.set(...args);
      } catch (err) {
        recordOutage(cacheName);
        logger.warn('[Cache] Redis asyncSet failed — local value retained', { key, error: err.message });
      }
    }
  }
}

/**
 * Delete one or more keys from the cache.
 */
function del(...keys) {
  cache.del(keys);

  const isReady = redisClientModule && typeof redisClientModule.isRedisReady === 'function' && redisClientModule.isRedisReady();
  if (isReady) {
    const client = redisClientModule.getRedisClient();
    if (client && keys.length > 0) {
      const redisKeys = keys.flat().map((k) => `cache:${k}`);
      client.del(...redisKeys).catch((err) => {
        logger.warn('[Cache] Redis del failed', { error: err.message });
      });
    }
  }
}

/**
 * Delete all keys matching a prefix.
 */
function delByPrefix(prefix) {
  const allKeys = cache.keys();
  const toDelete = allKeys.filter((k) => k.startsWith(prefix));
  if (toDelete.length > 0) del(...toDelete);
}

/**
 * Get all cache keys.
 */
function keys() {
  return cache.keys();
}

module.exports = {
  get,
  set,
  del,
  delByPrefix,
  asyncGet,
  asyncSet,
  getSafe,
  KEYS,
  TTL,
  keys,
  recordHit,
  recordMiss,
  recordOutage,
};
