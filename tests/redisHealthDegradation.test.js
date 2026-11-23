'use strict';

/**
 * Tests for Issue #38: Redis dependency health and degradation policy.
 * Covers:
 *   1. Readiness reflects required dependencies (REDIS_REQUIRED)
 *   2. Cache misses degrade safely to local tier on outage
 *   3. Queue-dependent mutations return actionable errors (503 QUEUE_UNAVAILABLE)
 *   4. Metrics distinguish outage from normal misses
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const redisClient = require('../backend/src/config/redisClient');
const cache = require('../backend/src/cache');
const metrics = require('../backend/src/metrics');
const healthController = require('../backend/src/controllers/healthController');
const database = require('../backend/src/config/database');
const stellarConfig = require('../backend/src/config/stellarConfig');

// Mock dependencies for healthController
jest.mock('../backend/src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue({ healthy: true, latency: 2, readyState: 1 }),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  horizonClient: {
    call: jest.fn().mockResolvedValue({}),
    activeUrl: 'https://horizon-testnet.stellar.org',
    getCircuitBreakerStatus: jest.fn().mockReturnValue([]),
  },
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30000,
  CB_HALF_OPEN_SUCCESS_THRESHOLD: 2,
}));

describe('Issue #38: Redis Dependency Health and Degradation Policy', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. Readiness reflects required dependencies', () => {
    test('when REDIS_REQUIRED=true and Redis is unreachable, healthReady returns 503 not_ready', async () => {
      process.env.REDIS_HOST = '127.0.0.1';
      process.env.REDIS_REQUIRED = 'true';

      jest.spyOn(redisClient, 'checkRedis').mockResolvedValue({
        configured: true,
        status: 'unreachable',
        error: 'Connection refused',
        required: true,
      });

      const req = {};
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await healthController.healthReady(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          reason: 'required_dependency_unhealthy',
          unhealthyDependency: 'redis',
          checks: expect.objectContaining({
            redis: expect.objectContaining({
              status: 'unreachable',
              required: true,
            }),
          }),
        })
      );
    });

    test('when REDIS_REQUIRED=false and Redis is unreachable, healthReady returns 200 ready (degraded safely)', async () => {
      process.env.REDIS_HOST = '127.0.0.1';
      process.env.REDIS_REQUIRED = 'false';

      jest.spyOn(redisClient, 'checkRedis').mockResolvedValue({
        configured: true,
        status: 'unreachable',
        error: 'Connection refused',
        required: false,
      });

      const req = {};
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await healthController.healthReady(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          checks: expect.objectContaining({
            redis: expect.objectContaining({
              status: 'unreachable',
              required: false,
            }),
          }),
        })
      );
    });

    test('when REDIS_REQUIRED=true and Redis is ok, healthReady returns 200 ready', async () => {
      process.env.REDIS_HOST = '127.0.0.1';
      process.env.REDIS_REQUIRED = 'true';

      jest.spyOn(redisClient, 'checkRedis').mockResolvedValue({
        configured: true,
        status: 'ok',
        latencyMs: 3,
        required: true,
      });

      const req = {};
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await healthController.healthReady(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          checks: expect.objectContaining({
            redis: expect.objectContaining({
              status: 'ok',
              required: true,
            }),
          }),
        })
      );
    });

    test('detailed healthCheck reflects checks.redis and returns 503 when required Redis is down', async () => {
      process.env.REDIS_HOST = '127.0.0.1';
      process.env.REDIS_REQUIRED = 'true';

      jest.spyOn(redisClient, 'checkRedis').mockResolvedValue({
        configured: true,
        status: 'unreachable',
        error: 'Timeout',
        required: true,
      });

      const req = {};
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await healthController.healthCheck(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'unhealthy',
          checks: expect.objectContaining({
            redis: expect.objectContaining({
              status: 'unreachable',
              required: true,
            }),
          }),
        })
      );
    });
  });

  describe('2. Cache misses degrade safely to in-memory tier', () => {
    test('asyncGet falls back to local cache without throwing when Redis fails', async () => {
      jest.spyOn(redisClient, 'isRedisReady').mockReturnValue(true);
      jest.spyOn(redisClient, 'getRedisClient').mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
      });

      // Populate local cache
      cache.set('test-degradation-key', { foo: 'bar' }, 60);

      const val = await cache.asyncGet('test-degradation-key', { cacheName: 'test' });
      expect(val).toEqual({ foo: 'bar' });
    });

    test('getSafe invokes fallback loader and caches result when Redis errors', async () => {
      jest.spyOn(redisClient, 'isRedisReady').mockReturnValue(true);
      jest.spyOn(redisClient, 'getRedisClient').mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('Redis timeout')),
        set: jest.fn().mockRejectedValue(new Error('Redis write failed')),
      });

      const loader = jest.fn().mockResolvedValue({ fresh: 'data' });
      const result = await cache.getSafe('test-loader-key', loader, { ttl: 60, cacheName: 'test-loader' });

      expect(result).toEqual({ fresh: 'data' });
      expect(loader).toHaveBeenCalledTimes(1);

      // Subsequent local get returns the cached value
      const localCached = cache.get('test-loader-key');
      expect(localCached).toEqual({ fresh: 'data' });
    });
  });

  describe('3. Queue-dependent mutations return actionable errors', () => {
    test('async report request returns 503 with QUEUE_UNAVAILABLE and retry guidance on queue failure', async () => {
      const reportController = require('../backend/src/controllers/reportController');
      const reportQueue = require('../backend/src/queue/reportQueue');

      const unavailableErr = new Error('Report queue unavailable — Redis not configured');
      unavailableErr.code = 'QUEUE_UNAVAILABLE';
      jest.spyOn(reportQueue, 'enqueueReportJob').mockRejectedValue(unavailableErr);

      const req = {
        query: {
          startDate: '2026-01-01',
          endDate: '2026-03-01', // > 30 days to trigger isLargeReport
          async: 'true',
        },
        schoolId: 'school-123',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      await reportController.getReport(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'QUEUE_UNAVAILABLE',
          actionable: true,
          retryAfterSeconds: 30,
        })
      );
    });
  });

  describe('4. Metrics distinguish outage from normal misses', () => {
    test('normal miss increments cache_misses_total and cache_operations_total with result="miss"', () => {
      const incOpSpy = jest.spyOn(metrics.cacheOperationsTotal, 'inc');
      const incMissSpy = jest.spyOn(metrics.cacheMissesTotal, 'inc');

      cache.get('non-existent-key-123', 'unit-test');

      expect(incMissSpy).toHaveBeenCalledWith({ cache: 'unit-test' });
      expect(incOpSpy).toHaveBeenCalledWith({ cache: 'unit-test', result: 'miss' });
    });

    test('Redis outage increments cache_outages_total and cache_operations_total with result="outage"', async () => {
      jest.spyOn(redisClient, 'isRedisReady').mockReturnValue(true);
      jest.spyOn(redisClient, 'getRedisClient').mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('ETIMEDOUT: Redis ping timed out')),
      });

      const incOpSpy = jest.spyOn(metrics.cacheOperationsTotal, 'inc');
      const incOutageSpy = jest.spyOn(metrics.cacheOutagesTotal, 'inc');

      await cache.asyncGet('outage-key', { cacheName: 'unit-test' });

      expect(incOutageSpy).toHaveBeenCalledWith({ cache: 'unit-test' });
      expect(incOpSpy).toHaveBeenCalledWith({ cache: 'unit-test', result: 'outage' });
    });

    test('cache hit increments cache_hits_total and cache_operations_total with result="hit"', () => {
      const incOpSpy = jest.spyOn(metrics.cacheOperationsTotal, 'inc');
      const incHitSpy = jest.spyOn(metrics.cacheHitsTotal, 'inc');

      cache.set('hit-key', 'value-123', 60);
      const val = cache.get('hit-key', 'unit-test');

      expect(val).toBe('value-123');
      expect(incHitSpy).toHaveBeenCalledWith({ cache: 'unit-test' });
      expect(incOpSpy).toHaveBeenCalledWith({ cache: 'unit-test', result: 'hit' });
    });
  });
});
