'use strict';

/**
 * Unit tests for stellarService.pollForLedgerInclusion — the ledger finality
 * polling loop that enforces SUBMITTED → SUCCESS/FAILED state transitions.
 *
 * Uses the same pure-stub approach as blockchainFinalityPolicy.test.js:
 * stellarConfig is fully mocked so no real Horizon calls or DB access happens.
 *
 * Covers:
 *   1. Resolves SUCCESS when tx appears confirmed on first poll.
 *   2. Resolves FAILED/TX_FAILED_ON_CHAIN when tx.successful===false.
 *   3. Retries on NOT_FOUND and resolves SUCCESS once tx appears.
 *   4. Resolves FAILED/FINALITY_TIMEOUT when deadline expires.
 *   5. Resolves FAILED/STELLAR_NETWORK_ERROR when only Horizon errors occur.
 *   6. Recovers from a transient Horizon error and resolves SUCCESS.
 *   7. Keeps polling while depth is below the confirmation threshold.
 */

// Must be set before any module that pulls in config/index.js
process.env.MONGO_URI  = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'poll-finality-test-secret-root';

// Short timeouts so tests finish in < 100 ms
process.env.FINALITY_POLL_TIMEOUT_MS       = '40';
process.env.FINALITY_POLL_INITIAL_DELAY_MS = '1';
process.env.FINALITY_POLL_MAX_DELAY_MS     = '5';

// ── Stellar SDK stub (virtual:true because it lives in backend/node_modules) ─
// stellarService requires Operation._fromXDRAmount at load time for normalizeAmount.
jest.mock('@stellar/stellar-sdk', () => ({
  Operation: {
    _fromXDRAmount: (stroops) => (parseInt(stroops, 10) / 1e7).toFixed(7),
    payment: jest.fn(),
  },
  Horizon: { Server: jest.fn().mockImplementation(() => ({})) },
  Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
  Asset: { native: jest.fn(() => ({ isNative: () => true, code: 'XLM', type: 'native' })) },
  StrKey: { isValidEd25519PublicKey: () => true },
  Transaction: jest.fn(),
}), { virtual: true });

// ── Controllable Horizon mock ────────────────────────────────────────────────

// We keep mutable references that individual tests can override.
let _txResponse = null;   // null → throw; object → resolve
let _txError    = null;   // truthy → throw this error
let _latestLedger = 1010;

const mockTxCall     = jest.fn(() => {
  if (_txError)    throw _txError;
  if (_txResponse) return Promise.resolve(_txResponse);
  return Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' }));
});
const mockLedgerCall = jest.fn(() =>
  Promise.resolve({ records: [{ sequence: _latestLedger }] }),
);

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({ transaction: () => ({ call: mockTxCall }) }),
    ledgers: () => ({ order: () => ({ limit: () => ({ call: mockLedgerCall }) }) }),
  },
  horizonClient: { call: jest.fn() },
  networkPassphrase: 'Test SDF Network ; September 2015',
  SCHOOL_WALLET: null,
  StellarSdk: {},
  ACCEPTED_ASSETS: { XLM: { code: 'XLM', type: 'native', issuer: null } },
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 10,
  isAcceptedAsset: () => ({ accepted: true }),
  resolveAsset: jest.fn(),
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30000,
  CB_HALF_OPEN_SUCCESS_THRESHOLD: 2,
}));

// horizonFailoverClient is loaded transitively by stellarConfig's real file
// but is superseded by the mock above — stub it to prevent resolution errors.
jest.mock('../backend/src/services/horizonFailoverClient', () => ({
  getInstance: () => ({ server: {}, call: jest.fn() }),
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30000,
  CB_HALF_OPEN_SUCCESS_THRESHOLD: 2,
}));

// withStellarRetry: bypass retry logic — call fn once and propagate errors.
jest.mock('../backend/src/utils/withStellarRetry', () => ({
  withStellarRetry: (fn) => fn(),
  isTransient: jest.fn(),
  classifyHorizonError: jest.fn((e) => e),
}));

// Stub all DB models stellarService imports at the top level
jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn(),
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../backend/src/models/studentModel', () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/paymentIntentModel', () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/services/transactionService', () => ({ savePayment: jest.fn() }));
jest.mock('../backend/src/services/distributedLock', () => ({
  acquire: jest.fn(),
  release: jest.fn(),
  studentBalanceLockKey: jest.fn((s, id) => `lock:${s}:${id}`),
}));
jest.mock('../backend/src/services/feeAdjustmentEngine', () => ({
  getEngineForSchool: jest.fn(() => ({
    calculateFee: jest.fn(() => ({ finalFee: 100, adjustments: [], effectiveRate: 1 })),
  })),
}));
jest.mock('../backend/src/utils/paymentLimits', () => ({
  validatePaymentAmount: jest.fn(async () => ({ valid: true })),
}));

// ── Subject under test ───────────────────────────────────────────────────────

const { pollForLedgerInclusion } = require('../backend/src/services/stellarService');
const { PAYMENT_FAILURE_REASONS } = require('../backend/src/constants/paymentStatus');
const { CONFIRMATION_STATES } = require('../backend/src/services/paymentConfirmationStateMachine');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePaymentDoc(overrides = {}) {
  return {
    schoolId: 'SCH-TEST',
    studentId: 'STU001',
    confirmationState: CONFIRMATION_STATES.DETECTED,
    isSuspicious: false,
    ...overrides,
  };
}

function confirmedTx(ledger = 1004) {
  return { successful: true, ledger_attr: ledger, ledger };
}

function mkErr(code, msg) {
  return Object.assign(new Error(msg || code), { code });
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _txResponse   = null;
  _txError      = null;
  _latestLedger = 1010;
  mockTxCall.mockClear();
  mockLedgerCall.mockClear();
  // Re-wire to use the module-level variables (closure)
  mockTxCall.mockImplementation(() => {
    if (_txError)    throw _txError;
    if (_txResponse) return Promise.resolve(_txResponse);
    return Promise.reject(mkErr('NOT_FOUND'));
  });
  mockLedgerCall.mockImplementation(() =>
    Promise.resolve({ records: [{ sequence: _latestLedger }] }),
  );
});

describe('pollForLedgerInclusion', () => {

  // 1. Happy path — confirmed on first poll
  it('resolves SUCCESS when tx appears confirmed on first poll', async () => {
    _txResponse = confirmedTx(1004);

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'abc123', {
      timeoutMs: 2000, initialDelayMs: 1, maxDelayMs: 2,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.failureReason).toBeNull();
    expect(result.ledger).toBe(1004);
    expect([CONFIRMATION_STATES.CONFIRMED, CONFIRMATION_STATES.FINALIZED])
      .toContain(result.confirmationState);
  });

  // 2. On-chain failure — tx.successful === false
  it('resolves FAILED/TX_FAILED_ON_CHAIN immediately when tx fails on-chain', async () => {
    _txResponse = { successful: false, ledger_attr: 999, ledger: 999 };

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'badhash', {
      timeoutMs: 2000, initialDelayMs: 1, maxDelayMs: 2,
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toBe(PAYMENT_FAILURE_REASONS.TX_FAILED_ON_CHAIN);
    expect(result.confirmationState).toBe(CONFIRMATION_STATES.FAILED);
    expect(result.confirmationStatus).toBe('failed');
  });

  // 3. NOT_FOUND then confirmed — retries correctly
  it('retries on NOT_FOUND and resolves SUCCESS once the tx appears', async () => {
    let calls = 0;
    mockTxCall.mockImplementation(() => {
      calls++;
      if (calls < 3) return Promise.reject(mkErr('NOT_FOUND'));
      return Promise.resolve(confirmedTx(1005));
    });

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'abc123', {
      timeoutMs: 5000, initialDelayMs: 1, maxDelayMs: 2,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.failureReason).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  // 4. Timeout — FINALITY_TIMEOUT
  it('resolves FAILED/FINALITY_TIMEOUT when the deadline expires before confirmation', async () => {
    // Always NOT_FOUND — never confirms
    mockTxCall.mockRejectedValue(mkErr('NOT_FOUND'));

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'abc123', {
      timeoutMs: 20, initialDelayMs: 1, maxDelayMs: 3,
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toBe(PAYMENT_FAILURE_REASONS.FINALITY_TIMEOUT);
    expect(result.confirmationState).toBe(CONFIRMATION_STATES.FAILED);
    expect(result.confirmationStatus).toBe('failed');
  });

  // 5. Sustained Horizon errors → STELLAR_NETWORK_ERROR
  it('resolves FAILED/STELLAR_NETWORK_ERROR when only Horizon errors occur', async () => {
    mockTxCall.mockRejectedValue(mkErr('HORIZON_UNAVAILABLE'));

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'abc123', {
      timeoutMs: 20, initialDelayMs: 1, maxDelayMs: 3,
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toBe(PAYMENT_FAILURE_REASONS.STELLAR_NETWORK_ERROR);
  });

  // 6. Transient Horizon error then recovery → SUCCESS
  it('recovers from a transient Horizon error and resolves SUCCESS on the next attempt', async () => {
    let calls = 0;
    mockTxCall.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(mkErr('HORIZON_UNAVAILABLE'));
      return Promise.resolve(confirmedTx(1003));
    });

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'abc123', {
      timeoutMs: 5000, initialDelayMs: 1, maxDelayMs: 2,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.failureReason).toBeNull();
  });

  // 7. Ledger depth below threshold on first response, confirmed on second
  it('keeps polling while depth is below CONFIRMATION_THRESHOLD and resolves SUCCESS once met', async () => {
    _txResponse = confirmedTx(1000);  // tx exists at ledger 1000
    let ledgerCalls = 0;
    mockLedgerCall.mockImplementation(() => {
      ledgerCalls++;
      // First check: depth 1 (below threshold 2) → pending
      // Second check: depth 4 → confirmed
      const seq = ledgerCalls === 1 ? 1001 : 1004;
      return Promise.resolve({ records: [{ sequence: seq }] });
    });

    const result = await pollForLedgerInclusion(makePaymentDoc(), 'abc123', {
      timeoutMs: 5000, initialDelayMs: 1, maxDelayMs: 2,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.failureReason).toBeNull();
  });
});
