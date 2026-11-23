'use strict';

const bullMQRetryService = require('../services/bullMQRetryService');
const logger = require('../utils/logger').child('BullMQAdminController');
const { logAudit } = require('../services/auditService');

/**
 * GET /api/admin/retry-queue/failed
 * List all failed jobs in the BullMQ dead-letter queue
 */
async function listFailedJobs(req, res, next) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;

    await bullMQRetryService.initializeRetryQueue();

    const jobs = await bullMQRetryService.getJobsByState('failed', limit + offset);
    const failedJobs = jobs.slice(offset, offset + limit);

    res.json({
      jobs: failedJobs,
      total: jobs.length,
      limit,
      offset,
    });
  } catch (err) {
    logger.error('Failed to list failed jobs', { error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/retry-queue/failed/:jobId
 * Get details of a specific failed job
 */
async function getFailedJobDetails(req, res, next) {
  try {
    const { jobId } = req.params;

    const jobDetails = await bullMQRetryService.getJobDetails(jobId);

    res.json(jobDetails);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    logger.error('Failed to get job details', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * POST /api/admin/retry-queue/failed/:jobId/retry
 * Re-enqueue a specific failed job for immediate retry
 */
async function retryFailedJob(req, res, next) {
  try {
    const { jobId } = req.params;

    const result = await bullMQRetryService.retryJobImmediately(jobId);

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'retry_failed_payment_job',
        performedBy: req.auditContext.performedBy,
        targetId: jobId,
        targetType: 'payment_job',
        details: { jobId },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Retried failed job', { jobId });

    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({
        error: err.message,
        code: 'INVALID_JOB_STATE',
      });
    }
    logger.error('Failed to retry job', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * DELETE /api/admin/retry-queue/failed/:jobId
 * Discard a failed job after investigation
 */
async function discardFailedJob(req, res, next) {
  try {
    const { jobId } = req.params;

    const result = await bullMQRetryService.removeJob(jobId);

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'discard_failed_payment_job',
        performedBy: req.auditContext.performedBy,
        targetId: jobId,
        targetType: 'payment_job',
        details: { jobId },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Discarded failed job', { jobId });

    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    logger.error('Failed to discard job', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/retry-queue/stats
 * Get comprehensive queue statistics including failed jobs count
 */
async function getQueueStats(req, res, next) {
  try {
    const stats = await bullMQRetryService.getRetryQueueStats();

    res.json(stats);
  } catch (err) {
    logger.error('Failed to get queue stats', { error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/retry-queue/dlq
 * List dead-lettered jobs in BullMQ DLQ
 */
async function listDeadLetterJobs(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const retryResult = await bullMQRetryService.listDeadLetterJobs({ limit, offset });
    const genericDlq = require('../queue/deadLetterQueue');
    const genericResults = await Promise.all(genericDlq.SUPPORTED_QUEUES.map((queueName) =>
      genericDlq.listDeadLetterJobs(queueName, { limit, offset })
    ));
    const jobs = [
      ...retryResult.jobs.map((job) => ({ ...job, originalQueue: 'transaction-retry-queue' })),
      ...genericResults.flatMap((result) => result.jobs),
    ].sort((left, right) => Date.parse(right.failedAt || right.createdAt) - Date.parse(left.failedAt || left.createdAt));
    res.json({ jobs, total: retryResult.total + genericResults.reduce((sum, result) => sum + result.total, 0), limit, offset });
  } catch (err) {
    logger.error('Failed to list dead-letter jobs', { error: err.message });
    next(err);
  }
}

async function replayQueueDeadLetterJob(req, res, next) {
  try {
    const { queue, jobId } = req.params;
    const deadLetterQueue = require('../queue/deadLetterQueue');
    if (!deadLetterQueue.SUPPORTED_QUEUES.includes(queue)) {
      return res.status(400).json({ error: 'Unsupported source queue', code: 'VALIDATION_ERROR' });
    }
    const result = await deadLetterQueue.replayDeadLetterJob(queue, jobId);
    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'replay_dead_letter_job',
        performedBy: req.auditContext.performedBy,
        targetId: jobId,
        targetType: 'dead_letter_job',
        details: { jobId, sourceQueue: queue, newJobId: result.newJobId },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: 'JOB_NOT_FOUND' });
    }
    if (err.code === 'STATE_CONFLICT') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
}

/**
 * GET /api/admin/retry-queue/dlq/:jobId
 * Inspect details of a specific dead-letter job
 */
async function getDeadLetterJobDetails(req, res, next) {
  try {
    const { jobId } = req.params;
    const jobDetails = await bullMQRetryService.getDeadLetterJobDetails(jobId);
    res.json(jobDetails);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Dead-letter job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    logger.error('Failed to get dead-letter job details', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * POST /api/admin/retry-queue/dlq/:jobId/replay
 * Controlled, idempotent replay of a dead-letter job
 */
async function replayDeadLetterJob(req, res, next) {
  try {
    const { jobId } = req.params;
    const result = await bullMQRetryService.replayDeadLetterJob(jobId, {
      performedBy: req.auditContext?.performedBy || 'admin',
    });

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'replay_dead_letter_job',
        performedBy: req.auditContext.performedBy,
        targetId: jobId,
        targetType: 'dead_letter_job',
        details: { jobId, transactionHash: result.transactionHash, idempotent: result.idempotent },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Replayed dead-letter job', { jobId, result });
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Dead-letter job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    logger.error('Failed to replay dead-letter job', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

module.exports = {
  listFailedJobs,
  getFailedJobDetails,
  retryFailedJob,
  discardFailedJob,
  getQueueStats,
  listDeadLetterJobs,
  getDeadLetterJobDetails,
  replayDeadLetterJob,
  replayQueueDeadLetterJob,
};
