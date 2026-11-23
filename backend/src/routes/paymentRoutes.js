'use strict';

const express = require('express');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');

const {
  getPaymentInstructions,
  createPaymentIntent,
  verifyPayment,
  submitTransaction,
  verifyTransactionHash,
} = require('../controllers/paymentController');

const {
  getAcceptedAssets,
  getPaymentLimitsEndpoint,
  getStudentPayments,
  getAllPayments,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
  getExchangeRates,
  getPaymentSummary,
} = require('../controllers/paymentQueryController');

const {
  syncAllPayments,
  getSyncStatus,
  finalizePayments,
  generateReceipt,
  lockPaymentForUpdate,
  unlockPayment,
  getDeadLetterJobs,
  retryDeadLetterJob,
  getQueueJobStatus,
  getStuckPayments,
  updatePaymentStatus,
  bulkUpdatePaymentStatus,
  reviewSuspiciousPayment,
  streamPaymentEvents,
  initiatePaymentRefund,
  approvePaymentRefund,
  getPaymentRefunds,
  getSchoolRefunds,
  verifyReceipt,
  getReconciliationReports,
  generateSchoolReconciliationReport,
  correctPlaceholderPayment,
} = require('../controllers/paymentAdminController');

const {
  validateStudentIdParam,
  validatePaymentInstructionsQuery,
  validateTxHashParam,
  validateCreatePaymentIntent,
  validateVerifyPayment,
  validateSubmitTransaction,
  validatePagination,
} = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');
const idempotencyMiddleware = require('../middleware/idempotency');
const { auditContext } = require('../middleware/auditContext');
const { strictLimiter, verifyLimiter, syncLimiter } = require('../middleware/rateLimiter');
const { contractPaused } = require('../middleware/contractPaused');

const router = express.Router();

// Idempotency middleware for critical payment endpoints that must fail-closed
// when the datastore becomes unreachable to prevent duplicate submissions.
const idempotency = idempotencyMiddleware({ criticalPaymentEndpoints: true });

/**
 * @swagger
 * /api/payments/instructions/{studentId}:
 *   get:
 *     summary: Get payment instructions for a student
 *     operationId: getPaymentInstructions
 *     tags:
 *       - Payments
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Student ID
 *       - in: query
 *         name: feeCategory
 *         required: false
 *         schema:
 *           type: string
 *           maxLength: 100
 *           pattern: '^[A-Za-z0-9_-]+$'
 *         description: Restrict the instructions to a single fee category
 *     responses:
 *       200:
 *         description: Payment instructions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 walletAddress:
 *                   type: string
 *                 memo:
 *                   type: string
 *                 acceptedAssets:
 *                   type: array
 *       400:
 *         description: VALIDATION_ERROR - feeCategory is malformed
 *       404:
 *         description: Student not found
 */

/**
 * @swagger
 * /api/payments/verify:
 *   post:
 *     summary: Verify a payment transaction
 *     operationId: verifyPayment
 *     tags:
 *       - Payments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               txHash:
 *                 type: string
 *                 description: Stellar transaction hash
 *     responses:
 *       200:
 *         description: Payment verified
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Payment'
 *       400:
 *         description: Invalid transaction
 */

/**
 * @swagger
 * /api/payments/sync:
 *   post:
 *     summary: Sync payments from Stellar blockchain
 *     operationId: syncAllPayments
 *     tags:
 *       - Payments
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Sync completed
 *       401:
 *         description: Unauthorized
 */

// No school context required
router.get("/verify/:txHash", validateTxHashParam, verifyLimiter, verifyTransactionHash);

// Validation runs BEFORE resolveSchool so missing-school requests still get
// proper 400 validation errors when the body itself is invalid.
router.post(
  "/intent",
  validateCreatePaymentIntent,
  idempotency,
  resolveSchool,
  contractPaused,
  createPaymentIntent,
);
router.post(
  "/submit",
  validateSubmitTransaction,
  idempotency,
  resolveSchool,
  contractPaused,
  submitTransaction,
);

// All remaining routes require school context
router.use(resolveSchool);

// Payment read endpoints now require authentication (Issue #1040)
router.get("/", requireSchoolAuth(), validatePagination, getAllPayments);
router.get("/summary", requireSchoolAuth(), getPaymentSummary);
router.get("/accepted-assets", requireSchoolAuth(), getAcceptedAssets);
router.get("/limits", requireSchoolAuth(), getPaymentLimitsEndpoint);
router.get("/sync/status", requireSchoolAuth(), getSyncStatus);
router.get("/events", requireSchoolAuth(), streamPaymentEvents);
router.get("/overpayments", requireSchoolAuth(), getOverpayments);
router.get("/suspicious", requireSchoolAuth(), getSuspiciousPayments);
router.get("/pending", requireSchoolAuth(), getPendingPayments);
router.get("/stuck", requireAdminAuth, getStuckPayments);
router.get("/retry-queue", requireAdminAuth, getRetryQueue);
router.get("/rates", requireSchoolAuth(), getExchangeRates);
router.get("/dlq", requireSchoolAuth(), getDeadLetterJobs);

router.post(
  "/verify",
  verifyLimiter,
  idempotency,
  validateVerifyPayment,
  contractPaused,
  verifyPayment,
);
// syncLimiter runs after requireAdminAuth on purpose: it keys on
// req.schoolId, which auth is what populates.
router.post("/sync", strictLimiter, requireAdminAuth, syncLimiter, auditContext, contractPaused, syncAllPayments);
router.post("/finalize", requireAdminAuth, auditContext, contractPaused, finalizePayments);
router.post("/dlq/:id/retry", requireSchoolAuth(), contractPaused, retryDeadLetterJob);

router.get("/balance/:studentId", validateStudentIdParam, requireSchoolAuth(), getStudentBalance);
router.get(
  "/instructions/:studentId",
  validateStudentIdParam,
  validatePaymentInstructionsQuery,
  getPaymentInstructions,
);
router.get("/receipt/:txHash", generateReceipt);
router.get("/queue/:txHash", requireSchoolAuth(), getQueueJobStatus);
router.get("/:studentId", validateStudentIdParam, requireSchoolAuth(), getStudentPayments);

router.post("/:paymentId/lock", requireSchoolAuth(), contractPaused, lockPaymentForUpdate);
router.post("/:paymentId/unlock", requireSchoolAuth(), unlockPayment);

// Registered BEFORE "/:txHash/status" on purpose: Express matches in order, so
// the parameterised route would otherwise capture "bulk" as a txHash.
router.patch("/bulk/status", requireAdminAuth, auditContext, contractPaused, bulkUpdatePaymentStatus);
router.patch("/:txHash/status", requireAdminAuth, auditContext, contractPaused, updatePaymentStatus);
router.patch("/:txHash/suspicion-review", requireAdminAuth, auditContext, contractPaused, reviewSuspiciousPayment);
router.patch("/:txHash/correct-placeholder", requireAdminAuth, auditContext, contractPaused, correctPlaceholderPayment);

router.post("/:txHash/refund", requireAdminAuth, auditContext, contractPaused, initiatePaymentRefund);
router.post("/refunds/:refundId/approve", requireAdminAuth, auditContext, contractPaused, approvePaymentRefund);
router.get("/:txHash/refunds", getPaymentRefunds);
router.get("/refunds/school/list", requireAdminAuth, getSchoolRefunds);

router.get("/verify/:receiptId", verifyReceipt);

router.get("/reconciliation/reports", requireAdminAuth, getReconciliationReports);
router.post("/reconciliation/report", requireAdminAuth, auditContext, contractPaused, generateSchoolReconciliationReport);

module.exports = router;
