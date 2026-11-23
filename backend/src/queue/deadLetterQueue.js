'use strict';

const { Queue } = require('bullmq');
const { getRedisClient } = require('../config/redisClient');
const logger = require('../utils/logger').child('DeadLetterQueue');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_SECONDS = RETENTION_MS / 1000;
const SUPPORTED_QUEUES = ['transaction-processing', 'report-generation'];
const queues = new Map();
let pruneTimer = null;

function getDeadLetterQueue(sourceQueue) {
  if (!SUPPORTED_QUEUES.includes(sourceQueue)) throw new Error('Unsupported source queue');
  const queueName = `dlq:${sourceQueue}`;
  if (!queues.has(queueName)) {
    const connection = getRedisClient();
    if (!connection) return null;
    queues.set(queueName, new Queue(queueName, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { age: RETENTION_SECONDS, count: 10000 },
        removeOnFail: { age: RETENTION_SECONDS, count: 10000 },
      },
    }));
    startPruner();
  }
  return queues.get(queueName);
}

async function moveExhaustedJob(sourceQueue, job, error) {
  if (!job) return false;
  const maxAttempts = Math.max(1, Number(job.opts?.attempts) || 1);
  if ((job.attemptsMade || 0) < maxAttempts) return false;
  const dlq = getDeadLetterQueue(sourceQueue);
  if (!dlq) throw new Error('Dead-letter queue unavailable');

  await dlq.add('dead-letter', {
    originalJobId: job.id,
    originalQueue: sourceQueue,
    originalName: job.name,
    originalData: job.data,
    attempts: job.attemptsMade,
    maxAttempts,
    failureReason: error?.message || 'Maximum retry attempts exhausted',
    failureCode: error?.code || 'UNKNOWN',
    failedAt: new Date().toISOString(),
  }, { jobId: `dlq-${job.id}` });
  if (sourceQueue === 'transaction-processing') {
    const PendingVerification = require('../models/pendingVerificationModel');
    await PendingVerification.findOneAndUpdate(
      { txHash: job.data.txHash },
      { $set: { status: 'dead_letter', lastError: error?.message || 'Maximum retry attempts exhausted', failureReason: error?.message || 'Maximum retry attempts exhausted', failureCode: error?.code || 'UNKNOWN' } },
      { _bypassTenantScope: true },
    );
  }
  await job.remove().catch((removeError) => {
    logger.warn('Unable to remove exhausted source job', { jobId: job.id, sourceQueue, error: removeError.message });
  });
  logger.error('Job moved to dead-letter queue', { jobId: job.id, sourceQueue, error: error?.message });
  return true;
}

async function listDeadLetterJobs(sourceQueue, { limit = 50, offset = 0 } = {}) {
  const dlq = getDeadLetterQueue(sourceQueue);
  if (!dlq) return { jobs: [], total: 0 };
  const jobs = await dlq.getWaiting(offset, offset + limit - 1);
  const total = await dlq.getWaitingCount();
  return {
    jobs: jobs.map((job) => ({
      jobId: job.id,
      originalJobId: job.data.originalJobId,
      originalQueue: job.data.originalQueue,
      originalName: job.data.originalName,
      originalData: job.data.originalData,
      failureReason: job.data.failureReason,
      failureCode: job.data.failureCode,
      attempts: job.data.attempts,
      failedAttempts: job.data.attempts,
      maxAttempts: job.data.maxAttempts,
      failedAt: job.data.failedAt,
      createdAt: new Date(job.timestamp).toISOString(),
    })),
    total,
  };
}

async function replayDeadLetterJob(sourceQueue, jobId) {
  const dlq = getDeadLetterQueue(sourceQueue);
  const job = await dlq?.getJob(jobId);
  if (!job) {
    const error = new Error(`Dead-letter job ${jobId} not found`);
    error.code = 'NOT_FOUND';
    throw error;
  }
  let sourceRecordUpdated = false;
  if (sourceQueue === 'transaction-processing') {
    const PendingVerification = require('../models/pendingVerificationModel');
    const updated = await PendingVerification.findOneAndUpdate(
      { txHash: job.data.originalData.txHash, status: 'dead_letter' },
      { $set: { status: 'pending', attempts: 0, lastError: null, failureReason: null, failureCode: null, nextRetryAt: new Date() } },
      { new: true, _bypassTenantScope: true },
    );
    if (!updated) {
      const error = new Error('Transaction is not in a replayable dead-letter state');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    sourceRecordUpdated = true;
  } else {
    const { ReportJob, REPORT_STATUSES } = require('../models/reportJobModel');
    const updated = await ReportJob.findOneAndUpdate(
      { jobId: job.data.originalData.jobId, status: REPORT_STATUSES.FAILED },
      { $set: { status: REPORT_STATUSES.PENDING, startedAt: null, completedAt: null, 'result.error': null } },
      { new: true },
    );
    if (!updated) {
      const error = new Error('Report is not in a replayable failed state');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    sourceRecordUpdated = true;
  }
  const connection = getRedisClient();
  const source = new Queue(sourceQueue, { connection });
  try {
    const requeued = await source.add(job.data.originalName, job.data.originalData, {
      attempts: Math.max(1, Number(job.data.maxAttempts) || 1),
      priority: 1,
      lifo: true,
      jobId: job.data.originalJobId,
    });
    await job.remove();
    return { success: true, jobId, newJobId: requeued.id, originalQueue: sourceQueue };
  } catch (error) {
    if (sourceRecordUpdated && sourceQueue === 'transaction-processing') {
      const PendingVerification = require('../models/pendingVerificationModel');
      await PendingVerification.findOneAndUpdate(
        { txHash: job.data.originalData.txHash, status: 'pending' },
        { $set: { status: 'dead_letter' } },
        { _bypassTenantScope: true },
      ).catch(() => {});
    } else if (sourceRecordUpdated) {
      const { ReportJob, REPORT_STATUSES } = require('../models/reportJobModel');
      await ReportJob.findOneAndUpdate(
        { jobId: job.data.originalData.jobId, status: REPORT_STATUSES.PENDING },
        { $set: { status: REPORT_STATUSES.FAILED } },
      ).catch(() => {});
    }
    throw error;
  } finally {
    await source.close();
  }
}

async function pruneDeadLetterQueue(queue) {
  let removed = 0;
  let offset = 0;
  const batchSize = 500;
  const cutoff = Date.now() - RETENTION_MS;
  while (true) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'failed', 'paused'], offset, offset + batchSize - 1);
    if (!jobs.length) break;
    const expired = jobs.filter((job) => (Date.parse(job.data.failedAt || '') || job.timestamp) < cutoff);
    if (expired.length) {
      await Promise.all(expired.map((job) => job.remove()));
      removed += expired.length;
      continue;
    }
    if (jobs.length < batchSize) break;
    offset += jobs.length;
  }
  return removed;
}

function startPruner() {
  if (pruneTimer) return;
  const run = () => Promise.all([...queues.values()].map(pruneDeadLetterQueue))
    .then((counts) => {
      const removed = counts.reduce((sum, count) => sum + count, 0);
      if (removed) logger.info('Pruned expired dead-letter jobs', { removed });
    })
    .catch((error) => logger.error('Dead-letter pruning failed', { error: error.message }));
  run();
  pruneTimer = setInterval(run, 60 * 60 * 1000);
  pruneTimer.unref();
}

async function getDeadLetterDepths() {
  const depths = {};
  for (const sourceQueue of SUPPORTED_QUEUES) {
    const queue = getDeadLetterQueue(sourceQueue);
    depths[sourceQueue] = queue ? await queue.getWaitingCount() : 0;
  }
  return depths;
}

async function closeDeadLetterQueues() {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

module.exports = {
  SUPPORTED_QUEUES,
  moveExhaustedJob,
  listDeadLetterJobs,
  replayDeadLetterJob,
  getDeadLetterDepths,
  closeDeadLetterQueues,
};
