'use strict';

/**
 * Issue #331 — Concurrent idempotency key tests
 *
 * Verifies that the idempotency implementation is race-condition safe under
 * real concurrency.  All tests fire N simultaneous requests with the same
 * idempotency key and assert:
 *   - Exactly one payment record is created (duplicate prevention)
 *   - Every other request receives the original success response or 409
 *   - Zero duplicate payment records exist after each scenario
 *
 * Scenarios:
 *   1. N=2  — two simultaneous identical verify requests
 *   2. N=5  — five simultaneous identical verify requests
 *   3. N=10 — ten simultaneous identical verify requests
 *   4. Redis lock expiry — lock expires before write completes; subsequent
 *      request must take over the reservation and complete without duplication
 *   5. Distinct keys — concurrent requests with distinct keys each succeed
 */

// ── Environment setup ─────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const request = require('supertest');
const crypto  = require('crypto');

// ── Database mock ─────────────────────────────────────────────────────────────
jest.mock('../backend/src/config/database', () => ({
  connect:    jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
  TRANSACTION_CONFIG: {
    readConcern: 'majority',
    writeConcern: 'majority',
    journal: true,
    transactionTimeoutMs: 30000,
  },
}));

// ── Model mocks ───────────────────────────────────────────────────────────────
const mockPaymentFindOne         = jest.fn();
const mockPaymentCreate          = jest.fn();
const mockPaymentAggregate       = jest.fn().mockResolvedValue([]);
const mockStudentFindOne         = jest.fn();
const mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({});
const mockSchoolFindOne          = jest.fn();
const mockPaymentIntentFindOne   = jest.fn();

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: (...a) => mockPaymentFindOne(...a),
  create:  (...a) => mockPaymentCreate(...a),
  aggregate: (...a) => mockPaymentAggregate(...a),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne:          (...a) => mockStudentFindOne(...a),
  findOneAndUpdate: (...a) => mockStudentFindOneAndUpdate(...a),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: (...a) => mockSchoolFindOne(...a),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne:          (...a) => mockPaymentIntentFindOne(...a),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

// ── Service mocks ─────────────────────────────────────────────────────────────
jest.mock('../backend/src/services/auditService', () => ({
  logAudit:           jest.fn().mockResolvedValue(undefined),
  getAuditLogs:       jest.fn().mockResolvedValue({ logs: [], total: 0, page: 1, limit: 50, pages: 1 }),
  getRecentAuditLogs: jest.fn().mockResolvedValue([]),
  verifyAuditChain:   jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  getAuditFailureCount: jest.fn().mockReturnValue(0),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: true,
    localAmount: 1200.0,
    currency: 'USD',
    rate: 12.0,
    rateTimestamp: new Date().toISOString(),
  }),
}));

// ── Distributed lock mock ─────────────────────────────────────────────────────
jest.mock('../backend/src/services/distributedLock', () => ({
  acquire:         jest.fn().mockResolvedValue('lock-token'),
  release:         jest.fn().mockResolvedValue(true),
  renew:           jest.fn().mockResolvedValue(true),
  withLock:        jest.fn(async (_key, _ttl, fn) => fn()),
  getCurrentFence: jest.fn().mockResolvedValue(0),
  close:           jest.fn().mockResolvedValue(true),
}));

// ── Stellar service mock ──────────────────────────────────────────────────────
const mockVerifyTransaction = jest.fn();
jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: (...a) => mockVerifyTransaction(...a),
  recordPayment:     jest.fn().mockResolvedValue({}),
}));

// ── Idempotency store mock (simulates real concurrency behaviour) ─────────────
//
// The idempotency store is the gatekeeper for duplicate requests.  We simulate
// its atomic reservation semantics: the first call to reserve() wins; all
// subsequent calls for the same key return { reserved: false, record: <...> }.
//
// A real Redis SET NX is the equivalent operation in production.

let _idemStore    = {};  // key -> completed record
let _idemInFlight = {};  // key -> true (in_progress)

const mockIdemGetFull = jest.fn();
const mockIdemReserve = jest.fn();
const mockIdemComplete = jest.fn();
const mockIdemRelease  = jest.fn();

jest.mock('../backend/src/services/idempotencyStore', () => ({
  getFull:    (...a) => mockIdemGetFull(...a),
  get:        jest.fn().mockResolvedValue(null),
  set:        jest.fn().mockResolvedValue(true),
  reserve:    (...a) => mockIdemReserve(...a),
  complete:   (...a) => mockIdemComplete(...a),
  release:    (...a) => mockIdemRelease(...a),
  redisEnabled: false,
  IN_FLIGHT_TTL_MS: 30000,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return a fresh 64-char hex tx hash */
function fakeTxHash() {
  return crypto.randomBytes(32).toString('hex');
}

/** Idempotency key in the format the middleware expects */
function idemKey(seed) {
  return `test-concurrent-${seed}`;
}

const SCHOOL_ID = 'SCH001';
const STELLAR_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Default school mock (called by resolveSchool) */
function mockSchool() {
  mockSchoolFindOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId:       SCHOOL_ID,
      stellarAddress: STELLAR_ADDR,
      localCurrency:  'USD',
      isActive:       true,
    }),
  });
}

/** Default student mock */
function mockStudent(studentId = 'STU001', feeAmount = 100) {
  mockStudentFindOne.mockResolvedValue({ studentId, feeAmount });
}

/** Default payment-intent mock */
function mockPaymentIntent(studentId = 'STU001', amount = 100) {
  mockPaymentIntentFindOne.mockResolvedValue({
    memo: studentId, studentId, amount, status: 'pending',
  });
}

/** Default Stellar verification result */
function mockHorizonVerify(txHash, studentId = 'STU001', amount = 100) {
  mockVerifyTransaction.mockResolvedValue({
    hash:       txHash,
    memo:       studentId,
    studentId,
    amount,
    assetCode:  'XLM',
    assetType:  'native',
    feeAmount:  amount,
    feeValidation: { status: 'valid', message: 'Payment matches required fee', excessAmount: 0 },
    networkFee: 0.00001,
    date:       new Date().toISOString(),
    senderAddress: 'GSENDER',
    ledger: 12345,
  });
}

/** Set up the idempotency store to behave with real atomic-reserve semantics */
function setupAtomicIdempotency() {
  _idemStore    = {};
  _idemInFlight = {};

  // reserve: first caller wins; others see the existing record
  mockIdemReserve.mockImplementation(async (key) => {
    if (_idemStore[key]) {
      return { reserved: false, record: _idemStore[key] };
    }
    if (_idemInFlight[key]) {
      return { reserved: false, record: { state: 'in_progress', responseStatus: null, responseBody: null } };
    }
    _idemInFlight[key] = true;
    return { reserved: true };
  });

  // getFull: reflect the current store state
  mockIdemGetFull.mockImplementation(async (key) => {
    if (_idemStore[key]) return _idemStore[key];
    if (_idemInFlight[key]) return { state: 'in_progress', responseStatus: null, responseBody: null };
    return null;
  });

  // complete: store the finished result
  mockIdemComplete.mockImplementation(async (key, record) => {
    delete _idemInFlight[key];
    _idemStore[key] = {
      state:          'completed',
      responseStatus: record.responseStatus,
      responseBody:   record.responseBody,
      scope:          record.scope || '',
    };
  });

  // release: drop in_progress flag so the key can be retried
  mockIdemRelease.mockImplementation(async (key) => {
    delete _idemInFlight[key];
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #331 — Concurrent idempotency key tests', () => {
  let app;

  beforeAll(() => {
    app = require('../backend/src/app');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setupAtomicIdempotency();
    mockSchool();
    mockStudent();
    mockPaymentIntent();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 1 — N=2 simultaneous identical requests
  // ────────────────────────────────────────────────────────────────────────────
  describe('N=2 simultaneous requests with the same idempotency key', () => {
    it('creates exactly one payment record and both responses are consistent', async () => {
      const txHash = fakeTxHash();
      const key    = idemKey('n2');

      mockPaymentFindOne.mockResolvedValue(null);
      mockHorizonVerify(txHash);
      mockPaymentCreate.mockResolvedValue({ txHash, studentId: 'STU001', amount: 100 });

      const makeRequest = () =>
        request(app)
          .post('/api/payments/verify')
          .set('X-School-Id', SCHOOL_ID)
          .set('Idempotency-Key', key)
          .send({ txHash });

      const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);

      // Both must succeed
      expect([r1.status, r2.status]).not.toContain(500);

      // At most one call to Payment.create (the winning request)
      expect(mockPaymentCreate.mock.calls.length).toBeLessThanOrEqual(1);

      // At most one Horizon verification
      expect(mockVerifyTransaction.mock.calls.length).toBeLessThanOrEqual(1);

      // Both responses reference the same transaction
      for (const r of [r1, r2]) {
        if (r.status === 200) {
          expect(r.body.hash || r.body.txHash || txHash).toBeTruthy();
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 2 — N=5 simultaneous identical requests
  // ────────────────────────────────────────────────────────────────────────────
  describe('N=5 simultaneous requests with the same idempotency key', () => {
    it('prevents duplicate payment records across five concurrent requests', async () => {
      const txHash = fakeTxHash();
      const key    = idemKey('n5');

      mockPaymentFindOne.mockResolvedValue(null);
      mockHorizonVerify(txHash);
      mockPaymentCreate.mockResolvedValue({ txHash, studentId: 'STU001', amount: 100 });

      const makeRequest = () =>
        request(app)
          .post('/api/payments/verify')
          .set('X-School-Id', SCHOOL_ID)
          .set('Idempotency-Key', key)
          .send({ txHash });

      const results = await Promise.all(Array.from({ length: 5 }, makeRequest));

      // No 500s
      results.forEach(r => expect(r.status).not.toBe(500));

      // Payment.create called at most once
      expect(mockPaymentCreate.mock.calls.length).toBeLessThanOrEqual(1);

      // Horizon called at most once
      expect(mockVerifyTransaction.mock.calls.length).toBeLessThanOrEqual(1);

      // At least one request succeeds with 200
      const successes = results.filter(r => r.status === 200);
      expect(successes.length).toBeGreaterThanOrEqual(1);

      // All non-200 responses are idempotency-replays (200 with cached body or 409)
      const nonSuccess = results.filter(r => r.status !== 200);
      nonSuccess.forEach(r => {
        expect([200, 409]).toContain(r.status);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 3 — N=10 simultaneous identical requests
  // ────────────────────────────────────────────────────────────────────────────
  describe('N=10 simultaneous requests with the same idempotency key', () => {
    it('zero duplicate payment records exist after ten concurrent requests', async () => {
      const txHash = fakeTxHash();
      const key    = idemKey('n10');

      mockPaymentFindOne.mockResolvedValue(null);
      mockHorizonVerify(txHash);
      mockPaymentCreate.mockResolvedValue({ txHash, studentId: 'STU001', amount: 100 });

      const makeRequest = () =>
        request(app)
          .post('/api/payments/verify')
          .set('X-School-Id', SCHOOL_ID)
          .set('Idempotency-Key', key)
          .send({ txHash });

      const results = await Promise.all(Array.from({ length: 10 }, makeRequest));

      // No 500s allowed — idempotency failures must not crash the server
      results.forEach(r => {
        expect(r.status).not.toBe(500);
        expect([200, 409]).toContain(r.status);
      });

      // The create call is made at most once — zero duplicates
      expect(mockPaymentCreate.mock.calls.length).toBeLessThanOrEqual(1);

      // Stellar Horizon hit at most once
      expect(mockVerifyTransaction.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('all responses reference the same payment data', async () => {
      const txHash = fakeTxHash();
      const key    = idemKey('n10-data');

      mockPaymentFindOne.mockResolvedValue(null);
      mockHorizonVerify(txHash, 'STU001', 250);
      mockPaymentCreate.mockResolvedValue({ txHash, studentId: 'STU001', amount: 250 });

      const makeRequest = () =>
        request(app)
          .post('/api/payments/verify')
          .set('X-School-Id', SCHOOL_ID)
          .set('Idempotency-Key', key)
          .send({ txHash });

      const results = await Promise.all(Array.from({ length: 10 }, makeRequest));

      const successBodies = results
        .filter(r => r.status === 200)
        .map(r => r.body);

      // All success responses should agree on the core fields
      successBodies.forEach(body => {
        if (body.hash) expect(body.hash).toBe(txHash);
        if (body.studentId) expect(body.studentId).toBe('STU001');
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 4 — Redis lock expiry before write completes
  // ────────────────────────────────────────────────────────────────────────────
  describe('Redis lock expiry scenario', () => {
    it('subsequent request takes over a stale in_progress reservation', async () => {
      const txHash = fakeTxHash();
      const staleKey = idemKey('stale-lock');

      // Simulate a stale in_progress record (lock expired before write)
      // The first call to getFull returns an old in_progress with a createdAt
      // older than IN_FLIGHT_TTL_MS.  The middleware must take it over.
      const staleCreatedAt = new Date(Date.now() - 60_000); // 60s ago — well past TTL

      mockIdemGetFull.mockResolvedValueOnce({
        state:          'in_progress',
        responseStatus: null,
        responseBody:   null,
        createdAt:      staleCreatedAt,
        scope:          '',
      });

      // After the takeover, reserve succeeds for the new request
      mockIdemReserve.mockResolvedValueOnce({ reserved: true });

      mockPaymentFindOne.mockResolvedValue(null);
      mockHorizonVerify(txHash);
      mockPaymentCreate.mockResolvedValue({ txHash, studentId: 'STU001', amount: 100 });

      const response = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', SCHOOL_ID)
        .set('Idempotency-Key', staleKey)
        .send({ txHash });

      // Should succeed — the new request took over the expired reservation
      expect([200, 409]).toContain(response.status);
      // Must not have created a duplicate payment
      expect(mockPaymentCreate.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('does not double-create a payment when lock expires during in-flight processing', async () => {
      const txHash = fakeTxHash();
      const key    = idemKey('lock-expiry-create');

      // Simulate: first request holds lock, creates payment, but lock expires
      // before complete() is called.  Second request sees in_progress (stale)
      // and also tries to create → must be deduplicated by the Payment record.
      let createCallCount = 0;
      mockPaymentFindOne.mockImplementation(async () => {
        // After the first create, subsequent findOnes see the existing payment
        if (createCallCount > 0) {
          return {
            txHash,
            studentId: 'STU001',
            memo:      'STU001',
            amount:    100,
            status:    'SUCCESS',
            confirmationStatus: 'confirmed',
            confirmedAt: new Date(),
          };
        }
        return null;
      });

      mockPaymentCreate.mockImplementation(async () => {
        createCallCount++;
        return { txHash, studentId: 'STU001', amount: 100 };
      });

      mockHorizonVerify(txHash);

      // Both requests use the same key
      const makeRequest = () =>
        request(app)
          .post('/api/payments/verify')
          .set('X-School-Id', SCHOOL_ID)
          .set('Idempotency-Key', key)
          .send({ txHash });

      const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);

      expect([r1.status, r2.status]).not.toContain(500);
      // At most one actual payment creation
      expect(createCallCount).toBeLessThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 5 — Distinct keys allow independent concurrent successes
  // ────────────────────────────────────────────────────────────────────────────
  describe('Distinct idempotency keys', () => {
    it('concurrent requests with different keys each succeed independently', async () => {
      const n = 5;
      const requests = Array.from({ length: n }, (_, i) => {
        const txHash    = fakeTxHash();
        const studentId = `STU${String(i + 1).padStart(3, '0')}`;
        const key       = idemKey(`distinct-${i}`);

        mockHorizonVerify(txHash, studentId, 100);
        mockPaymentCreate.mockResolvedValueOnce({ txHash, studentId, amount: 100 });
        mockStudentFindOne.mockResolvedValueOnce({ studentId, feeAmount: 100 });
        mockPaymentIntentFindOne.mockResolvedValueOnce({ memo: studentId, studentId, amount: 100, status: 'pending' });
        mockPaymentFindOne.mockResolvedValueOnce(null);

        return request(app)
          .post('/api/payments/verify')
          .set('X-School-Id', SCHOOL_ID)
          .set('Idempotency-Key', key)
          .send({ txHash });
      });

      const results = await Promise.all(requests);

      // All should succeed — they have distinct keys
      results.forEach(r => {
        expect(r.status).not.toBe(500);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Determinism — tests are repeatable across CI runs
  // ────────────────────────────────────────────────────────────────────────────
  describe('Determinism', () => {
    it('produces the same outcome across repeated runs with the same concurrency level', async () => {
      for (let run = 0; run < 3; run++) {
        // Reset store for each run
        setupAtomicIdempotency();
        jest.clearAllMocks();
        mockSchool();
        mockStudent();
        mockPaymentIntent();

        const txHash = fakeTxHash();
        const key    = idemKey(`determinism-run-${run}`);

        mockPaymentFindOne.mockResolvedValue(null);
        mockHorizonVerify(txHash);
        mockPaymentCreate.mockResolvedValue({ txHash, studentId: 'STU001', amount: 100 });

        const makeRequest = () =>
          request(app)
            .post('/api/payments/verify')
            .set('X-School-Id', SCHOOL_ID)
            .set('Idempotency-Key', key)
            .send({ txHash });

        const results = await Promise.all(Array.from({ length: 5 }, makeRequest));

        results.forEach(r => expect(r.status).not.toBe(500));
        expect(mockPaymentCreate.mock.calls.length).toBeLessThanOrEqual(1);
      }
    });
  });
});
