'use strict';

/**
 * escrowContract.js — Soroban escrow contract emulator
 *
 * This module simulates the event-emission behaviour of the Soroban escrow
 * contract for the off-chain backend. In a production deployment with a real
 * Soroban contract, the indexer would receive these events directly from the
 * Stellar network. This emulator:
 *
 *   1. Provides the same event shapes as the on-chain contract
 *      (see docs/contract-events.md for the formal schema).
 *   2. Validates all inputs against the schema before emitting.
 *   3. Integrates with the existing paymentEvents bus so consumers
 *      subscribe to 'contract.event' using the same asyncEmit pattern.
 *
 * Event topic structure (positional, Soroban-compatible):
 *   topics[0]  = "escrow"            (namespace, constant)
 *   topics[1]  = <EventType>         (discriminator)
 *   topics[2+] = indexed fields      (filterable by Horizon)
 *
 * All amounts are in STROOPS (int, 7 decimal places).
 * 1 XLM = 10_000_000 stroops.
 *
 * Schema version: 1
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

// ─── Constants ───────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const NAMESPACE = 'escrow';

const EVENT_TYPES = Object.freeze({
  ESCROW_CREATED:    'EscrowCreated',
  FUNDS_RELEASED:    'FundsReleased',
  REFUND_ISSUED:     'RefundIssued',
  DISPUTE_RAISED:    'DisputeRaised',
  DISPUTE_RESOLVED:  'DisputeResolved',
});

const ASSETS = Object.freeze(['XLM', 'USDC']);

const FEE_VALIDATION_STATUSES = Object.freeze(['valid', 'overpaid', 'underpaid']);

const REFUND_REASON_CODES = Object.freeze([
  'dispute_resolved',
  'overpayment',
  'admin_initiated',
  'escrow_expired',
]);

const DISPUTE_REASON_CODES = Object.freeze([
  'wrong_amount',
  'not_received',
  'duplicate',
  'other',
]);

const DISPUTE_OUTCOMES = Object.freeze([
  'released_to_school',
  'refunded_to_depositor',
  'partial_release',
]);

// ─── Event bus ───────────────────────────────────────────────────────────────

/**
 * Dedicated event emitter for contract events.
 * Consumers listen on 'contract.event' and receive a structured ContractEvent.
 */
const contractEvents = new EventEmitter();
contractEvents.setMaxListeners(20);

/**
 * Emit a contract event and await all listener results.
 * Mirrors the asyncEmit pattern from paymentEvents.js.
 *
 * @param {string} eventType
 * @param {object} event
 * @returns {Promise<PromiseSettledResult[]>}
 */
contractEvents.asyncEmit = async function asyncEmit(eventType, event) {
  const listeners = contractEvents.rawListeners(eventType);
  if (listeners.length === 0) return [];
  return Promise.allSettled(
    listeners.map((listener) => {
      try {
        const result = listener(event);
        return (result != null && typeof result.then === 'function')
          ? result
          : Promise.resolve(result);
      } catch (err) {
        return Promise.reject(err);
      }
    }),
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the common envelope fields present in every event.
 *
 * @param {string} contractId - Contract address (or placeholder for emulator)
 * @param {number} [ledgerSequence] - Ledger number (defaults to 0 for emulator)
 * @returns {object}
 */
function commonFields(contractId, ledgerSequence = 0) {
  return {
    schemaVersion:   SCHEMA_VERSION,
    contractId:      contractId || 'EMULATOR',
    ledgerSequence:  ledgerSequence,
    timestampMs:     Date.now(),
  };
}

/**
 * Validate that a value is a safe integer representing a non-negative stroop
 * amount.
 *
 * @param {*} value
 * @param {string} fieldName
 * @throws {TypeError}
 */
function assertStroops(value, fieldName) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${fieldName} must be a non-negative integer (stroops), got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Validate that a value is a non-empty string.
 *
 * @param {*} value
 * @param {string} fieldName
 * @throws {TypeError}
 */
function assertSymbol(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(
      `${fieldName} must be a non-empty string (Symbol), got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Validate that a value is one of an allowed set.
 *
 * @param {*} value
 * @param {readonly string[]} allowed
 * @param {string} fieldName
 * @throws {RangeError}
 */
function assertEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new RangeError(
      `${fieldName} must be one of [${allowed.join(', ')}], got: ${JSON.stringify(value)}`,
    );
  }
}

// ─── Contract operations ──────────────────────────────────────────────────────

/**
 * Emit an EscrowCreated event.
 *
 * Call this when a new escrow is created and funds are locked.
 *
 * @param {object} params
 * @param {string}  params.paymentId        - Unique escrow/payment identifier
 * @param {string}  params.schoolId         - Multi-tenant school identifier
 * @param {string}  params.studentId        - Student identifier
 * @param {string}  params.schoolAccount    - School's Stellar account address
 * @param {string}  params.depositorAccount - Payer's Stellar account address
 * @param {number}  params.amount           - Escrowed amount in stroops
 * @param {string}  params.asset            - "XLM" or "USDC"
 * @param {string}  params.feeCategory      - Fee category key
 * @param {number}  params.expectedFeeAmount - Expected fee in stroops
 * @param {string}  params.memoText         - Stellar memo (max 28 chars)
 * @param {number}  params.expiresAtMs      - Expiry timestamp (ms)
 * @param {string}  [params.contractId]     - Contract address
 * @param {number}  [params.ledgerSequence] - Ledger number
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function emitEscrowCreated(params) {
  const {
    paymentId, schoolId, studentId, schoolAccount, depositorAccount,
    amount, asset, feeCategory, expectedFeeAmount, memoText, expiresAtMs,
    contractId, ledgerSequence,
  } = params;

  // Validate required fields
  assertSymbol(paymentId,        'paymentId');
  assertSymbol(schoolId,         'schoolId');
  assertSymbol(studentId,        'studentId');
  assertSymbol(schoolAccount,    'schoolAccount');
  assertSymbol(depositorAccount, 'depositorAccount');
  assertStroops(amount,           'amount');
  assertEnum(asset, ASSETS,       'asset');
  assertSymbol(feeCategory,      'feeCategory');
  assertStroops(expectedFeeAmount, 'expectedFeeAmount');
  assertSymbol(memoText,         'memoText');
  if (typeof expiresAtMs !== 'number' || !Number.isInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new TypeError(`expiresAtMs must be a positive integer (ms timestamp), got: ${JSON.stringify(expiresAtMs)}`);
  }

  /** @type {ContractEvent} */
  const event = {
    topics: [NAMESPACE, EVENT_TYPES.ESCROW_CREATED, paymentId, schoolAccount],
    data: {
      ...commonFields(contractId, ledgerSequence),
      paymentId,
      schoolId,
      studentId,
      schoolAccount,
      depositorAccount,
      amount,
      asset,
      feeCategory,
      expectedFeeAmount,
      memoText,
      expiresAtMs,
    },
  };

  return contractEvents.asyncEmit('contract.event', event);
}

/**
 * Emit a FundsReleased event.
 *
 * Call this when the escrow releases funds to the school.
 *
 * @param {object} params
 * @param {string}  params.paymentId           - Escrow/payment identifier
 * @param {string}  params.schoolId            - School identifier
 * @param {string}  params.studentId           - Student identifier
 * @param {string}  params.schoolAccount       - Destination account
 * @param {string}  params.depositorAccount    - Original payer account
 * @param {number}  params.releasedAmount      - Amount released in stroops
 * @param {number}  params.excessAmount        - Excess returned to payer (0 if none)
 * @param {string}  params.asset               - "XLM" or "USDC"
 * @param {string}  params.feeValidationStatus - "valid" | "overpaid" | "underpaid"
 * @param {string}  params.releasedBy          - Account that triggered the release
 * @param {string}  [params.contractId]
 * @param {number}  [params.ledgerSequence]
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function emitFundsReleased(params) {
  const {
    paymentId, schoolId, studentId, schoolAccount, depositorAccount,
    releasedAmount, excessAmount, asset, feeValidationStatus, releasedBy,
    contractId, ledgerSequence,
  } = params;

  assertSymbol(paymentId,        'paymentId');
  assertSymbol(schoolId,         'schoolId');
  assertSymbol(studentId,        'studentId');
  assertSymbol(schoolAccount,    'schoolAccount');
  assertSymbol(depositorAccount, 'depositorAccount');
  assertStroops(releasedAmount,   'releasedAmount');
  assertStroops(excessAmount ?? 0, 'excessAmount');
  assertEnum(asset, ASSETS,       'asset');
  assertEnum(feeValidationStatus, FEE_VALIDATION_STATUSES, 'feeValidationStatus');
  assertSymbol(releasedBy,       'releasedBy');

  /** @type {ContractEvent} */
  const event = {
    topics: [NAMESPACE, EVENT_TYPES.FUNDS_RELEASED, paymentId, schoolAccount],
    data: {
      ...commonFields(contractId, ledgerSequence),
      paymentId,
      schoolId,
      studentId,
      schoolAccount,
      depositorAccount,
      releasedAmount,
      excessAmount: excessAmount ?? 0,
      asset,
      feeValidationStatus,
      releasedBy,
    },
  };

  return contractEvents.asyncEmit('contract.event', event);
}

/**
 * Emit a RefundIssued event.
 *
 * Call this when escrowed funds are returned to the depositor.
 *
 * @param {object} params
 * @param {string}  params.paymentId        - Original escrow/payment identifier
 * @param {string}  params.refundTxHash     - Transaction hash of the refund op
 * @param {string}  params.schoolId         - School identifier
 * @param {string}  params.studentId        - Student identifier
 * @param {string}  params.depositorAccount - Account receiving the refund
 * @param {string}  params.schoolAccount    - School account (for reconciliation)
 * @param {number}  params.refundAmount     - Amount refunded in stroops
 * @param {string}  params.asset            - "XLM" or "USDC"
 * @param {string}  params.reason           - Refund reason code
 * @param {string}  params.initiatedBy      - Account that initiated the refund
 * @param {string}  [params.contractId]
 * @param {number}  [params.ledgerSequence]
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function emitRefundIssued(params) {
  const {
    paymentId, refundTxHash, schoolId, studentId, depositorAccount,
    schoolAccount, refundAmount, asset, reason, initiatedBy,
    contractId, ledgerSequence,
  } = params;

  assertSymbol(paymentId,        'paymentId');
  assertSymbol(refundTxHash,     'refundTxHash');
  assertSymbol(schoolId,         'schoolId');
  assertSymbol(studentId,        'studentId');
  assertSymbol(depositorAccount, 'depositorAccount');
  assertSymbol(schoolAccount,    'schoolAccount');
  assertStroops(refundAmount,     'refundAmount');
  assertEnum(asset, ASSETS,       'asset');
  assertEnum(reason, REFUND_REASON_CODES, 'reason');
  assertSymbol(initiatedBy,      'initiatedBy');

  /** @type {ContractEvent} */
  const event = {
    topics: [NAMESPACE, EVENT_TYPES.REFUND_ISSUED, paymentId, depositorAccount],
    data: {
      ...commonFields(contractId, ledgerSequence),
      paymentId,
      refundTxHash,
      schoolId,
      studentId,
      depositorAccount,
      schoolAccount,
      refundAmount,
      asset,
      reason,
      initiatedBy,
    },
  };

  return contractEvents.asyncEmit('contract.event', event);
}

/**
 * Emit a DisputeRaised event.
 *
 * Call this when a dispute is opened against an escrowed payment.
 *
 * @param {object} params
 * @param {string}  params.paymentId        - Payment under dispute
 * @param {string}  [params.disputeId]      - Unique dispute identifier (auto-generated if omitted)
 * @param {string}  params.schoolId         - School identifier
 * @param {string}  params.studentId        - Student identifier
 * @param {string}  params.raisedBy         - Account that raised the dispute
 * @param {string}  params.schoolAccount    - School account
 * @param {string}  params.depositorAccount - Payer account
 * @param {number}  params.disputedAmount   - Amount under dispute in stroops
 * @param {string}  params.asset            - "XLM" or "USDC"
 * @param {string}  params.reasonCode       - Machine-readable reason code
 * @param {number}  params.slaDeadlineMs    - SLA deadline (ms timestamp)
 * @param {string}  [params.contractId]
 * @param {number}  [params.ledgerSequence]
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function emitDisputeRaised(params) {
  const {
    paymentId, schoolId, studentId, raisedBy, schoolAccount, depositorAccount,
    disputedAmount, asset, reasonCode, slaDeadlineMs,
    contractId, ledgerSequence,
  } = params;

  const disputeId = params.disputeId || `DISP-${uuidv4()}`;

  assertSymbol(paymentId,        'paymentId');
  assertSymbol(disputeId,        'disputeId');
  assertSymbol(schoolId,         'schoolId');
  assertSymbol(studentId,        'studentId');
  assertSymbol(raisedBy,         'raisedBy');
  assertSymbol(schoolAccount,    'schoolAccount');
  assertSymbol(depositorAccount, 'depositorAccount');
  assertStroops(disputedAmount,   'disputedAmount');
  assertEnum(asset, ASSETS,       'asset');
  assertEnum(reasonCode, DISPUTE_REASON_CODES, 'reasonCode');
  if (typeof slaDeadlineMs !== 'number' || !Number.isInteger(slaDeadlineMs) || slaDeadlineMs <= 0) {
    throw new TypeError(`slaDeadlineMs must be a positive integer (ms timestamp), got: ${JSON.stringify(slaDeadlineMs)}`);
  }

  /** @type {ContractEvent} */
  const event = {
    topics: [NAMESPACE, EVENT_TYPES.DISPUTE_RAISED, paymentId, disputeId],
    data: {
      ...commonFields(contractId, ledgerSequence),
      paymentId,
      disputeId,
      schoolId,
      studentId,
      raisedBy,
      schoolAccount,
      depositorAccount,
      disputedAmount,
      asset,
      reasonCode,
      slaDeadlineMs,
    },
  };

  return contractEvents.asyncEmit('contract.event', event);
}

/**
 * Emit a DisputeResolved event.
 *
 * Call this when a dispute is closed with a resolution.
 *
 * @param {object} params
 * @param {string}  params.paymentId        - Payment that was under dispute
 * @param {string}  params.disputeId        - Unique dispute identifier
 * @param {string}  params.schoolId         - School identifier
 * @param {string}  params.studentId        - Student identifier
 * @param {string}  params.resolvedBy       - Account that resolved the dispute
 * @param {string}  params.schoolAccount    - School account
 * @param {string}  params.depositorAccount - Payer account
 * @param {string}  params.outcome          - Resolution outcome code
 * @param {number}  params.schoolAmount     - Amount to school (0 if full refund)
 * @param {number}  params.depositorAmount  - Amount to depositor (0 if full release)
 * @param {string}  params.asset            - "XLM" or "USDC"
 * @param {string}  [params.resolutionNote] - Optional human-readable note
 * @param {string}  [params.contractId]
 * @param {number}  [params.ledgerSequence]
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function emitDisputeResolved(params) {
  const {
    paymentId, disputeId, schoolId, studentId, resolvedBy, schoolAccount,
    depositorAccount, outcome, schoolAmount, depositorAmount, asset,
    resolutionNote, contractId, ledgerSequence,
  } = params;

  assertSymbol(paymentId,        'paymentId');
  assertSymbol(disputeId,        'disputeId');
  assertSymbol(schoolId,         'schoolId');
  assertSymbol(studentId,        'studentId');
  assertSymbol(resolvedBy,       'resolvedBy');
  assertSymbol(schoolAccount,    'schoolAccount');
  assertSymbol(depositorAccount, 'depositorAccount');
  assertEnum(outcome, DISPUTE_OUTCOMES, 'outcome');
  assertStroops(schoolAmount,     'schoolAmount');
  assertStroops(depositorAmount,  'depositorAmount');
  assertEnum(asset, ASSETS,       'asset');
  // resolutionNote is optional — validate only if provided
  if (resolutionNote !== undefined && resolutionNote !== null) {
    assertSymbol(resolutionNote, 'resolutionNote');
  }

  /** @type {ContractEvent} */
  const event = {
    topics: [NAMESPACE, EVENT_TYPES.DISPUTE_RESOLVED, paymentId, disputeId],
    data: {
      ...commonFields(contractId, ledgerSequence),
      paymentId,
      disputeId,
      schoolId,
      studentId,
      resolvedBy,
      schoolAccount,
      depositorAccount,
      outcome,
      schoolAmount,
      depositorAmount,
      asset,
      resolutionNote: resolutionNote ?? null,
    },
  };

  return contractEvents.asyncEmit('contract.event', event);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Event bus — consumers subscribe here
  contractEvents,

  // Lifecycle operations — each emits the corresponding schema event
  emitEscrowCreated,
  emitFundsReleased,
  emitRefundIssued,
  emitDisputeRaised,
  emitDisputeResolved,

  // Constants — exposed for use by parsers and tests
  SCHEMA_VERSION,
  NAMESPACE,
  EVENT_TYPES,
  ASSETS,
  FEE_VALIDATION_STATUSES,
  REFUND_REASON_CODES,
  DISPUTE_REASON_CODES,
  DISPUTE_OUTCOMES,
};
