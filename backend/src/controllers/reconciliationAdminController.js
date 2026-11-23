'use strict';

/**
 * Reconciliation admin controller — Issue #33
 *
 * Exposes operator-facing endpoints to:
 *   POST /api/admin/reconciliation/run      — trigger a bounded job run
 *   GET  /api/admin/reconciliation          — list discrepancy records
 *   PATCH /api/admin/reconciliation/:id     — update review status
 */

const { runProviderReconciliation, listDiscrepancies, updateDiscrepancyReview } = require('../services/providerReconciliationJob');
const PaymentReconciliationRun = require('../models/paymentReconciliationRunModel');
const logger = require('../utils/logger').child('ReconciliationAdminController');

const MAX_RANGE_DAYS = parseInt(process.env.RECONCILIATION_MAX_RANGE_DAYS, 10) || 90;

/**
 * POST /api/admin/reconciliation/run
 *
 * Body:
 *   schoolId?   string  — limit to one school; omit for all active schools
 *   rangeStart  string  — ISO 8601 date string (inclusive)
 *   rangeEnd    string  — ISO 8601 date string (inclusive)
 *
 * The endpoint is idempotent: submitting the same range twice yields the
 * same set of discrepancy records without duplication.
 */
async function triggerRun(req, res, next) {
  try {
    const { schoolId, rangeStart: rawStart, rangeEnd: rawEnd } = req.body;

    if (!rawStart || !rawEnd) {
      return res.status(400).json({ error: 'rangeStart and rangeEnd are required', code: 'VALIDATION_ERROR' });
    }

    const rangeStart = new Date(rawStart);
    const rangeEnd   = new Date(rawEnd);

    if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
      return res.status(400).json({ error: 'rangeStart and rangeEnd must be valid ISO 8601 dates', code: 'VALIDATION_ERROR' });
    }

    if (rangeStart >= rangeEnd) {
      return res.status(400).json({ error: 'rangeStart must be before rangeEnd', code: 'VALIDATION_ERROR' });
    }

    const rangeDays = (rangeEnd - rangeStart) / (24 * 60 * 60 * 1000);
    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({
        error:  `Date range exceeds the maximum of ${MAX_RANGE_DAYS} days`,
        code:   'RANGE_TOO_LARGE',
        maxDays: MAX_RANGE_DAYS,
      });
    }

    logger.info('Reconciliation run triggered', {
      schoolId: schoolId || 'all',
      rangeStart: rangeStart.toISOString(),
      rangeEnd:   rangeEnd.toISOString(),
      triggeredBy: req.admin?.username,
    });

    const result = await runProviderReconciliation({
      schoolId: schoolId || undefined,
      rangeStart,
      rangeEnd,
    });

    return res.status(200).json({
      message: 'Reconciliation run complete',
      ...result,
    });
  } catch (err) {
    logger.error('Reconciliation run failed', { error: err.message });
    return next(err);
  }
}

/**
 * GET /api/admin/reconciliation
 *
 * Query params:
 *   schoolId?         string
 *   reviewStatus?     pending | reviewed | dismissed
 *   discrepancyType?  AMOUNT_MISMATCH | MISSING_LOCAL | MISSING_ONCHAIN | STATUS_MISMATCH
 *   page?             number (default 1)
 *   limit?            number (default 50, max 100)
 */
async function getDiscrepancies(req, res, next) {
  try {
    const schoolId        = req.schoolId || req.query.schoolId;
    const reviewStatus    = req.query.reviewStatus    || undefined;
    const discrepancyType = req.query.discrepancyType || undefined;
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));

    if (!schoolId) {
      return res.status(400).json({ error: 'schoolId is required', code: 'MISSING_SCHOOL_CONTEXT' });
    }

    const result = await listDiscrepancies({ schoolId, reviewStatus, discrepancyType, page, limit });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/admin/reconciliation/:id
 *
 * Body:
 *   reviewStatus  reviewed | dismissed   (required)
 *   reviewNote?   string
 */
async function reviewDiscrepancy(req, res, next) {
  try {
    const { id } = req.params;
    const { reviewStatus, reviewNote } = req.body;
    const reviewedBy = req.admin?.username || 'unknown';

    if (!reviewStatus) {
      return res.status(400).json({ error: 'reviewStatus is required', code: 'VALIDATION_ERROR' });
    }

    const updated = await updateDiscrepancyReview({ id, reviewStatus, reviewedBy, reviewNote });
    return res.json(updated);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    return next(err);
  }
}

async function getPaymentReconciliationRuns(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const filter = {};
    if (req.query.status && ['running', 'completed', 'failed'].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const [runs, total] = await Promise.all([
      PaymentReconciliationRun.find(filter)
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PaymentReconciliationRun.countDocuments(filter),
    ]);
    return res.json({ data: runs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { triggerRun, getDiscrepancies, reviewDiscrepancy, getPaymentReconciliationRuns };
