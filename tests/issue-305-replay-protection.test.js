'use strict';

/**
 * Tests for Issue #305 — Add replay protection for all contract instruction invocations.
 *
 * Covers:
 *  1. First invocation with nonce=0 is accepted.
 *  2. Replaying the same nonce returns NONCE_ALREADY_USED.
 *  3. An out-of-order (future) nonce is rejected with NONCE_OUT_OF_ORDER.
 *  4. Each operation type has its own independent counter.
 *  5. Each school has its own independent counter.
 *  6. getExpectedNonce always returns the next un-used value.
 *  7. Nonce overflow wraps safely back to 0.
 *  8. Unknown operation types throw at the API boundary.
 *  9. Replay-attack scenario: re-submitting a valid envelope is rejected.
 * 10. Nonce reset (admin disaster-recovery) brings counter back to 0.
 */

const {
  OPERATION_TYPES,
  NonceManager,
  InMemoryNonceStore,
  resetNonceManager,
} = require('../backend/src/services/contractNonce');

// ── Shared fixture ─────────────────────────────────────────────────────────────

const SCHOOL_A = 'sch-001';
const SCHOOL_B = 'sch-002';
const OP = OPERATION_TYPES.RELEASE_ESCROW;

/** Return a fresh NonceManager for each test suite. */
function freshManager() {
  return new NonceManager(new InMemoryNonceStore());
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. First-use: nonce 0 is accepted
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — replay protection: first-use nonce', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('initial expected nonce is 0', async () => {
    const n = await nm.getExpectedNonce(SCHOOL_A, OP);
    expect(n).toBe(0);
  });

  test('nonce 0 is accepted on first invocation', async () => {
    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0);
    expect(result.accepted).toBe(true);
    expect(result.nextNonce).toBe(1);
  });

  test('after first invocation, expected nonce advances to 1', async () => {
    await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0);
    expect(await nm.getExpectedNonce(SCHOOL_A, OP)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Replay attack: same nonce rejected with NONCE_ALREADY_USED
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — replay attack: resubmitting a consumed nonce', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('replaying nonce 0 after it was consumed returns NONCE_ALREADY_USED', async () => {
    await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0); // consume it
    const replay = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0); // replay

    expect(replay.accepted).toBe(false);
    expect(replay.reason).toBe('NONCE_ALREADY_USED');
    expect(replay.expected).toBe(1);
    expect(replay.supplied).toBe(0);
  });

  test('replaying any previously-used nonce is rejected', async () => {
    // Advance the counter to 5.
    for (let i = 0; i < 5; i++) {
      await nm.verifyAndConsumeNonce(SCHOOL_A, OP, i);
    }
    // Attempt to replay nonces 0–4.
    for (let nonce = 0; nonce < 5; nonce++) {
      const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, nonce);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('NONCE_ALREADY_USED');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Out-of-order nonce rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — out-of-order nonce', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('skipping ahead to nonce 5 is rejected with NONCE_OUT_OF_ORDER', async () => {
    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 5);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('NONCE_OUT_OF_ORDER');
    expect(result.expected).toBe(0);
    expect(result.supplied).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Per-operation-type isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — per-operation-type nonce isolation', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('RELEASE_ESCROW and REFUND_ESCROW have independent counters', async () => {
    // Advance RELEASE_ESCROW twice.
    await nm.verifyAndConsumeNonce(SCHOOL_A, OPERATION_TYPES.RELEASE_ESCROW, 0);
    await nm.verifyAndConsumeNonce(SCHOOL_A, OPERATION_TYPES.RELEASE_ESCROW, 1);

    // REFUND_ESCROW counter must still be at 0.
    const refundNonce = await nm.getExpectedNonce(SCHOOL_A, OPERATION_TYPES.REFUND_ESCROW);
    expect(refundNonce).toBe(0);
  });

  test('all OPERATION_TYPES start at 0 independently', async () => {
    for (const opType of Object.values(OPERATION_TYPES)) {
      const n = await nm.getExpectedNonce(SCHOOL_A, opType);
      expect(n).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Per-school isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — per-school nonce isolation', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('advancing school A nonce does not affect school B nonce', async () => {
    await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0);
    await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 1);

    const schoolBNonce = await nm.getExpectedNonce(SCHOOL_B, OP);
    expect(schoolBNonce).toBe(0);
  });

  test('school B can start its own sequence independently', async () => {
    await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0); // advance A
    const result = await nm.verifyAndConsumeNonce(SCHOOL_B, OP, 0); // B starts fresh
    expect(result.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. getExpectedNonce consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — getExpectedNonce is the client query interface', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('getExpectedNonce tracks the counter across multiple operations', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await nm.getExpectedNonce(SCHOOL_A, OP)).toBe(i);
      await nm.verifyAndConsumeNonce(SCHOOL_A, OP, i);
    }
    expect(await nm.getExpectedNonce(SCHOOL_A, OP)).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Overflow handling
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — nonce overflow wraps safely', () => {
  test('nonce at MAX_SAFE_INTEGER wraps to 0', async () => {
    // Inject a store pre-seeded at MAX_SAFE_INTEGER.
    const store = new InMemoryNonceStore();
    await store.set(SCHOOL_A, OP, Number.MAX_SAFE_INTEGER);
    const nm = new NonceManager(store);

    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, Number.MAX_SAFE_INTEGER);
    expect(result.accepted).toBe(true);
    expect(result.nextNonce).toBe(0); // wraps around

    const next = await nm.getExpectedNonce(SCHOOL_A, OP);
    expect(next).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Unknown operation types throw at the API boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — unknown operation type is rejected at the API', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('getExpectedNonce throws for unknown operationType', async () => {
    await expect(nm.getExpectedNonce(SCHOOL_A, 'MALICIOUS_OP')).rejects.toThrow(/unknown/i);
  });

  test('verifyAndConsumeNonce throws for unknown operationType', async () => {
    await expect(nm.verifyAndConsumeNonce(SCHOOL_A, 'FAKE_OP', 0)).rejects.toThrow(/unknown/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Replay attack simulation: re-submitting a "release escrow" envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — replay attack scenario: re-submitting a release-escrow envelope', () => {
  test('captured release-escrow envelope cannot be resubmitted', async () => {
    const nm = freshManager();

    // Step 1: client queries the nonce before signing.
    const capturedNonce = await nm.getExpectedNonce(SCHOOL_A, OPERATION_TYPES.RELEASE_ESCROW);
    expect(capturedNonce).toBe(0);

    // Step 2: legitimate release — backend verifies and advances the nonce.
    const legitimateRelease = await nm.verifyAndConsumeNonce(
      SCHOOL_A, OPERATION_TYPES.RELEASE_ESCROW, capturedNonce,
    );
    expect(legitimateRelease.accepted).toBe(true);

    // Step 3: attacker replays the captured envelope.
    const replayAttempt = await nm.verifyAndConsumeNonce(
      SCHOOL_A, OPERATION_TYPES.RELEASE_ESCROW, capturedNonce,
    );
    expect(replayAttempt.accepted).toBe(false);
    expect(replayAttempt.reason).toBe('NONCE_ALREADY_USED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Admin nonce reset
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — admin nonce reset (disaster-recovery)', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('resetNonce brings counter back to 0 after advancing', async () => {
    // Advance a few times.
    for (let i = 0; i < 5; i++) {
      await nm.verifyAndConsumeNonce(SCHOOL_A, OP, i);
    }
    expect(await nm.getExpectedNonce(SCHOOL_A, OP)).toBe(5);

    // Admin resets.
    await nm.resetNonce(SCHOOL_A, OP);
    expect(await nm.getExpectedNonce(SCHOOL_A, OP)).toBe(0);
  });

  test('after reset, nonce 0 is accepted again', async () => {
    await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0);
    await nm.resetNonce(SCHOOL_A, OP);
    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0);
    expect(result.accepted).toBe(true);
  });

  test('resetNonce throws for unknown operationType', async () => {
    await expect(nm.resetNonce(SCHOOL_A, 'UNKNOWN')).rejects.toThrow(/unknown/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Invalid nonce format
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — invalid nonce format is rejected', () => {
  let nm;
  beforeEach(() => { nm = freshManager(); });

  test('string nonce is rejected with INVALID_NONCE_FORMAT', async () => {
    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, '0');
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_NONCE_FORMAT');
  });

  test('negative nonce is rejected', async () => {
    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, -1);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_NONCE_FORMAT');
  });

  test('floating-point nonce is rejected', async () => {
    const result = await nm.verifyAndConsumeNonce(SCHOOL_A, OP, 0.5);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_NONCE_FORMAT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. resetNonceManager singleton helper
// ─────────────────────────────────────────────────────────────────────────────

describe('#305 — resetNonceManager returns a fresh singleton', () => {
  test('fresh singleton starts all nonces at 0', async () => {
    const nm = resetNonceManager();
    for (const opType of Object.values(OPERATION_TYPES)) {
      expect(await nm.getExpectedNonce(SCHOOL_A, opType)).toBe(0);
    }
  });
});
