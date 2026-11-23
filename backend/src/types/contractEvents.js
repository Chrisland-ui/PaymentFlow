'use strict';

/**
 * contractEvents.js — JS type definitions for Soroban escrow contract events
 *
 * This file serves as the single source of truth for event type shapes in the
 * backend.  Since the project uses plain JavaScript (no TypeScript), types are
 * expressed as JSDoc typedefs and runtime validators.
 *
 * Usage:
 *   const { validateContractEvent, CONTRACT_EVENT_SCHEMAS } =
 *     require('../types/contractEvents');
 *
 * Schema version: 1 (see docs/contract-events.md)
 */

const {
  EVENT_TYPES,
  ASSETS,
  FEE_VALIDATION_STATUSES,
  REFUND_REASON_CODES,
  DISPUTE_REASON_CODES,
  DISPUTE_OUTCOMES,
  SCHEMA_VERSION,
} = require('../soroban/escrowContract');

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {object} ContractEventCommon
 * @property {number} schemaVersion  - Integer schema version (currently 1)
 * @property {string} contractId     - Emitting contract address
 * @property {number} ledgerSequence - Ledger number at emission
 * @property {number} timestampMs    - Unix timestamp in milliseconds
 */

/**
 * @typedef {object} EscrowCreatedData
 * @extends ContractEventCommon
 * @property {string} paymentId         - Unique escrow/payment identifier
 * @property {string} schoolId          - Multi-tenant school identifier
 * @property {string} studentId         - Student identifier
 * @property {string} schoolAccount     - School's Stellar account address
 * @property {string} depositorAccount  - Payer's Stellar account address
 * @property {number} amount            - Escrowed amount in stroops
 * @property {string} asset             - "XLM" or "USDC"
 * @property {string} feeCategory       - Fee category key
 * @property {number} expectedFeeAmount - Expected fee in stroops
 * @property {string} memoText          - Stellar memo text
 * @property {number} expiresAtMs       - Escrow expiry timestamp (ms)
 */

/**
 * @typedef {object} FundsReleasedData
 * @extends ContractEventCommon
 * @property {string} paymentId           - Escrow/payment identifier
 * @property {string} schoolId            - School identifier
 * @property {string} studentId           - Student identifier
 * @property {string} schoolAccount       - Destination account
 * @property {string} depositorAccount    - Original payer account
 * @property {number} releasedAmount      - Amount released in stroops
 * @property {number} excessAmount        - Excess returned to payer (0 if none)
 * @property {string} asset               - "XLM" or "USDC"
 * @property {string} feeValidationStatus - "valid" | "overpaid" | "underpaid"
 * @property {string} releasedBy          - Account that triggered release
 */

/**
 * @typedef {object} RefundIssuedData
 * @extends ContractEventCommon
 * @property {string} paymentId        - Original escrow/payment identifier
 * @property {string} refundTxHash     - Transaction hash of the refund operation
 * @property {string} schoolId         - School identifier
 * @property {string} studentId        - Student identifier
 * @property {string} depositorAccount - Account receiving the refund
 * @property {string} schoolAccount    - School account (for reconciliation)
 * @property {number} refundAmount     - Amount refunded in stroops
 * @property {string} asset            - "XLM" or "USDC"
 * @property {string} reason           - Refund reason code
 * @property {string} initiatedBy      - Account that initiated the refund
 */

/**
 * @typedef {object} DisputeRaisedData
 * @extends ContractEventCommon
 * @property {string} paymentId        - Payment under dispute
 * @property {string} disputeId        - Unique dispute identifier
 * @property {string} schoolId         - School identifier
 * @property {string} studentId        - Student identifier
 * @property {string} raisedBy         - Account that raised the dispute
 * @property {string} schoolAccount    - School account
 * @property {string} depositorAccount - Payer account
 * @property {number} disputedAmount   - Amount under dispute in stroops
 * @property {string} asset            - "XLM" or "USDC"
 * @property {string} reasonCode       - Machine-readable reason code
 * @property {number} slaDeadlineMs    - SLA deadline timestamp (ms)
 */

/**
 * @typedef {object} DisputeResolvedData
 * @extends ContractEventCommon
 * @property {string}      paymentId        - Payment that was under dispute
 * @property {string}      disputeId        - Unique dispute identifier
 * @property {string}      schoolId         - School identifier
 * @property {string}      studentId        - Student identifier
 * @property {string}      resolvedBy       - Account that resolved the dispute
 * @property {string}      schoolAccount    - School account
 * @property {string}      depositorAccount - Payer account
 * @property {string}      outcome          - Resolution outcome code
 * @property {number}      schoolAmount     - Amount to school in stroops
 * @property {number}      depositorAmount  - Amount to depositor in stroops
 * @property {string}      asset            - "XLM" or "USDC"
 * @property {string|null} resolutionNote   - Optional human-readable note
 */

/**
 * @typedef {object} ContractEvent
 * @property {string[]} topics - Topic array: [namespace, eventType, ...indexedFields]
 * @property {EscrowCreatedData|FundsReleasedData|RefundIssuedData|DisputeRaisedData|DisputeResolvedData} data
 */

// ─── Field schemas ────────────────────────────────────────────────────────────

/**
 * Per-field validation specs.
 *
 * Each entry is: { type, required, enum?, minValue?, label }
 *   - type:     'string' | 'number' | 'stroops'
 *   - stroops:  non-negative integer
 *   - required: true = error if absent; false = warning only
 */

const COMMON_FIELDS = {
  schemaVersion:  { type: 'number',  required: true,  label: 'schemaVersion' },
  contractId:     { type: 'string',  required: true,  label: 'contractId' },
  ledgerSequence: { type: 'number',  required: true,  label: 'ledgerSequence' },
  timestampMs:    { type: 'number',  required: true,  label: 'timestampMs' },
};

/** @type {Record<string, object>} Field specs indexed by event type */
const CONTRACT_EVENT_SCHEMAS = Object.freeze({
  [EVENT_TYPES.ESCROW_CREATED]: {
    ...COMMON_FIELDS,
    paymentId:         { type: 'string',  required: true },
    schoolId:          { type: 'string',  required: true },
    studentId:         { type: 'string',  required: true },
    schoolAccount:     { type: 'string',  required: true },
    depositorAccount:  { type: 'string',  required: true },
    amount:            { type: 'stroops', required: true },
    asset:             { type: 'string',  required: true, enum: ASSETS },
    feeCategory:       { type: 'string',  required: true },
    expectedFeeAmount: { type: 'stroops', required: true },
    memoText:          { type: 'string',  required: true },
    expiresAtMs:       { type: 'number',  required: true },
  },

  [EVENT_TYPES.FUNDS_RELEASED]: {
    ...COMMON_FIELDS,
    paymentId:           { type: 'string',  required: true },
    schoolId:            { type: 'string',  required: true },
    studentId:           { type: 'string',  required: true },
    schoolAccount:       { type: 'string',  required: true },
    depositorAccount:    { type: 'string',  required: true },
    releasedAmount:      { type: 'stroops', required: true },
    excessAmount:        { type: 'stroops', required: true },
    asset:               { type: 'string',  required: true, enum: ASSETS },
    feeValidationStatus: { type: 'string',  required: true, enum: FEE_VALIDATION_STATUSES },
    releasedBy:          { type: 'string',  required: true },
  },

  [EVENT_TYPES.REFUND_ISSUED]: {
    ...COMMON_FIELDS,
    paymentId:        { type: 'string',  required: true },
    refundTxHash:     { type: 'string',  required: true },
    schoolId:         { type: 'string',  required: true },
    studentId:        { type: 'string',  required: true },
    depositorAccount: { type: 'string',  required: true },
    schoolAccount:    { type: 'string',  required: true },
    refundAmount:     { type: 'stroops', required: true },
    asset:            { type: 'string',  required: true, enum: ASSETS },
    reason:           { type: 'string',  required: true, enum: REFUND_REASON_CODES },
    initiatedBy:      { type: 'string',  required: true },
  },

  [EVENT_TYPES.DISPUTE_RAISED]: {
    ...COMMON_FIELDS,
    paymentId:        { type: 'string',  required: true },
    disputeId:        { type: 'string',  required: true },
    schoolId:         { type: 'string',  required: true },
    studentId:        { type: 'string',  required: true },
    raisedBy:         { type: 'string',  required: true },
    schoolAccount:    { type: 'string',  required: true },
    depositorAccount: { type: 'string',  required: true },
    disputedAmount:   { type: 'stroops', required: true },
    asset:            { type: 'string',  required: true, enum: ASSETS },
    reasonCode:       { type: 'string',  required: true, enum: DISPUTE_REASON_CODES },
    slaDeadlineMs:    { type: 'number',  required: true },
  },

  [EVENT_TYPES.DISPUTE_RESOLVED]: {
    ...COMMON_FIELDS,
    paymentId:        { type: 'string',  required: true },
    disputeId:        { type: 'string',  required: true },
    schoolId:         { type: 'string',  required: true },
    studentId:        { type: 'string',  required: true },
    resolvedBy:       { type: 'string',  required: true },
    schoolAccount:    { type: 'string',  required: true },
    depositorAccount: { type: 'string',  required: true },
    outcome:          { type: 'string',  required: true, enum: DISPUTE_OUTCOMES },
    schoolAmount:     { type: 'stroops', required: true },
    depositorAmount:  { type: 'stroops', required: true },
    asset:            { type: 'string',  required: true, enum: ASSETS },
    resolutionNote:   { type: 'string',  required: false },  // optional
  },
});

// ─── Validator ────────────────────────────────────────────────────────────────

/**
 * Validate a raw contract event object against the schema.
 *
 * Returns a result object instead of throwing, so the parser can decide how
 * to handle partial or unknown-version events.
 *
 * @param {object} event - Raw event with { topics, data }
 * @returns {{ valid: boolean, eventType: string|null, errors: string[], warnings: string[] }}
 */
function validateContractEvent(event) {
  const errors   = [];
  const warnings = [];

  // ── Structure check ───────────────────────────────────────────────────────
  if (!event || typeof event !== 'object') {
    return { valid: false, eventType: null, errors: ['event must be an object'], warnings };
  }
  if (!Array.isArray(event.topics) || event.topics.length < 2) {
    errors.push('event.topics must be an array with at least 2 elements');
  }
  if (!event.data || typeof event.data !== 'object') {
    errors.push('event.data must be an object');
  }
  if (errors.length > 0) {
    return { valid: false, eventType: null, errors, warnings };
  }

  // ── Namespace check ───────────────────────────────────────────────────────
  if (event.topics[0] !== 'escrow') {
    errors.push(`topics[0] must be "escrow", got: ${JSON.stringify(event.topics[0])}`);
  }

  // ── Event type check ──────────────────────────────────────────────────────
  const eventType = event.topics[1];
  if (!eventType || !Object.values(EVENT_TYPES).includes(eventType)) {
    errors.push(
      `topics[1] must be a known event type (${Object.values(EVENT_TYPES).join(', ')}), got: ${JSON.stringify(eventType)}`,
    );
    return { valid: false, eventType: null, errors, warnings };
  }

  // ── Schema version check ──────────────────────────────────────────────────
  const { schemaVersion } = event.data;
  if (schemaVersion !== SCHEMA_VERSION) {
    warnings.push(
      `schemaVersion ${schemaVersion} does not match expected ${SCHEMA_VERSION}. ` +
      'Consumer may need updating.',
    );
  }

  // ── Field-level validation ────────────────────────────────────────────────
  const schema = CONTRACT_EVENT_SCHEMAS[eventType];
  for (const [field, spec] of Object.entries(schema)) {
    const value = event.data[field];

    if (value === undefined || value === null) {
      if (spec.required) {
        errors.push(`data.${field} is required but missing`);
      }
      continue;
    }

    if (spec.type === 'string') {
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`data.${field} must be a non-empty string, got: ${JSON.stringify(value)}`);
      } else if (spec.enum && !spec.enum.includes(value)) {
        errors.push(
          `data.${field} must be one of [${spec.enum.join(', ')}], got: ${JSON.stringify(value)}`,
        );
      }
    } else if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`data.${field} must be a finite number, got: ${JSON.stringify(value)}`);
      }
    } else if (spec.type === 'stroops') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        errors.push(
          `data.${field} must be a non-negative integer (stroops), got: ${JSON.stringify(value)}`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    eventType,
    errors,
    warnings,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Validation
  validateContractEvent,
  CONTRACT_EVENT_SCHEMAS,

  // Re-exported constants from escrowContract for convenience
  EVENT_TYPES,
  ASSETS,
  FEE_VALIDATION_STATUSES,
  REFUND_REASON_CODES,
  DISPUTE_REASON_CODES,
  DISPUTE_OUTCOMES,
  SCHEMA_VERSION,
};
