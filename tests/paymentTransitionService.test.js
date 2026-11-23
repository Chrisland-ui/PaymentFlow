'use strict';

/**
 * Tests for paymentTransitionService (Issue #32).
 *
 * Verifies:
 *   - Valid transitions succeed and persist
 *   - Illegal transitions are rejected with stable error envelopes
 *   - PENDING is always rejected as a target
 *   - Admin-override enables wider transition table
 *   - Audit entries are written for both success and failure paths
 *   - No secret values are included in audit details
 */

// ── Env ───────────────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-abcdef01';
process.env.MONGO_URI  = 'mongodb://localhost:27017/test';

// ── Audit spy ─────────────────────────────────────────────────────────────────
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../backend/src/services/auditService', () => ({
  logAudit:              (...args) => mockLogAudit(...args),
  getAuditHealth:        jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
  getAuditLogs:          jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getRecentAuditLogs:    jest.fn().mockResolvedValue([]),
  verifyAuditChain:      jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  archiveAuditLogs:      jest.fn().mockResolvedValue(0),
  _resetAuditFailureCount: jest.fn(),
}));

const { transition, transitionByHash } = require('../../backend/src/services/paymentTransitionService');
const { PAYMENT_STATUS } = require('../../backend/src/constants/paymentStatus');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fake Mongoose payment document. */
function makePayment(status = PAYMENT_STATUS.PENDING, txHash = 'abc123') {
  let _status = status;
  return {
    _id:      '507f1f77bcf86cd799439011',
    txHash,
    schoolId: 'SCH001',
    amount:   100,
    get status() { return _status; },
    set status(v) { _status = v; },
    $locals:  {},
    save: jest.fn().mockImplementation(function () {
      return Promise.resolve(this);
    }),
  };
}

const COMMON_OPTS = {
  reason:      'test reason',
  performedBy: 'admin@test.com',
  schoolId:    'SCH001',
  ipAddress:   '127.0.0.1',
  userAgent:   'jest',
};

// ─────────────────────────────────────────────────────────────────────────────
// Valid transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('paymentTransitionService — valid transitions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('PENDING → FAILED succeeds', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    const result = await transition(payment, PAYMENT_STATUS.FAILED, COMMON_OPTS);

    expect(result.ok).toBe(true);
    expect(result.previousStatus).toBe(PAYMENT_STATUS.PENDING);
    expect(payment.status).toBe(PAYMENT_STATUS.FAILED);
    expect(payment.save).toHaveBeenCalledTimes(1);
  });

  test('SUCCESS → DISPUTED succeeds', async () => {
    const payment = makePayment(PAYMENT_STATUS.SUCCESS);
    const result = await transition(payment, PAYMENT_STATUS.DISPUTED, COMMON_OPTS);

    expect(result.ok).toBe(true);
    expect(result.previousStatus).toBe(PAYMENT_STATUS.SUCCESS);
  });

  test('SUCCESS → REFUNDED succeeds', async () => {
    const payment = makePayment(PAYMENT_STATUS.SUCCESS);
    const result = await transition(payment, PAYMENT_STATUS.REFUNDED, COMMON_OPTS);

    expect(result.ok).toBe(true);
  });

  test('FAILED → SUCCESS succeeds with adminOverride', async () => {
    const payment = makePayment(PAYMENT_STATUS.FAILED);
    const result = await transition(payment, PAYMENT_STATUS.SUCCESS, {
      ...COMMON_OPTS,
      adminOverride: true,
    });

    expect(result.ok).toBe(true);
    expect(payment.$locals.adminOverride).toBe(true);
  });

  test('DISPUTED → REFUNDED succeeds with adminOverride', async () => {
    const payment = makePayment(PAYMENT_STATUS.DISPUTED);
    const result = await transition(payment, PAYMENT_STATUS.REFUNDED, {
      ...COMMON_OPTS,
      adminOverride: true,
    });

    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Illegal transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('paymentTransitionService — illegal transitions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns ok:false for unknown target status', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    const result = await transition(payment, 'NONEXISTENT', COMMON_OPTS);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_STATUS');
    expect(payment.save).not.toHaveBeenCalled();
  });

  test('PENDING → PENDING is rejected (cannot target PENDING)', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    const result = await transition(payment, PAYMENT_STATUS.PENDING, COMMON_OPTS);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
    expect(payment.save).not.toHaveBeenCalled();
  });

  test('SUCCESS → FAILED is rejected without adminOverride', async () => {
    const payment = makePayment(PAYMENT_STATUS.SUCCESS);
    const result = await transition(payment, PAYMENT_STATUS.FAILED, COMMON_OPTS);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
    expect(payment.save).not.toHaveBeenCalled();
  });

  test('DISPUTED → FAILED is rejected even with adminOverride', async () => {
    const payment = makePayment(PAYMENT_STATUS.DISPUTED);
    const result = await transition(payment, PAYMENT_STATUS.FAILED, {
      ...COMMON_OPTS,
      adminOverride: true,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
  });

  test('REFUNDED → SUCCESS is rejected (terminal state)', async () => {
    const payment = makePayment(PAYMENT_STATUS.REFUNDED);
    const result = await transition(payment, PAYMENT_STATUS.SUCCESS, {
      ...COMMON_OPTS,
      adminOverride: true,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit logging
// ─────────────────────────────────────────────────────────────────────────────

describe('paymentTransitionService — audit logging', () => {
  beforeEach(() => jest.clearAllMocks());

  test('writes success audit entry on valid transition', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    await transition(payment, PAYMENT_STATUS.FAILED, COMMON_OPTS);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId:   'SCH001',
        action:     'payment_status_transition',
        performedBy: 'admin@test.com',
        targetId:   payment.txHash,
        targetType: 'payment',
        result:     'success',
        details:    expect.objectContaining({
          from:   PAYMENT_STATUS.PENDING,
          to:     PAYMENT_STATUS.FAILED,
          reason: 'test reason',
        }),
      })
    );
  });

  test('writes failure audit entry on rejected transition', async () => {
    const payment = makePayment(PAYMENT_STATUS.SUCCESS);
    await transition(payment, PAYMENT_STATUS.FAILED, COMMON_OPTS);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:  'payment_status_transition',
        result:  'failure',
        details: expect.objectContaining({
          from:     PAYMENT_STATUS.SUCCESS,
          to:       PAYMENT_STATUS.FAILED,
          rejected: true,
        }),
      })
    );
  });

  test('audit details never contain raw credentials or tokens', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    await transition(payment, PAYMENT_STATUS.FAILED, {
      ...COMMON_OPTS,
      reason: 'testing',
    });

    const call = mockLogAudit.mock.calls[0][0];
    const detailsStr = JSON.stringify(call.details);

    // These strings should never appear in audit details
    expect(detailsStr).not.toMatch(/secret/i);
    expect(detailsStr).not.toMatch(/password/i);
    expect(detailsStr).not.toMatch(/token/i);
    expect(detailsStr).not.toMatch(/privateKey/i);
  });

  test('includes ipAddress and userAgent in audit entry', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    await transition(payment, PAYMENT_STATUS.FAILED, COMMON_OPTS);

    const call = mockLogAudit.mock.calls[0][0];
    expect(call.ipAddress).toBe('127.0.0.1');
    expect(call.userAgent).toBe('jest');
  });

  test('uses "unknown" performedBy when not provided', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING);
    await transition(payment, PAYMENT_STATUS.FAILED, {
      reason:   'test',
      schoolId: 'SCH001',
    });

    const call = mockLogAudit.mock.calls[0][0];
    expect(call.performedBy).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// transitionByHash
// ─────────────────────────────────────────────────────────────────────────────

describe('paymentTransitionService.transitionByHash', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns NOT_FOUND when payment does not exist', async () => {
    const MockPayment = { findOne: jest.fn().mockResolvedValue(null) };
    const result = await transitionByHash(MockPayment, 'deadbeef', PAYMENT_STATUS.FAILED, {
      ...COMMON_OPTS,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });

  test('delegates to transition() when payment is found', async () => {
    const payment = makePayment(PAYMENT_STATUS.PENDING, 'deadbeef');
    const MockPayment = { findOne: jest.fn().mockResolvedValue(payment) };

    const result = await transitionByHash(MockPayment, 'deadbeef', PAYMENT_STATUS.FAILED, COMMON_OPTS);

    expect(result.ok).toBe(true);
    expect(payment.status).toBe(PAYMENT_STATUS.FAILED);
  });
});
