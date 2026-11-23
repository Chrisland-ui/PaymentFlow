'use strict';

/**
 * Contract Tests — Payment Creation & Verification Endpoints
 * ----------------------------------------------------------
 * These tests verify the API contract for payment creation endpoints from
 * the HTTP boundary, using the actual validation middleware (not mocks).
 *
 * Coverage:
 *   POST /api/payments/intent  — 17 input combinations
 *   POST /api/payments/verify  — 9 input combinations
 *
 * Each test asserts:
 *   1. The correct HTTP status code
 *   2. The response body shape (error, code/errors fields)
 *
 * The response shape contract follows the OpenAPI error schema:
 *   { error: string, code: string }          — single-field errors
 *   { errors: [{ field: string, message: string }] }  — validation errors
 *
 * These tests run in CI on every PR touching the payment validation path.
 * A PR that breaks a validation rule will fail at least one test here.
 */

// ── Environment setup ─────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef1234567890abcdef';

const request = require('supertest');

// ── Mocks ─────────────────────────────────────────────────────────────────────
// We mock infrastructure (DB, auth, Stellar) but keep the validation middleware
// real so that the contract tests reflect the actual API behaviour.

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

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
  requireSchoolAuth: () => (req, res, next) => next(),
}));

// School context middleware — inject a valid school into every request
jest.mock('../backend/src/middleware/schoolContext', () => ({
  resolveSchool: (req, res, next) => {
    req.schoolId = 'SCH-DEFAULT';
    req.school = {
      schoolId: 'SCH-DEFAULT',
      name: 'Default School',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      isActive: true,
    };
    return next();
  },
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockImplementation(({ studentId }) => {
    // Only 'STU001' resolves; all others return null (unknown student)
    if (studentId === 'STU001') {
      return Promise.resolve({
        _id: '507f1f77bcf86cd799439011',
        studentId: 'STU001',
        name: 'Alice',
        class: '5A',
        feeAmount: 250,
        feePaid: false,
        schoolId: 'SCH-DEFAULT',
        deletedAt: null,
      });
    }
    return Promise.resolve(null);
  }),
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({
    studentId: 'STU001',
    amount: 250,
    memo: 'MEMO1234',
    status: 'pending',
    toObject() { return { studentId: 'STU001', amount: 250, memo: 'MEMO1234', status: 'pending' }; },
  }),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  activeFilter: jest.fn((f = {}) => ({ ...f, deletedAt: null })),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'SCH-DEFAULT',
      name: 'Default School',
      slug: 'sch-default',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      isActive: true,
    }),
  }),
}));

jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn().mockResolvedValue({ status: 'confirmed', amount: 250 }),
  syncPaymentsForSchool: jest.fn().mockResolvedValue([]),
  recordPayment: jest.fn().mockResolvedValue({}),
  validatePaymentWithDynamicFee: jest.fn().mockResolvedValue({ valid: true }),
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

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockResolvedValue({}),
}));

// ── App under test ────────────────────────────────────────────────────────────
const app = require('../backend/src/app');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A valid 24-char hex MongoDB ObjectId */
const VALID_STUDENT_OBJ_ID = '507f1f77bcf86cd799439011';

/** A valid 64-char lowercase hex Stellar transaction hash */
const VALID_TX_HASH = 'a'.repeat(64);

/**
 * Assert the error response body conforms to the OpenAPI error contract:
 *   - Single-field: { error: string } with optional code
 *   - Multi-field:  { errors: [{ field, message }] }
 */
function assertErrorShape(body) {
  const hasSingleError = typeof body.error === 'string';
  const hasErrorsArray =
    Array.isArray(body.errors) &&
    body.errors.length > 0 &&
    body.errors.every(
      (e) => typeof e.field === 'string' && typeof e.message === 'string'
    );
  expect(hasSingleError || hasErrorsArray).toBe(true);
}

// ── POST /api/payments/intent ────────────────────────────────────────────────

describe('POST /api/payments/intent — contract tests', () => {
  const endpoint = '/api/payments/intent';

  // ── Missing required fields ───────────────────────────────────────────────

  test('TC-01: missing studentId → 400 with validation error shape', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ amount: 100 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-02: missing entire body → 400 with validation error shape', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({});
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Invalid studentId formats ─────────────────────────────────────────────

  test('TC-03: studentId is empty string → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: '' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-04: studentId is too short (not 24-char hex) → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: 'abc123' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-05: studentId is 24 chars but not hex → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: 'gggggggggggggggggggggggg' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-06: studentId is a number (wrong type) → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: 12345678901234567890 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Invalid amount values ─────────────────────────────────────────────────

  test('TC-07: amount is zero → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: 0 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-08: amount is negative → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: -50 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-09: amount is below minimum (0.5 < 1.0 XLM minimum) → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: 0.5 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-10: amount exceeds 7 decimal places → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: 1.12345678 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-11: amount is a string → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: 'one hundred' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Invalid currency ──────────────────────────────────────────────────────

  test('TC-12: currency is unsupported asset → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, currency: 'BTC' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TC-13: currency is an empty string → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, currency: '' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Unknown additional fields ─────────────────────────────────────────────

  test('TC-14: unknown field in body → 400 (schema strips unknown fields)', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, hackerField: 'inject' });
    // Schema uses allowUnknown: false — unknown keys are rejected
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Valid minimal payload ─────────────────────────────────────────────────

  test('TC-15: valid minimal payload (studentId only) → 200 or 404 (not 400 or 500)', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID });
    // Validation passes; business logic may return 200 or 404 depending on mock
    expect([200, 201, 404]).toContain(res.status);
    // Must NOT be a validation error
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });

  // ── Valid full payload ────────────────────────────────────────────────────

  test('TC-16: valid full payload (studentId + amount + currency) → 200 or 404 (not 400 or 500)', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: 250, currency: 'XLM' });
    expect([200, 201, 404]).toContain(res.status);
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });

  test('TC-17: valid payload with USDC currency → 200 or 404 (not 400 or 500)', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ studentId: VALID_STUDENT_OBJ_ID, amount: 100.5, currency: 'USDC' });
    expect([200, 201, 404]).toContain(res.status);
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });
});

// ── POST /api/payments/verify ─────────────────────────────────────────────────

describe('POST /api/payments/verify — contract tests', () => {
  const endpoint = '/api/payments/verify';

  // ── Missing required field ────────────────────────────────────────────────

  test('TV-01: missing txHash → 400 with validation error shape', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({});
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Invalid txHash formats ────────────────────────────────────────────────

  test('TV-02: txHash is too short (32 chars) → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: 'a'.repeat(32) });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TV-03: txHash is too long (65 chars) → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: 'a'.repeat(65) });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TV-04: txHash contains uppercase letters → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: 'A'.repeat(64) });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TV-05: txHash contains non-hex characters → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: 'g'.repeat(64) });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TV-06: txHash is a number → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: 1234567890 });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  test('TV-07: txHash is null → 400', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: null });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });

  // ── Valid txHash ──────────────────────────────────────────────────────────

  test('TV-08: valid 64-char lowercase hex txHash → not 400 or 500 (passes validation)', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: VALID_TX_HASH });
    // Validation passes; business logic runs (may return 200, 404, or 422 depending on mock)
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });

  test('TV-09: valid txHash with extra unknown field → 400 (schema rejects unknown fields)', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ txHash: VALID_TX_HASH, extra: 'field' });
    expect(res.status).toBe(400);
    assertErrorShape(res.body);
  });
});
