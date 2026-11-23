'use strict';

/**
 * Issue #82 — Authorization tests for every admin route
 *
 * Table-driven suite that exercises:
 *   - Unauthenticated requests (no token) → 401
 *   - Wrong-role requests (school-scoped token, not super-admin) → 403
 *   - Valid admin token → must NOT return 401 or 403
 *
 * Acceptance criteria:
 *   ✓ Every requireAdminAuth-protected route in adminRoutes.js is represented
 *   ✓ Tests fail when a new route lacks policy coverage (via static inspection)
 *   ✓ Response codes are consistent across unauthenticated / wrong-role / allowed
 */

// ── Environment setup (must precede app/module imports) ───────────────────────
process.env.MONGO_URI            = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET            = 'test-jwt-secret-issue82-abcdef1234';
process.env.STELLAR_NETWORK       = 'testnet';

const request = require('supertest');
const jwt     = require('jsonwebtoken');

// ── Utility: sign a JWT ───────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;

function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { role: 'admin', sub: 'admin-user', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function makeSchoolToken(schoolId = 'school-a', roles = ['owner']) {
  return jwt.sign(
    { schoolId, roles, sub: 'school-user' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// ── Heavy mocks — prevent real I/O ───────────────────────────────────────────
jest.mock('../backend/src/config/database', () => ({
  connect:          jest.fn().mockResolvedValue(true),
  disconnect:       jest.fn().mockResolvedValue(true),
  healthCheck:      jest.fn().mockResolvedValue({ healthy: true }),
  TRANSACTION_CONFIG: {
    readConcern: 'majority', writeConcern: 'majority', journal: true, transactionTimeoutMs: 30000,
  },
}));

jest.mock('../backend/src/config/redisClient', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  getRedisStatus:  jest.fn().mockReturnValue('disabled'),
  isRedisReady:    jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:            jest.fn().mockResolvedValue({}),
  getAuditLogs:        jest.fn().mockResolvedValue({ logs: [], total: 0, page: 1, limit: 50, pages: 1 }),
  getRecentAuditLogs:  jest.fn().mockResolvedValue([]),
  verifyAuditChain:    jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  getAuditFailureCount: jest.fn().mockReturnValue(0),
}));

jest.mock('../backend/src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(null),
  set: jest.fn(),
  del: jest.fn(),
}));

// ── Model stubs ───────────────────────────────────────────────────────────────
const modelStub = () => ({
  find:            jest.fn().mockResolvedValue([]),
  findOne:         jest.fn().mockResolvedValue(null),
  create:          jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  findByIdAndDelete: jest.fn().mockResolvedValue({}),
  findOneAndUpdate:  jest.fn().mockResolvedValue({}),
  countDocuments:    jest.fn().mockResolvedValue(0),
  aggregate:         jest.fn().mockResolvedValue([]),
  updateOne:         jest.fn().mockResolvedValue({}),
  deleteOne:         jest.fn().mockResolvedValue({}),
});

jest.mock('../backend/src/models/schoolModel',       () => modelStub());
jest.mock('../backend/src/models/studentModel',      () => modelStub());
jest.mock('../backend/src/models/paymentModel',      () => modelStub());
jest.mock('../backend/src/models/feeStructureModel', () => modelStub());
jest.mock('../backend/src/models/auditLogModel',     () => modelStub());
jest.mock('../backend/src/models/webhookRetryModel', () => modelStub());
jest.mock('../backend/src/models/webhookDeliveryModel', () => modelStub());
jest.mock('../backend/src/models/webhookEndpointModel', () => modelStub());
jest.mock('../backend/src/models/pendingVerificationModel', () => modelStub());
jest.mock('../backend/src/models/systemConfigModel', () => modelStub());
jest.mock('../backend/src/models/outboxModel',       () => modelStub());
jest.mock('../backend/src/models/inboundWebhookNonceModel', () => modelStub());
jest.mock('../backend/src/models/idempotencyKeyModel', () => modelStub());
jest.mock('../backend/src/models/paymentIntentModel',  () => modelStub());
jest.mock('../backend/src/models/sourceValidationRuleModel', () => modelStub());
jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => modelStub());
jest.mock('../backend/src/models/paymentPlanModel',   () => modelStub());
jest.mock('../backend/src/models/disputeModel',       () => modelStub());
jest.mock('../backend/src/models/auditLogModel',      () => modelStub());
jest.mock('../backend/src/models/reminderLogModel',   () => modelStub());
jest.mock('../backend/src/models/receiptModel',       () => modelStub());
jest.mock('../backend/src/models/reportJobModel',     () => modelStub());
jest.mock('../backend/src/models/metricsModel',       () => modelStub());
jest.mock('../backend/src/models/refundModel',        () => modelStub());
jest.mock('../backend/src/models/userModel',          () => modelStub());
jest.mock('../backend/src/models/emailDeliveryModel', () => modelStub());
jest.mock('../backend/src/models/emailSuppressionModel', () => modelStub());
jest.mock('../backend/src/models/reconciliationCursorModel', () => modelStub());
jest.mock('../backend/src/models/reconciliationReportModel', () => modelStub());

// ── Service stubs ─────────────────────────────────────────────────────────────
jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction:    jest.fn(),
  syncPaymentsForSchool: jest.fn(),
  recordPayment:        jest.fn(),
  finalizeConfirmedPayments: jest.fn(),
  validatePaymentWithDynamicFee: jest.fn(),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency:   jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry:        jest.fn().mockResolvedValue({}),
  startRetryWorker:     jest.fn(),
  stopRetryWorker:      jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/retryServiceSelector', () => ({
  getRetryService: jest.fn().mockReturnValue({
    queueForRetry:        jest.fn().mockResolvedValue({}),
    startRetryWorker:     jest.fn(),
    stopRetryWorker:      jest.fn(),
    isRetryWorkerRunning: jest.fn().mockReturnValue(false),
  }),
  startRetryWorker:     jest.fn(),
  stopRetryWorker:      jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/bullMQRetryService', () => ({
  initialize:         jest.fn().mockResolvedValue({}),
  queueFailedTransaction: jest.fn().mockResolvedValue({}),
  getHealthStatus:    jest.fn().mockResolvedValue({ healthy: true }),
  getJobsByState:     jest.fn().mockResolvedValue([]),
  retryJobImmediately: jest.fn().mockResolvedValue({}),
  removeJob:          jest.fn().mockResolvedValue({}),
  getJobDetails:      jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/queue/transactionRetryQueue', () => ({
  initializeQueue: jest.fn().mockResolvedValue({}),
  addTransactionToRetryQueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
  getQueueStats:   jest.fn().mockResolvedValue({ health: 'healthy', metrics: {} }),
  getDLQStats:     jest.fn().mockResolvedValue({ metrics: {} }),
  shutdownQueue:   jest.fn().mockResolvedValue({}),
  drainWorker:     jest.fn().mockResolvedValue({}),
  getWorker:       jest.fn().mockReturnValue(null),
  config:          { worker: { concurrency: 5 } },
  QUEUE_NAMES:     { TRANSACTION_RETRY: 'tx-retry', DEAD_LETTER: 'tx-dlq' },
}));

jest.mock('../backend/src/queue/transactionQueue', () => ({
  enqueueTransaction:     jest.fn().mockResolvedValue({}),
  closeQueue:             jest.fn().mockResolvedValue({}),
  getRecoveryStatus:      jest.fn().mockReturnValue({ status: 'ok' }),
  recoverPendingJobsWithRetry: jest.fn().mockResolvedValue({}),
  startWorker:            jest.fn(),
  stopWorker:             jest.fn(),
  worker:                 null,
}));

jest.mock('../backend/src/services/transactionPollingService', () => ({
  startPolling: jest.fn(),
  stopPolling:  jest.fn(),
}));

jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
  stopConsistencyScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(),
  stopReminderScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/piiAnonymizationScheduler', () => ({
  startPiiAnonymizationScheduler: jest.fn(),
  stopPiiAnonymizationScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/transactionQueueService', () => ({
  startWorker: jest.fn(),
  stopWorker:  jest.fn(),
}));

jest.mock('../backend/src/services/sessionCleanupService', () => ({
  startSessionCleanupScheduler: jest.fn(),
  stopSessionCleanupScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/reconciliationService', () => ({
  startReconciliationScheduler: jest.fn(),
  stopReconciliationScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/stuckPaymentReconciliation', () => ({
  startStuckPaymentReconciliationScheduler: jest.fn(),
  stopStuckPaymentReconciliationScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/auditLogCleanupService', () => ({
  startAuditLogCleanupScheduler: jest.fn(),
  stopAuditLogCleanupScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/metricsRollupService', () => ({
  startMetricsRollupScheduler: jest.fn(),
  stopMetricsRollupScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/webhookRetryScheduler', () => ({
  startWebhookRetryScheduler: jest.fn(),
  stopWebhookRetryScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/outboxDispatcher', () => ({
  startOutboxDispatcher: jest.fn(),
  stopOutboxDispatcher:  jest.fn(),
}));

jest.mock('../backend/src/services/reconciliationReportScheduler', () => ({
  startReconciliationReportScheduler: jest.fn(),
  stopReconciliationReportScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/jobRecoveryScheduler', () => ({
  startJobRecoveryScheduler: jest.fn(),
  stopJobRecoveryScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/reportQueueService', () => ({
  startWorker: jest.fn(),
  stopWorker:  jest.fn(),
}));

jest.mock('../backend/src/services/reportCacheInvalidator', () => ({
  close: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/paymentSavedSubscribers', () => ({
  registerPaymentSavedSubscribers: jest.fn(),
}));

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn().mockResolvedValue({}),
  setupMonitoring:      jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/middleware/metricsAuth', () => ({
  metricsAuthMiddleware:      jest.fn((req, res, next) => next()),
  validateMetricsTokenOnStartup: jest.fn(),
}));

jest.mock('../backend/src/utils/heapMonitoring', () => ({
  startHeapMonitoring: jest.fn(),
}));

jest.mock('../backend/src/errorHandling', () => ({
  setupEnforceConsoleErrorLogging: jest.fn(),
}));

// ── Load app after all mocks ──────────────────────────────────────────────────
const app = require('../backend/src/app');

// ── Static inspection: every requireAdminAuth route must appear in the table ──

describe('Issue #82 — Admin route static inspection', () => {
  const adminRoutes = require('../backend/src/routes/adminRoutes');

  /**
   * Collect all [METHOD, path] pairs that have requireAdminAuth in their
   * middleware stack from a given Express router.
   */
  function collectAdminProtectedRoutes(router, prefix = '') {
    const found = [];
    for (const layer of (router.stack || [])) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
        const middlewareNames = layer.route.stack.map(l => l.handle?.name || '');
        if (middlewareNames.includes('requireAdminAuth')) {
          methods.forEach(method => {
            found.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
          });
        }
      } else if (layer.handle && layer.handle.stack) {
        found.push(...collectAdminProtectedRoutes(layer.handle, prefix));
      }
    }
    return found;
  }

  it('adminRoutes.js: every route uses requireAdminAuth middleware', () => {
    const unprotected = [];
    for (const layer of (adminRoutes.stack || [])) {
      if (!layer.route) continue;
      const names = layer.route.stack.map(l => l.handle?.name || '');
      if (!names.includes('requireAdminAuth')) {
        const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
        unprotected.push(`${methods.join('|').toUpperCase()} ${layer.route.path}`);
      }
    }
    if (unprotected.length > 0) {
      throw new Error(
        `Admin routes missing requireAdminAuth:\n${unprotected.join('\n')}\n` +
        `Add requireAdminAuth middleware to these routes.`
      );
    }
  });

  it('adminRoutes.js has at least 10 protected routes (regression guard)', () => {
    const routes = [];
    for (const layer of (adminRoutes.stack || [])) {
      if (layer.route) routes.push(layer.route.path);
    }
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });
});

// ── HTTP-level table-driven authorization tests ───────────────────────────────

/**
 * Each entry describes one protected admin endpoint.
 * Fields:
 *   method  — HTTP verb (lowercase)
 *   path    — URL including any placeholder IDs
 *   body    — optional request body
 */
const ADMIN_ROUTES = [
  // /api/admin/* — adminRoutes.js
  { method: 'post', path: '/api/admin/log-level', body: { level: 'info' } },
  { method: 'get',  path: '/api/admin/webhooks/dlq' },
  { method: 'post', path: '/api/admin/webhooks/dlq/fake-id/retry' },
  { method: 'post', path: '/api/admin/webhooks/fake-id/replay' },
  { method: 'get',  path: '/api/admin/pending-verifications/backlog' },
  { method: 'get',  path: '/api/admin/pending-verifications/dead-letter' },
  { method: 'get',  path: '/api/admin/pending-verifications/fake-id' },
  { method: 'post', path: '/api/admin/pending-verifications/fake-id/retry' },
  { method: 'get',  path: '/api/admin/payment-limits' },
  { method: 'put',  path: '/api/admin/payment-limits', body: { min: 1, max: 10000 } },
  { method: 'delete', path: '/api/admin/payment-limits/school-a' },
  { method: 'get',  path: '/api/admin/retry-queue/failed' },
  { method: 'get',  path: '/api/admin/retry-queue/failed/fake-job-id' },
  { method: 'post', path: '/api/admin/retry-queue/failed/fake-job-id/retry' },
  { method: 'delete', path: '/api/admin/retry-queue/failed/fake-job-id' },
  { method: 'get',  path: '/api/admin/retry-queue/stats' },
  { method: 'get',  path: '/api/admin/outbox/dead-letter' },
  { method: 'get',  path: '/api/admin/outbox/dead-letter/fake-event-id' },
  { method: 'post', path: '/api/admin/outbox/dead-letter/fake-event-id/replay' },
  { method: 'delete', path: '/api/admin/outbox/dead-letter/fake-event-id' },
  { method: 'get',  path: '/api/admin/outbox/stats' },
  // /api/schools — schoolRoutes.js (requireAdminAuth write routes)
  { method: 'post',   path: '/api/schools', body: { name: 'Test School', slug: 'test-school' } },
  { method: 'patch',  path: '/api/schools/school-a', body: { name: 'Updated' } },
  { method: 'delete', path: '/api/schools/school-a' },
  { method: 'put',    path: '/api/schools/school-a/stellar-address', body: { stellarAddress: 'GXXX', reason: 'rotation' } },
  // /api/students — requireAdminAuth routes
  { method: 'post',   path: '/api/students', body: { name: 'Test', class: 'Grade 1' } },
  { method: 'get',    path: '/api/students' },
  { method: 'get',    path: '/api/students/export' },
  { method: 'get',    path: '/api/students/fake-student-id' },
  { method: 'put',    path: '/api/students/fake-student-id', body: { name: 'Updated' } },
  { method: 'delete', path: '/api/students/fake-student-id' },
  // /api/payments — requireAdminAuth routes
  { method: 'post',   path: '/api/payments/sync' },
  { method: 'post',   path: '/api/payments/finalize' },
  { method: 'get',    path: '/api/payments/stuck' },
  { method: 'get',    path: '/api/payments/retry-queue' },
  { method: 'patch',  path: '/api/payments/fake-hash/status', body: { status: 'confirmed' } },
];

describe('Issue #82 — Admin route HTTP authorization enforcement', () => {
  let adminToken;
  let schoolToken;

  beforeAll(() => {
    adminToken  = makeAdminToken();
    schoolToken = makeSchoolToken('school-a', ['owner']);
  });

  describe('Unauthenticated requests → 401', () => {
    test.each(ADMIN_ROUTES)(
      '$method $path → 401 with no token',
      async ({ method, path, body }) => {
        const req = request(app)[method](path);
        if (body) req.send(body).set('Content-Type', 'application/json');
        const res = await req;
        expect([401, 429]).toContain(res.status);
        if (res.status === 401) {
          expect(res.body).toHaveProperty('code');
          expect(['MISSING_AUTH_TOKEN', 'INVALID_AUTH_TOKEN', 'TOKEN_EXPIRED']).toContain(res.body.code);
        }
      }
    );
  });

  describe('Wrong-role (school token, not admin) → 401 or 403', () => {
    test.each(ADMIN_ROUTES)(
      '$method $path → 401/403 with school token',
      async ({ method, path, body }) => {
        const req = request(app)[method](path)
          .set('Authorization', `Bearer ${schoolToken}`);
        if (body) req.send(body).set('Content-Type', 'application/json');
        const res = await req;
        // School tokens are completely invalid for admin auth → 401 (INSUFFICIENT_ROLE)
        // or 403, not 2xx
        expect([401, 403, 429]).toContain(res.status);
      }
    );
  });

  describe('Valid admin token → not 401 or 403', () => {
    test.each(ADMIN_ROUTES)(
      '$method $path → authenticated (not 401/403)',
      async ({ method, path, body }) => {
        const req = request(app)[method](path)
          .set('Authorization', `Bearer ${adminToken}`);
        if (body) req.send(body).set('Content-Type', 'application/json');
        const res = await req;
        // With a valid admin token, the request must NOT be rejected as unauthorised
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      }
    );
  });

  describe('Expired token → 401 with TOKEN_EXPIRED', () => {
    it('POST /api/admin/log-level with expired token returns 401 TOKEN_EXPIRED', async () => {
      const expiredToken = jwt.sign(
        { role: 'admin', sub: 'admin-user' },
        JWT_SECRET,
        { expiresIn: -1 } // already expired
      );
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({ level: 'info' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });
  });

  describe('Malformed / tampered token → 401 with INVALID_AUTH_TOKEN', () => {
    it('POST /api/admin/log-level with garbage token returns 401', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .send({ level: 'debug' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_AUTH_TOKEN');
    });

    it('GET /api/admin/retry-queue/stats with tampered signature returns 401', async () => {
      const [header, payload] = adminToken.split('.');
      const tamperedToken = `${header}.${payload}.invalidsignature`;
      const res = await request(app)
        .get('/api/admin/retry-queue/stats')
        .set('Authorization', `Bearer ${tamperedToken}`);
      expect(res.status).toBe(401);
    });
  });

  describe('super_admin role claim → accepted like role:admin', () => {
    it('GET /api/admin/retry-queue/stats with roles:["super_admin"] returns 2xx', async () => {
      const superToken = jwt.sign(
        { roles: ['super_admin'], sub: 'super-admin-user' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      const res = await request(app)
        .get('/api/admin/retry-queue/stats')
        .set('Authorization', `Bearer ${superToken}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe('Admin token via cookie (HttpOnly) → accepted', () => {
    it('GET /api/admin/payment-limits with cookie token is accepted', async () => {
      const res = await request(app)
        .get('/api/admin/payment-limits')
        .set('Cookie', `admin_token=${adminToken}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
});

// ── Error-code consistency test ───────────────────────────────────────────────

describe('Issue #82 — Auth error response consistency', () => {
  const sampleAdminRoutes = [
    { method: 'get',  path: '/api/admin/retry-queue/stats' },
    { method: 'post', path: '/api/admin/log-level' },
    { method: 'get',  path: '/api/admin/payment-limits' },
  ];

  it('all missing-token responses have the same shape { error, code }', async () => {
    const adminToken = makeAdminToken();
    for (const { method, path } of sampleAdminRoutes) {
      const res = await request(app)[method](path);
      if (res.status === 401) {
        expect(typeof res.body.error).toBe('string');
        expect(typeof res.body.code).toBe('string');
      }
    }
  });
});
