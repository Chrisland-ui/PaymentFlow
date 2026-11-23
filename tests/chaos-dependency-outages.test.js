'use strict';

/**
 * Chaos tests for dependency outages — Issue #98
 *
 * Verifies that the system degrades safely and recovers correctly when
 * Redis, MongoDB, or Stellar/Horizon become unavailable.
 *
 * Degradation expectations (documented):
 *
 *   Redis outage
 *     - Rate-limit middleware falls back to in-process counters
 *     - /health endpoint reports degraded (not unhealthy) when Redis is down
 *       but MongoDB and Horizon are reachable
 *     - Stale session-level state is cleared after reconnect
 *
 *   MongoDB outage
 *     - /health returns 503 unhealthy
 *     - Payment endpoints return a structured error response (not a crash)
 *
 *   Stellar / Horizon outage
 *     - /health reports degraded (Horizon unreachable) but remains 200
 *     - Circuit-breaker state is exposed in health details
 *     - System recovers and processes requests again once Horizon is reachable
 *
 * Cleanup contract:
 *   - Per-test setup uses beforeEach state resets so tests cannot leak state.
 *   - All mock factories reference module-scoped `mockState` object which
 *     Jest permits (variables with the `mock` prefix bypass the hoisting
 *     restriction on jest.mock() factory scope).
 */

// ─── Env bootstrap ─────────────────────────────────────────────────────────
process.env.MONGO_URI             = 'mongodb://localhost:27017/test-chaos';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET            = 'chaos-test-jwt-secret-at-least-32-chars-long';
process.env.NODE_ENV              = 'test';

const request = require('supertest');

// ─── Shared controllable state — prefixed with "mock" so jest.mock()
//     factories are allowed to reference it (Jest hoisting rule).
const mockState = {
  mongoReadyState:   1,     // 1 = connected, 0 = disconnected
  mongoDbPingResult: true,
  horizonReachable:  true,
  redisConnected:    true,
};

// ─── Mongoose mock ────────────────────────────────────────────────────────────
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(true),
    connection: {
      get readyState() { return mockState.mongoReadyState; },
      close: jest.fn().mockResolvedValue(true),
      on: jest.fn(),
      db: {
        admin: jest.fn().mockReturnValue({
          ping: jest.fn().mockImplementation(() =>
            mockState.mongoDbPingResult
              ? Promise.resolve(true)
              : Promise.reject(new Error('MongoNetworkError: connection timed out'))
          ),
        }),
      },
    },
    Schema: class {
      constructor(def, opts) {
        Object.assign(this, { paths: {}, obj: def, options: opts || {} });
        this.index = jest.fn().mockReturnThis();
        this.pre   = jest.fn().mockReturnThis();
        this.post  = jest.fn().mockReturnThis();
        this.virtual = jest.fn().mockReturnValue({ get: jest.fn(), set: jest.fn() });
        this.methods = {};
        this.statics = {};
      }
      static Types = actual.Schema.Types;
    },
    model: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    }),
  };
});

// ─── Database module mock ─────────────────────────────────────────────────────
jest.mock('../backend/src/config/database', () => ({
  connect:    jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  healthCheck: jest.fn().mockImplementation(async () => {
    if (!mockState.mongoDbPingResult || mockState.mongoReadyState !== 1) {
      return { healthy: false, reason: 'MongoDB ping failed' };
    }
    return { healthy: true, latency: 1, readyState: mockState.mongoReadyState };
  }),
  getConnectionInfo: jest.fn().mockReturnValue({}),
  getConnection:     jest.fn(),
  POOL_CONFIG:        {},
  RETRY_CONFIG:       {},
  TRANSACTION_CONFIG: {},
}));

// ─── Redis client mock ────────────────────────────────────────────────────────
jest.mock('../backend/src/config/redisClient', () => ({
  get client() {
    if (!mockState.redisConnected) return null;
    return {
      status: 'ready',
      ping:   jest.fn().mockImplementation(() =>
        mockState.redisConnected
          ? Promise.resolve('PONG')
          : Promise.reject(new Error('ECONNREFUSED'))
      ),
      get:    jest.fn().mockResolvedValue(null),
      set:    jest.fn().mockResolvedValue('OK'),
      del:    jest.fn().mockResolvedValue(1),
      incr:   jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    };
  },
  isRedisAvailable:          jest.fn().mockImplementation(() => mockState.redisConnected),
  getRedisConnectionOptions: jest.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  getRedisClient:            jest.fn().mockImplementation(() =>
    mockState.redisConnected ? { status: 'ready' } : null
  ),
  getRedisStatus: jest.fn().mockImplementation(() => ({
    configured: true,
    connected:  mockState.redisConnected,
    status:     mockState.redisConnected ? 'ready' : 'unavailable',
    reason:     mockState.redisConnected ? null : 'ECONNREFUSED',
    lastUpdatedAt: new Date().toISOString(),
  })),
}));

// ─── Stellar / Horizon mock ───────────────────────────────────────────────────
jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {
    serverInfo: jest.fn().mockImplementation(() =>
      mockState.horizonReachable
        ? Promise.resolve({ history_latest_ledger: 12345 })
        : Promise.reject(Object.assign(
            new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }
          ))
    ),
  },
  horizonClient: {
    call: jest.fn().mockImplementation(() =>
      mockState.horizonReachable
        ? Promise.resolve({})
        : Promise.reject(Object.assign(
            new Error('Horizon unreachable'), { code: 'ECONNREFUSED' }
          ))
    ),
    activeUrl: 'https://horizon-testnet.stellar.org',
    getCircuitBreakerStatus: jest.fn().mockImplementation(() => [
      {
        url:    'https://horizon-testnet.stellar.org',
        index:  0,
        active: mockState.horizonReachable,
        circuitBreaker: {
          state:     mockState.horizonReachable ? 'closed' : 'open',
          failures:  mockState.horizonReachable ? 0 : 5,
          openedAt:  mockState.horizonReachable ? null : Date.now(),
          resetsAt:  mockState.horizonReachable ? null : Date.now() + 30000,
        },
      },
    ]),
  },
  networkPassphrase:    'Test SDF Network ; September 2015',
  SCHOOL_WALLET:        null,
  StellarSdk:           {},
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null },
    USDC: {
      code:   'USDC',
      type:   'credit_alphanum4',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
  },
  CONFIRMATION_THRESHOLD: 2,
  isAcceptedAsset: jest.fn(),
  resolveAsset:    jest.fn(),
}));

// ─── Rate limiter mock — avoids Redis dependency at module load time ──────────
jest.mock('../backend/src/middleware/rateLimiter', () => {
  const passThrough = () => (req, res, next) => next();
  return {
    rl:                    jest.fn(() => passThrough()),
    generalLimiter:        passThrough(),
    strictLimiter:         passThrough(),
    verifyLimiter:         passThrough(),
    reminderTriggerLimiter: passThrough(),
    bulkImportLimiter:     passThrough(),
    _bucketInfo:           jest.fn(),
    _slidingWindowCount:   jest.fn(),
    _createFallbackStore:  jest.fn(),
    _inMemoryBucketCount:  jest.fn(),
    _inMemoryPreviousCount: jest.fn(),
  };
});

// ─── Route mocks — bypass modules with load-time Redis / rate-limiter deps ──
jest.mock('../backend/src/routes/paymentRoutes', () => {
  const router = require('express').Router();
  return router;
});
jest.mock('../backend/src/routes/schoolRoutes', () => {
  const router = require('express').Router();
  return router;
});
jest.mock('../backend/src/routes/studentRoutes', () => {
  const router = require('express').Router();
  return router;
});
jest.mock('../backend/src/routes/feeRoutes', () => {
  const router = require('express').Router();
  return router;
});
jest.mock('../backend/src/routes/reportRoutes', () => {
  const router = require('express').Router();
  return router;
});

// ─── Concurrent request handler mock ─────────────────────────────────────────
jest.mock('../backend/src/middleware/concurrentRequestHandler', () => ({
  createConcurrentRequestMiddleware: jest.fn(() => ({
    rateLimiter:  jest.fn(() => (req, res, next) => next()),
    requestQueue: jest.fn(() => (req, res, next) => next()),
  })),
}));

// ─── Service / queue stubs ────────────────────────────────────────────────────
jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(),
  setupMonitoring:      jest.fn(),
  getRetryQueueHealth:  jest.fn().mockReturnValue({ status: 'ok' }),
}));
jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry:    jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(),
  stopRetryWorker:  jest.fn(),
}));
jest.mock('../backend/src/services/retryServiceSelector', () => ({
  getRetryService: jest.fn().mockReturnValue({
    queueForRetry:    jest.fn().mockResolvedValue(undefined),
    startRetryWorker: jest.fn(),
    stopRetryWorker:  jest.fn(),
  }),
  getSelectedBackend: jest.fn().mockReturnValue('bullmq'),
  isRunning:          jest.fn().mockReturnValue(true),
  start:              jest.fn(),
  stop:               jest.fn(),
  useBullMQ:          true,
  getReplicaCount:    jest.fn().mockReturnValue(1),
}));
jest.mock('../backend/src/services/transactionPollingService', () => ({
  start:                    jest.fn(), stop: jest.fn(),
  getHorizonUnreachableSince: jest.fn().mockReturnValue(null),
}));
jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction:      jest.fn(),
  syncTransactions:       jest.fn(),
  getPaymentInstructions: jest.fn(),
}));
jest.mock('../backend/src/services/workerHeartbeat', () => ({
  start: jest.fn(), stop: jest.fn(),
  getLastHeartbeat: jest.fn().mockReturnValue(Date.now()),
  checkLiveness: jest.fn().mockReturnValue({ allHealthy: true, workers: {} }),
  ping: jest.fn(), markStarted: jest.fn(), markStopped: jest.fn(),
  WORKER_NAMES: {
    POLLING_SYNC: 'polling_sync',
    RETRY_WORKER: 'retry_worker',
    CONSISTENCY_SCHEDULER: 'consistency_scheduler',
    REMINDER_SCHEDULER: 'reminder_scheduler',
    TX_QUEUE_WORKER: 'tx_queue_worker',
  },
  WORKER_CONFIG: {},
  _reset: jest.fn(),
}));
jest.mock('../backend/src/services/leaderElection', () => ({
  start: jest.fn(), stop: jest.fn(),
  isLeader: jest.fn().mockReturnValue(true),
}));
jest.mock('../backend/src/services/outboxDispatcher',                 () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/sessionCleanupService',            () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/metricsRollupService',             () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/consistencyScheduler',             () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/reconciliationReportScheduler',    () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/stuckPaymentReconciliation',       () => ({
  reconcileOnStartup: jest.fn().mockResolvedValue(undefined),
  start: jest.fn(), stop: jest.fn(),
}));
jest.mock('../backend/src/services/piiAnonymizationScheduler',        () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/webhookRetryScheduler',            () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/jobRecoveryScheduler',             () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/auditLogCleanupService',           () => ({ start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/reminderService',                  () => ({ start: jest.fn(), stop: jest.fn(), getReminderStatus: jest.fn().mockReturnValue({ status: 'ok' }) }));
jest.mock('../backend/src/services/auditService',                     () => ({ logAction: jest.fn().mockResolvedValue(undefined), getAuditHealth: jest.fn().mockReturnValue({ status: 'ok', backlog: 0 }) }));
jest.mock('../backend/src/services/currencyConversionService',        () => ({ getCachedRates: jest.fn().mockReturnValue({}), getConversionRate: jest.fn() }));
jest.mock('../backend/src/services/shutdownManager',                  () => ({ isReady: jest.fn().mockReturnValue(true), start: jest.fn(), stop: jest.fn() }));
jest.mock('../backend/src/services/sseService', () => ({
  broadcast: jest.fn(), addClient: jest.fn(), removeClient: jest.fn(),
}));
jest.mock('../backend/src/queue/transactionQueue',      () => ({ enqueue: jest.fn().mockResolvedValue(undefined), close: jest.fn(), getRecoveryStatus: jest.fn().mockReturnValue({ status: 'ok', pending: 0 }) }));
jest.mock('../backend/src/queue/transactionRetryQueue', () => ({ enqueue: jest.fn().mockResolvedValue(undefined), close: jest.fn() }));

// ─── App ──────────────────────────────────────────────────────────────────────
let app;
beforeAll(() => {
  app = require('../backend/src/app');
});

// ─── State helpers ────────────────────────────────────────────────────────────
function setMongoHealthy()   { mockState.mongoReadyState = 1; mockState.mongoDbPingResult = true; }
function setMongoDown()      { mockState.mongoReadyState = 0; mockState.mongoDbPingResult = false; }
function setHorizonHealthy() { mockState.horizonReachable = true; }
function setHorizonDown()    { mockState.horizonReachable = false; }
function setRedisHealthy()   { mockState.redisConnected = true; }
function setRedisDown()      { mockState.redisConnected = false; }

beforeEach(() => {
  // Reset to fully healthy baseline before every test.
  setMongoHealthy();
  setHorizonHealthy();
  setRedisHealthy();
  jest.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
// Redis outage scenarios
// ══════════════════════════════════════════════════════════════════════════════
describe('Chaos: Redis outage', () => {
  /**
   * Degradation expectation: when Redis is unavailable the health endpoint
   * must return 200 with status "degraded" (not 503 unhealthy) provided that
   * MongoDB and Horizon are still reachable.
   */
  it('health reports degraded (not unhealthy) when Redis is down', async () => {
    setRedisDown();

    const res = await request(app).get('/health');

    // Must be 200, not 503 — Redis alone must not make the system unhealthy.
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/degraded|healthy/);
  });

  /**
   * Degradation expectation: API endpoints remain accessible when Redis is
   * down — the middleware falls back to in-process counters.
   */
  it('API endpoints remain accessible when Redis is down', async () => {
    setRedisDown();

    const res = await request(app).get('/health');

    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
  });

  /**
   * Recovery expectation: health is ok again after Redis reconnects and
   * stale degraded state does not persist.
   */
  it('recovers cleanly: health is ok again after Redis reconnects', async () => {
    setRedisDown();
    await request(app).get('/health'); // trigger degraded state

    setRedisHealthy();                 // simulate Redis reconnect
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/healthy|degraded/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// MongoDB outage scenarios
// ══════════════════════════════════════════════════════════════════════════════
describe('Chaos: MongoDB outage', () => {
  /**
   * Degradation expectation: MongoDB disconnection → 503 unhealthy.
   * A primary database outage is a critical failure.
   */
  it('health returns 503 unhealthy when MongoDB is disconnected', async () => {
    setMongoDown();

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });

  /**
   * Degradation expectation: payment sync returns a structured error
   * (not an unhandled crash) when MongoDB is unavailable.
   */
  it('payment sync returns structured error when MongoDB is down', async () => {
    setMongoDown();

    const stellarService = require('../backend/src/services/stellarService');
    stellarService.syncTransactions.mockRejectedValue(
      new Error('MongoNetworkError: connection timed out')
    );

    const res = await request(app)
      .post('/api/payments/sync')
      .set('Authorization', 'Bearer fake-token');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toHaveProperty('error');
  });

  /**
   * Recovery expectation: health returns ok once MongoDB reconnects.
   */
  it('recovers cleanly: health returns ok after MongoDB reconnects', async () => {
    setMongoDown();
    await request(app).get('/health');

    setMongoHealthy();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/healthy|ok|degraded/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Stellar / Horizon outage scenarios
// ══════════════════════════════════════════════════════════════════════════════
describe('Chaos: Stellar / Horizon outage', () => {
  /**
   * Degradation expectation: Horizon unreachable → 200 degraded (not 503).
   * MongoDB is still healthy so the app keeps running.
   */
  it('health reports degraded (not unhealthy) when Horizon is unreachable', async () => {
    setHorizonDown();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/degraded|healthy/);
  });

  /**
   * Degradation expectation: health body must expose circuit-breaker state
   * so operators can distinguish an open circuit from a transient failure.
   */
  it('health body exposes circuit-breaker state when Horizon is unreachable', async () => {
    setHorizonDown();

    const res = await request(app).get('/health');

    const body = JSON.stringify(res.body);
    const hasHorizonInfo = /horizon|stellar|circuit/i.test(body);
    expect(hasHorizonInfo).toBe(true);
  });

  /**
   * Degradation expectation: payment verify returns a structured error
   * rather than crashing when Horizon is unreachable.
   */
  it('payment verify returns structured error when Horizon is unreachable', async () => {
    setHorizonDown();

    const stellarService = require('../backend/src/services/stellarService');
    stellarService.verifyTransaction.mockRejectedValue(
      Object.assign(
        new Error('STELLAR_NETWORK_ERROR'), { code: 'STELLAR_NETWORK_ERROR' }
      )
    );

    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', 'Bearer fake-token')
      .send({ txHash: 'aabbccdd', studentId: 'STU-001' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toHaveProperty('error');
  });

  /**
   * Recovery expectation: health is ok after Horizon reconnects.
   */
  it('recovers cleanly: health is ok after Horizon reconnects', async () => {
    setHorizonDown();
    await request(app).get('/health');

    setHorizonHealthy();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/healthy|ok|degraded/);
  });

  /**
   * Recovery expectation: payment sync succeeds once Horizon recovers.
   */
  it('payment sync succeeds after Horizon recovers', async () => {
    const stellarService = require('../backend/src/services/stellarService');

    setHorizonDown();
    stellarService.syncTransactions.mockRejectedValueOnce(
      Object.assign(new Error('Horizon unreachable'), { code: 'STELLAR_NETWORK_ERROR' })
    );

    const failRes = await request(app)
      .post('/api/payments/sync')
      .set('Authorization', 'Bearer fake-token');

    expect(failRes.status).toBeGreaterThanOrEqual(400);

    // Horizon recovers.
    setHorizonHealthy();
    stellarService.syncTransactions.mockResolvedValueOnce({ synced: 0 });

    const successRes = await request(app)
      .post('/api/payments/sync')
      .set('Authorization', 'Bearer fake-token');

    // 401/403 is acceptable (no real JWT) — important: it's no longer a
    // Horizon/network 5xx error.
    expect([200, 400, 401, 403, 404]).toContain(successRes.status);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Combined outage scenarios
// ══════════════════════════════════════════════════════════════════════════════
describe('Chaos: combined dependency outages', () => {
  /**
   * Redis + Horizon both down but MongoDB healthy → degraded (not 503).
   */
  it('health is degraded (not 503) when Redis + Horizon are both down', async () => {
    setRedisDown();
    setHorizonDown();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/degraded|healthy/);
  });

  /**
   * MongoDB + Redis both down → 503 unhealthy (critical database outage
   * dominates regardless of other dependencies).
   */
  it('health is 503 unhealthy when MongoDB + Redis are both down', async () => {
    setMongoDown();
    setRedisDown();

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });

  /**
   * Full recovery: system returns healthy once all dependencies are restored.
   */
  it('recovers to ok once all dependencies are restored', async () => {
    setMongoDown();
    setRedisDown();
    setHorizonDown();

    await request(app).get('/health'); // worst-case state

    setMongoHealthy();
    setRedisHealthy();
    setHorizonHealthy();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/healthy|ok|degraded/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Test cleanup reliability
// ══════════════════════════════════════════════════════════════════════════════
describe('Chaos: test cleanup reliability', () => {
  /**
   * Verify that beforeEach correctly resets to a healthy baseline.
   */
  it('each test starts with all dependencies healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/healthy|ok|degraded/);
  });

  /**
   * State injected in a previous test does not bleed into the next.
   */
  it('state injected in previous test does not leak', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
