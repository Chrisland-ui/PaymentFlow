'use strict';

/**
 * Tests for the paymentStatus constants — specifically the additions made
 * for the SUBMITTED intermediate status and ledger finality polling.
 *
 * Covers:
 *   1. SUBMITTED → SUCCESS is now an allowed transition (normal path).
 *   2. SUBMITTED → FAILED is still allowed (timeout / on-chain failure path).
 *   3. SUBMITTED → SUCCESS is allowed via admin override.
 *   4. PAYMENT_FAILURE_REASONS is exported and contains expected keys.
 *   5. isTransitionAllowed returns correct results for the new transitions.
 */

// Minimum env required by the module (config is not loaded here, but jest
// module resolution may pull in transitive deps that need it)
process.env.MONGO_URI  = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'payment-status-test-secret';

const {
  PAYMENT_STATUS,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  PAYMENT_FAILURE_REASONS,
  isTransitionAllowed,
} = require('../backend/src/constants/paymentStatus');

describe('PAYMENT_STATUS_TRANSITIONS — SUBMITTED', () => {
  it('includes SUCCESS as a valid target from SUBMITTED', () => {
    const targets = PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.SUBMITTED] || [];
    expect(targets).toContain(PAYMENT_STATUS.SUCCESS);
  });

  it('includes FAILED as a valid target from SUBMITTED', () => {
    const targets = PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.SUBMITTED] || [];
    expect(targets).toContain(PAYMENT_STATUS.FAILED);
  });

  it('does not allow DISPUTED as a target from SUBMITTED', () => {
    const targets = PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.SUBMITTED] || [];
    expect(targets).not.toContain(PAYMENT_STATUS.DISPUTED);
  });
});

describe('ADMIN_PAYMENT_STATUS_TRANSITIONS — SUBMITTED', () => {
  it('includes SUCCESS as a valid admin target from SUBMITTED', () => {
    const targets = ADMIN_PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.SUBMITTED] || [];
    expect(targets).toContain(PAYMENT_STATUS.SUCCESS);
  });

  it('includes FAILED as a valid admin target from SUBMITTED', () => {
    const targets = ADMIN_PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.SUBMITTED] || [];
    expect(targets).toContain(PAYMENT_STATUS.FAILED);
  });
});

describe('isTransitionAllowed — SUBMITTED', () => {
  it('allows SUBMITTED → SUCCESS (normal path)', () => {
    expect(isTransitionAllowed('SUBMITTED', 'SUCCESS')).toBe(true);
  });

  it('allows SUBMITTED → FAILED (timeout / on-chain failure path)', () => {
    expect(isTransitionAllowed('SUBMITTED', 'FAILED')).toBe(true);
  });

  it('rejects SUBMITTED → DISPUTED', () => {
    expect(isTransitionAllowed('SUBMITTED', 'DISPUTED')).toBe(false);
  });

  it('rejects SUBMITTED → PENDING (backwards move)', () => {
    expect(isTransitionAllowed('SUBMITTED', 'PENDING')).toBe(false);
  });

  it('allows SUBMITTED → SUCCESS with admin override', () => {
    expect(isTransitionAllowed('SUBMITTED', 'SUCCESS', true)).toBe(true);
  });

  it('allows SUBMITTED → FAILED with admin override', () => {
    expect(isTransitionAllowed('SUBMITTED', 'FAILED', true)).toBe(true);
  });
});

describe('PAYMENT_FAILURE_REASONS', () => {
  it('is exported from paymentStatus', () => {
    expect(PAYMENT_FAILURE_REASONS).toBeDefined();
    expect(typeof PAYMENT_FAILURE_REASONS).toBe('object');
  });

  it('contains FINALITY_TIMEOUT', () => {
    expect(PAYMENT_FAILURE_REASONS.FINALITY_TIMEOUT).toBe('FINALITY_TIMEOUT');
  });

  it('contains TX_FAILED_ON_CHAIN', () => {
    expect(PAYMENT_FAILURE_REASONS.TX_FAILED_ON_CHAIN).toBe('TX_FAILED_ON_CHAIN');
  });

  it('contains STELLAR_NETWORK_ERROR', () => {
    expect(PAYMENT_FAILURE_REASONS.STELLAR_NETWORK_ERROR).toBe('STELLAR_NETWORK_ERROR');
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(PAYMENT_FAILURE_REASONS)).toBe(true);
  });

  it('values are non-empty strings', () => {
    for (const val of Object.values(PAYMENT_FAILURE_REASONS)) {
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
  });
});
