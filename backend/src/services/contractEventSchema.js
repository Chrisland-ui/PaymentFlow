'use strict';

/**
 * Contract Event Schema & Indexing Service (Issue #59).
 *
 * Off-chain reconciliation and data indexing need stable, versioned events for
 * deposits, releases, refunds, and disputes.
 *
 * This module defines:
 *   1. Event topics and payloads with strict versioning and correlation IDs.
 *   2. Rich payloads with enough data to rebuild projections from scratch.
 *   3. Idempotent processing semantics for indexers.
 *   4. Schema compatibility validation (forward & backward compatibility).
 */

const crypto = require('crypto');

const CURRENT_SCHEMA_VERSION = '1.0.0';
const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0'];

const CONTRACT_EVENT_TOPICS = {
  DEPOSIT: 'deposit',
  RELEASE: 'release',
  REFUND: 'refund',
  DISPUTE: 'dispute',
};

const DISPUTE_STATUSES = [
  'opened',
  'under_review',
  'resolved_refund',
  'resolved_release',
  'dismissed',
];

class ContractEventSchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContractEventSchemaError';
    this.details = details;
  }
}

/**
 * Validates common event header fields.
 *
 * @param {object} event
 */
function validateEventHeader(event) {
  if (!event || typeof event !== 'object') {
    throw new ContractEventSchemaError('Event must be a valid object');
  }

  const { eventId, eventVersion, topic, contractId, ledger, txHash, timestamp, correlationId } = event;

  if (!eventId || typeof eventId !== 'string' || !eventId.trim()) {
    throw new ContractEventSchemaError('Event missing required non-empty "eventId"');
  }

  if (!eventVersion || !SUPPORTED_SCHEMA_VERSIONS.includes(eventVersion)) {
    throw new ContractEventSchemaError(
      `Unsupported eventVersion "${eventVersion}". Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      { eventVersion }
    );
  }

  if (!topic || !Object.values(CONTRACT_EVENT_TOPICS).includes(topic)) {
    throw new ContractEventSchemaError(
      `Invalid or unknown topic "${topic}". Supported: ${Object.values(CONTRACT_EVENT_TOPICS).join(', ')}`,
      { topic }
    );
  }

  if (!contractId || typeof contractId !== 'string') {
    throw new ContractEventSchemaError('Event missing required "contractId"');
  }

  if (typeof ledger !== 'number' || ledger < 0) {
    throw new ContractEventSchemaError('Event missing valid non-negative integer "ledger" sequence');
  }

  if (!txHash || typeof txHash !== 'string' || txHash.length < 32) {
    throw new ContractEventSchemaError('Event missing valid transaction hash "txHash"');
  }

  if (!timestamp || isNaN(Date.parse(timestamp))) {
    throw new ContractEventSchemaError('Event missing valid ISO-8601 "timestamp"');
  }

  if (!correlationId || typeof correlationId !== 'string' || !correlationId.trim()) {
    throw new ContractEventSchemaError('Event missing required non-empty "correlationId"');
  }

  return true;
}

/**
 * Validates payload structure against topic specification.
 *
 * @param {string} topic
 * @param {object} payload
 */
function validateTopicPayload(topic, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ContractEventSchemaError(`Payload for topic "${topic}" must be an object`);
  }

  const { studentId, schoolId, asset, amountStroops, amountDecimal } = payload;

  if (!studentId || typeof studentId !== 'string') {
    throw new ContractEventSchemaError(`Topic "${topic}" payload missing required "studentId"`);
  }

  if (!schoolId || typeof schoolId !== 'string') {
    throw new ContractEventSchemaError(`Topic "${topic}" payload missing required "schoolId"`);
  }

  if (!asset || typeof asset !== 'object' || !asset.code) {
    throw new ContractEventSchemaError(`Topic "${topic}" payload missing required "asset" object with code`);
  }

  if (amountStroops === undefined || amountStroops === null) {
    throw new ContractEventSchemaError(`Topic "${topic}" payload missing required "amountStroops"`);
  }

  if (!amountDecimal || typeof amountDecimal !== 'string') {
    throw new ContractEventSchemaError(`Topic "${topic}" payload missing required "amountDecimal" string`);
  }

  switch (topic) {
    case CONTRACT_EVENT_TOPICS.DEPOSIT:
      if (!payload.payer || typeof payload.payer !== 'string') {
        throw new ContractEventSchemaError('Deposit payload missing required "payer" address');
      }
      break;

    case CONTRACT_EVENT_TOPICS.RELEASE:
      if (!payload.beneficiary || typeof payload.beneficiary !== 'string') {
        throw new ContractEventSchemaError('Release payload missing required "beneficiary" address');
      }
      if (!payload.authorizedBy || typeof payload.authorizedBy !== 'string') {
        throw new ContractEventSchemaError('Release payload missing required "authorizedBy"');
      }
      break;

    case CONTRACT_EVENT_TOPICS.REFUND:
      if (!payload.recipient || typeof payload.recipient !== 'string') {
        throw new ContractEventSchemaError('Refund payload missing required "recipient" address');
      }
      if (!payload.reason || typeof payload.reason !== 'string') {
        throw new ContractEventSchemaError('Refund payload missing required "reason"');
      }
      if (!payload.authorizedBy || typeof payload.authorizedBy !== 'string') {
        throw new ContractEventSchemaError('Refund payload missing required "authorizedBy"');
      }
      break;

    case CONTRACT_EVENT_TOPICS.DISPUTE:
      if (!payload.disputeId || typeof payload.disputeId !== 'string') {
        throw new ContractEventSchemaError('Dispute payload missing required "disputeId"');
      }
      if (!payload.initiator || typeof payload.initiator !== 'string') {
        throw new ContractEventSchemaError('Dispute payload missing required "initiator"');
      }
      if (!payload.status || !DISPUTE_STATUSES.includes(payload.status)) {
        throw new ContractEventSchemaError(
          `Dispute payload invalid status "${payload.status}". Valid: ${DISPUTE_STATUSES.join(', ')}`
        );
      }
      if (!payload.reason || typeof payload.reason !== 'string') {
        throw new ContractEventSchemaError('Dispute payload missing required "reason"');
      }
      break;

    default:
      throw new ContractEventSchemaError(`Unhandled topic validation: ${topic}`);
  }

  return true;
}

/**
 * Validates a contract event against the schema.
 *
 * @param {object} event
 * @returns {boolean} True if event is valid
 */
function validateContractEvent(event) {
  validateEventHeader(event);
  validateTopicPayload(event.topic, event.payload);
  return true;
}

/**
 * Factory for creating a validated contract event object.
 *
 * @param {string} topic
 * @param {object} params
 * @param {string} [params.eventId]
 * @param {string} [params.eventVersion]
 * @param {string} params.contractId
 * @param {number} params.ledger
 * @param {string} params.txHash
 * @param {string} [params.timestamp]
 * @param {string} params.correlationId
 * @param {object} params.payload
 * @returns {object} Validated contract event
 */
function createContractEvent(topic, {
  eventId = null,
  eventVersion = CURRENT_SCHEMA_VERSION,
  contractId,
  ledger,
  txHash,
  timestamp = null,
  correlationId,
  payload,
}) {
  const generatedEventId = eventId || `${txHash}:${topic}:${crypto.randomBytes(4).toString('hex')}`;
  const generatedTimestamp = timestamp || new Date().toISOString();

  const event = {
    eventId: generatedEventId,
    eventVersion,
    topic,
    contractId,
    ledger,
    txHash,
    timestamp: generatedTimestamp,
    correlationId,
    payload,
  };

  validateContractEvent(event);
  return event;
}

/**
 * Idempotently processes an event into an in-memory or projection state.
 *
 * Guarantees that applying the same event multiple times produces identical state
 * without double-crediting or duplicate mutations.
 *
 * @param {object} event
 * @param {object} projection Current state projection
 * @param {Set<string>} processedEventIds Set of already processed event IDs
 * @returns {{ processed: boolean, reason?: string, projection: object }}
 */
function processEventIdempotently(event, projection, processedEventIds) {
  validateContractEvent(event);

  if (processedEventIds.has(event.eventId)) {
    return {
      processed: false,
      reason: 'duplicate_event',
      projection,
    };
  }

  const { topic, payload, eventId } = event;
  const stroops = BigInt(payload.amountStroops);
  const studentId = payload.studentId;

  // Initialize projection student record if needed
  if (!projection.students) projection.students = {};
  if (!projection.students[studentId]) {
    projection.students[studentId] = {
      depositedStroops: 0n,
      releasedStroops: 0n,
      refundedStroops: 0n,
      activeDisputes: 0,
      history: [],
    };
  }

  const studentState = projection.students[studentId];

  switch (topic) {
    case CONTRACT_EVENT_TOPICS.DEPOSIT:
      studentState.depositedStroops += stroops;
      break;

    case CONTRACT_EVENT_TOPICS.RELEASE:
      studentState.releasedStroops += stroops;
      break;

    case CONTRACT_EVENT_TOPICS.REFUND:
      studentState.refundedStroops += stroops;
      break;

    case CONTRACT_EVENT_TOPICS.DISPUTE:
      if (payload.status === 'opened') {
        studentState.activeDisputes += 1;
      } else if (payload.status === 'resolved_refund' || payload.status === 'resolved_release' || payload.status === 'dismissed') {
        studentState.activeDisputes = Math.max(0, studentState.activeDisputes - 1);
      }
      break;
  }

  studentState.history.push({
    eventId,
    topic,
    ledger: event.ledger,
    timestamp: event.timestamp,
    correlationId: event.correlationId,
  });

  processedEventIds.add(eventId);

  return {
    processed: true,
    projection,
  };
}

/**
 * Rebuilds state projections from an array / stream of contract events from scratch.
 *
 * @param {object[]} events
 * @param {object} [initialProjection]
 * @returns {object} Rebuilt projection
 */
function rebuildProjectionFromEvents(events, initialProjection = null) {
  const projection = initialProjection ? JSON.parse(JSON.stringify(initialProjection)) : { students: {} };
  const processedEventIds = new Set();

  // Sort events chronologically by ledger sequence
  const sorted = [...events].sort((a, b) => (a.ledger || 0) - (b.ledger || 0));

  for (const ev of sorted) {
    processEventIdempotently(ev, projection, processedEventIds);
  }

  return projection;
}

/**
 * Validates forward and backward schema compatibility.
 *
 * Rules:
 *   - Additional unexpected optional fields in payload must NOT break indexer validation.
 *   - Events with supported major version are accepted.
 *
 * @param {object} event
 * @param {string} [targetVersion='1.0.0']
 * @returns {{ compatible: boolean, reason?: string }}
 */
function validateSchemaCompatibility(event, targetVersion = CURRENT_SCHEMA_VERSION) {
  try {
    validateEventHeader(event);

    const [major] = (event.eventVersion || '').split('.');
    const [targetMajor] = targetVersion.split('.');

    if (major !== targetMajor) {
      return {
        compatible: false,
        reason: `Major version mismatch: event has ${event.eventVersion}, expected compatible with ${targetVersion}`,
      };
    }

    validateTopicPayload(event.topic, event.payload);
    return { compatible: true };
  } catch (err) {
    return { compatible: false, reason: err.message };
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  CONTRACT_EVENT_TOPICS,
  DISPUTE_STATUSES,
  ContractEventSchemaError,
  validateContractEvent,
  createContractEvent,
  processEventIdempotently,
  rebuildProjectionFromEvents,
  validateSchemaCompatibility,
};
