'use strict';

/**
 * Emergency pause/upgrade routes.
 *
 * All routes require requireAdminAuth (JWT with super-admin role).
 * State-mutating routes also run auditContext to capture actor metadata.
 *
 * Mount point: /api/admin/emergency  (see app.js)
 */

const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

const {
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
} = require('../controllers/emergencyController');

// ── Status (read-only) ────────────────────────────────────────────────────────
router.get('/status',                requireAdminAuth, getStatus);

// ── Pause workflow ────────────────────────────────────────────────────────────
router.post('/pause/propose',        requireAdminAuth, auditContext, proposePause);
router.post('/pause/approve/:approvalId', requireAdminAuth, auditContext, approvePause);
router.post('/pause/reject/:approvalId',  requireAdminAuth, auditContext, rejectPause);

// ── Unpause workflow ──────────────────────────────────────────────────────────
router.post('/unpause/propose',        requireAdminAuth, auditContext, proposeUnpause);
router.post('/unpause/approve/:approvalId', requireAdminAuth, auditContext, approveUnpause);
router.post('/unpause/reject/:approvalId',  requireAdminAuth, auditContext, rejectUnpause);

// ── Upgrade workflow ──────────────────────────────────────────────────────────
router.post('/upgrade/propose',        requireAdminAuth, auditContext, proposeUpgrade);
router.post('/upgrade/approve/:approvalId', requireAdminAuth, auditContext, approveUpgrade);
router.post('/upgrade/reject/:approvalId',  requireAdminAuth, auditContext, rejectUpgrade);

// ── Proposal listing ──────────────────────────────────────────────────────────
router.get('/approvals',             requireAdminAuth, listApprovals);
router.get('/approvals/:approvalId', requireAdminAuth, getApproval);

module.exports = router;
