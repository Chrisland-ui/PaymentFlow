'use strict';

/**
 * Tests for the blockchain finality policy — Issue #62.
 *
 * Verifies:
 *   1. Correct state transitions through the full lifecycle
 *   2. User-facing statuses never claim finality prematurely (detected/pending → not settled)
 *   3. Delayed confirmation / timeout detection
 *   4. Suspicious payments immediately fail
 *   5. Network error hold behaviour (latestLedger = null → keep current state)
 *   6. The same policy constants are used regardless of which path calls them
 *
 * Pure unit tests — no DB, no real Horizon access.
 */

// Provide the minimum env vars the config loader needs before any require
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-secret-for-finality-policy-tests-only';

// Stub stellarConfig so we don't need a real Stellar network
jest.mock('../backend/src/config/stellarConfig', () => ({
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 10,
  server: {},
  horizonClient: { call: jest.fn() },
  networkPassphrase: 'Test SDF Network ; September 2015',
  SCHOOL_WALLET: null,
  StellarSdk: {},
  ACCEPTED_ASSETS: {},
  isAcceptedAsset: jest.fn(),
  resolveAsset: jest.fn(),
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30000,
  CB_HALF_OPEN_SUCCESS_THRESHOLD: 2,
}));

const {
  FINALITY_POLICY,
  FINALITY_TIMEOUT_MS,
  evaluatePaymentFinality,
  isFinalityTimeout,
  shouldTrustStatus,
} = require('../backend/src/services/blockchainFinalityPolicy');

const { CONFIRMATION_STATES } = require('../backend/src/services/paymentConfirmationStateMachine');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal payment object */
function makePayment(overrides = {}) {
  return {
    confirmationState: null,
    ledger: null,
    isSuspicious: false,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FINALITY_POLICY shape
// ---------------------------------------------------------------------------

describe('FINALITY_POLICY', () => {
  it('exposes confirmationThreshold', () => {
    expect(FINALITY_POLICY.confirmationThreshold).toBe(2);
  });

  it('exposes finalizationThreshold', () => {
    expect(FINALITY_POLICY.finalizationThreshold).toBe(10);
  });

  it('has a positive timeoutMs', () => {
    expect(FINALITY_POLICY.timeoutMs).toBeGreaterThan(0);
  });

  it('networkErrorBehavior is "hold"', () => {
    expect(FINALITY_POLICY.networkErrorBehavior).toBe('hold');
  });

  it('reorgBehavior is "recheck"', () => {
    expect(FINALITY_POLICY.reorgBehavior).toBe('recheck');
  });

  it('FINALITY_TIMEOUT_MS matches policy timeoutMs', () => {
    expect(FINALITY_TIMEOUT_MS).toBe(FINALITY_POLICY.timeoutMs);
  });
});

// ---------------------------------------------------------------------------
// evaluatePaymentFinality — state transitions
// ---------------------------------------------------------------------------

describe('evaluatePaymentFinality — state transitions', () => {
  const CT = 2;   // confirmationThreshold
  const FT = 10;  // finalizationThreshold

  it('returns detected when payment has no ledger info', () => {
    const result = evaluatePaymentFinality(makePayment(), 1000);
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.DETECTED);
    expect(result.isSettled).toBe(false);
    expect(result.legacyStatus).toBe('pending_confirmation');
  });

  it('returns pending when depth is 1 (below confirmationThreshold)', () => {
    const result = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }),
      1001, // depth = 1
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.PENDING);
    expect(result.isSettled).toBe(false);
    expect(result.legacyStatus).toBe('pending_confirmation');
  });

  it('returns confirmed when depth meets confirmationThreshold', () => {
    const result = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }),
      1000 + CT, // depth = 2
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(result.isSettled).toBe(true);
    expect(result.legacyStatus).toBe('confirmed');
  });

  it('returns finalized when depth meets finalizationThreshold', () => {
    const result = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }),
      1000 + FT, // depth = 10
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.FINALIZED);
    expect(result.isSettled).toBe(true);
    expect(result.legacyStatus).toBe('confirmed');
    expect(result.isTerminal).toBe(true);
  });

  it('can skip from detected straight to confirmed on first observation deep in chain', () => {
    const result = evaluatePaymentFinality(
      makePayment({ confirmationState: null, ledger: 900 }),
      905, // depth = 5, above CT but below FT
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(result.isSettled).toBe(true);
    expect(result.changed).toBe(true);
  });

  it('can skip from detected straight to finalized on first observation very deep', () => {
    const result = evaluatePaymentFinality(
      makePayment({ confirmationState: null, ledger: 900 }),
      920, // depth = 20, above FT
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.FINALIZED);
    expect(result.isSettled).toBe(true);
  });

  it('re-polling the same ledger range is a no-op (idempotent)', () => {
    const payment = makePayment({ confirmationState: CONFIRMATION_STATES.CONFIRMED, ledger: 1000 });
    const first = evaluatePaymentFinality(payment, 1002);
    const second = evaluatePaymentFinality({ ...payment, confirmationState: first.fineGrainedState }, 1002);
    expect(second.changed).toBe(false);
    expect(second.fineGrainedState).toBe(CONFIRMATION_STATES.CONFIRMED);
  });

  it('never regresses — stale Horizon replica reporting lower ledger is a no-op', () => {
    const confirmed = makePayment({ confirmationState: CONFIRMATION_STATES.CONFIRMED, ledger: 1000 });
    // Simulate ledger sequence going backwards (stale replica)
    const result = evaluatePaymentFinality(confirmed, 1001); // depth=1, below CT
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePaymentFinality — user-facing status never claims finality prematurely
// ---------------------------------------------------------------------------

describe('evaluatePaymentFinality — no premature finality claims', () => {
  it('detected state: isSettled is false', () => {
    const { isSettled, legacyStatus } = evaluatePaymentFinality(makePayment(), 1000);
    expect(isSettled).toBe(false);
    expect(legacyStatus).not.toBe('confirmed');
  });

  it('pending state: isSettled is false', () => {
    const { isSettled, legacyStatus } = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }), 1001,
    );
    expect(isSettled).toBe(false);
    expect(legacyStatus).not.toBe('confirmed');
  });

  it('shouldRetry is true for detected/pending (not yet settled, not terminal)', () => {
    const detected = evaluatePaymentFinality(makePayment(), 1000);
    expect(detected.shouldRetry).toBe(true);

    const pending = evaluatePaymentFinality(makePayment({ ledger: 1000 }), 1001);
    expect(pending.shouldRetry).toBe(true);
  });

  it('shouldRetry is false once confirmed (already settled)', () => {
    const { shouldRetry } = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }), 1002,
    );
    expect(shouldRetry).toBe(false);
  });

  it('shouldRetry is false once finalized (terminal)', () => {
    const { shouldRetry } = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }), 1010,
    );
    expect(shouldRetry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePaymentFinality — suspicious payments
// ---------------------------------------------------------------------------

describe('evaluatePaymentFinality — suspicious payments', () => {
  it('immediately returns failed for a suspicious payment regardless of depth', () => {
    const result = evaluatePaymentFinality(
      makePayment({ ledger: 1000, isSuspicious: true }),
      1020, // deeply confirmed otherwise
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.FAILED);
    expect(result.legacyStatus).toBe('failed');
    expect(result.isSettled).toBe(false);
    expect(result.isTerminal).toBe(true);
    expect(result.shouldRetry).toBe(false);
  });

  it('failed state is terminal — re-evaluating does not change it', () => {
    const payment = makePayment({
      ledger: 1000,
      confirmationState: CONFIRMATION_STATES.FAILED,
    });
    const result = evaluatePaymentFinality(payment, 9999);
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.FAILED);
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePaymentFinality — network error / hold policy
// ---------------------------------------------------------------------------

describe('evaluatePaymentFinality — network error hold behaviour', () => {
  it('keeps current state when latestLedgerSequence is null (Horizon unreachable)', () => {
    const result = evaluatePaymentFinality(
      makePayment({ confirmationState: CONFIRMATION_STATES.PENDING, ledger: 1000 }),
      null,
    );
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.PENDING);
    expect(result.changed).toBe(false);
  });

  it('keeps detected state when latestLedgerSequence is undefined', () => {
    const result = evaluatePaymentFinality(makePayment(), undefined);
    expect(result.fineGrainedState).toBe(CONFIRMATION_STATES.DETECTED);
    expect(result.isSettled).toBe(false);
  });

  it('does not fail the payment on a network error', () => {
    const result = evaluatePaymentFinality(
      makePayment({ ledger: 1000 }),
      null,
    );
    expect(result.fineGrainedState).not.toBe(CONFIRMATION_STATES.FAILED);
  });
});

// ---------------------------------------------------------------------------
// isFinalityTimeout — delayed confirmation detection
// ---------------------------------------------------------------------------

describe('isFinalityTimeout', () => {
  it('returns false for a freshly created payment in detected state', () => {
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.DETECTED,
      createdAt: new Date(),
    });
    expect(isFinalityTimeout(payment)).toBe(false);
  });

  it('returns false for a freshly created payment in pending state', () => {
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.PENDING,
      createdAt: new Date(),
    });
    expect(isFinalityTimeout(payment)).toBe(false);
  });

  it('returns true for a detected payment older than FINALITY_TIMEOUT_MS', () => {
    const oldDate = new Date(Date.now() - FINALITY_TIMEOUT_MS - 1000);
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.DETECTED,
      createdAt: oldDate,
    });
    expect(isFinalityTimeout(payment)).toBe(true);
  });

  it('returns true for a pending payment older than FINALITY_TIMEOUT_MS', () => {
    const oldDate = new Date(Date.now() - FINALITY_TIMEOUT_MS - 5000);
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.PENDING,
      createdAt: oldDate,
    });
    expect(isFinalityTimeout(payment)).toBe(true);
  });

  it('returns false for a confirmed payment even if very old', () => {
    const veryOld = new Date(0); // epoch
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.CONFIRMED,
      createdAt: veryOld,
    });
    expect(isFinalityTimeout(payment)).toBe(false);
  });

  it('returns false for a finalized payment', () => {
    const veryOld = new Date(0);
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.FINALIZED,
      createdAt: veryOld,
    });
    expect(isFinalityTimeout(payment)).toBe(false);
  });

  it('returns false for a failed payment', () => {
    const veryOld = new Date(0);
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.FAILED,
      createdAt: veryOld,
    });
    expect(isFinalityTimeout(payment)).toBe(false);
  });

  it('returns false when createdAt is null', () => {
    const payment = makePayment({
      confirmationState: CONFIRMATION_STATES.DETECTED,
      createdAt: null,
    });
    expect(isFinalityTimeout(payment)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldTrustStatus — never shows unconfirmed state as settled
// ---------------------------------------------------------------------------

describe('shouldTrustStatus', () => {
  it('returns false for detected', () => {
    expect(shouldTrustStatus(CONFIRMATION_STATES.DETECTED)).toBe(false);
  });

  it('returns false for pending', () => {
    expect(shouldTrustStatus(CONFIRMATION_STATES.PENDING)).toBe(false);
  });

  it('returns true for confirmed', () => {
    expect(shouldTrustStatus(CONFIRMATION_STATES.CONFIRMED)).toBe(true);
  });

  it('returns true for finalized', () => {
    expect(shouldTrustStatus(CONFIRMATION_STATES.FINALIZED)).toBe(true);
  });

  it('returns false for failed (not settled)', () => {
    expect(shouldTrustStatus(CONFIRMATION_STATES.FAILED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy consistency — same constants used everywhere
// ---------------------------------------------------------------------------

describe('Policy consistency', () => {
  it('confirmationThreshold from FINALITY_POLICY matches stellarConfig', () => {
    const { CONFIRMATION_THRESHOLD } = require('../backend/src/config/stellarConfig');
    expect(FINALITY_POLICY.confirmationThreshold).toBe(CONFIRMATION_THRESHOLD);
  });

  it('finalizationThreshold from FINALITY_POLICY matches stellarConfig', () => {
    const { FINALIZATION_THRESHOLD } = require('../backend/src/config/stellarConfig');
    expect(FINALITY_POLICY.finalizationThreshold).toBe(FINALIZATION_THRESHOLD);
  });

  it('FINALIZATION_THRESHOLD is always >= CONFIRMATION_THRESHOLD', () => {
    expect(FINALITY_POLICY.finalizationThreshold).toBeGreaterThanOrEqual(
      FINALITY_POLICY.confirmationThreshold,
    );
  });
});
