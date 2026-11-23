/**
 * BullMQ Transaction Retry Service
 *
 * This service provides a high-level interface for adding failed Stellar transactions
 * to the BullMQ retry queue. It integrates with the existing retry mechanism and
 * provides additional features like automatic error classification and retry scheduling.
 */

const {
  initializeQueue,
  addTransactionToRetryQueue,
  getQueueStats,
  getDLQStats,
  getDeadLetterQueue,
  shutdownQueue,
  config,
  QUEUE_NAMES,
} = require('../queue/transactionRetryQueue');
const logger = require('../utils/logger').child('BullMQRetryService');

const PendingVerification = require('../models/pendingVerificationModel');

// Shared retry contract (Issue #81) — both backends classify failures identically.
const retryContract = require('./retryContract');

// Singleton queue instance
let queueInstance = null;

/**
 * Error classification for retry decisions. Kept as an exported shape for
 * backwards compatibility; the canonical lists live in retryContract.
 */
const ERROR_CLASSIFICATION = {
  TRANSIENT: retryContract.TRANSIENT_ERROR_CODES,
  PERMANENT: retryContract.PERMANENT_ERROR_CODES,
};

/**
 * Classify error type for retry decision (delegates to the shared contract).
 */
function classifyError(error) {
  return retryContract.classifyError(error);
}

/**
 * Initialize the queue system
 */
async function initializeRetryQueue() {
  if (!queueInstance) {
    queueInstance = await initializeQueue();
    logger.info('Queue system initialized');
  }
  return queueInstance;
}

/**
 * Queue a failed transaction for retry with smart error handling
 *
 * @param {string} transactionHash - The Stellar transaction hash
 * @param {Object} options - Additional options
 * @param {string} options.studentId - Student ID associated with the transaction
 * @param {string} options.memo - Transaction memo
 * @param {Error} options.error - The original error that caused the failure
 * @param {Object} options.metadata - Additional metadata to store with the job
 */
async function queueFailedTransaction(transactionHash, options = {}) {
  try {
    await initializeRetryQueue();

    const { studentId, memo, error, metadata = {} } = options;

    // Classify the error to determine retry strategy
    const errorType = error ? classifyError(error) : 'unknown';

    // If it's a permanent error, don't queue for retry
    if (errorType === 'permanent') {
      console.log(`[BullMQRetryService] Permanent error detected for ${transactionHash}, not queueing for retry`);
      return {
        queued: false,
        reason: 'permanent_error',
        errorCode: error?.code || 'UNKNOWN',
      };
    }

    // Also store in MongoDB for tracking and potential recovery.
    // Bypass: admin retry queue is cross-school; txHash is globally unique so no leak risk.
    await PendingVerification.findOneAndUpdate(
      { txHash: transactionHash },
      {
        $setOnInsert: {
          txHash: transactionHash,
          studentId,
          memo,
        },
        $set: {
          status: 'queued',
          lastError: error?.message || 'Unknown error',
          lastErrorCode: error?.code || 'UNKNOWN',
          errorType,
          nextRetryAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { upsert: true, new: true, _bypassTenantScope: true }
    );

    // Add to BullMQ queue
    const job = await addTransactionToRetryQueue(transactionHash, studentId, {
      memo,
      originalError: error?.message,
      originalErrorCode: error?.code,
      errorType,
      metadata,
      queuedAt: new Date().toISOString(),
    });

    logger.info(`Queued transaction ${transactionHash} for retry (attempt ${metadata.attemptNumber || 1})`);


    return {
      queued: true,
      jobId: job?.id,
      errorType,
      transactionHash,
    };

  } catch (error) {
    logger.error('Failed to queue transaction', { transactionHash, error: error.message });
    throw error;
  }
}

/**
 * Get comprehensive queue statistics
 */
async function getRetryQueueStats() {
  try {
    const [mainStats, dlqStats] = await Promise.all([
      getQueueStats(),
      getDLQStats(),
    ]);

    // Get MongoDB pending verification stats
    // System-wide stats aggregate: intentionally spans all schools.
    const mongoStats = await PendingVerification.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]).option({ _bypassTenantScope: true });

    return {
      bullmq: mainStats,
      deadLetter: dlqStats,
      mongodb: {
        pendingVerifications: mongoStats.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
      },
      systemHealth: {
        queueHealth: mainStats.health,
        redisConnected: mainStats.health === 'healthy',
        workerConcurrency: config.worker.concurrency,
      },
    };

  } catch (error) {
    logger.error('Failed to get queue stats', { error: error.message });
    throw error;
  }
}

/**
 * Get specific job details
 */
async function getJobDetails(jobId) {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;
    const job = await queue.getJob(jobId);

    if (!job) {
      const err = new Error(`Job ${jobId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    const state = await job.getState();
    const progress = job.progress;
    const data = job.data;
    const result = job.returnvalue;
    const failedReason = job.failedReason;

    return {
      jobId: job.id,
      transactionHash: data.transactionHash,
      state,
      progress,
      data,
      result,
      failedReason,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      createdAt: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    };

  } catch (error) {
    logger.error('Failed to get job details', { jobId, error: error.message });
    throw error;
  }
}

/**
 * Get jobs by state
 */
async function getJobsByState(state, limit = 50) {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;

    let jobs = [];

    switch (state) {
      case 'waiting':
        jobs = await queue.getWaiting(0, limit);
        break;
      case 'active':
        jobs = await queue.getActive(0, limit);
        break;
      case 'completed':
        jobs = await queue.getCompleted(0, limit);
        break;
      case 'failed':
        jobs = await queue.getFailed(0, limit);
        break;
      case 'delayed':
        jobs = await queue.getDelayed(0, limit);
        break;
      default:
        throw new Error(`Invalid state: ${state}`);
    }

    return jobs.map(job => ({
      jobId: job.id,
      transactionHash: job.data.transactionHash,
      state: state,
      attemptsMade: job.attemptsMade,
      createdAt: new Date(job.timestamp).toISOString(),
      data: job.data,
    }));

  } catch (error) {
    logger.error('Failed to get jobs by state', { state, error: error.message });
    throw error;
  }
}

/**
 * Retry a specific failed job immediately
 */
async function retryJobImmediately(jobId) {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;
    const job = await queue.getJob(jobId);

    if (!job) {
      const err = new Error(`Job ${jobId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    const state = await job.getState();
    if (state !== 'failed') {
      const err = new Error(`Job ${jobId} is not in failed state (current: ${state})`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    await job.retry();

    console.log(`[BullMQRetryService] Retrying job ${jobId} immediately`);

    return {
      success: true,
      jobId,
      message: 'Job queued for immediate retry',
    };

  } catch (error) {
    logger.error('Failed to retry job', { jobId, error: error.message });
    throw error;
  }
}

/**
 * Remove a job from the queue
 */
async function removeJob(jobId) {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;
    const job = await queue.getJob(jobId);

    if (!job) {
      const err = new Error(`Job ${jobId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    await job.remove();

    console.log(`[BullMQRetryService] Removed job ${jobId}`);

    return {
      success: true,
      jobId,
    };

  } catch (error) {
    logger.error('Failed to remove job', { jobId, error: error.message });
    throw error;
  }
}

/**
 * Clean up old completed jobs
 */
async function cleanupOldJobs(maxAge = 86400000) {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;

    const count = await queue.clean(maxAge, 1000, 'completed');

    console.log(`[BullMQRetryService] Cleaned up ${count} old completed jobs`);

    return {
      cleaned: count,
      maxAge,
    };

  } catch (error) {
    logger.error('Failed to cleanup old jobs', { error: error.message });
    throw error;
  }
}

/**
 * Pause the queue
 */
async function pauseQueue() {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;
    await queue.pause();

    console.log('[BullMQRetryService] Queue paused');

    return { success: true, paused: true };

  } catch (error) {
    logger.error('Failed to pause queue', { error: error.message });
    throw error;
  }
}

/**
 * Resume the queue
 */
async function resumeQueue() {
  try {
    await initializeRetryQueue();
    const queue = queueInstance.queue;
    await queue.resume();

    console.log('[BullMQRetryService] Queue resumed');

    return { success: true, paused: false };

  } catch (error) {
    console.error('[BullMQRetryService] Failed to resume queue:', error);
    throw error;
  }
}

/**
 * Get health status
 */
async function getHealthStatus() {
  try {
    const stats = await getRetryQueueStats();

    return {
      healthy: stats.systemHealth.queueHealth === 'healthy',
      status: stats.systemHealth.queueHealth,
      details: {
        redis: stats.systemHealth.redisConnected ? 'connected' : 'disconnected',
        workerConcurrency: stats.systemHealth.workerConcurrency,
        queueSize: stats.bullmq.metrics.totalJobs,
        failedJobs: stats.bullmq.metrics.failedJobs,
        deadLetteredJobs: stats.deadLetter.metrics?.failed || 0,
      },
    };

  } catch (error) {
    return {
      healthy: false,
      status: 'unhealthy',
      error: error.message,
    };
  }
}

/**
 * Drain the retry worker for graceful shutdown.
 * Waits for active jobs to complete, or marks them for recovery on restart.
 */
async function drainWorker() {
  const transactionRetryQueue = require('../queue/transactionRetryQueue');
  if (transactionRetryQueue.getWorker && typeof transactionRetryQueue.getWorker === 'function') {
    return transactionRetryQueue.drainWorker();
  }
  return { drained: true, activeJobs: 0, requeuedJobs: 0 };
}

/**
 * List jobs in the dead-letter queue with sensitive payload redacted.
 */
async function listDeadLetterJobs(opts = {}) {
  try {
    await initializeRetryQueue();
    const dlq = getDeadLetterQueue();
    if (!dlq) {
      return { jobs: [], total: 0, limit: opts.limit || 50, offset: opts.offset || 0 };
    }

    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);

    const waitingJobs = await dlq.getWaiting(offset, offset + limit - 1);
    const total = await dlq.getWaitingCount();

    const jobs = waitingJobs.map((job) => ({
      jobId: job.id,
      originalJobId: job.data.originalJobId,
      transactionHash: job.data.transactionHash,
      studentId: job.data.studentId,
      correlationId: job.data.correlationId,
      failureReason: job.data.failureReason,
      failureCode: job.data.failureCode,
      failedAttempts: job.data.failedAttempts,
      attemptHistory: job.data.attemptHistory || [],
      safePayload: job.data.safePayload || {},
      failedAt: job.data.failedAt,
      createdAt: new Date(job.timestamp).toISOString(),
    }));

    return {
      jobs,
      total,
      limit,
      offset,
    };
  } catch (error) {
    logger.error('Failed to list dead-letter jobs', { error: error.message });
    throw error;
  }
}

/**
 * Inspect details of a specific dead-letter job from DLQ.
 */
async function getDeadLetterJobDetails(jobId) {
  try {
    await initializeRetryQueue();
    const dlq = getDeadLetterQueue();
    if (!dlq) {
      const err = new Error('Dead-letter queue unavailable');
      err.code = 'QUEUE_UNAVAILABLE';
      throw err;
    }

    const job = await dlq.getJob(jobId);
    if (!job) {
      const err = new Error(`Dead-letter job ${jobId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    return {
      jobId: job.id,
      originalJobId: job.data.originalJobId,
      transactionHash: job.data.transactionHash,
      studentId: job.data.studentId,
      correlationId: job.data.correlationId,
      failureReason: job.data.failureReason,
      failureCode: job.data.failureCode,
      failedAttempts: job.data.failedAttempts,
      attemptHistory: job.data.attemptHistory || [],
      safePayload: job.data.safePayload || {},
      failedAt: job.data.failedAt,
      createdAt: new Date(job.timestamp).toISOString(),
    };
  } catch (error) {
    logger.error('Failed to get dead-letter job details', { jobId, error: error.message });
    throw error;
  }
}

/**
 * Controlled, idempotent replay of a dead-lettered job.
 */
async function replayDeadLetterJob(jobId, operatorContext = {}) {
  try {
    await initializeRetryQueue();
    const dlq = getDeadLetterQueue();
    if (!dlq) {
      const err = new Error('Dead-letter queue unavailable');
      err.code = 'QUEUE_UNAVAILABLE';
      throw err;
    }

    const job = await dlq.getJob(jobId);
    if (!job) {
      const err = new Error(`Dead-letter job ${jobId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    const txHash = job.data.transactionHash;
    const studentId = job.data.studentId;
    const correlationId = job.data.correlationId;
    const safePayload = job.data.safePayload || {};

    // Idempotency: verify if already successfully processed
    const Payment = require('../models/paymentModel');
    const existingPayment = await Payment.findOne({ txHash });
    if (existingPayment && (existingPayment.status === 'SUCCESS' || existingPayment.status === 'confirmed')) {
      logger.info('[BullMQRetryService] Replay skipped: transaction already processed and confirmed', {
        jobId,
        txHash,
      });

      await job.remove().catch((e) => logger.debug('Failed to remove replayed job from DLQ', { error: e.message }));
      await PendingVerification.findOneAndUpdate(
        { txHash },
        { $set: { status: 'resolved', resolvedAt: new Date() } },
        { _bypassTenantScope: true }
      );

      return {
        success: true,
        replayed: false,
        idempotent: true,
        jobId,
        transactionHash: txHash,
        message: 'Transaction already successfully processed and confirmed on-chain',
      };
    }

    // Re-enqueue into retry queue with fresh attempts and enriched context
    const newJob = await addTransactionToRetryQueue(txHash, studentId, {
      ...safePayload,
      correlationId,
      replayedFromDLQ: true,
      replayedJobId: jobId,
      replayedBy: operatorContext.performedBy || 'admin',
      replayedAt: new Date().toISOString(),
      priority: 1,
    });

    // Remove old job from DLQ
    await job.remove().catch((e) => logger.debug('Failed to remove replayed job from DLQ', { error: e.message }));

    // Update PendingVerification in MongoDB
    await PendingVerification.findOneAndUpdate(
      { txHash },
      {
        $set: {
          status: 'pending',
          attempts: 0,
          nextRetryAt: new Date(),
          lastReplayedAt: new Date(),
          lastError: null,
        },
        $inc: { replayCount: 1 },
      },
      { _bypassTenantScope: true }
    );

    logger.info('[BullMQRetryService] Safely re-enqueued dead-letter job for replay', {
      jobId,
      newJobId: newJob?.id,
      txHash,
      performedBy: operatorContext.performedBy,
    });

    return {
      success: true,
      replayed: true,
      idempotent: false,
      jobId,
      newJobId: newJob?.id,
      transactionHash: txHash,
      message: 'Job successfully re-enqueued for retry',
    };
  } catch (error) {
    logger.error('Failed to replay dead-letter job', { jobId, error: error.message });
    throw error;
  }
}

module.exports = {
  initializeRetryQueue,
  queueFailedTransaction,
  getRetryQueueStats,
  getJobDetails,
  getJobsByState,
  listDeadLetterJobs,
  getDeadLetterJobDetails,
  replayDeadLetterJob,
  retryJobImmediately,
  removeJob,
  cleanupOldJobs,
  pauseQueue,
  resumeQueue,
  getHealthStatus,
  classifyError,
  shutdownQueue,
  drainWorker,
  QUEUE_NAMES,
};