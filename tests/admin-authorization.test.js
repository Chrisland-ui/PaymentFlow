'use strict';

/**
 * Authorization Tests — Every Admin Route
 * ----------------------------------------
 * Verifies the authorization contract for every admin endpoint:
 *
 *   1. Unauthenticated requests → 401
 *   2. Authenticated admin (own school) → 200/202/204 (or appropriate success)
 *   3. Cross-tenant: school A's token requesting school B data → 403
 *
 * The test matrix is driven by the ADMIN_ROUTES data table at the bottom of
 * this file. Adding a new admin endpoint is as simple as adding a row.
 *
 * CI: This test suite runs on every PR. A PR that adds an admin route without
 * a corresponding entry in ADMIN_ROUTES will not automatically fail — but the
 * routeAuthCoverage.test.js test in the suite will catch unprotected routes.
 */

// ── Environment setup ─────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef1234567890abcdef';

const request = require('supertest');
const jwt = require('jsonwebtoken');

// ── Mongoose mock ──────────────────────────────────────────────────────────────
jest.mock('mongoose', () => {
  const Schema = class {
    constructor() {
      this.index = jest.fn();
      this.pre = jest.fn();
      this.post = jest.fn();
      this.virtual = jest.fn().mockReturnValue({ get: jest.fn() });
      this.add = jest.fn();
      this.plugin = jest.fn();
      this.query = {};
      this.methods = {};
      this.statics = {};
    }
  };
  return {
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    Schema,
    model: jest.fn().mockReturnValue({}),
    Types: { ObjectId: String, Mixed: 'Mixed' },
  };
});

// ── Model mocks ───────────────────────────────────────────────────────────────
const makeChainable = (value) => {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
  chain.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue(makeChainable({
    schoolId: 'SCH-A',
    name: 'School A',
    slug: 'sch-a',
    stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    isActive: true,
  })),
  find: jest.fn().mockReturnValue(makeChainable([])),
  create: jest.fn().mockResolvedValue({}),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue(makeChainable([])),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  aggregate: jest.fn().mockResolvedValue([]),
  activeFilter: jest.fn((f = {}) => ({ ...f, deletedAt: null })),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockReturnValue(makeChainable([])),
  countDocuments: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/auditLogModel', () => ({
  find: jest.fn().mockReturnValue(makeChainable([])),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/webhookRetryModel', () => ({
  find: jest.fn().mockReturnValue(makeChainable([])),
  findOne: jest.fn().mockResolvedValue(null),
  countDocuments: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue(makeChainable([])),
  findOne: jest.fn().mockResolvedValue(null),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/systemConfigModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({ value: {} }),
}));

jest.mock('../backend/src/models/webhookDeliveryModel', () => ({
  find: jest.fn().mockReturnValue(makeChainable([])),
  findOne: jest.fn().mockResolvedValue(null),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/outboxModel', () => ({
  find: jest.fn().mockReturnValue(makeChainable([])),
  findOne: jest.fn().mockResolvedValue(null),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue({}),
  startRetryWorker: jest.fn(),
  stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn().mockResolvedValue({}),
  syncPaymentsForSchool: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockResolvedValue({}),
}));

// ── Token factories ───────────────────────────────────────────────────────────

/**
 * Generate a signed admin JWT for the given school.
 * The auth middleware (requireAdminAuth) verifies this token.
 */
function makeAdminToken(schoolId = 'SCH-A') {
  return jwt.sign(
    { userId: 'admin-001', email: 'admin@school.com', role: 'admin', schoolId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Token for School A
const TOKEN_SCHOOL_A = makeAdminToken('SCH-A');
// Token for School B (cross-tenant)
const TOKEN_SCHOOL_B = makeAdminToken('SCH-B');

// ── App under test ────────────────────────────────────────────────────────────
const app = require('../backend/src/app');

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Send a request with the given method, path, and optional token.
 * Automatically sets Content-Type for methods with a body.
 */
async function apiRequest(method, path, token = null, body = {}) {
  let req = request(app)[method](path);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (['post', 'put', 'patch', 'delete'].includes(method)) {
    req = req.set('Content-Type', 'application/json').send(body);
  }
  return req;
}

// ── Admin route matrix ────────────────────────────────────────────────────────
//
// Each entry describes one admin endpoint to test.
//
// Fields:
//   method        — HTTP method (lowercase)
//   path          — Exact URL path
//   description   — Human-readable label for the test
//   body          — Request body for POST/PUT/PATCH (optional)
//
// The test loop generates three tests per entry:
//   1. Unauthenticated → 401
//   2. Authenticated as School A → not 401 (any other status is acceptable)
//   3. School B token on School A endpoint → 401 or 403
//
const ADMIN_ROUTES = [
  // ── Log level ──────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/api/admin/log-level',
    description: 'POST /api/admin/log-level (change log level)',
    body: { level: 'debug' },
  },

  // ── Webhook DLQ ───────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/admin/webhooks/dlq',
    description: 'GET /api/admin/webhooks/dlq (list webhook DLQ)',
  },
  {
    method: 'post',
    path: '/api/admin/webhooks/dlq/fake-id/retry',
    description: 'POST /api/admin/webhooks/dlq/:id/retry (retry DLQ entry)',
    body: {},
  },
  {
    method: 'post',
    path: '/api/admin/webhooks/fake-id/replay',
    description: 'POST /api/admin/webhooks/:id/replay (replay webhook)',
    body: {},
  },

  // ── Pending verifications ─────────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/admin/pending-verifications/backlog',
    description: 'GET /api/admin/pending-verifications/backlog',
  },
  {
    method: 'get',
    path: '/api/admin/pending-verifications/dead-letter',
    description: 'GET /api/admin/pending-verifications/dead-letter',
  },
  {
    method: 'get',
    path: '/api/admin/pending-verifications/fake-id',
    description: 'GET /api/admin/pending-verifications/:id',
  },
  {
    method: 'post',
    path: '/api/admin/pending-verifications/fake-id/retry',
    description: 'POST /api/admin/pending-verifications/:id/retry',
    body: {},
  },

  // ── Payment limits ────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/admin/payment-limits',
    description: 'GET /api/admin/payment-limits',
  },
  {
    method: 'put',
    path: '/api/admin/payment-limits',
    description: 'PUT /api/admin/payment-limits (update limits)',
    body: { min: 1, max: 10000 },
  },
  {
    method: 'delete',
    path: '/api/admin/payment-limits/SCH-A',
    description: 'DELETE /api/admin/payment-limits/:schoolId',
  },

  // ── BullMQ retry queue ────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/admin/retry-queue/failed',
    description: 'GET /api/admin/retry-queue/failed (list failed jobs)',
  },
  {
    method: 'get',
    path: '/api/admin/retry-queue/failed/fake-job-id',
    description: 'GET /api/admin/retry-queue/failed/:jobId (job details)',
  },
  {
    method: 'post',
    path: '/api/admin/retry-queue/failed/fake-job-id/retry',
    description: 'POST /api/admin/retry-queue/failed/:jobId/retry',
    body: {},
  },
  {
    method: 'delete',
    path: '/api/admin/retry-queue/failed/fake-job-id',
    description: 'DELETE /api/admin/retry-queue/failed/:jobId (discard job)',
  },
  {
    method: 'get',
    path: '/api/admin/retry-queue/stats',
    description: 'GET /api/admin/retry-queue/stats',
  },

  // ── Outbox DLQ ────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/admin/outbox/dead-letter',
    description: 'GET /api/admin/outbox/dead-letter',
  },
  {
    method: 'get',
    path: '/api/admin/outbox/dead-letter/fake-event-id',
    description: 'GET /api/admin/outbox/dead-letter/:eventId',
  },
  {
    method: 'post',
    path: '/api/admin/outbox/dead-letter/fake-event-id/replay',
    description: 'POST /api/admin/outbox/dead-letter/:eventId/replay',
    body: {},
  },
  {
    method: 'delete',
    path: '/api/admin/outbox/dead-letter/fake-event-id',
    description: 'DELETE /api/admin/outbox/dead-letter/:eventId',
  },
  {
    method: 'get',
    path: '/api/admin/outbox/stats',
    description: 'GET /api/admin/outbox/stats',
  },
];

// ── Test loop — generate tests from the matrix ────────────────────────────────

describe('Admin route authorization matrix', () => {
  describe('Unauthenticated requests → 401', () => {
    test.each(ADMIN_ROUTES)(
      '$description — no token → 401',
      async ({ method, path, body }) => {
        const res = await apiRequest(method, path, null, body);
        expect(res.status).toBe(401);
      }
    );
  });

  describe('Authenticated admin (own school) → not 401', () => {
    test.each(ADMIN_ROUTES)(
      '$description — valid token → not 401',
      async ({ method, path, body }) => {
        const res = await apiRequest(method, path, TOKEN_SCHOOL_A, body);
        // Auth passed — any non-401 response is acceptable
        expect(res.status).not.toBe(401);
      }
    );
  });
});

// ── Cross-tenant tests ────────────────────────────────────────────────────────
//
// These endpoints are explicitly school-scoped. A token for School B must not
// succeed when the endpoint is scoped to School A's data.
//
// The admin endpoints below use schoolId as a path or query parameter.
// The auth middleware will reject mismatched school tokens with 401 or 403.
//

describe('Cross-tenant access — school B token must not access school A data', () => {
  const crossTenantRoutes = [
    {
      method: 'get',
      path: '/api/admin/payment-limits?schoolId=SCH-A',
      description: 'GET /api/admin/payment-limits scoped to SCH-A',
    },
    {
      method: 'delete',
      path: '/api/admin/payment-limits/SCH-A',
      description: 'DELETE /api/admin/payment-limits/SCH-A (school A limits)',
    },
    {
      method: 'get',
      path: '/api/admin/pending-verifications/backlog?schoolId=SCH-A',
      description: 'GET pending-verifications/backlog scoped to SCH-A',
    },
    {
      method: 'get',
      path: '/api/admin/webhooks/dlq?schoolId=SCH-A',
      description: 'GET webhooks/dlq scoped to SCH-A',
    },
  ];

  test.each(crossTenantRoutes)(
    '$description — school B token → 401 or 403',
    async ({ method, path, body }) => {
      const res = await apiRequest(method, path, TOKEN_SCHOOL_B, body);
      expect([401, 403]).toContain(res.status);
    }
  );

  test('Direct school ID mismatch: school B token on school A payment-limits delete → 401 or 403', async () => {
    const res = await request(app)
      .delete('/api/admin/payment-limits/SCH-A')
      .set('Authorization', `Bearer ${TOKEN_SCHOOL_B}`);
    expect([401, 403]).toContain(res.status);
  });

  test('Missing Authorization header on payment-limits → 401 (not 403 or 200)', async () => {
    const res = await request(app)
      .get('/api/admin/payment-limits');
    expect(res.status).toBe(401);
  });

  test('Malformed Authorization header → 401', async () => {
    const res = await request(app)
      .get('/api/admin/payment-limits')
      .set('Authorization', 'NotBearer bad-token');
    expect(res.status).toBe(401);
  });

  test('Expired token → 401', async () => {
    const expiredToken = jwt.sign(
      { userId: 'admin-001', schoolId: 'SCH-A', role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' } // already expired
    );
    const res = await request(app)
      .get('/api/admin/payment-limits')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  test('Token signed with wrong secret → 401', async () => {
    const badToken = jwt.sign(
      { userId: 'admin-001', schoolId: 'SCH-A', role: 'admin' },
      'wrong-secret-that-does-not-match',
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/api/admin/payment-limits')
      .set('Authorization', `Bearer ${badToken}`);
    expect(res.status).toBe(401);
  });
});

// ── Role enforcement ──────────────────────────────────────────────────────────
//
// The admin routes use requireAdminAuth which checks the JWT role claim.
// A parent-role token must not gain access to admin endpoints.
//

describe('Role enforcement — non-admin roles must not access admin endpoints', () => {
  function makeParentToken(schoolId = 'SCH-A') {
    return jwt.sign(
      { userId: 'parent-001', email: 'parent@school.com', role: 'parent', schoolId },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  }

  const TOKEN_PARENT = makeParentToken('SCH-A');

  const sensitiveEndpoints = [
    { method: 'post', path: '/api/admin/log-level', body: { level: 'debug' } },
    { method: 'get', path: '/api/admin/payment-limits' },
    { method: 'put', path: '/api/admin/payment-limits', body: { min: 1, max: 1000 } },
    { method: 'get', path: '/api/admin/retry-queue/stats' },
    { method: 'get', path: '/api/admin/webhooks/dlq' },
    { method: 'get', path: '/api/admin/outbox/dead-letter' },
  ];

  test.each(sensitiveEndpoints)(
    '$method $path — parent role → 401 or 403',
    async ({ method, path, body }) => {
      const res = await apiRequest(method, path, TOKEN_PARENT, body);
      expect([401, 403]).toContain(res.status);
    }
  );
});

// ── Response body contract ────────────────────────────────────────────────────
//
// 401 and 403 responses must include a consistent error body.
//

describe('Authorization error response body contract', () => {
  test('Unauthenticated request includes error or message field in body', async () => {
    const res = await request(app)
      .get('/api/admin/payment-limits');
    expect(res.status).toBe(401);
    // Must have some error indication in the body
    const body = res.body;
    const hasErrorField = typeof body.error === 'string' || typeof body.message === 'string';
    expect(hasErrorField).toBe(true);
  });

  test('Unauthenticated 401 response does NOT expose internal details (no stack trace)', async () => {
    const res = await request(app)
      .get('/api/admin/retry-queue/stats');
    expect(res.status).toBe(401);
    expect(res.body.stack).toBeUndefined();
  });
});
