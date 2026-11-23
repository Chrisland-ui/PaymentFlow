'use strict';

/**
 * Canonical payment status definitions — Issue #72.
 *
 * This is the single source of truth for payment statuses and their allowed
 * transitions. Import this module everywhere a status value is needed:
 *
 *   const { PAYMENT_STATUS, PAYMENT_STATUS_TRANSITIONS, ADMIN_PAYMENT_STATUS_TRANSITIONS }
 *     = require('../constants/paymentStatus');
 *
 * Never use inline string literals for payment statuses. This prevents drift
 * between the model's allowed set, controller checks, and any future tooling.
 */

/**
 * All valid payment status values.
 *
 * PENDING   — Payment detected on-chain, awaiting confirmation.
 * SUBMITTED — Payment has been submitted for processing.
 * SUCCESS   — Payment confirmed and matched to a student.
 * FAILED    — Payment failed (bad destination, wrong asset, etc.).
 * DISPUTED  — Payment marked as disputed by an admin or parent.
 * REFUNDED  — Payment has been refunded.
 * INVALID   — Payment is structurally invalid (missing memo, etc.).
 */
const PAYMENT_STATUS = Object.freeze({
  PENDING:   'PENDING',
  SUBMITTED: 'SUBMITTED',
  SUCCESS:   'SUCCESS',
  FAILED:    'FAILED',
  DISPUTED:  'DISPUTED',
  REFUNDED:  'REFUNDED',
  INVALID:   'INVALID',
});

/**
 * Array of all valid status strings (for Mongoose enum validation).
 */
const PAYMENT_STATUS_VALUES = Object.freeze(Object.values(PAYMENT_STATUS));

/**
 * Allowed status transitions for normal (non-admin) paths.
 *
 *   SUCCESS   → DISPUTED  : admin marks a confirmed payment as disputed
 *   SUCCESS   → REFUNDED  : admin marks a confirmed payment as refunded
 *   PENDING   → FAILED    : admin manually fails a stuck pending payment
 *   SUBMITTED → SUCCESS   : ledger-finality polling confirms the transaction
 *                           (see stellarService.pollForLedgerInclusion)
 *   SUBMITTED → FAILED    : ledger-finality polling times out (FINALITY_TIMEOUT)
 *                           or the transaction fails on-chain after submission
 *
 * All other transitions are rejected. Callers with admin authority can use
 * ADMIN_PAYMENT_STATUS_TRANSITIONS (see below) after setting
 * payment.$locals.adminOverride = true.
 */
const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.SUCCESS]:   [PAYMENT_STATUS.DISPUTED, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.PENDING]:   [PAYMENT_STATUS.SUBMITTED, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUBMITTED]: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED],
});

/**
 * Additional transitions available only when adminOverride = true.
 * These paths must be explicitly audited by the caller.
 *
 *   SUCCESS  → REFUNDED  : admin refunds a confirmed payment
 *   DISPUTED → REFUNDED  : admin resolves a dispute via refund
 *   FAILED   → SUCCESS   : admin corrects a payment wrongly marked failed
 *                          (e.g. a submission that actually succeeded, a sync
 *                          race, a misclassified permanent-failure code) once
 *                          manual reconciliation confirms funds arrived —
 *                          Issue #1029
 *   FAILED   → DISPUTED  : admin escalates a wrongly-failed payment for
 *                          investigation rather than confirming it outright —
 *                          Issue #1029
 *   SUBMITTED → SUCCESS  : admin manually confirms a stuck SUBMITTED payment
 *                          after manual on-chain verification
 *   SUBMITTED → FAILED   : admin manually fails a stuck SUBMITTED payment
 */
const ADMIN_PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.SUCCESS]:   [PAYMENT_STATUS.DISPUTED, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.PENDING]:   [PAYMENT_STATUS.SUBMITTED, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUBMITTED]: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.DISPUTED]:  [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.FAILED]:    [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.DISPUTED],
});

/**
 * Returns true when a status transition is allowed for the given path.
 *
 * @param {string} from - Current status
 * @param {string} to   - Desired next status
 * @param {boolean} [adminOverride=false] - Use admin transition table
 * @returns {boolean}
 */
function isTransitionAllowed(from, to, adminOverride = false) {
  const table = adminOverride
    ? ADMIN_PAYMENT_STATUS_TRANSITIONS
    : PAYMENT_STATUS_TRANSITIONS;
  const allowed = table[from] || [];
  return allowed.includes(to);
}

/**
 * Canonical failure reason codes for payments that transition to FAILED.
 *
 * These are stored in `payment.suspicionReason` (re-used as a general
 * failure-reason field) and exposed in API responses so clients can
 * distinguish permanent failures from transient ones.
 *
 * FINALITY_TIMEOUT  — A SUBMITTED transaction was not observed in a closed
 *                     ledger within FINALITY_POLL_TIMEOUT_MS. The transaction
 *                     may still confirm later; operators should investigate
 *                     via the Stellar Horizon API using the tx hash.
 *                     See: docs/stellar-finality-policy.md
 * TX_FAILED_ON_CHAIN — Horizon confirmed the tx was included in a ledger but
 *                      `successful === false` (e.g. op_bad_auth, op_no_trust).
 * STELLAR_NETWORK_ERROR — Horizon was unreachable for the full polling window.
 */
const PAYMENT_FAILURE_REASONS = Object.freeze({
  FINALITY_TIMEOUT: 'FINALITY_TIMEOUT',
  TX_FAILED_ON_CHAIN: 'TX_FAILED_ON_CHAIN',
  STELLAR_NETWORK_ERROR: 'STELLAR_NETWORK_ERROR',
});

module.exports = {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  PAYMENT_FAILURE_REASONS,
  isTransitionAllowed,
};
