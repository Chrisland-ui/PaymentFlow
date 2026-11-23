'use strict';

/**
 * Blockchain finality policy — Issue #62.
 *
 * Single authoritative source for when an on-chain Stellar transaction is
 * considered safe to show as settled. Used by:
 *   - API handlers    (payment status responses)
 *   - Queue workers   (transaction processing decisions)
 *   - Reconciliation  (consistency checks, stuck-payment detection)
 *
 * The policy is a thin coordination layer over the existing
 * paymentConfirmationStateMachine (which owns the pure state logic) and
 * stellarConfig (which owns threshold constants). Nothing here duplicates
 * thresholds — it imports them and re-exports them as a single policy object
 * so callers never need to reach into two different modules.
 *
 * Design decisions:
 *   - networkErrorBehavior = 'hold': when Horizon returns no ledger info
 *     (null latestLedger), keep the payment in its current early state rather
 *     than failing it. A transient network error should never permanently
 *     reject a legitimate payment.
 *   - reorgBehavior = 'recheck': on a suspected reorg (ledger depth regresses)
 *     the state machine's monotonicity guarantee already returns a no-op, so
 *     we simply log and re-check on the next poll cycle.
 *   - User-facing statuses only claim finality at CONFIRMED or above. The
 *     `shouldTrustStatus` helper enforces this rule in one place.
 */

const {
  CONFIRMATION_STATES,
  TERMINAL_STATES,
  computeTargetState,
  resolveNextState,
  deriveLegacyConfirmationStatus,
  isConfirmedOrAbove,
} = require('./paymentConfirmationStateMachine');

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * How long (ms) a payment may remain in detected/pending before it is
 * considered timed-out and eligible for operator review. Configurable via
 * FINALITY_TIMEOUT_MS; defaults to 30 minutes.
 *
 * This does NOT automatically fail the payment — it is a signal to the
 * stuck-payment reconciler that the payment deserves attention.
 */
const FINALITY_TIMEOUT_MS = parseInt(
  process.env.FINALITY_TIMEOUT_MS || String(30 * 60 * 1000),
  10,
);

// Lazy-load to avoid circular imports and missing-env errors in tests that
// stub stellarConfig. Resolved once on first use.
let _thresholds = null;
function getThresholds() {
  if (!_thresholds) {
    const { CONFIRMATION_THRESHOLD, FINALIZATION_THRESHOLD } = require('../config/stellarConfig');
    _thresholds = { confirmationThreshold: CONFIRMATION_THRESHOLD, finalizationThreshold: FINALIZATION_THRESHOLD };
  }
  return _thresholds;
}

/**
 * The canonical finality policy object.
 *
 * All callers that need to know "when is a payment final?" should import
 * FINALITY_POLICY rather than reading thresholds directly from stellarConfig.
 * This ensures a single place to update if the policy ever changes.
 *
 * Fields:
 *   confirmationThreshold  — ledger depth required for CONFIRMED state
 *   finalizationThreshold  — ledger depth required for FINALIZED state
 *   timeoutMs              — max ms in detected/pending before flagging stuck
 *   networkErrorBehavior   — 'hold': keep current state on Horizon errors
 *   reorgBehavior          — 'recheck': re-evaluate on next poll cycle
 */
const FINALITY_POLICY = Object.freeze({
  get confirmationThreshold() { return getThresholds().confirmationThreshold; },
  get finalizationThreshold() { return getThresholds().finalizationThreshold; },
  timeoutMs: FINALITY_TIMEOUT_MS,
  networkErrorBehavior: 'hold',
  reorgBehavior: 'recheck',
});

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate the finality of a payment given the latest known ledger sequence.
 *
 * Pure function — no I/O. Combines computeTargetState + resolveNextState from
 * the state machine with the FINALITY_POLICY thresholds so callers don't need
 * to pass thresholds manually.
 *
 * When latestLedgerSequence is null/undefined (Horizon unreachable) the
 * networkErrorBehavior='hold' rule keeps the payment in its current state
 * rather than advancing or failing it.
 *
 * @param {object} payment         - Payment document (or plain object)
 * @param {string|null} payment.confirmationState  - Current fine-grained state
 * @param {number|null} payment.ledger             - Ledger the tx was in
 * @param {boolean} [payment.isSuspicious]         - Fraud/anomaly flag
 * @param {number|null} latestLedgerSequence       - Latest Horizon ledger seq
 * @returns {{
 *   fineGrainedState: string,
 *   legacyStatus: string,
 *   isSettled: boolean,
 *   isTerminal: boolean,
 *   shouldRetry: boolean,
 *   changed: boolean,
 * }}
 */
function evaluatePaymentFinality(payment, latestLedgerSequence) {
  const { confirmationThreshold, finalizationThreshold } = getThresholds();

  // Network error / hold policy: if we have no ledger info and the policy is
  // 'hold', do not advance or fail — return the current state unchanged.
  const effectiveLatestLedger =
    latestLedgerSequence != null ? latestLedgerSequence : null;

  if (effectiveLatestLedger == null && FINALITY_POLICY.networkErrorBehavior === 'hold') {
    const currentState = payment.confirmationState || CONFIRMATION_STATES.DETECTED;
    const legacyStatus = deriveLegacyConfirmationStatus(currentState);
    const settled =
      currentState === CONFIRMATION_STATES.CONFIRMED ||
      currentState === CONFIRMATION_STATES.FINALIZED;
    return {
      fineGrainedState: currentState,
      legacyStatus,
      isSettled: settled,
      isTerminal: TERMINAL_STATES.has(currentState),
      shouldRetry: !TERMINAL_STATES.has(currentState) && !settled,
      changed: false,
    };
  }

  const targetState = computeTargetState({
    txLedger: payment.ledger || null,
    latestLedgerSequence: effectiveLatestLedger,
    isSuspicious: payment.isSuspicious || false,
    confirmationThreshold,
    finalizationThreshold,
  });

  const { state: nextState, changed } = resolveNextState(
    payment.confirmationState || null,
    targetState,
  );

  const legacyStatus = deriveLegacyConfirmationStatus(nextState);
  const settled =
    nextState === CONFIRMATION_STATES.CONFIRMED ||
    nextState === CONFIRMATION_STATES.FINALIZED;

  return {
    fineGrainedState: nextState,
    legacyStatus,
    isSettled: settled,
    isTerminal: TERMINAL_STATES.has(nextState),
    // Retry makes sense for any non-terminal, non-settled state
    shouldRetry: !TERMINAL_STATES.has(nextState) && !settled,
    changed,
  };
}

/**
 * Returns true when a payment has been stuck in a pre-confirmation state
 * (detected or pending) for longer than FINALITY_POLICY.timeoutMs.
 *
 * Does NOT fail the payment — callers decide whether to escalate to ops or
 * re-queue. The payment's `createdAt` (or `detectedAt` if present) is used
 * as the start of the timer.
 *
 * @param {object} payment
 * @param {string|null} payment.confirmationState
 * @param {Date|string|null} payment.createdAt
 * @returns {boolean}
 */
function isFinalityTimeout(payment) {
  const state = payment.confirmationState || CONFIRMATION_STATES.DETECTED;

  // Only relevant for pre-confirmation states
  if (
    state !== CONFIRMATION_STATES.DETECTED &&
    state !== CONFIRMATION_STATES.PENDING
  ) {
    return false;
  }

  const createdAt = payment.createdAt ? new Date(payment.createdAt) : null;
  if (!createdAt || isNaN(createdAt.getTime())) return false;

  const ageMs = Date.now() - createdAt.getTime();
  return ageMs > FINALITY_POLICY.timeoutMs;
}

/**
 * Returns true only when the fine-grained state is CONFIRMED or FINALIZED —
 * the threshold at which it is safe to show the user that the payment has
 * settled. Detected and pending states must never be shown to the user as
 * "confirmed" or "paid". Failed is explicitly excluded even though its rank
 * is numerically high — it is a rejection, not a settlement.
 *
 * Use this guard anywhere a user-visible "confirmed" label would be rendered
 * or a balance is about to be credited.
 *
 * @param {string} fineGrainedState
 * @returns {boolean}
 */
function shouldTrustStatus(fineGrainedState) {
  return (
    fineGrainedState === CONFIRMATION_STATES.CONFIRMED ||
    fineGrainedState === CONFIRMATION_STATES.FINALIZED
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  FINALITY_POLICY,
  FINALITY_TIMEOUT_MS,
  evaluatePaymentFinality,
  isFinalityTimeout,
  shouldTrustStatus,
};
