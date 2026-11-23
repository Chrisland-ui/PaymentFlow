'use strict';

/**
 * Contract Upgrade and Pause Controls (Issue #61).
 *
 * Operational recovery requires explicit, least-privilege controls that are
 * defined in advance and cannot be improvised during an incident.
 *
 * This module defines:
 *   1. Pause / unpause controls with role-gated access (OPERATOR or OWNER can pause;
 *      only OWNER can unpause).
 *   2. Multi-sig upgrade proposal workflow (OWNER proposes, quorum approves, then executes).
 *   3. Rollback record when an upgrade fails (reason + timestamp + proposer).
 *   4. Explicit list of actions that remain available while the contract is paused.
 *   5. Audit trail helpers for all state-changing calls.
 */

const UPGRADE_STATES = {
  IDLE: 'IDLE',
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  ROLLED_BACK: 'ROLLED_BACK',
  COMPLETED: 'COMPLETED',
};

/**
 * Roles allowed to pause the contract.
 * Unpausing is intentionally restricted to OWNER only to prevent an operator
 * from inadvertently re-opening a contract mid-incident.
 */
const PAUSE_ROLES = {
  CAN_PAUSE: ['OWNER', 'OPERATOR'],
  CAN_UNPAUSE: ['OWNER'],
};

/**
 * Minimum number of distinct approvals required before an upgrade can execute.
 * Set to 2 so that a single compromised key cannot unilaterally deploy new code.
 */
const UPGRADE_QUORUM = 2;

/**
 * Actions that remain callable while the contract is paused.
 * Everything else MUST be blocked until the contract is unpaused.
 */
const ALLOWED_ACTIONS_WHILE_PAUSED = Object.freeze(['unpause']);

class UpgradeControlError extends Error {
  /**
   * @param {string} code  Machine-readable error code.
   * @param {string} message Human-readable description.
   * @param {object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UpgradeControlError';
    this.code = code;
    this.details = details;
  }
}

const ERROR_CODES = {
  UNAUTHORIZED_ROLE: 'UNAUTHORIZED_ROLE',
  CONTRACT_PAUSED: 'CONTRACT_PAUSED',
  CONTRACT_NOT_PAUSED: 'CONTRACT_NOT_PAUSED',
  INSUFFICIENT_QUORUM: 'INSUFFICIENT_QUORUM',
  ALREADY_APPROVED: 'ALREADY_APPROVED',
  INVALID_PROPOSAL_STATE: 'INVALID_PROPOSAL_STATE',
  DUPLICATE_PROPOSER: 'DUPLICATE_PROPOSER',
  INVALID_CONTRACT_HASH: 'INVALID_CONTRACT_HASH',
};

// ---------------------------------------------------------------------------
// Pause / Unpause controls
// ---------------------------------------------------------------------------

/**
 * Pauses the contract.  Only OWNER and OPERATOR may do this.
 *
 * @param {string} caller  Public key / identifier of the calling actor.
 * @param {string} role    Role of the calling actor (e.g. 'OWNER', 'OPERATOR').
 * @returns {{ paused: true, pausedBy: string, pausedAt: string }}
 * @throws {UpgradeControlError} When the caller lacks the required role.
 */
function pauseContract(caller, role) {
  if (!PAUSE_ROLES.CAN_PAUSE.includes(role)) {
    throw new UpgradeControlError(
      ERROR_CODES.UNAUTHORIZED_ROLE,
      `Role "${role}" is not permitted to pause the contract. Allowed: ${PAUSE_ROLES.CAN_PAUSE.join(', ')}`,
      { caller, role },
    );
  }

  return {
    paused: true,
    pausedBy: caller,
    pausedAt: new Date().toISOString(),
    role,
  };
}

/**
 * Unpauses the contract.  Only OWNER may do this.
 *
 * @param {string} caller       Public key / identifier of the calling actor.
 * @param {string} role         Role of the calling actor.
 * @param {object} pauseRecord  The record returned by a prior `pauseContract` call.
 * @returns {{ paused: false, unpausedBy: string, unpausedAt: string, pauseDurationMs: number }}
 * @throws {UpgradeControlError} When the caller is not OWNER or the contract is not paused.
 */
function unpauseContract(caller, role, pauseRecord) {
  if (!PAUSE_ROLES.CAN_UNPAUSE.includes(role)) {
    throw new UpgradeControlError(
      ERROR_CODES.UNAUTHORIZED_ROLE,
      `Role "${role}" is not permitted to unpause the contract. Only OWNER can unpause.`,
      { caller, role },
    );
  }

  if (!pauseRecord || !pauseRecord.paused) {
    throw new UpgradeControlError(
      ERROR_CODES.CONTRACT_NOT_PAUSED,
      'Cannot unpause a contract that is not currently paused.',
      { caller },
    );
  }

  const unpausedAt = new Date();
  const pausedAt = new Date(pauseRecord.pausedAt);
  const pauseDurationMs = unpausedAt.getTime() - pausedAt.getTime();

  return {
    paused: false,
    unpausedBy: caller,
    unpausedAt: unpausedAt.toISOString(),
    pauseDurationMs,
    previousPauseRecord: pauseRecord,
  };
}

/**
 * Returns the list of actions that may be invoked while the contract is paused.
 * Callers should consult this list before forwarding any transaction to the contract.
 *
 * @returns {ReadonlyArray<string>}
 */
function getAllowedActionsWhilePaused() {
  return ALLOWED_ACTIONS_WHILE_PAUSED;
}

/**
 * Validates whether a contract action is permitted given the current pause state.
 *
 * @param {string}  action    The action name (e.g. 'deposit', 'release', 'unpause').
 * @param {boolean} isPaused  Current pause state of the contract.
 * @param {string}  role      Role of the calling actor.
 * @returns {{ permitted: true } | { permitted: false, code: string, reason: string }}
 */
function checkActionPermitted(action, isPaused, role) {
  if (!isPaused) {
    return { permitted: true };
  }

  if (action === 'unpause' && PAUSE_ROLES.CAN_UNPAUSE.includes(role)) {
    return { permitted: true };
  }

  if (ALLOWED_ACTIONS_WHILE_PAUSED.includes(action)) {
    // An allowed action while paused but caller lacks role
    if (action === 'unpause') {
      return {
        permitted: false,
        code: ERROR_CODES.UNAUTHORIZED_ROLE,
        reason: `Action "unpause" requires role OWNER; caller has role "${role}".`,
      };
    }
    return { permitted: true };
  }

  return {
    permitted: false,
    code: ERROR_CODES.CONTRACT_PAUSED,
    reason: `Contract is paused. Action "${action}" is not permitted. Allowed while paused: ${ALLOWED_ACTIONS_WHILE_PAUSED.join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Upgrade authorization
// ---------------------------------------------------------------------------

/**
 * Validates whether a given role may propose or execute an upgrade.
 * Upgrades are the highest-privilege operation and are restricted to OWNER only.
 *
 * @param {string} role Role of the calling actor.
 * @returns {{ authorized: true } | { authorized: false, reason: string }}
 */
function validateUpgradeAuthorization(role) {
  if (role === 'OWNER') {
    return { authorized: true };
  }
  return {
    authorized: false,
    reason: `Contract upgrades require role OWNER. Caller has role "${role}". This is a least-privilege control: no other role may propose or execute upgrades.`,
  };
}

// ---------------------------------------------------------------------------
// Multi-sig upgrade proposal workflow
// ---------------------------------------------------------------------------

/**
 * Creates a new upgrade proposal.  Only OWNER may propose an upgrade.
 *
 * @param {string} proposer         Public key of the proposing OWNER.
 * @param {string} role             Role of the proposer (must be 'OWNER').
 * @param {string} newContractHash  Hex-encoded SHA-256 of the new WASM binary.
 * @param {object} [metadata]       Optional metadata (description, migration notes, etc.).
 * @returns {object} Upgrade proposal record.
 * @throws {UpgradeControlError}
 */
function proposeUpgrade(proposer, role, newContractHash, metadata = {}) {
  const authCheck = validateUpgradeAuthorization(role);
  if (!authCheck.authorized) {
    throw new UpgradeControlError(
      ERROR_CODES.UNAUTHORIZED_ROLE,
      authCheck.reason,
      { proposer, role },
    );
  }

  if (!newContractHash || typeof newContractHash !== 'string' || newContractHash.length < 16) {
    throw new UpgradeControlError(
      ERROR_CODES.INVALID_CONTRACT_HASH,
      'newContractHash must be a non-empty hex string representing the WASM binary hash.',
      { newContractHash },
    );
  }

  return {
    state: UPGRADE_STATES.PROPOSED,
    proposer,
    newContractHash,
    metadata,
    approvals: [proposer], // Proposer counts as first approval
    proposedAt: new Date().toISOString(),
    quorumRequired: UPGRADE_QUORUM,
  };
}

/**
 * Adds an approval signature to an existing upgrade proposal.
 *
 * @param {object} proposal  Proposal returned by `proposeUpgrade`.
 * @param {string} approver  Public key of the approving OWNER.
 * @param {string} role      Role of the approver (must be 'OWNER').
 * @returns {object} Updated proposal record.
 * @throws {UpgradeControlError}
 */
function approveUpgrade(proposal, approver, role) {
  if (proposal.state !== UPGRADE_STATES.PROPOSED) {
    throw new UpgradeControlError(
      ERROR_CODES.INVALID_PROPOSAL_STATE,
      `Cannot approve an upgrade in state "${proposal.state}". Proposal must be in PROPOSED state.`,
      { state: proposal.state },
    );
  }

  const authCheck = validateUpgradeAuthorization(role);
  if (!authCheck.authorized) {
    throw new UpgradeControlError(
      ERROR_CODES.UNAUTHORIZED_ROLE,
      authCheck.reason,
      { approver, role },
    );
  }

  if (proposal.approvals.includes(approver)) {
    throw new UpgradeControlError(
      ERROR_CODES.ALREADY_APPROVED,
      `Actor "${approver}" has already approved this upgrade proposal.`,
      { approver },
    );
  }

  const updatedApprovals = [...proposal.approvals, approver];
  const quorumMet = updatedApprovals.length >= proposal.quorumRequired;

  return {
    ...proposal,
    approvals: updatedApprovals,
    state: quorumMet ? UPGRADE_STATES.APPROVED : UPGRADE_STATES.PROPOSED,
    approvedAt: quorumMet ? new Date().toISOString() : undefined,
  };
}

/**
 * Executes an approved upgrade.  All approvals must meet quorum first.
 *
 * @param {object} proposal  Proposal in APPROVED state.
 * @param {string} executor  Public key of the executing actor.
 * @param {string} role      Role of the executor (must be 'OWNER').
 * @returns {object} Updated proposal record in EXECUTING state.
 * @throws {UpgradeControlError}
 */
function executeUpgrade(proposal, executor, role) {
  if (proposal.state !== UPGRADE_STATES.APPROVED) {
    throw new UpgradeControlError(
      ERROR_CODES.INVALID_PROPOSAL_STATE,
      `Cannot execute an upgrade in state "${proposal.state}". Proposal must be APPROVED (quorum met).`,
      { state: proposal.state, approvals: proposal.approvals, quorumRequired: proposal.quorumRequired },
    );
  }

  const authCheck = validateUpgradeAuthorization(role);
  if (!authCheck.authorized) {
    throw new UpgradeControlError(
      ERROR_CODES.UNAUTHORIZED_ROLE,
      authCheck.reason,
      { executor, role },
    );
  }

  if (proposal.approvals.length < proposal.quorumRequired) {
    throw new UpgradeControlError(
      ERROR_CODES.INSUFFICIENT_QUORUM,
      `Upgrade requires ${proposal.quorumRequired} approvals but only ${proposal.approvals.length} collected.`,
      { approvals: proposal.approvals, quorumRequired: proposal.quorumRequired },
    );
  }

  return {
    ...proposal,
    state: UPGRADE_STATES.EXECUTING,
    executor,
    executionStartedAt: new Date().toISOString(),
  };
}

/**
 * Records a rollback after an upgrade execution failure.
 *
 * @param {object} proposal  Proposal in EXECUTING state.
 * @param {string} reason    Human-readable description of why the upgrade failed.
 * @param {string} [rolledBackBy] Public key of the actor initiating the rollback.
 * @returns {object} Updated proposal record in ROLLED_BACK state.
 * @throws {UpgradeControlError}
 */
function rollbackUpgrade(proposal, reason, rolledBackBy = 'SYSTEM') {
  if (![UPGRADE_STATES.EXECUTING, UPGRADE_STATES.APPROVED].includes(proposal.state)) {
    throw new UpgradeControlError(
      ERROR_CODES.INVALID_PROPOSAL_STATE,
      `Cannot roll back an upgrade in state "${proposal.state}". Only EXECUTING or APPROVED upgrades can be rolled back.`,
      { state: proposal.state },
    );
  }

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new UpgradeControlError(
      ERROR_CODES.INVALID_PROPOSAL_STATE,
      'A non-empty reason is required when rolling back an upgrade.',
    );
  }

  return {
    ...proposal,
    state: UPGRADE_STATES.ROLLED_BACK,
    rollback: {
      reason: reason.trim(),
      rolledBackBy,
      rolledBackAt: new Date().toISOString(),
      previousState: proposal.state,
    },
  };
}

module.exports = {
  // Constants
  UPGRADE_STATES,
  PAUSE_ROLES,
  UPGRADE_QUORUM,
  ALLOWED_ACTIONS_WHILE_PAUSED,
  ERROR_CODES,

  // Errors
  UpgradeControlError,

  // Pause / unpause
  pauseContract,
  unpauseContract,
  getAllowedActionsWhilePaused,
  checkActionPermitted,

  // Upgrade lifecycle
  validateUpgradeAuthorization,
  proposeUpgrade,
  approveUpgrade,
  executeUpgrade,
  rollbackUpgrade,
};
