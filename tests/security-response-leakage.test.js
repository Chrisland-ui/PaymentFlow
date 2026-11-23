'use strict';

/**
 * Security regression tests — Issue #95
 *
 * Exercise validation, auth, provider, and database failure paths and verify
 * that responses never leak stack traces, tokens, internal identifiers, or
 * other sensitive data.
 *
 * Acceptance criteria:
 *   - Production-mode responses are safe (no stack, no internal message for 5xx)
 *   - Redaction assertions are reusable via the helpers exported at the bottom
 *   - Intentional diagnostic fields are allowlisted in SAFE_FIELDS
 *
 * Design notes:
 *   - HTTP-level tests run without NODE_ENV=production because the config module
 *     requires APP_URL when NODE_ENV=production. The errorHandler production
 *     behavior is tested directly in the unit test section below.
 *   - No real credentials, tokens, or PII appear anywhere in this file.
 *   - The fake JWT secret and placeholder wallet address are CI-only values.
 */

// ── Environment setup (must come before any require) ─────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'ci-security-regression-test-secret-not-used-in-prod';

const request = require('supertest');
const jwt = require('jsonwebtoken');

// ── Mock heavy dependencies (same pattern as authentication-enforcement.test.js)

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'school-a',
      name: 'Test School',
      slug: 'school-a',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      isActive: true,
    }),
  }),
  find: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../backend/src/models/auditLogModel', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn(),
  syncPaymentsForSchool: jest.fn(),
  recordPayment: jest.fn(),
  finalizeConfirmedPayments: jest.fn(),
  validatePaymentWithDynamicFee: jest.fn(),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: false, localAmount: 0, currency: 'USD', rate: 0, rateTimestamp: new Date(),
  }),
  enrichPaymentWithConversion: jest.fn().mockResolvedValue({}),
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

// ── Reusable safety helpers ────────────────────────────────────────────────────

/**
 * Fields that ARE intentionally present in error responses and are safe to
 * expose. Structured error shape from errorHandler.
 *
 * Allowlisted fields:
 *   - error / message / code / details   — structured error shape
 *   - success                            — envelope field
 *   - status / isAdmin / expiresIn       — auth/login metadata
 */
const SAFE_FIELDS = new Set([
  'error', 'message', 'code', 'details', 'success', 'status',
  'isAdmin', 'expiresIn', 'refreshExpiresIn',
]);

/**
 * Patterns that must NEVER appear anywhere in a production HTTP response body,
 * regardless of field name.
 */
const PROHIBITED_PATTERNS = [
  // Stack trace indicators
  /at\s+\w[\w.]*\s*\(.*\.js:\d+:\d+\)/,  // "at fn (/path/file.js:10:5)"
  /Error:\s*.+\n\s+at\s/,                 // multi-line stack trace start
  // Internal path leakage
  /\/app\/src\//,
  /\/workspaces\//,
  /node_modules\//,
  // Internal connection string leakage
  /mongodb:\/\//,
  /redis:\/\//,
];

/**
 * Assert that a response body is safe for production exposure.
 * Returns an array of violation strings (empty = safe).
 *
 * @param {object} body  - parsed JSON response body
 * @param {string} label - description for error messages
 * @returns {string[]}   - violation messages
 */
function assertResponseSafe(body, label = '') {
  const violations = [];
  const bodyStr = JSON.stringify(body);

  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(bodyStr)) {
      violations.push(
        `${label}: body matches prohibited pattern ${pattern.toString().substring(0, 60)}` +
        ` — snippet: ${bodyStr.substring(0, 120)}`
      );
    }
  }

  return violations;
}

/**
 * Assert that a 5xx response does NOT echo internal error details.
 * @param {object} body
 * @param {string} label
 * @returns {string[]}
 */
function assert5xxMessageRedacted(body, label = '') {
  const violations = [];
  const msg = typeof body?.error === 'object' ? body.error?.message : (body?.message || '');
  if (msg && msg !== 'An internal server error occurred.') {
    const internalIndicators = [/mongodb:\/\//, /cannot read/i, /is not a function/i, /at\s+\w/];
    for (const ind of internalIndicators) {
      if (ind.test(msg)) {
        violations.push(`${label}: 5xx response leaked internal message: "${msg}"`);
        break;
      }
    }
  }
  return violations;
}

// Export helpers for reuse in other test files
module.exports = { assertResponseSafe, assert5xxMessageRedacted, PROHIBITED_PATTERNS, SAFE_FIELDS };

// ── Test suite ────────────────────────────────────────────────────────────────

const app = require('../backend/src/app');
const cache = require('../backend/src/cache');

function validAdminToken() {
  return jwt.sign({ role: 'admin', email: 'ci-test@example.invalid' }, process.env.JWT_SECRET);
}

beforeEach(() => {
  jest.clearAllMocks();
  cache.delByPrefix('ip_auth_fail:');
  cache.delByPrefix('ip_blocked:');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unauthenticated requests (auth failure path)
// ─────────────────────────────────────────────────────────────────────────────

describe('Auth failure paths — no token leakage', () => {
  test('401 on missing token does not contain prohibited patterns', async () => {
    const res = await request(app)
      .get('/api/students')
      .set('X-School-ID', 'school-a')
      .expect(401);

    const violations = assertResponseSafe(res.body, 'GET /api/students 401');
    expect(violations).toEqual([]);
  });

  test('401 response code is MISSING_AUTH_TOKEN', async () => {
    const res = await request(app)
      .get('/api/students')
      .set('X-School-ID', 'school-a')
      .expect(401);

    expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
  });

  test('401 on invalid token format does not expose server internals', async () => {
    const res = await request(app)
      .post('/api/payments/sync')
      .set('X-School-ID', 'school-a')
      .set('Authorization', 'Bearer not.a.valid.jwt.token')
      .expect(401);

    const violations = assertResponseSafe(res.body, 'invalid JWT 401');
    expect(violations).toEqual([]);
    expect(res.body.code).toBe('INVALID_AUTH_TOKEN');
  });

  test('401 on expired token does not expose server internals', async () => {
    const expiredToken = jwt.sign(
      { role: 'admin', email: 'ci@example.invalid' },
      process.env.JWT_SECRET,
      { expiresIn: '-1h' }
    );

    const res = await request(app)
      .post('/api/payments/sync')
      .set('X-School-ID', 'school-a')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);

    const violations = assertResponseSafe(res.body, 'expired JWT 401');
    expect(violations).toEqual([]);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('403 INSUFFICIENT_ROLE does not expose server internals', async () => {
    const nonAdminToken = jwt.sign(
      { role: 'user', schoolId: 'school-a', roles: ['viewer'] },
      process.env.JWT_SECRET
    );

    const res = await request(app)
      .post('/api/students')
      .set('X-School-ID', 'school-a')
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .send({ studentId: 'STU001', name: 'Test', class: '5A' })
      .expect(403);

    const violations = assertResponseSafe(res.body, '403 INSUFFICIENT_ROLE');
    expect(violations).toEqual([]);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('403 TENANT_MISMATCH does not expose server internals', async () => {
    const schoolBToken = jwt.sign(
      { schoolId: 'school-b', roles: ['owner'] },
      process.env.JWT_SECRET
    );

    const res = await request(app)
      .get('/api/students')
      .set('X-School-ID', 'school-a')
      .set('Authorization', `Bearer ${schoolBToken}`)
      .expect(403);

    const violations = assertResponseSafe(res.body, '403 TENANT_MISMATCH');
    expect(violations).toEqual([]);
    expect(res.body.code).toBe('TENANT_MISMATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Validation failure paths (400/404 errors)
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation failure paths — no stack trace leakage', () => {
  test('404 on unknown route does not contain prohibited patterns', async () => {
    const res = await request(app)
      .get('/api/nonexistent-route-xyz-123')
      .expect(404);

    const violations = assertResponseSafe(res.body, '404 unknown route');
    expect(violations).toEqual([]);
  });

  test('POST /api/auth/login with missing credentials returns 401 safely', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({})
      .expect(401);

    const violations = assertResponseSafe(res.body, 'login missing body');
    expect(violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Service/provider failure paths (5xx errors)
// ─────────────────────────────────────────────────────────────────────────────

describe('Service failure paths — 5xx responses do not expose internals', () => {
  const savedEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // Set production mode for 5xx leak tests
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'https://ci-test.example.invalid';
  });

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    delete process.env.APP_URL;
  });

  test('When service throws with stack trace in message, 5xx response hides it', async () => {
    const { syncPaymentsForSchool } = require('../backend/src/services/stellarService');
    syncPaymentsForSchool.mockRejectedValueOnce(
      Object.assign(new Error('Internal error'), {
        stack: 'Error: Internal error\n    at /workspaces/PaymentFlow/src/db.js:15:3',
      })
    );

    const res = await request(app)
      .post('/api/payments/sync')
      .set('X-School-ID', 'school-a')
      .set('Authorization', `Bearer ${validAdminToken()}`)
      .expect(500);

    const violations = assertResponseSafe(res.body, 'sync 500 — stack trace');
    expect(violations).toEqual([]);
  });

  test('When service throws with mongodb:// in message, it is not included in response', async () => {
    const { syncPaymentsForSchool } = require('../backend/src/services/stellarService');
    syncPaymentsForSchool.mockRejectedValueOnce(
      new Error('Failed to connect: mongodb://admin:supersecret@mongo-host:27017/db')
    );

    const res = await request(app)
      .post('/api/payments/sync')
      .set('X-School-ID', 'school-a')
      .set('Authorization', `Bearer ${validAdminToken()}`)
      .expect(500);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('mongodb://');
    expect(body).not.toContain('supersecret');
  });

  test('5xx response uses generic message, not raw internal error string', async () => {
    const { syncPaymentsForSchool } = require('../backend/src/services/stellarService');
    syncPaymentsForSchool.mockRejectedValueOnce(
      new Error('Cannot read properties of undefined (reading "schoolId")')
    );

    const res = await request(app)
      .post('/api/payments/sync')
      .set('X-School-ID', 'school-a')
      .set('Authorization', `Bearer ${validAdminToken()}`)
      .expect(500);

    const msg = res.body?.error?.message || res.body?.message || '';
    expect(msg).toBe('An internal server error occurred.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Token leakage prevention
// ─────────────────────────────────────────────────────────────────────────────

describe('Token and credential leakage prevention', () => {
  test('Login failure response does not contain the word "token" as a value', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong-password-ci-test' })
      .expect(401);

    // The error response should not have raw token values
    const body = JSON.stringify(res.body);
    // Must not contain the raw JWT secret
    expect(body).not.toContain(process.env.JWT_SECRET);
    const violations = assertResponseSafe(res.body, 'login 401 no secret leakage');
    expect(violations).toEqual([]);
  });

  test('Error response does not include cookie value from admin_token cookie', async () => {
    const res = await request(app)
      .post('/api/payments/sync')
      .set('X-School-ID', 'school-a')
      .set('Cookie', 'admin_token=ci-fake-cookie-value-12345')
      .expect(401);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ci-fake-cookie-value-12345');
    const violations = assertResponseSafe(res.body, '401 cookie value not in response');
    expect(violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Error handler — direct unit tests for production/non-production modes
// ─────────────────────────────────────────────────────────────────────────────

describe('globalErrorHandler — production mode safety', () => {
  const { globalErrorHandler } = require('../backend/src/middleware/errorHandler');
  const savedEnv = process.env.NODE_ENV;

  function makeReq() {
    return { path: '/test', method: 'GET', requestId: 'req-sec-test', schoolId: null };
  }

  function makeRes() {
    const jsonCalls = [];
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn((body) => { jsonCalls.push(body); return res; });
    res._calls = jsonCalls;
    return res;
  }

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  test('production: 5xx response uses generic message, no stack field', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Connection string: mongodb://admin:secret@host/db');
    err.stack = 'Error: Connection string...\n    at /app/src/db.js:10:5';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = res._calls[0];
    expect(body.error.message).toBe('An internal server error occurred.');
    expect(body).not.toHaveProperty('stack');
    expect(JSON.stringify(body)).not.toContain('mongodb://');
    expect(JSON.stringify(body)).not.toContain('secret');

    const violations = assertResponseSafe(body, 'errorHandler prod 5xx');
    expect(violations).toEqual([]);
  });

  test('production: 4xx error message is preserved (client errors are safe)', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Validation failed: txHash must be a 64-char hex string');
    err.code = 'VALIDATION_ERROR'; // maps to 400

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = res._calls[0];
    expect(body.error.message).toBe('Validation failed: txHash must be a 64-char hex string');

    const violations = assertResponseSafe(body, 'errorHandler prod 4xx');
    expect(violations).toEqual([]);
  });

  test('development: stack trace is included (intentional diagnostic field)', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('dev-only error');
    err.stack = 'Error: dev-only error\n    at /app/src/server.js:10:5';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = res._calls[0];
    // In development the stack IS intentional
    expect(body.error.stack).toBe(err.stack);
  });

  test('production: error code is preserved for programmatic handling', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Not found');
    err.code = 'NOT_FOUND';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = res._calls[0];
    expect(body.error.code).toBe('NOT_FOUND');
    const violations = assertResponseSafe(body, 'errorHandler prod code field');
    expect(violations).toEqual([]);
  });

  test('production: internal 5xx message does not contain raw exception text', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Cannot read properties of undefined (reading "schoolId")');

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = res._calls[0];
    expect(body.error.message).toBe('An internal server error occurred.');
    expect(JSON.stringify(body)).not.toContain('Cannot read properties');
  });

  test('production: JWT_SECRET value never appears in any response body', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error(`JWT_SECRET=${process.env.JWT_SECRET}`);

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = res._calls[0];
    expect(JSON.stringify(body)).not.toContain(process.env.JWT_SECRET);
    expect(JSON.stringify(body)).not.toContain('JWT_SECRET');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Error response shape compliance
// ─────────────────────────────────────────────────────────────────────────────

describe('Error response shape — code field present on auth failures', () => {
  const AUTH_PROTECTED_ROUTES = [
    { method: 'get',  path: '/api/students',      label: 'GET /api/students' },
    { method: 'post', path: '/api/payments/sync', label: 'POST /api/payments/sync' },
    { method: 'get',  path: '/api/fees',          label: 'GET /api/fees' },
    { method: 'get',  path: '/api/audit',         label: 'GET /api/audit' },
  ];

  test.each(AUTH_PROTECTED_ROUTES)(
    '$label 401 response has a code field and no prohibited patterns',
    async ({ method, path }) => {
      const res = await request(app)[method](path)
        .set('X-School-ID', 'school-a')
        .expect(401);

      // Must have a code
      const code = res.body.code || res.body?.error?.code;
      expect(code).toBeTruthy();

      // Must be safe
      const violations = assertResponseSafe(res.body, `${method.toUpperCase()} ${path}`);
      expect(violations).toEqual([]);
    }
  );
});
