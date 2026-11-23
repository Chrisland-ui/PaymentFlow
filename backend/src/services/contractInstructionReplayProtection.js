'use strict';

/**
 * Replay Protection for Contract Instructions (Issue #57).
 *
 * Repeated submission of a valid contract instruction (such as deposits,
 * releases, refunds, or dispute resolutions) can produce duplicate releases,
 * double-spends, or state corruption.
 *
 * This module enforces:
 *   1. Nonce and Operation-ID semantics for strict one-time execution.
 *   2. Replay detection that rejects duplicate submissions without changing state.
 *   3. Safe concurrent convergence so race conditions resolve deterministically.
 *   4. Inclusion of Operation IDs in all audit traces.
 */

const crypto = require('crypto');

let auditService = null;
try {
  auditService = require('./auditService');
} catch {
  auditService = null;
}

const INSTRUCTION_STATUS = {
  PENDING: 'PENDING',
  COMMITTED: 'COMMITTED',
  FAILED: 'FAILED',
};

const ERROR_CODES = {
  INVALID_OPERATION_ID: 'INVALID_OPERATION_ID',
  OPERATION_ALREADY_COMMITTED: 'OPERATION_ALREADY_COMMITTED',
  OPERATION_PAYLOAD_MISMATCH: 'OPERATION_PAYLOAD_MISMATCH',
  CONCURRENT_IN_PROGRESS: 'CONCURRENT_IN_PROGRESS',
  INVALID_NONCE: 'INVALID_NONCE',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
};

class ContractInstructionReplayError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContractInstructionReplayError';
    this.code = code;
    this.details = details;
  }
}

/**
 * In-memory instruction registry.
 * Maps operationId -> {
 *   operationId,
 *   instructionType,
 *   contractAddress,
 *   payloadHash,
 *   actor,
 *   status,
 *   result,
 *   createdAt,
 *   executedAt,
 *   replayCount
 * }
 */
const instructionStore = new Map();

/**
 * In-memory in-flight promise map for safe concurrency convergence.
 * Maps operationId -> Promise<{ status, result }>
 */
const inFlightOperations = new Map();

/**
 * In-memory nonce tracking per account/scope.
 * Maps accountIdentifier -> currentNonce (bigint)
 */
const accountNonces = new Map();

/**
 * Dedicated structured audit trace storage for audit logging and tracing.
 */
const auditTraces = [];

/**
 * Generates a deterministic SHA-256 hash of the instruction payload.
 *
 * @param {object|string} payload
 * @returns {string} Hex hash
 */
function hashPayload(payload) {
  const normalized = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(normalized || '').digest('hex');
}

/**
 * Records an audit trace event ensuring operationId is strictly present.
 *
 * @param {object} trace
 * @param {string} trace.operationId
 * @param {string} trace.action
 * @param {string} trace.instructionType
 * @param {string} trace.actor
 * @param {string} [trace.contractAddress]
 * @param {string} trace.status
 * @param {object} [trace.details]
 */
async function recordAuditTrace({
  operationId,
  action,
  instructionType,
  actor,
  contractAddress = null,
  status,
  details = {},
}) {
  if (!operationId) {
    throw new ContractInstructionReplayError(
      ERROR_CODES.INVALID_OPERATION_ID,
      'Operation ID is required in audit traces'
    );
  }

  const traceRecord = {
    traceId: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    operationId,
    action,
    instructionType,
    actor: actor || 'UNKNOWN',
    contractAddress,
    status,
    details,
    timestamp: new Date().toISOString(),
  };

  auditTraces.push(traceRecord);

  // Forward to centralized auditService if available
  if (auditService && typeof auditService.logAudit === 'function') {
    try {
      await auditService.logAudit({
        schoolId: details.schoolId || 'CONTRACT_SYSTEM',
        userId: actor || 'CONTRACT_CALLER',
        action: `CONTRACT_${action}`,
        details: {
          operationId,
          instructionType,
          status,
          contractAddress,
          ...details,
        },
      });
    } catch {
      // Prevent audit forwarding failures from interrupting critical path
    }
  }

  return traceRecord;
}

/**
 * Validates sequential nonce for an account (if sequential nonce semantics used).
 *
 * @param {string} account
 * @param {bigint|number|string} expectedNonce
 * @returns {boolean}
 */
function verifyAndConsumeNonce(account, expectedNonce) {
  if (!account) return false;
  const current = accountNonces.get(account) || 0n;
  const target = BigInt(expectedNonce);

  if (target !== current + 1n) {
    throw new ContractInstructionReplayError(
      ERROR_CODES.INVALID_NONCE,
      `Invalid sequence nonce for ${account}: expected ${(current + 1n).toString()}, received ${target.toString()}`,
      { account, currentNonce: current.toString(), expectedNonce: target.toString() }
    );
  }

  accountNonces.set(account, target);
  return true;
}

/**
 * Executes a contract instruction with strict replay protection and concurrency convergence.
 *
 * Guarantees:
 *   1. If operationId was already COMMITTED and payload matches: Replay is rejected without
 *      calling executeFn or changing state. The original result is returned.
 *   2. If operationId was already COMMITTED but payload differs: Replay is rejected with
 *      OPERATION_PAYLOAD_MISMATCH (anti-tampering).
 *   3. If operationId is in-flight (concurrent submissions): All callers await the in-flight
 *      execution, converging safely on the exact same result with only one invocation of executeFn.
 *   4. All actions include the operationId in the audit trace log.
 *
 * @param {object} params
 * @param {string} params.operationId Unique instruction/operation identifier
 * @param {string} params.instructionType Type of instruction (e.g. 'DEPOSIT', 'RELEASE', 'REFUND')
 * @param {string} [params.contractAddress] Contract or school address
 * @param {object} params.payload Instruction parameters
 * @param {string} params.actor Signer or caller public key
 * @param {Function} params.executeFn State-mutating business logic callback
 * @param {boolean} [params.throwOnReplay=false] If true, throws on replay instead of returning idempotent result
 * @param {object} [params.auditDetails]
 * @returns {Promise<{ status: string, operationId: string, result: any, stateMutated: boolean }>}
 */
async function executeInstructionWithReplayProtection({
  operationId,
  instructionType,
  contractAddress = null,
  payload = {},
  actor = 'UNKNOWN',
  executeFn,
  throwOnReplay = false,
  auditDetails = {},
}) {
  if (!operationId || typeof operationId !== 'string' || !operationId.trim()) {
    throw new ContractInstructionReplayError(
      ERROR_CODES.INVALID_OPERATION_ID,
      'Valid non-empty operationId is required'
    );
  }

  if (typeof executeFn !== 'function') {
    throw new TypeError('executeFn must be an executable function');
  }

  const opId = operationId.trim();
  const payloadChecksum = hashPayload(payload);

  // 1. Check existing recorded operations
  const existing = instructionStore.get(opId);
  if (existing) {
    if (existing.status === INSTRUCTION_STATUS.COMMITTED) {
      if (existing.payloadHash !== payloadChecksum) {
        await recordAuditTrace({
          operationId: opId,
          action: 'REPLAY_PAYLOAD_MISMATCH',
          instructionType,
          actor,
          contractAddress,
          status: 'REJECTED',
          details: { reason: 'Payload hash conflict with previously committed operation', ...auditDetails },
        });

        throw new ContractInstructionReplayError(
          ERROR_CODES.OPERATION_PAYLOAD_MISMATCH,
          `Operation ID "${opId}" already executed with different parameters`,
          { operationId: opId, originalExecutedAt: existing.executedAt }
        );
      }

      // Replay of identical valid operation: reject execution without mutating state
      existing.replayCount = (existing.replayCount || 0) + 1;

      await recordAuditTrace({
        operationId: opId,
        action: 'REPLAY_REJECTED_IDEMPOTENT',
        instructionType,
        actor,
        contractAddress,
        status: 'IDEMPOTENT_SKIPPED',
        details: { replayCount: existing.replayCount, ...auditDetails },
      });

      if (throwOnReplay) {
        throw new ContractInstructionReplayError(
          ERROR_CODES.OPERATION_ALREADY_COMMITTED,
          `Operation ID "${opId}" already committed`,
          { operationId: opId, result: existing.result }
        );
      }

      return {
        status: 'REPLAY_IDEMPOTENT',
        operationId: opId,
        result: existing.result,
        stateMutated: false,
        executedAt: existing.executedAt,
      };
    }
  }

  // 2. Safe Concurrent Convergence
  // If an execution for this operationId is currently in progress, join its promise
  if (inFlightOperations.has(opId)) {
    await recordAuditTrace({
      operationId: opId,
      action: 'CONCURRENT_EXECUTION_JOINED',
      instructionType,
      actor,
      contractAddress,
      status: 'AWAITING_CONVERGENCE',
      details: { reason: 'Concurrent request safely joined in-flight promise', ...auditDetails },
    });

    const convergedResult = await inFlightOperations.get(opId);
    return {
      status: 'CONVERGED',
      operationId: opId,
      result: convergedResult,
      stateMutated: false,
    };
  }

  // 3. Register as in-flight
  const executionPromise = (async () => {
    instructionStore.set(opId, {
      operationId: opId,
      instructionType,
      contractAddress,
      payloadHash: payloadChecksum,
      actor,
      status: INSTRUCTION_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      replayCount: 0,
    });

    await recordAuditTrace({
      operationId: opId,
      action: 'INSTRUCTION_START',
      instructionType,
      actor,
      contractAddress,
      status: INSTRUCTION_STATUS.PENDING,
      details: auditDetails,
    });

    try {
      // Execute the business logic / state mutation
      const executionResult = await executeFn();

      const committedRecord = {
        operationId: opId,
        instructionType,
        contractAddress,
        payloadHash: payloadChecksum,
        actor,
        status: INSTRUCTION_STATUS.COMMITTED,
        result: executionResult,
        executedAt: new Date().toISOString(),
        replayCount: 0,
      };
      instructionStore.set(opId, committedRecord);

      await recordAuditTrace({
        operationId: opId,
        action: 'INSTRUCTION_COMMITTED',
        instructionType,
        actor,
        contractAddress,
        status: INSTRUCTION_STATUS.COMMITTED,
        details: auditDetails,
      });

      return executionResult;
    } catch (err) {
      instructionStore.set(opId, {
        operationId: opId,
        instructionType,
        contractAddress,
        payloadHash: payloadChecksum,
        actor,
        status: INSTRUCTION_STATUS.FAILED,
        error: err.message,
        failedAt: new Date().toISOString(),
        replayCount: 0,
      });

      await recordAuditTrace({
        operationId: opId,
        action: 'INSTRUCTION_FAILED',
        instructionType,
        actor,
        contractAddress,
        status: INSTRUCTION_STATUS.FAILED,
        details: { error: err.message, ...auditDetails },
      });

      throw err;
    } finally {
      inFlightOperations.delete(opId);
    }
  })();

  inFlightOperations.set(opId, executionPromise);

  const finalResult = await executionPromise;
  return {
    status: 'COMMITTED',
    operationId: opId,
    result: finalResult,
    stateMutated: true,
  };
}

/**
 * Retrieves all audit traces for a specific operation ID.
 *
 * @param {string} operationId
 * @returns {object[]}
 */
function getAuditTracesForOperation(operationId) {
  if (!operationId) return [];
  return auditTraces.filter((t) => t.operationId === operationId);
}

/**
 * Resets stores (for testing / teardown).
 */
function clearStores() {
  instructionStore.clear();
  inFlightOperations.clear();
  accountNonces.clear();
  auditTraces.length = 0;
}

module.exports = {
  INSTRUCTION_STATUS,
  ERROR_CODES,
  ContractInstructionReplayError,
  hashPayload,
  verifyAndConsumeNonce,
  executeInstructionWithReplayProtection,
  recordAuditTrace,
  getAuditTracesForOperation,
  clearStores,
};
