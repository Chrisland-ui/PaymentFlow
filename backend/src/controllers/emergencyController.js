'use strict';

/**
 * emergencyController — HTTP handlers for emergency pause/upgrade controls.
 *
 * All routes require requireAdminAuth and auditContext.
 *
 * Pause / unpause operate through a two-of-three multisig workflow:
 *  POST /api/admin/emergency/pause/propose      — propose a pause
 *  POST /api/admin/emergency/pause/approve/:id  — second admin approves → executes
 *  POST /api/admin/emergency/pause/reject/:id   — any signer rejects → closes
 *  POST /api/admin/emergency/unpause/propose
 *  POST /api/admin/emergency/unpause/approve/:id
 *  POST /api/admin/emergency/unpause/reject/:id
 *
 * Upgrade operates through the same multisig workflow:
 *  POST /api/admin/emergency/upgrade/propose    — propose a new version hash
 *  POST /api/admin/emergency/upgrade/approve/:id
 *  POST /api/admin/emergency/upgrade/reject/:id
 *
 * Status / listing:
 *  GET  /api/admin/emergency/status             — current pause state + pending proposals
 *  GET  /api/admin/emergency/approvals          — list open proposals
 *  GET  /api/admin/emergency/approvals/:id      — single proposal
 */

const {
  pauseContract,
  unpauseContract,
  getContractPauseStatus,
} = require('../services/contractPauseService');

const {
  propose,
  approve,
  reject,
  listPending,
  findById,
} = require('../services/multisigService');

const { logAudit } = require('../services/auditService');
const logger = require('../utils/logger').child('EmergencyController');
const crypto = require('crypto');

// ── Helpers ───────────────────────────────────────────────────────────────────

function actorFrom(req) {
  return req.auditContext?.performedBy || req.admin?.email || req.admin?.userId || 'unknown';
}

function ipFrom(req) {
  return req.auditContext?.ipAddress || req.ip || null;
}

function uaFrom(req) {
  return req.auditContext?.userAgent || req.headers?.['user-agent'] || null;
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/emergency/status
 * Returns authoritative pause state and any open proposals.
 */
async function getStatus(req, res, next) {
  try {
    const [pauseStatus, pending] = await Promise.all([
      getContractPauseStatus(),
      listPending(),
    ]);

    res.json({
      contractPaused: pauseStatus.paused,
      source: pauseStatus.source,
      pendingProposals: pending.map((p) => ({
        id: p._id,
        operationType: p.operationType,
        proposedBy: p.proposedBy,
        reason: p.reason,
        approvals: p.approvals.length,
        required: p.requiredSigners,
        expiresAt: p.expiresAt,
        status: p.status,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── Pause workflow ────────────────────────────────────────────────────────────

/**
 * POST /api/admin/emergency/pause/propose
 * Body: { reason?: string }
 */
async function proposePause(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { reason } = req.body || {};
    const { approval } = await propose({
      operationType: 'pause',
      proposedBy: actor,
      payload: {},
      reason,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
    });

    res.status(202).json({
      message:
        'Pause proposal created. A second authorised signer must approve before the ' +
        'contract is paused.',
      approvalId: approval._id,
      status: approval.status,
      approvals: approval.approvals.length,
      required: approval.requiredSigners,
      expiresAt: approval.expiresAt,
    });
  } catch (err) {
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    if (err.code === 'DUPLICATE_PROPOSAL')   return res.status(409).json({ error: err.message, code: err.code, existingId: err.existingId });
    next(err);
  }
}

/**
 * POST /api/admin/emergency/pause/approve/:approvalId
 * Body: {} (identity comes from the JWT via auditContext)
 */
async function approvePause(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { approval, executed } = await approve({
      approvalId: req.params.approvalId,
      signerId: actor,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
      onApproved: async (a) => {
        await pauseContract({
          performedBy: actor,
          ipAddress: ipFrom(req),
          userAgent: uaFrom(req),
          reason: a.reason || 'Multisig approval reached quorum',
        });
      },
    });

    res.json({
      message: executed ? 'Quorum reached — contract is now PAUSED.' : 'Approval recorded.',
      status: approval.status,
      approvals: approval.approvals.length,
      required: approval.requiredSigners,
      executed,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND')           return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ALREADY_VOTED')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'APPROVAL_EXPIRED')    return res.status(410).json({ error: err.message, code: err.code });
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    next(err);
  }
}

/**
 * POST /api/admin/emergency/pause/reject/:approvalId
 * Body: { reason?: string }
 */
async function rejectPause(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { approval } = await reject({
      approvalId: req.params.approvalId,
      signerId: actor,
      reason: req.body?.reason,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
    });

    res.json({
      message: 'Pause proposal rejected.',
      status: approval.status,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND')           return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ALREADY_VOTED')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    next(err);
  }
}

// ── Unpause workflow ──────────────────────────────────────────────────────────

/**
 * POST /api/admin/emergency/unpause/propose
 * Body: { reason?: string }
 */
async function proposeUnpause(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { reason } = req.body || {};
    const { approval } = await propose({
      operationType: 'unpause',
      proposedBy: actor,
      payload: {},
      reason,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
    });

    res.status(202).json({
      message:
        'Unpause proposal created. A second authorised signer must approve before ' +
        'the contract is unpaused.',
      approvalId: approval._id,
      status: approval.status,
      approvals: approval.approvals.length,
      required: approval.requiredSigners,
      expiresAt: approval.expiresAt,
    });
  } catch (err) {
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    if (err.code === 'DUPLICATE_PROPOSAL')   return res.status(409).json({ error: err.message, code: err.code, existingId: err.existingId });
    next(err);
  }
}

/**
 * POST /api/admin/emergency/unpause/approve/:approvalId
 */
async function approveUnpause(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { approval, executed } = await approve({
      approvalId: req.params.approvalId,
      signerId: actor,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
      onApproved: async (a) => {
        await unpauseContract({
          performedBy: actor,
          ipAddress: ipFrom(req),
          userAgent: uaFrom(req),
          reason: a.reason || 'Multisig approval reached quorum',
        });
      },
    });

    res.json({
      message: executed ? 'Quorum reached — contract is now UNPAUSED.' : 'Approval recorded.',
      status: approval.status,
      approvals: approval.approvals.length,
      required: approval.requiredSigners,
      executed,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND')           return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ALREADY_VOTED')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'APPROVAL_EXPIRED')    return res.status(410).json({ error: err.message, code: err.code });
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    next(err);
  }
}

/**
 * POST /api/admin/emergency/unpause/reject/:approvalId
 * Body: { reason?: string }
 */
async function rejectUnpause(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { approval } = await reject({
      approvalId: req.params.approvalId,
      signerId: actor,
      reason: req.body?.reason,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
    });

    res.json({
      message: 'Unpause proposal rejected.',
      status: approval.status,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND')           return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ALREADY_VOTED')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    next(err);
  }
}

// ── Upgrade workflow ──────────────────────────────────────────────────────────
// The "contract" in this Node.js system is the running backend process rather
// than a Soroban WASM binary.  "Upgrading" means deploying a new image/version.
// The upgrade workflow:
//  1. An admin proposes an upgrade with a version hash (SHA-256 of the new
//     deployment artefact — Docker image digest, git commit SHA, etc.).
//  2. A second admin approves, recording the intended version.
//  3. The approval document is recorded and can be verified by the CI/CD
//     pipeline before it proceeds with the deployment.
//
// The upgrade itself (restart/redeploy) is performed by the CI/CD pipeline or
// the on-call engineer.  This endpoint records the intent and authorisation
// so it can be audited and cross-checked.

/**
 * POST /api/admin/emergency/upgrade/propose
 * Body: { newVersionHash: string, reason?: string }
 *
 * newVersionHash — SHA-256 hex of the new deployment artefact (Docker digest,
 *                  git commit SHA, or any canonical identifier of the new
 *                  version).  This is the analogue of Soroban's new_wasm_hash.
 */
async function proposeUpgrade(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { newVersionHash, reason } = req.body || {};

    if (!newVersionHash || typeof newVersionHash !== 'string') {
      return res.status(400).json({
        error: 'newVersionHash is required (SHA-256 hex of the new deployment artefact)',
        code: 'VALIDATION_ERROR',
      });
    }

    // Accept 7–64 char hex or semver-style strings
    if (!/^[a-fA-F0-9]{7,64}$/.test(newVersionHash) && !/^v?\d+\.\d+\.\d+/.test(newVersionHash)) {
      return res.status(400).json({
        error: 'newVersionHash must be a 7-64 character hex string or a semver version',
        code: 'VALIDATION_ERROR',
      });
    }

    const { approval } = await propose({
      operationType: 'upgrade',
      proposedBy: actor,
      payload: { newVersionHash },
      reason,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
    });

    res.status(202).json({
      message:
        'Upgrade proposal created. A second authorised signer must approve before ' +
        'the deployment may proceed.',
      approvalId: approval._id,
      newVersionHash,
      status: approval.status,
      approvals: approval.approvals.length,
      required: approval.requiredSigners,
      expiresAt: approval.expiresAt,
    });
  } catch (err) {
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    if (err.code === 'DUPLICATE_PROPOSAL')   return res.status(409).json({ error: err.message, code: err.code, existingId: err.existingId });
    next(err);
  }
}

/**
 * POST /api/admin/emergency/upgrade/approve/:approvalId
 */
async function approveUpgrade(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { approval, executed } = await approve({
      approvalId: req.params.approvalId,
      signerId: actor,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
      onApproved: async (a) => {
        // Log the authorised version hash so the CI/CD pipeline can verify it.
        logger.info('Upgrade authorised by multisig quorum', {
          approvalId: a._id,
          newVersionHash: a.payload?.newVersionHash,
          approvedBy: a.approvals.map((ap) => ap.signerId),
        });

        await logAudit({
          schoolId: 'system',
          action: 'contract_upgrade_authorised',
          performedBy: actor,
          targetId: String(a._id),
          targetType: 'pending_approval',
          details: {
            newVersionHash: a.payload?.newVersionHash,
            approvedBy: a.approvals.map((ap) => ap.signerId),
            reason: a.reason || null,
          },
          result: 'success',
          ipAddress: ipFrom(req),
          userAgent: uaFrom(req),
        });
      },
    });

    res.json({
      message: executed
        ? `Quorum reached — upgrade to ${approval.payload?.newVersionHash} is AUTHORISED. ` +
          'The CI/CD pipeline may now proceed with the deployment.'
        : 'Approval recorded.',
      status: approval.status,
      newVersionHash: approval.payload?.newVersionHash,
      approvals: approval.approvals.length,
      required: approval.requiredSigners,
      executed,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND')           return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ALREADY_VOTED')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'APPROVAL_EXPIRED')    return res.status(410).json({ error: err.message, code: err.code });
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    next(err);
  }
}

/**
 * POST /api/admin/emergency/upgrade/reject/:approvalId
 * Body: { reason?: string }
 */
async function rejectUpgrade(req, res, next) {
  const actor = actorFrom(req);
  try {
    const { approval } = await reject({
      approvalId: req.params.approvalId,
      signerId: actor,
      reason: req.body?.reason,
      ipAddress: ipFrom(req),
      userAgent: uaFrom(req),
    });

    res.json({
      message: 'Upgrade proposal rejected.',
      status: approval.status,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND')           return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ALREADY_VOTED')       return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'SIGNER_NOT_AUTHORISED') return res.status(403).json({ error: err.message, code: err.code });
    next(err);
  }
}

// ── Proposal listing ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/emergency/approvals
 */
async function listApprovals(req, res, next) {
  try {
    const pending = await listPending();
    res.json({ approvals: pending, count: pending.length });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/emergency/approvals/:approvalId
 */
async function getApproval(req, res, next) {
  try {
    const approval = await findById(req.params.approvalId);
    if (!approval) {
      return res.status(404).json({ error: 'Approval not found', code: 'NOT_FOUND' });
    }
    res.json({ approval });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStatus,
  proposePause,
  approvePause,
  rejectPause,
  proposeUnpause,
  approveUnpause,
  rejectUnpause,
  proposeUpgrade,
  approveUpgrade,
  rejectUpgrade,
  listApprovals,
  getApproval,
};
