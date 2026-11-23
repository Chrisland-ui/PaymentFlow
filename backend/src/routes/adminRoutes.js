'use strict';

const express = require('express');
const router = express.Router();
const { setLogLevel } = require('../controllers/adminController');
const { listDLQ, retryDLQEntry, replayWebhook } = require('../controllers/webhookAdminController');
const {
  getBacklog,
  listDeadLetterVerifications,
  getDeadLetterVerification,
  retryDeadLetterVerification,
} = require('../controllers/pendingVerificationAdminController');
const {
  getLimits,
  updateLimits,
  deleteSchoolLimits,
} = require('../controllers/paymentLimitsAdminController');
const {
  listFailedJobs,
  getFailedJobDetails,
  retryFailedJob,
  discardFailedJob,
  getQueueStats,
  listDeadLetterJobs,
  getDeadLetterJobDetails,
  replayDeadLetterJob,
  replayQueueDeadLetterJob,
} = require('../controllers/bullMQAdminController');
const {
  listDeadLetterEvents,
  getDeadLetterEventDetails,
  replayDeadLetterEvent,
  discardDeadLetterEvent,
  getOutboxStats,
} = require('../controllers/outboxAdminController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { triggerRun, getDiscrepancies, reviewDiscrepancy } = require('../controllers/reconciliationAdminController');
const { runRetentionHandler, previewRetentionHandler, listDeletionCertificates } = require('../controllers/retentionController');

// POST /api/admin/log-level — change log level at runtime
router.post('/log-level', requireAdminAuth, auditContext, setLogLevel);

// Webhook dead-letter queue admin endpoints
router.get('/webhooks/dlq', requireAdminAuth, listDLQ);
router.post('/webhooks/dlq/:id/retry', requireAdminAuth, auditContext, retryDLQEntry);
// Manual replay — accepts any delivery status (Issue #73)
router.post('/webhooks/:id/replay', requireAdminAuth, auditContext, replayWebhook);

// Stellar verification retry backlog / dead-letter admin endpoints
router.get('/pending-verifications/backlog', requireAdminAuth, getBacklog);
router.get('/pending-verifications/dead-letter', requireAdminAuth, listDeadLetterVerifications);
router.get('/pending-verifications/:id', requireAdminAuth, getDeadLetterVerification);
router.post('/pending-verifications/:id/retry', requireAdminAuth, auditContext, retryDeadLetterVerification);

// Payment limits — runtime-configurable fraud control (#1117). Every mutation
// is audit-logged by the controller.
router.get('/payment-limits', requireAdminAuth, getLimits);
router.put('/payment-limits', requireAdminAuth, auditContext, updateLimits);
router.delete('/payment-limits/:schoolId', requireAdminAuth, auditContext, deleteSchoolLimits);

// BullMQ retry queue admin endpoints (Issue #1336, #37)
router.get('/retry-queue/failed', requireAdminAuth, listFailedJobs);
router.get('/retry-queue/failed/:jobId', requireAdminAuth, getFailedJobDetails);
router.post('/retry-queue/failed/:jobId/retry', requireAdminAuth, auditContext, retryFailedJob);
router.delete('/retry-queue/failed/:jobId', requireAdminAuth, auditContext, discardFailedJob);
router.get('/retry-queue/stats', requireAdminAuth, getQueueStats);
router.get('/retry-queue/dlq', requireAdminAuth, listDeadLetterJobs);
router.get('/retry-queue/dlq/:jobId', requireAdminAuth, getDeadLetterJobDetails);
router.post('/retry-queue/dlq/:jobId/replay', requireAdminAuth, auditContext, replayDeadLetterJob);
router.post('/retry-queue/dlq/:queue/:jobId/replay', requireAdminAuth, auditContext, replayQueueDeadLetterJob);

// Outbox dead-letter queue admin endpoints (Issue #1339)
router.get('/outbox/dead-letter', requireAdminAuth, listDeadLetterEvents);
router.get('/outbox/dead-letter/:eventId', requireAdminAuth, getDeadLetterEventDetails);
router.post('/outbox/dead-letter/:eventId/replay', requireAdminAuth, auditContext, replayDeadLetterEvent);
router.delete('/outbox/dead-letter/:eventId', requireAdminAuth, auditContext, discardDeadLetterEvent);
router.get('/outbox/stats', requireAdminAuth, getOutboxStats);

// Data retention operations and immutable deletion certificates.
router.post('/retention/run', requireAdminAuth, auditContext, runRetentionHandler);
router.get('/retention/preview', requireAdminAuth, previewRetentionHandler);
router.get('/retention/certificates', requireAdminAuth, listDeletionCertificates);

// Provider reconciliation job — Issue #33
// Trigger a bounded, idempotent reconciliation run and inspect discrepancy records.
router.post('/reconciliation/run',  requireAdminAuth, auditContext, triggerRun);
router.get('/reconciliation/runs', requireAdminAuth, getPaymentReconciliationRuns);
router.get('/reconciliation',       requireAdminAuth, getDiscrepancies);
router.patch('/reconciliation/:id', requireAdminAuth, auditContext, reviewDiscrepancy);

module.exports = router;
