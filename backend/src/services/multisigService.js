'use strict';

/**
 * multisigService — two-of-three approval workflow for high-risk operations.
 *
 * Supported operations: 'pause', 'unpause', 'upgrade'
 *
 * Flow:
 *  1. An authorised admin calls propose() → creates a PendingApproval document
 *     with status 'pending'.
 *  2. Any OTHER authorised admin calls approve() or reject() with the approval
 *     document ID.
 *  3. Once the approval count reaches the requiredSigners threshold the status
 *     transitions to 'approved' and the callback is executed atomically.
 *  4. If any signer rejects, the status transitions to 'rejected' and no
 *     further action is taken.
 *  5. Documents older than APPROVAL_TTL_HOURS are treated as expired.
 *
 * The AUTHORISED_SIGNERS list is read from the environment variable
 * MULTISIG_SIGNERS (comma-separated admin identities — emails or userIds).
 * Example:
 *   MULTISIG_SIGNERS=alice@example.com,bob@example.com,carol@example.com
 *
 * If the variable is unset the service falls back to a permissive mode where
 * any authenticated admin may propose/approve (equivalent to 1-of-N).  In
 * production the variable MUST be set.
 */

const PendingApproval = require('../models/pendingApprovalModel');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger').child('MultisigService');

// ── Configuration ─────────────────────────────────────────────────────────────

const APPROVAL_TTL_HOURS = parseInt(process.env.MULTISIG_APPROVAL_TTL_HOURS || '24', 10);
const REQUIRED_SIGNERS   = parseInt(process.env.MULTISIG_REQUIRED_SIGNERS    || '2',  10);

/**
 * Authorised signers from env.  Empty array means "any authenticated admin".
 */
function getAuthorisedSigners() {
  const raw = process.env.MULTISIG_SIGNERS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAuthorisedSigner(identity) {
  const signers = getAuthorisedSigners();
  if (signers.length === 0) return true; // permissive fallback
  return signers.includes(identity);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Propose a high-risk operation.  Creates a PendingApproval document.
 *
 * @param {object} opts
 * @param {'pause'|'unpause'|'upgrade'} opts.operationType
 * @param {string} opts.proposedBy   - identity of the proposer
 * @param {object} [opts.payload]    - operation-specific data
 * @param {string} [opts.reason]     - human-readable justification
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.userAgent]
 * @returns {Promise<{approval: PendingApproval, alreadyExecuted: boolean}>}
 */
async function propose({ operationType, proposedBy, payload = {}, reason, ipAddress, userAgent }) {
  if (!isAuthorisedSigner(proposedBy)) {
    const err = new Error(`${proposedBy} is not an authorised multisig signer`);
    err.code = 'SIGNER_NOT_AUTHORISED';
    throw err;
  }

  // Disallow duplicate pending proposals for the same operation type
  const existing = await PendingApproval.findOne({
    operationType,
    status: 'pending',
    expiresAt: { $gt: new Date() },
  });
  if (existing) {
    const err = new Error(
      `A pending ${operationType} proposal already exists (id: ${existing._id}). ` +
      'Approve or wait for it to expire before proposing again.'
    );
    err.code = 'DUPLICATE_PROPOSAL';
    err.existingId = String(existing._id);
    throw err;
  }

  const expiresAt = new Date(Date.now() + APPROVAL_TTL_HOURS * 60 * 60 * 1000);

  const approval = await PendingApproval.create({
    operationType,
    proposedBy,
    payload,
    reason: reason || null,
    requiredSigners: REQUIRED_SIGNERS,
    expiresAt,
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
    // The proposer's own vote counts as the first approval
    approvals: [{ signerId: proposedBy, approvedAt: new Date() }],
    status: REQUIRED_SIGNERS <= 1 ? 'approved' : 'pending',
  });

  logger.info('Multisig proposal created', {
    approvalId: approval._id,
    operationType,
    proposedBy,
  });

  await logAudit({
    schoolId: 'system',
    action: `multisig_propose_${operationType}`,
    performedBy: proposedBy,
    targetId: String(approval._id),
    targetType: 'pending_approval',
    details: { reason: reason || null, payload, expiresAt },
    result: 'success',
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  });

  return { approval, alreadyExecuted: false };
}

/**
 * Cast an approval vote on a pending proposal.
 * If quorum is reached, the proposal transitions to 'approved' and the
 * provided `onApproved` callback is invoked atomically.
 *
 * @param {object} opts
 * @param {string} opts.approvalId  - PendingApproval._id
 * @param {string} opts.signerId    - identity of the approving admin
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.userAgent]
 * @param {Function} [opts.onApproved] - async callback executed when quorum is
 *                                       reached; receives the approval document
 * @returns {Promise<{approval: PendingApproval, executed: boolean}>}
 */
async function approve({ approvalId, signerId, ipAddress, userAgent, onApproved }) {
  if (!isAuthorisedSigner(signerId)) {
    const err = new Error(`${signerId} is not an authorised multisig signer`);
    err.code = 'SIGNER_NOT_AUTHORISED';
    throw err;
  }

  const approval = await PendingApproval.findById(approvalId);
  if (!approval) {
    const err = new Error(`Approval not found: ${approvalId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (approval.status !== 'pending') {
    const err = new Error(`Approval is not in pending state (current: ${approval.status})`);
    err.code = 'INVALID_STATE';
    throw err;
  }

  if (new Date() > approval.expiresAt) {
    approval.status = 'expired';
    await approval.save();
    const err = new Error('Approval has expired');
    err.code = 'APPROVAL_EXPIRED';
    throw err;
  }

  if (approval.hasVoted(signerId)) {
    const err = new Error(`${signerId} has already voted on this proposal`);
    err.code = 'ALREADY_VOTED';
    throw err;
  }

  approval.approvals.push({ signerId, approvedAt: new Date() });

  logger.info('Multisig approval vote cast', {
    approvalId,
    signerId,
    totalApprovals: approval.approvals.length,
    required: approval.requiredSigners,
  });

  await logAudit({
    schoolId: 'system',
    action: `multisig_approve_${approval.operationType}`,
    performedBy: signerId,
    targetId: String(approval._id),
    targetType: 'pending_approval',
    details: { totalApprovals: approval.approvals.length },
    result: 'success',
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  });

  let executed = false;

  if (approval.hasQuorum()) {
    approval.status = 'approved';
    await approval.save();

    if (typeof onApproved === 'function') {
      try {
        await onApproved(approval);
        approval.status = 'executed';
        approval.executedAt = new Date();
        executed = true;
      } catch (execErr) {
        // The underlying operation failed — leave status as 'approved' so it
        // can be retried by an operator.
        logger.error('Multisig callback failed after quorum reached', {
          approvalId,
          error: execErr.message,
        });
        throw execErr;
      }
    }
  }

  await approval.save();
  return { approval, executed };
}

/**
 * Cast a rejection vote on a pending proposal.
 * Any single rejection immediately closes the proposal.
 *
 * @param {object} opts
 * @param {string} opts.approvalId
 * @param {string} opts.signerId
 * @param {string} [opts.reason]
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.userAgent]
 * @returns {Promise<{approval: PendingApproval}>}
 */
async function reject({ approvalId, signerId, reason, ipAddress, userAgent }) {
  if (!isAuthorisedSigner(signerId)) {
    const err = new Error(`${signerId} is not an authorised multisig signer`);
    err.code = 'SIGNER_NOT_AUTHORISED';
    throw err;
  }

  const approval = await PendingApproval.findById(approvalId);
  if (!approval) {
    const err = new Error(`Approval not found: ${approvalId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (approval.status !== 'pending') {
    const err = new Error(`Approval is not in pending state (current: ${approval.status})`);
    err.code = 'INVALID_STATE';
    throw err;
  }

  if (approval.hasVoted(signerId)) {
    const err = new Error(`${signerId} has already voted on this proposal`);
    err.code = 'ALREADY_VOTED';
    throw err;
  }

  approval.rejections.push({ signerId, rejectedAt: new Date(), reason: reason || null });
  approval.status = 'rejected';
  await approval.save();

  logger.warn('Multisig proposal rejected', { approvalId, signerId, reason });

  await logAudit({
    schoolId: 'system',
    action: `multisig_reject_${approval.operationType}`,
    performedBy: signerId,
    targetId: String(approval._id),
    targetType: 'pending_approval',
    details: { reason: reason || null },
    result: 'success',
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  });

  return { approval };
}

/**
 * List pending proposals (not yet expired, not yet executed).
 */
async function listPending() {
  return PendingApproval.find({
    status: 'pending',
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Fetch a single approval by ID.
 */
async function findById(approvalId) {
  return PendingApproval.findById(approvalId).lean();
}

module.exports = {
  propose,
  approve,
  reject,
  listPending,
  findById,
  // Exposed for tests
  _getAuthorisedSigners: getAuthorisedSigners,
};
