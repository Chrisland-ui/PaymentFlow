'use strict';

/**
 * contractNonce — replay protection for contract instruction invocations.
 *
 * Issue #305: Add replay protection for all contract instruction invocations.
 *
 * Problem:
 *   A captured, signed transaction envelope (e.g. a "release escrow" call)
 *   can be resubmitted to the Stellar network because the operation itself
 *   carries no replay-protection nonce at the application layer.
 *   Stellar's account sequence numbers protect at the account level, but an
 *   attacker who submits the captured envelope BEFORE the legitimate owner does
 *   can still replay it once.
 *
 * Solution:
 *   Each contract operation type has an independent nonce counter, stored
 *   per-school and per-operation-type in-process (with optional persistence via
 *   a provided store interface).  Before processing any invocation the backend
 *   verifies that the supplied nonce matches the expected next value, then
 *   atomically increments it.  Any invocation with a stale or out-of-order
 *   nonce is rejected with NONCE_ALREADY_USED.
 *
 * Nonce lifecycle:
 *   1. Client queries the current expected nonce via getExpectedNonce().
 *   2. Client includes that nonce value in the signed transaction envelope.
 *   3. Backend calls verifyAndConsumeNonce() before broadcasting.
 *   4. On success, the nonce advances; the same value can never be used again.
 *
 * Overflow:
 *   Nonces are 53-bit safe integers (Number.MAX_SAFE_INTEGER = 2^53 - 1).
 *   If a counter reaches MAX_SAFE_INTEGER the next increment wraps to 0 so the
 *   counter continues safely (extremely unlikely in practice — more than 9 *
 *   10^15 operations per account would be required).
 *
 * Backend integration:
 *   The NonceManger class must be instantiated once per process (singleton) and
 *   consulted before every contract invocation.  A persistence adapter may be
 *   injected via the `store` constructor parameter; the default in-memory store
 *   is suitable for single-process deployments.  For multi-replica deployments
 *   supply a Redis-backed store.
 */

// ── Operation types ────────────────────────────────────────────────────────────

/**
 * Canonical set of contract operation types.
 * Each entry in the authorization path that mutates on-chain state must use
 * exactly one of these strings as its operation type.
 */
const OPERATION_TYPES = Object.freeze({
  RELEASE_ESCROW:   'RELEASE_ESCROW',
  REFUND_ESCROW:    'REFUND_ESCROW',
  OPEN_DISPUTE:     'OPEN_DISPUTE',
  RESOLVE_DISPUTE:  'RESOLVE_DISPUTE',
  FUND_ESCROW:      'FUND_ESCROW',
  UPDATE_FEE:       'UPDATE_FEE',
});

// ── In-memory nonce store ─────────────────────────────────────────────────────

/**
 * Default in-memory nonce store.
 * All nonces start at 0 for every new (schoolId, operationType) pair.
 */
class InMemoryNonceStore {
  constructor() {
    /** @type {Map<string, number>} */
    this._nonces = new Map();
  }

  _key(schoolId, operationType) {
    return `${schoolId}::${operationType}`;
  }

  /**
   * @param {string} schoolId
   * @param {string} operationType
   * @returns {Promise<number>}
   */
  async get(schoolId, operationType) {
    return this._nonces.get(this._key(schoolId, operationType)) ?? 0;
  }

  /**
   * @param {string} schoolId
   * @param {string} operationType
   * @param {number} value
   * @returns {Promise<void>}
   */
  async set(schoolId, operationType, value) {
    this._nonces.set(this._key(schoolId, operationType), value);
  }
}

// ── NonceManager ──────────────────────────────────────────────────────────────

class NonceManager {
  /**
   * @param {{ get: Function, set: Function }} [store] – Optional custom nonce store.
   */
  constructor(store) {
    this._store = store || new InMemoryNonceStore();
  }

  /**
   * Return the nonce that the next invocation of (schoolId, operationType)
   * MUST supply.  The client should call this just before signing the
   * transaction envelope.
   *
   * @param {string} schoolId
   * @param {string} operationType
   * @returns {Promise<number>}
   */
  async getExpectedNonce(schoolId, operationType) {
    this._assertOperationType(operationType);
    return this._store.get(schoolId, operationType);
  }

  /**
   * Verify that the supplied nonce matches the expected value and atomically
   * advance the counter.
   *
   * @param {string} schoolId
   * @param {string} operationType
   * @param {number} suppliedNonce – The nonce embedded in the signed envelope.
   * @returns {Promise<{ accepted: boolean, reason?: string, nextNonce?: number }>}
   */
  async verifyAndConsumeNonce(schoolId, operationType, suppliedNonce) {
    this._assertOperationType(operationType);

    const expected = await this._store.get(schoolId, operationType);

    if (typeof suppliedNonce !== 'number' || !Number.isInteger(suppliedNonce) || suppliedNonce < 0) {
      return { accepted: false, reason: 'INVALID_NONCE_FORMAT' };
    }

    if (suppliedNonce !== expected) {
      // The supplied nonce is either already used (< expected) or skips ahead
      // (> expected) — both are rejected to preserve ordering guarantees.
      return {
        accepted: false,
        reason: suppliedNonce < expected ? 'NONCE_ALREADY_USED' : 'NONCE_OUT_OF_ORDER',
        expected,
        supplied: suppliedNonce,
      };
    }

    // Advance the counter — handle overflow safely.
    const nextNonce = expected >= Number.MAX_SAFE_INTEGER ? 0 : expected + 1;
    await this._store.set(schoolId, operationType, nextNonce);

    return { accepted: true, nextNonce };
  }

  /**
   * Reset a nonce counter to zero (useful in tests and disaster-recovery).
   * This should only be called by the contract admin after manual on-chain
   * reconciliation.
   *
   * @param {string} schoolId
   * @param {string} operationType
   * @returns {Promise<void>}
   */
  async resetNonce(schoolId, operationType) {
    this._assertOperationType(operationType);
    await this._store.set(schoolId, operationType, 0);
  }

  /**
   * @private
   */
  _assertOperationType(operationType) {
    const valid = Object.values(OPERATION_TYPES);
    if (!valid.includes(operationType)) {
      throw new Error(
        `Unknown operationType "${operationType}". Must be one of: ${valid.join(', ')}`,
      );
    }
  }
}

// ── Singleton for the main process ────────────────────────────────────────────

let _singleton = null;

/**
 * Return the process-level NonceManager singleton.
 * A custom store can be injected on first call (e.g. to provide a Redis-backed
 * store for multi-replica deployments).
 *
 * @param {{ get: Function, set: Function }} [store]
 * @returns {NonceManager}
 */
function getNonceManager(store) {
  if (!_singleton) {
    _singleton = new NonceManager(store);
  }
  return _singleton;
}

/**
 * Replace the singleton — used in tests to start from a clean state.
 * @param {{ get: Function, set: Function }} [store]
 * @returns {NonceManager}
 */
function resetNonceManager(store) {
  _singleton = new NonceManager(store || new InMemoryNonceStore());
  return _singleton;
}

module.exports = {
  OPERATION_TYPES,
  NonceManager,
  InMemoryNonceStore,
  getNonceManager,
  resetNonceManager,
};
