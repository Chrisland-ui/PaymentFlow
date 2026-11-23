'use strict';

/**
 * contractEventParser.js — Backend event parser for Soroban escrow events
 *
 * Consumes raw Soroban contract events (from the on-chain indexer or the
 * emulator) and converts them into structured backend domain objects ready
 * for persistence and downstream processing.
 *
 * Responsibilities:
 *   1. Validate incoming events using the schema definitions from
 *      backend/src/types/contractEvents.js.
 *   2. Convert stroop amounts to decimal values for MongoDB storage.
 *   3. Map each event type to the corresponding backend action descriptor
 *      (what the reconciliation job should do next).
 *   4. Return a typed ParsedEvent with normalised fields plus a
 *      `reconciliationAction` that drives the payment state machine.
 *
 * Usage:
 *   const parser = require('./contractEventParser');
 *
 *   // Subscribe to the contract event bus
 *   contractEvents.on('contract.event', async (rawEvent) => {
 *     const parsed = parser.parse(rawEvent);
 *     if (!parsed.valid) { logger.warn(...); return; }
 *     await reconciliationQueue.add(parsed.reconciliationAction, parsed.payload);
 *   });
 *
 * Schema version: 1 (see docs/contract-events.md)
 */

const {
  validateContractEvent,
  EVENT_TYPES,
  SCHEMA_VERSION,
} = require('../types/contractEvents');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Multiplier used by Stellar to express XLM amounts as integer stroops.
 * 1 XLM = 10,000,000 stroops.
 */
const STROOPS_PER_UNIT = 10_000_000;

/**
 * Reconciliation action codes — tell the backend what to do when an event
 * arrives. These map to the off-chain reconciliation table in the schema doc.
 */
const RECONCILIATION_ACTIONS = Object.freeze({
  CREATE_OR_UPDATE_PAYMENT:  'CREATE_OR_UPDATE_PAYMENT',
  CONFIRM_PAYMENT:           'CONFIRM_PAYMENT',
  PROCESS_REFUND:            'PROCESS_REFUND',
  OPEN_DISPUTE:              'OPEN_DISPUTE',
  RESOLVE_DISPUTE:           'RESOLVE_DISPUTE',
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a stroop integer to a decimal number.
 *
 * Uses JavaScript's built-in floating-point for amounts up to ~9 quadrillion
 * stroops (≈ 900 billion XLM). For production use with very large amounts,
 * replace with a Decimal library (project already has decimal.js).
 *
 * @param {number} stroops
 * @returns {number}
 */
function stroopsToDecimal(stroops) {
  // Guard against NaN/null falling through
  if (typeof stroops !== 'number') return 0;
  return stroops / STROOPS_PER_UNIT;
}

/**
 * Convert a decimal XLM/USDC amount to stroops (integer).
 *
 * @param {number} decimal
 * @returns {number}
 */
function decimalToStroops(decimal) {
  return Math.round(decimal * STROOPS_PER_UNIT);
}

// ─── Per-event-type payload builders ─────────────────────────────────────────

/**
 * Build a normalised payload from an EscrowCreated event.
 *
 * @param {object} data - Validated event data
 * @returns {object}
 */
function buildEscrowCreatedPayload(data) {
  return {
    paymentId:         data.paymentId,
    schoolId:          data.schoolId,
    studentId:         data.studentId,
    schoolAccount:     data.schoolAccount,
    depositorAccount:  data.depositorAccount,
    amount:            stroopsToDecimal(data.amount),
    amountStroops:     data.amount,
    asset:             data.asset,
    feeCategory:       data.feeCategory,
    expectedFeeAmount: stroopsToDecimal(data.expectedFeeAmount),
    expectedFeeAmountStroops: data.expectedFeeAmount,
    memoText:          data.memoText,
    expiresAtMs:       data.expiresAtMs,
    // Envelope
    contractId:        data.contractId,
    ledgerSequence:    data.ledgerSequence,
    timestampMs:       data.timestampMs,
    schemaVersion:     data.schemaVersion,
  };
}

/**
 * Build a normalised payload from a FundsReleased event.
 *
 * @param {object} data - Validated event data
 * @returns {object}
 */
function buildFundsReleasedPayload(data) {
  return {
    paymentId:            data.paymentId,
    schoolId:             data.schoolId,
    studentId:            data.studentId,
    schoolAccount:        data.schoolAccount,
    depositorAccount:     data.depositorAccount,
    releasedAmount:       stroopsToDecimal(data.releasedAmount),
    releasedAmountStroops: data.releasedAmount,
    excessAmount:         stroopsToDecimal(data.excessAmount),
    excessAmountStroops:  data.excessAmount,
    asset:                data.asset,
    feeValidationStatus:  data.feeValidationStatus,
    releasedBy:           data.releasedBy,
    // Envelope
    contractId:           data.contractId,
    ledgerSequence:       data.ledgerSequence,
    timestampMs:          data.timestampMs,
    schemaVersion:        data.schemaVersion,
  };
}

/**
 * Build a normalised payload from a RefundIssued event.
 *
 * @param {object} data - Validated event data
 * @returns {object}
 */
function buildRefundIssuedPayload(data) {
  return {
    paymentId:          data.paymentId,
    refundTxHash:       data.refundTxHash,
    schoolId:           data.schoolId,
    studentId:          data.studentId,
    depositorAccount:   data.depositorAccount,
    schoolAccount:      data.schoolAccount,
    refundAmount:       stroopsToDecimal(data.refundAmount),
    refundAmountStroops: data.refundAmount,
    asset:              data.asset,
    reason:             data.reason,
    initiatedBy:        data.initiatedBy,
    // Envelope
    contractId:         data.contractId,
    ledgerSequence:     data.ledgerSequence,
    timestampMs:        data.timestampMs,
    schemaVersion:      data.schemaVersion,
  };
}

/**
 * Build a normalised payload from a DisputeRaised event.
 *
 * @param {object} data - Validated event data
 * @returns {object}
 */
function buildDisputeRaisedPayload(data) {
  return {
    paymentId:           data.paymentId,
    disputeId:           data.disputeId,
    schoolId:            data.schoolId,
    studentId:           data.studentId,
    raisedBy:            data.raisedBy,
    schoolAccount:       data.schoolAccount,
    depositorAccount:    data.depositorAccount,
    disputedAmount:      stroopsToDecimal(data.disputedAmount),
    disputedAmountStroops: data.disputedAmount,
    asset:               data.asset,
    reasonCode:          data.reasonCode,
    slaDeadlineMs:       data.slaDeadlineMs,
    // Envelope
    contractId:          data.contractId,
    ledgerSequence:      data.ledgerSequence,
    timestampMs:         data.timestampMs,
    schemaVersion:       data.schemaVersion,
  };
}

/**
 * Build a normalised payload from a DisputeResolved event.
 *
 * @param {object} data - Validated event data
 * @returns {object}
 */
function buildDisputeResolvedPayload(data) {
  return {
    paymentId:             data.paymentId,
    disputeId:             data.disputeId,
    schoolId:              data.schoolId,
    studentId:             data.studentId,
    resolvedBy:            data.resolvedBy,
    schoolAccount:         data.schoolAccount,
    depositorAccount:      data.depositorAccount,
    outcome:               data.outcome,
    schoolAmount:          stroopsToDecimal(data.schoolAmount),
    schoolAmountStroops:   data.schoolAmount,
    depositorAmount:       stroopsToDecimal(data.depositorAmount),
    depositorAmountStroops: data.depositorAmount,
    asset:                 data.asset,
    resolutionNote:        data.resolutionNote ?? null,
    // Envelope
    contractId:            data.contractId,
    ledgerSequence:        data.ledgerSequence,
    timestampMs:           data.timestampMs,
    schemaVersion:         data.schemaVersion,
  };
}

// ─── Action derivation ────────────────────────────────────────────────────────

/**
 * Map an event type to the corresponding reconciliation action.
 *
 * @param {string} eventType
 * @returns {string}
 */
function deriveReconciliationAction(eventType) {
  const map = {
    [EVENT_TYPES.ESCROW_CREATED]:   RECONCILIATION_ACTIONS.CREATE_OR_UPDATE_PAYMENT,
    [EVENT_TYPES.FUNDS_RELEASED]:   RECONCILIATION_ACTIONS.CONFIRM_PAYMENT,
    [EVENT_TYPES.REFUND_ISSUED]:    RECONCILIATION_ACTIONS.PROCESS_REFUND,
    [EVENT_TYPES.DISPUTE_RAISED]:   RECONCILIATION_ACTIONS.OPEN_DISPUTE,
    [EVENT_TYPES.DISPUTE_RESOLVED]: RECONCILIATION_ACTIONS.RESOLVE_DISPUTE,
  };
  return map[eventType] || null;
}

// ─── Payload dispatch ─────────────────────────────────────────────────────────

/**
 * Build the event-type–specific payload from validated data.
 *
 * @param {string} eventType
 * @param {object} data
 * @returns {object}
 */
function buildPayload(eventType, data) {
  switch (eventType) {
    case EVENT_TYPES.ESCROW_CREATED:   return buildEscrowCreatedPayload(data);
    case EVENT_TYPES.FUNDS_RELEASED:   return buildFundsReleasedPayload(data);
    case EVENT_TYPES.REFUND_ISSUED:    return buildRefundIssuedPayload(data);
    case EVENT_TYPES.DISPUTE_RAISED:   return buildDisputeRaisedPayload(data);
    case EVENT_TYPES.DISPUTE_RESOLVED: return buildDisputeResolvedPayload(data);
    default:
      return { ...data };
  }
}

// ─── Main parse function ──────────────────────────────────────────────────────

/**
 * Parse and validate a raw Soroban contract event.
 *
 * @param {object} rawEvent - Raw event from the indexer or contract emulator
 * @returns {{
 *   valid: boolean,
 *   eventType: string|null,
 *   reconciliationAction: string|null,
 *   payload: object|null,
 *   errors: string[],
 *   warnings: string[]
 * }}
 */
function parse(rawEvent) {
  const validation = validateContractEvent(rawEvent);

  if (!validation.valid) {
    return {
      valid:               false,
      eventType:           validation.eventType,
      reconciliationAction: null,
      payload:             null,
      errors:              validation.errors,
      warnings:            validation.warnings,
    };
  }

  const { eventType, warnings } = validation;
  const payload = buildPayload(eventType, rawEvent.data);
  const reconciliationAction = deriveReconciliationAction(eventType);

  return {
    valid:               true,
    eventType,
    reconciliationAction,
    payload,
    errors:              [],
    warnings,
  };
}

/**
 * Parse a batch of raw events, skipping invalid ones.
 *
 * @param {object[]} rawEvents
 * @param {{ onInvalid?: (result: object) => void }} [options]
 * @returns {Array<{ eventType: string, reconciliationAction: string, payload: object }>}
 */
function parseBatch(rawEvents, options = {}) {
  const { onInvalid } = options;
  const results = [];

  for (const rawEvent of rawEvents) {
    const result = parse(rawEvent);
    if (result.valid) {
      results.push({
        eventType:            result.eventType,
        reconciliationAction: result.reconciliationAction,
        payload:              result.payload,
        warnings:             result.warnings,
      });
    } else if (typeof onInvalid === 'function') {
      onInvalid(result);
    }
  }

  return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Core operations
  parse,
  parseBatch,

  // Helpers — exposed for testing
  stroopsToDecimal,
  decimalToStroops,
  deriveReconciliationAction,

  // Constants
  RECONCILIATION_ACTIONS,
  SCHEMA_VERSION,
};
