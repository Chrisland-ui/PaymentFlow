'use strict';

/**
 * Issue #33 — Provider reconciliation job tests.
 *
 * Tests cover:
 *   1. runProviderReconciliation input validation (date range, order).
 *   2. Idempotency — same jobRunId on re-run; E11000 counted as skipped.
 *   3. Rate-limit handling — 429 / message-based detection; graceful partial result.
 *   4. Discrepancy detection — MISSING_LOCAL, MISSING_ONCHAIN, AMOUNT_MISMATCH.
 *   5. Protected data — Payment/Student never modified.
 *   6. Pagination — listDiscrepancies returns correct page shapes.
 *   7. Review workflow — updateDiscrepancyReview transitions status.
 *   8. Admin controller validation — bad dates, missing fields, oversized range.
 */

jest.mock('../backend/src/services/consistencyService', () => ({
  fetchChainTransactions: jest.fn(),
  checkSchoolConsistency: jest.fn(),
}));
jest.mock('../backend/src/models/schoolModel');
jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/models/discrepancyRecordModel');

const { fetchChainTransactions } = require('../backend/src/services/consistencyService');
const School            = require('../backend/src/models/schoolModel');
const Payment           = require('../backend/src/models/paymentModel');
const DiscrepancyRecord = require('../backend/src/models/discrepancyRecordModel');

const {
  runProviderReconciliation,
  listDiscrepancies,
  updateDiscrepancyReview,
  _buildJobRunId,
} = require('../backend/src/services/providerReconciliationJob');

// ── Test constants ────────────────────────────────────────────────────────────

const SCHOOL_ID   = 'SCH-RECON-TEST';
const WALLET_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const RANGE_START = new Date('2026-05-01T00:00:00.000Z');
const RANGE_END   = new Date('2026-05-07T23:59:59.999Z');

// ── Factories ─────────────────────────────────────────────────────────────────

function makeTx({ hash, amount, memo = null, createdAt = '2026-05-03T10:00:00Z' }) {
  return {
    hash,
    memo_type:  memo ? 'text' : 'none',
    memo,
    created_at: createdAt,
    operations: jest.fn().mockResolvedValue({
      records: [{ type: 'payment', to: WALLET_ADDR, amount: String(amount) }],
    }),
  };
}

function makePayment({ txHash, amount, studentId = 'STU-001', confirmedAt = RANGE_START }) {
  return {
    _id:         { toString: () => `id-${txHash}` },
    txHash,
    amount,
    studentId,
    status:      'SUCCESS',
    schoolId:    SCHOOL_ID,
    confirmedAt,
    deletedAt:   null,
  };
}

/** Set up all mocks for a test scenario. */
function setupMocks({ schoolExists = true, payments = [], chainTxs = [] } = {}) {
  // School
  School.findOne = jest.fn().mockResolvedValue(
    schoolExists ? { schoolId: SCHOOL_ID, stellarAddress: WALLET_ADDR, name: 'Test School' } : null
  );
  School.find = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean:   jest.fn().mockResolvedValue([{ schoolId: SCHOOL_ID }]),
  });

  // Payment.find — first call returns the batch, second returns [] to end pagination
  let callCount = 0;
  Payment.find = jest.fn().mockImplementation(() => ({
    sort:  function () { return this; },
    limit: function () { return this; },
    lean:  jest.fn().mockImplementation(() =>
      Promise.resolve(callCount++ === 0 ? payments : [])
    ),
  }));
  Payment.findOneAndUpdate = jest.fn();
  Payment.updateOne        = jest.fn();

  // Horizon
  fetchChainTransactions.mockResolvedValue(chainTxs);

  // DiscrepancyRecord
  DiscrepancyRecord.create         = jest.fn().mockResolvedValue({ _id: 'dr-1' });
  DiscrepancyRecord.countDocuments = jest.fn().mockResolvedValue(0);
  DiscrepancyRecord.find = jest.fn().mockReturnValue({
    sort:  function () { return this; },
    skip:  function () { return this; },
    limit: function () { return this; },
    lean:  jest.fn().mockResolvedValue([]),
  });
  DiscrepancyRecord.findByIdAndUpdate = jest.fn().mockResolvedValue({
    _id: 'dr-1', reviewStatus: 'reviewed',
  });
}

// ── 1. Input validation ───────────────────────────────────────────────────────

describe('runProviderReconciliation — input validation', () => {
  test('throws TypeError when rangeStart is not a Date', async () => {
    await expect(
      runProviderReconciliation({ rangeStart: '2026-05-01', rangeEnd: new Date() })
    ).rejects.toThrow(TypeError);
  });

  test('throws TypeError when rangeEnd is not a Date', async () => {
    await expect(
      runProviderReconciliation({ rangeStart: new Date(), rangeEnd: '2026-05-07' })
    ).rejects.toThrow(TypeError);
  });

  test('throws RangeError when rangeStart >= rangeEnd', async () => {
    await expect(
      runProviderReconciliation({ rangeStart: RANGE_END, rangeEnd: RANGE_START })
    ).rejects.toThrow(RangeError);
  });

  test('throws RangeError when rangeStart === rangeEnd', async () => {
    const d = new Date();
    await expect(
      runProviderReconciliation({ rangeStart: d, rangeEnd: d })
    ).rejects.toThrow(RangeError);
  });
});

// ── 2. Idempotency ────────────────────────────────────────────────────────────

describe('idempotency', () => {
  test('jobRunId is deterministic for the same schoolId + range', () => {
    const id1 = _buildJobRunId(SCHOOL_ID, RANGE_START, RANGE_END);
    const id2 = _buildJobRunId(SCHOOL_ID, RANGE_START, RANGE_END);
    expect(id1).toBe(id2);
  });

  test('jobRunId differs for different date ranges', () => {
    const id1 = _buildJobRunId(SCHOOL_ID, RANGE_START, RANGE_END);
    const id2 = _buildJobRunId(SCHOOL_ID, RANGE_START, new Date('2026-06-01'));
    expect(id1).not.toBe(id2);
  });

  test('E11000 duplicate key is counted as skippedDuplicate, not an error', async () => {
    const hash = 'a'.repeat(64);
    setupMocks({
      payments: [makePayment({ txHash: hash, amount: 250 })],
      chainTxs: [], // causes MISSING_ONCHAIN
    });
    DiscrepancyRecord.create.mockRejectedValue({ code: 11000 });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.schools[0].skippedDuplicates).toBe(1);
    expect(result.schools[0].discrepanciesFound).toBe(0);
  });
});

// ── 3. Rate-limit handling ────────────────────────────────────────────────────

describe('rate-limit handling', () => {
  test('returns partial result without throwing when Horizon returns 429', async () => {
    setupMocks();
    fetchChainTransactions.mockRejectedValue({ response: { status: 429 } });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.schools[0].rateLimited).toBe(true);
    expect(result.schools[0].discrepanciesFound).toBe(0);
  });

  test('sets rateLimited=true on generic "rate" message', async () => {
    setupMocks();
    fetchChainTransactions.mockRejectedValue(new Error('rate limit exceeded'));

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.schools[0].rateLimited).toBe(true);
  });

  test('non-rate-limit Horizon error returns partial result without throwing', async () => {
    setupMocks();
    fetchChainTransactions.mockRejectedValue(new Error('unexpected server error'));

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.schools[0].discrepanciesFound).toBe(0);
  });
});

// ── 4. Discrepancy detection ──────────────────────────────────────────────────

describe('discrepancy detection', () => {
  test('MISSING_LOCAL: emits discrepancy when on-chain tx has no local Payment', async () => {
    const hash = 'b'.repeat(64);
    setupMocks({
      payments: [],
      chainTxs: [makeTx({ hash, amount: '100', memo: 'STU-001' })],
    });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.totalDiscrepancies).toBe(1);
    const call = DiscrepancyRecord.create.mock.calls[0][0];
    expect(call.discrepancyType).toBe('MISSING_LOCAL');
    expect(call.chainAmount).toBe(100);
  });

  test('MISSING_ONCHAIN: emits discrepancy when local SUCCESS has no on-chain match', async () => {
    const hash = 'c'.repeat(64);
    setupMocks({
      payments: [makePayment({ txHash: hash, amount: 250, studentId: 'STU-002' })],
      chainTxs: [],
    });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.totalDiscrepancies).toBe(1);
    const call = DiscrepancyRecord.create.mock.calls[0][0];
    expect(call.discrepancyType).toBe('MISSING_ONCHAIN');
    expect(call.localAmount).toBe(250);
  });

  test('AMOUNT_MISMATCH: emits discrepancy when amounts differ beyond epsilon', async () => {
    const hash = 'd'.repeat(64);
    setupMocks({
      payments: [makePayment({ txHash: hash, amount: 250 })],
      chainTxs: [makeTx({ hash, amount: '250.001', memo: 'STU-003' })],
    });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.totalDiscrepancies).toBe(1);
    const call = DiscrepancyRecord.create.mock.calls[0][0];
    expect(call.discrepancyType).toBe('AMOUNT_MISMATCH');
  });

  test('no discrepancy when amounts match exactly', async () => {
    const hash = 'e'.repeat(64);
    setupMocks({
      payments: [makePayment({ txHash: hash, amount: 250 })],
      chainTxs: [makeTx({ hash, amount: '250', memo: 'STU-004' })],
    });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.totalDiscrepancies).toBe(0);
    expect(DiscrepancyRecord.create).not.toHaveBeenCalled();
  });

  test('chain txs outside the date window are ignored', async () => {
    const hash = 'f'.repeat(64);
    setupMocks({
      payments: [],
      chainTxs: [makeTx({ hash, amount: '100', memo: 'STU-005', createdAt: '2025-01-01T00:00:00Z' })],
    });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.totalDiscrepancies).toBe(0);
  });

  test('gracefully handles missing school — returns zero discrepancies', async () => {
    setupMocks({ schoolExists: false, chainTxs: [] });

    const result = await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(result.schools[0].discrepanciesFound).toBe(0);
  });
});

// ── 5. Protected financial data ───────────────────────────────────────────────

describe('protected financial data', () => {
  test('Payment.findOneAndUpdate is never called', async () => {
    const hash = 'g'.repeat(64);
    setupMocks({
      payments: [],
      chainTxs: [makeTx({ hash, amount: '100', memo: 'STU-006' })],
    });

    await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(Payment.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('Payment.updateOne is never called', async () => {
    const hash = 'h'.repeat(64);
    setupMocks({
      payments: [],
      chainTxs: [makeTx({ hash, amount: '100', memo: 'STU-007' })],
    });

    await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(Payment.updateOne).not.toHaveBeenCalled();
  });

  test('DiscrepancyRecord.create is the only write operation', async () => {
    const hash = 'i'.repeat(64);
    setupMocks({
      payments: [],
      chainTxs: [makeTx({ hash, amount: '100', memo: 'STU-008' })],
    });

    await runProviderReconciliation({
      schoolId: SCHOOL_ID, rangeStart: RANGE_START, rangeEnd: RANGE_END,
    });
    expect(DiscrepancyRecord.create).toHaveBeenCalledTimes(1);
  });
});

// ── 6. listDiscrepancies pagination ──────────────────────────────────────────

describe('listDiscrepancies', () => {
  test('returns data array and pagination object', async () => {
    setupMocks();
    DiscrepancyRecord.find = jest.fn().mockReturnValue({
      sort:  function () { return this; },
      skip:  function () { return this; },
      limit: function () { return this; },
      lean:  jest.fn().mockResolvedValue([
        { _id: 'dr-1', discrepancyType: 'MISSING_LOCAL', reviewStatus: 'pending' },
      ]),
    });
    DiscrepancyRecord.countDocuments = jest.fn().mockResolvedValue(1);

    const result = await listDiscrepancies({ schoolId: SCHOOL_ID, page: 1, limit: 50 });
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.hasPrev).toBe(false);
    expect(typeof result.pagination.hasNext).toBe('boolean');
  });

  test('hasPrev is true on page 2', async () => {
    setupMocks();
    DiscrepancyRecord.countDocuments = jest.fn().mockResolvedValue(60);

    const result = await listDiscrepancies({ schoolId: SCHOOL_ID, page: 2, limit: 50 });
    expect(result.pagination.hasPrev).toBe(true);
  });
});

// ── 7. Review workflow ────────────────────────────────────────────────────────

describe('updateDiscrepancyReview', () => {
  test('transitions to "reviewed"', async () => {
    setupMocks();
    const updated = await updateDiscrepancyReview({
      id: 'dr-1', reviewStatus: 'reviewed', reviewedBy: 'admin', reviewNote: 'confirmed',
    });
    expect(updated.reviewStatus).toBe('reviewed');
    expect(DiscrepancyRecord.findByIdAndUpdate).toHaveBeenCalledWith(
      'dr-1',
      expect.objectContaining({ reviewStatus: 'reviewed', reviewedBy: 'admin' }),
      expect.any(Object),
    );
  });

  test('transitions to "dismissed"', async () => {
    setupMocks();
    DiscrepancyRecord.findByIdAndUpdate = jest.fn().mockResolvedValue({
      _id: 'dr-1', reviewStatus: 'dismissed',
    });
    const updated = await updateDiscrepancyReview({
      id: 'dr-1', reviewStatus: 'dismissed', reviewedBy: 'admin',
    });
    expect(updated.reviewStatus).toBe('dismissed');
  });

  test('throws on invalid reviewStatus', async () => {
    await expect(
      updateDiscrepancyReview({ id: 'dr-1', reviewStatus: 'approved', reviewedBy: 'admin' })
    ).rejects.toThrow();
  });

  test('throws NOT_FOUND when record is null', async () => {
    setupMocks();
    DiscrepancyRecord.findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    await expect(
      updateDiscrepancyReview({ id: 'nonexistent', reviewStatus: 'reviewed', reviewedBy: 'admin' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ── 8. Admin controller validation ───────────────────────────────────────────

describe('reconciliationAdminController — input validation', () => {
  const { triggerRun } = require('../backend/src/controllers/reconciliationAdminController');

  function makeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json   = jest.fn().mockReturnValue(res);
    return res;
  }

  test('returns 400 when rangeStart is missing', async () => {
    const req = { body: { rangeEnd: '2026-05-07' }, admin: { username: 'admin' }, schoolId: SCHOOL_ID };
    const res = makeRes();
    await triggerRun(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when rangeEnd is missing', async () => {
    const req = { body: { rangeStart: '2026-05-01' }, admin: { username: 'admin' }, schoolId: SCHOOL_ID };
    const res = makeRes();
    await triggerRun(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when rangeStart >= rangeEnd', async () => {
    const req = {
      body: { rangeStart: '2026-05-07', rangeEnd: '2026-05-01' },
      admin: { username: 'admin' },
      schoolId: SCHOOL_ID,
    };
    const res = makeRes();
    await triggerRun(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when range exceeds MAX_RANGE_DAYS', async () => {
    const req = {
      body: {
        rangeStart: '2020-01-01T00:00:00Z',
        rangeEnd:   '2026-01-01T00:00:00Z',
      },
      admin: { username: 'admin' },
      schoolId: SCHOOL_ID,
    };
    const res = makeRes();
    await triggerRun(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('RANGE_TOO_LARGE');
  });
});
