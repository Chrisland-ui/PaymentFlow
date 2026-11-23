'use strict';

/**
 * Contract tests for payment creation validation — Issue #81
 *
 * Covers POST /api/payments/intent (createPaymentIntent):
 *   - Valid inputs (studentId only; optional amount and currency)
 *   - Boundary values for amount (minimum, maximum precision, edge XLM amounts)
 *   - Supported currency codes (XLM, USDC)
 *   - Malformed and unknown fields
 *   - Validation error response shape
 *   - Absence of side effects for invalid requests
 *
 * All schemas are defined in:
 *   backend/src/middleware/schemas/paymentSchemas.js
 *
 * Validation rules (from createPaymentIntentSchema):
 *   studentId  — required, 24-char lowercase hex MongoDB ObjectId
 *   amount     — optional, positive number ≥ 1.0, at most 7 decimal places
 *   currency   — optional, must be 'XLM' or 'USDC' (case-insensitive; coerced to uppercase)
 *   No unknown fields are allowed (allowUnknown: false).
 */

// ─── Environment bootstrap ─────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const request = require('supertest');

// ─── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
  requireSchoolAuth: () => (req, res, next) => next(),
}));

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

// A valid 24-char hex MongoDB ObjectId for use in test bodies.
const VALID_STUDENT_ID = '507f1f77bcf86cd799439011';

jest.mock('../backend/src/models/studentModel', () => {
  const student = {
    _id: '507f1f77bcf86cd799439011',
    studentId: 'STU001',
    name: 'Alice',
    class: '5A',
    feeAmount: 250,
    feePaid: false,
    schoolId: 'SCH001',
  };
  const makeStudentQuery = (value) => {
    const p = Promise.resolve(value);
    p.includeDeleted = () => Promise.resolve(null);
    p.lean = () => Promise.resolve(value);
    return p;
  };
  return {
    create: jest.fn().mockResolvedValue(student),
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([student]) }),
    findOne: jest.fn().mockImplementation(() => makeStudentQuery(student)),
    findOneAndUpdate: jest.fn().mockResolvedValue(student),
    countDocuments: jest.fn().mockResolvedValue(1),
  };
});

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
    populate: jest.fn().mockResolvedValue([]),
  }),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
  activeFilter: jest.fn((f = {}) => ({ ...f, deletedAt: null })),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create: jest.fn().mockResolvedValue({
    studentId: VALID_STUDENT_ID,
    amount: 250,
    memo: 'ABCD1234',
    status: 'pending',
    toObject() {
      return { studentId: VALID_STUDENT_ID, amount: 250, memo: 'ABCD1234', status: 'pending' };
    },
  }),
  findOne: jest.fn().mockResolvedValue(null),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/idempotencyStore', () => ({
  getFull: jest.fn().mockResolvedValue(null),
  reserve: jest.fn().mockResolvedValue({ reserved: true }),
  complete: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
  IN_FLIGHT_TTL_MS: 30000,
}));

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(),
  setupMonitoring: jest.fn(),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(),
  stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/queue/transactionQueue', () => ({
  enqueueTransaction: jest.fn().mockResolvedValue({ id: 'mock-job' }),
  getJobStatus: jest.fn().mockResolvedValue({ found: false }),
}));

jest.mock('../backend/src/services/transactionQueueService', () => ({
  startWorker: jest.fn(),
  stopWorker: jest.fn(),
}));

jest.mock('../backend/src/services/transactionService', () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
}));

jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(),
  stopReminderScheduler: jest.fn(),
  processReminders: jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'SCH001',
      name: 'Test School',
      slug: 'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD',
      isActive: true,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    }),
  }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  create: jest.fn().mockResolvedValue({ className: '5A', feeAmount: 250 }),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne: jest.fn().mockResolvedValue({ className: '5A', feeAmount: 250, isActive: true }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: true,
    localAmount: 100,
    currency: 'USD',
    rate: 0.5,
    rateTimestamp: new Date().toISOString(),
  }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) =>
    Promise.resolve({ ...p, localCurrency: { available: false } }),
  ),
  _getRates: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GISSUER' },
  },
  server: {
    transactions: () => ({
      transaction: () => ({
        call: async () => ({
          hash: 'a'.repeat(64),
          successful: true,
          created_at: new Date().toISOString(),
        }),
      }),
    }),
  },
}));

jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments: jest.fn().mockResolvedValue(undefined),
  syncPaymentsForSchool: jest.fn().mockResolvedValue({ found: 0, new: 0, matched: 0, unmatched: 0, failed: 0, alreadyProcessed: 0, failedDetails: [] }),
  verifyTransaction: jest.fn().mockResolvedValue({
    hash: 'a'.repeat(64),
    memo: 'STU001',
    studentId: 'STU001',
    amount: 250,
    assetCode: 'XLM',
    assetType: 'native',
    expectedAmount: 250,
    feeAmount: 250,
    feeValidation: { status: 'valid', excessAmount: 0, message: 'Payment matches the required fee' },
    networkFee: 0.00001,
    date: new Date().toISOString(),
    ledger: 100,
    senderAddress: 'GSENDER123',
  }),
  recordPayment: jest.fn().mockResolvedValue({}),
  finalizeConfirmedPayments: jest.fn().mockResolvedValue(undefined),
}));

// ─── App setup ─────────────────────────────────────────────────────────────────

const app = require('../backend/src/app');

// Helper: supertest wrapper that always sends the X-School-ID header
function schoolApi(app) {
  const agent = request(app);
  const wrap = (method) => (...args) => {
    const req = agent[method](...args);
    return req.set('X-School-ID', 'SCH001');
  };
  return {
    get: wrap('get'),
    post: wrap('post'),
    put: wrap('put'),
    patch: wrap('patch'),
    delete: wrap('delete'),
  };
}

const testApi = schoolApi(app);

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Assert that the response is a 400 validation error with a consistent shape.
 *
 * The validation middleware (validate.js) returns:
 *   { errors: [{ field, message }, ...] }
 *
 * @param {object} res - supertest response
 */
function assertValidationError(res) {
  expect(res.status).toBe(400);
  expect(res.body).toHaveProperty('errors');
  expect(Array.isArray(res.body.errors)).toBe(true);
  expect(res.body.errors.length).toBeGreaterThan(0);
  res.body.errors.forEach((err) => {
    expect(err).toHaveProperty('field');
    expect(err).toHaveProperty('message');
    expect(typeof err.field).toBe('string');
    expect(typeof err.message).toBe('string');
  });
}

/**
 * Assert that a validation error includes an entry for the given field.
 */
function assertFieldError(res, field) {
  const fields = res.body.errors.map((e) => e.field);
  expect(fields).toContain(field);
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe('POST /api/payments/intent — contract tests (issue #81)', () => {

  // ── Valid inputs ─────────────────────────────────────────────────────────────

  describe('valid inputs', () => {
    test('accepts a request with studentId only (amount and currency are optional)', async () => {
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'valid-student-id-only')
        .send({ studentId: VALID_STUDENT_ID });

      expect(res.status).toBe(200);
    });

    test('accepts a request with studentId and a valid amount', async () => {
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'valid-student-amount')
        .send({ studentId: VALID_STUDENT_ID, amount: 100.0 });

      expect(res.status).toBe(200);
    });

    test('accepts a request with studentId, amount, and currency XLM', async () => {
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'valid-xlm')
        .send({ studentId: VALID_STUDENT_ID, amount: 50.5, currency: 'XLM' });

      expect(res.status).toBe(200);
    });

    test('accepts a request with studentId, amount, and currency USDC', async () => {
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'valid-usdc')
        .send({ studentId: VALID_STUDENT_ID, amount: 75.25, currency: 'USDC' });

      expect(res.status).toBe(200);
    });

    test('coerces lowercase currency to uppercase (xlm → XLM)', async () => {
      // The schema uses .uppercase() on the currencyCode, so 'xlm' is coerced
      // to 'XLM' before the allowed-values check. The request should succeed.
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'coerce-lowercase-xlm')
        .send({ studentId: VALID_STUDENT_ID, currency: 'xlm' });

      expect(res.status).toBe(200);
    });

    test('accepts the minimum valid amount (1.0)', async () => {
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'min-amount-1.0')
        .send({ studentId: VALID_STUDENT_ID, amount: 1.0 });

      expect(res.status).toBe(200);
    });

    test('accepts an amount with the maximum allowed precision (7 decimal places)', async () => {
      const res = await testApi.post('/api/payments/intent')
        .set('Idempotency-Key', 'max-precision-7dp')
        .send({ studentId: VALID_STUDENT_ID, amount: 1.1234567 });

      expect(res.status).toBe(200);
    });
  });

  // ── studentId validation ─────────────────────────────────────────────────────

  describe('studentId field validation', () => {
    test('400 when studentId is missing', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ amount: 100 });

      assertValidationError(res);
      assertFieldError(res, 'studentId');
    });

    test('400 when studentId is not a string', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: 12345678901234567890, amount: 100 });

      assertValidationError(res);
    });

    test('400 when studentId is fewer than 24 hex characters', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: 'abc123' });

      assertValidationError(res);
      assertFieldError(res, 'studentId');
    });

    test('400 when studentId is more than 24 characters', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: 'a'.repeat(25) });

      assertValidationError(res);
      assertFieldError(res, 'studentId');
    });

    test('400 when studentId is exactly 24 chars but contains non-hex characters', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: 'zzzzzzzzzzzzzzzzzzzzzzzz' }); // 24 non-hex chars

      assertValidationError(res);
      assertFieldError(res, 'studentId');
    });

    test('400 when studentId is an empty string', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: '' });

      assertValidationError(res);
      assertFieldError(res, 'studentId');
    });

    test('400 when studentId is null', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: null });

      assertValidationError(res);
    });
  });

  // ── amount field validation ──────────────────────────────────────────────────

  describe('amount field validation', () => {
    test('400 when amount is zero', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 0 });

      assertValidationError(res);
      assertFieldError(res, 'amount');
    });

    test('400 when amount is negative', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: -1 });

      assertValidationError(res);
      assertFieldError(res, 'amount');
    });

    test('400 when amount is below the minimum (< 1.0)', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 0.5 });

      assertValidationError(res);
      assertFieldError(res, 'amount');
    });

    test('400 when amount is 0.9999999 (just below the minimum)', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 0.9999999 });

      assertValidationError(res);
      assertFieldError(res, 'amount');
    });

    test('400 when amount has more than 7 decimal places', async () => {
      // 1.12345678 has 8 decimal places — exceeds Stellar precision
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 1.12345678 });

      assertValidationError(res);
      assertFieldError(res, 'amount');
    });

    test('400 when amount is a non-numeric string', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 'one-hundred' });

      assertValidationError(res);
      assertFieldError(res, 'amount');
    });

    test('400 when amount is an array', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: [100] });

      assertValidationError(res);
    });
  });

  // ── currency field validation ────────────────────────────────────────────────

  describe('currency field validation', () => {
    test('400 when currency is an unsupported value', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, currency: 'BTC' });

      assertValidationError(res);
      assertFieldError(res, 'currency');
    });

    test('400 when currency is a numeric value', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, currency: 42 });

      assertValidationError(res);
    });

    test('400 when currency is an empty string', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, currency: '' });

      assertValidationError(res);
    });

    test('error response names the unsupported currencies in its message', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, currency: 'EUR' });

      assertValidationError(res);
      const currencyError = res.body.errors.find((e) => e.field === 'currency');
      expect(currencyError).toBeDefined();
      // The error message should indicate which values are allowed
      expect(currencyError.message).toMatch(/XLM|USDC/);
    });
  });

  // ── Unknown / extra fields ───────────────────────────────────────────────────

  describe('unknown and extra fields', () => {
    test('400 when the request body contains unknown fields', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, unknownField: 'injected' });

      // allowUnknown: false means any extra key triggers a validation error
      assertValidationError(res);
    });

    test('400 when multiple unknown fields are present', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({
          studentId: VALID_STUDENT_ID,
          beneficiaryName: 'Alice',
          metadata: { reference: 'REF-001' },
        });

      assertValidationError(res);
    });

    test('400 when a valid field is paired with an unknown field', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({
          studentId: VALID_STUDENT_ID,
          amount: 100,
          currency: 'XLM',
          extra: 'should-not-be-here',
        });

      assertValidationError(res);
    });
  });

  // ── Malformed payloads ───────────────────────────────────────────────────────

  describe('malformed payloads', () => {
    test('400 when the body is an empty object', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({});

      // studentId is required, so an empty body must fail
      assertValidationError(res);
      assertFieldError(res, 'studentId');
    });

    test('400 when the body is an array', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send([{ studentId: VALID_STUDENT_ID }]);

      // Arrays are not a valid object body
      expect(res.status).toBe(400);
    });

    test('400 when Content-Type is application/json but the body is invalid JSON', async () => {
      const res = await request(app)
        .post('/api/payments/intent')
        .set('X-School-ID', 'SCH001')
        .set('Content-Type', 'application/json')
        .send('{ studentId: not-valid-json }');

      expect(res.status).toBe(400);
    });
  });

  // ── Validation error response shape ─────────────────────────────────────────

  describe('validation error response shape', () => {
    test('returns { errors: [...] } — no top-level "error" string for schema violations', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({});

      // The validate() middleware always uses the `errors` array shape, not
      // the single-string `error` shape used by business-logic errors.
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('errors');
      expect(res.body).not.toHaveProperty('code'); // no business-logic error code
    });

    test('returns all validation failures in a single response (abortEarly: false)', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({
          // studentId missing → error
          amount: -5,         // negative → error
          currency: 'DOGE',   // unsupported → error
        });

      assertValidationError(res);
      // All three fields should surface in one round-trip
      const fields = res.body.errors.map((e) => e.field);
      expect(fields).toContain('studentId');
      expect(fields).toContain('amount');
      expect(fields).toContain('currency');
    });

    test('each error entry has a non-empty "field" and "message"', async () => {
      const res = await testApi.post('/api/payments/intent')
        .send({ amount: 0.1 }); // missing studentId and invalid amount

      assertValidationError(res);
      res.body.errors.forEach((err) => {
        expect(err.field).toBeTruthy();
        expect(err.message).toBeTruthy();
      });
    });
  });

  // ── Absence of side effects for invalid requests ─────────────────────────────

  describe('absence of side effects for invalid requests', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('no payment intent is created for an invalid studentId', async () => {
      const PaymentIntent = require('../backend/src/models/paymentIntentModel');

      await testApi.post('/api/payments/intent')
        .send({ studentId: 'not-a-valid-id' });

      expect(PaymentIntent.create).not.toHaveBeenCalled();
    });

    test('no payment intent is created when amount is below the minimum', async () => {
      const PaymentIntent = require('../backend/src/models/paymentIntentModel');

      await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 0.001 });

      expect(PaymentIntent.create).not.toHaveBeenCalled();
    });

    test('no payment intent is created for an unsupported currency', async () => {
      const PaymentIntent = require('../backend/src/models/paymentIntentModel');

      await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 100, currency: 'ETH' });

      expect(PaymentIntent.create).not.toHaveBeenCalled();
    });

    test('no payment intent is created when the body contains unknown fields', async () => {
      const PaymentIntent = require('../backend/src/models/paymentIntentModel');

      await testApi.post('/api/payments/intent')
        .send({ studentId: VALID_STUDENT_ID, amount: 100, unknownField: 'injected' });

      expect(PaymentIntent.create).not.toHaveBeenCalled();
    });

    test('no audit log entry is written for a rejected request', async () => {
      const auditService = require('../backend/src/services/auditService');

      await testApi.post('/api/payments/intent')
        .send({});

      expect(auditService.logAudit).not.toHaveBeenCalled();
    });
  });

  // ── Currency precision coverage ──────────────────────────────────────────────

  describe('Stellar precision boundary values', () => {
    const precisionCases = [
      { amount: 1.0,       desc: 'integer',             valid: true  },
      { amount: 1.1,       desc: '1 dp',                valid: true  },
      { amount: 1.12,      desc: '2 dp',                valid: true  },
      { amount: 1.123,     desc: '3 dp',                valid: true  },
      { amount: 1.1234,    desc: '4 dp',                valid: true  },
      { amount: 1.12345,   desc: '5 dp',                valid: true  },
      { amount: 1.123456,  desc: '6 dp',                valid: true  },
      { amount: 1.1234567, desc: '7 dp (max)',          valid: true  },
      // amounts below the min threshold
      { amount: 0.9999999, desc: '7 dp below min',      valid: false },
      { amount: 0.0000001, desc: 'Stellar stroops unit', valid: false },
    ];

    precisionCases.forEach(({ amount, desc, valid }) => {
      test(`amount ${amount} (${desc}) → ${valid ? 'accepted' : 'rejected'}`, async () => {
        const res = await testApi.post('/api/payments/intent')
          .set('Idempotency-Key', `precision-${amount.toString().replace('.', '_')}`)
          .send({ studentId: VALID_STUDENT_ID, amount });

        if (valid) {
          expect(res.status).toBe(200);
        } else {
          assertValidationError(res);
          assertFieldError(res, 'amount');
        }
      });
    });
  });

  // ── Supported currencies coverage ───────────────────────────────────────────

  describe('supported currency codes', () => {
    const supportedCurrencies = ['XLM', 'USDC'];
    const unsupportedCurrencies = ['BTC', 'ETH', 'EUR', 'USD', 'DOGE', 'SOL', 'ADA', ''];

    supportedCurrencies.forEach((currency) => {
      test(`${currency} is accepted`, async () => {
        const res = await testApi.post('/api/payments/intent')
          .set('Idempotency-Key', `currency-supported-${currency}`)
          .send({ studentId: VALID_STUDENT_ID, currency });

        expect(res.status).toBe(200);
      });
    });

    unsupportedCurrencies.forEach((currency) => {
      test(`"${currency}" is rejected`, async () => {
        const res = await testApi.post('/api/payments/intent')
          .send({ studentId: VALID_STUDENT_ID, currency });

        expect(res.status).toBe(400);
      });
    });
  });
});
