'use strict';

const { Queue, Worker } = require('bullmq');
const { getRedisClient } = require('../config/redisClient');
const { ReportJob, REPORT_STATUSES } = require('../models/reportJobModel');
const logger = require('../utils/logger');
const { randomUUID } = require('crypto');
const sseService = require('../services/sseService');
const paymentEvents = require('../events/paymentEvents');

const QUEUE_NAME = 'report-generation';
const REPORT_JOB_TTL_MS = parseInt(process.env.REPORT_JOB_TTL_MS || String(6 * 60 * 60 * 1000), 10);

let reportQueue = null;
let worker = null;

function createQueue() {
  if (!getRedisClient()) {
    logger.warn('[ReportQueue] Redis not configured — report queue unavailable');
    return null;
  }

  try {
    reportQueue = new Queue(QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10000 },
      },
    });
    return reportQueue;
  } catch (err) {
    logger.error('[ReportQueue] Failed to create queue', { error: err.message });
    return null;
  }
}

async function enqueueReportJob(jobData) {
  if (!reportQueue) {
    const err = new Error('Report queue unavailable — Redis not configured');
    err.code = 'QUEUE_UNAVAILABLE';
    throw err;
  }

  // Deduplication: return an existing pending/processing job for the same
  // school + type + date range instead of creating a duplicate.
  const existingJob = await ReportJob.findOne({
    schoolId: jobData.schoolId,
    type: jobData.type || 'report',
    status: { $in: [REPORT_STATUSES.PENDING, REPORT_STATUSES.PROCESSING] },
    'params.startDate': jobData.startDate || null,
    'params.endDate': jobData.endDate || null,
  }).lean();

  if (existingJob) {
    logger.info('[ReportQueue] Returning existing job (deduplication)', {
      jobId: existingJob.jobId,
      type: jobData.type,
      schoolId: jobData.schoolId,
    });
    return { jobId: existingJob.jobId, reportJob: existingJob, deduplicated: true };
  }

  const jobId = `report-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + REPORT_JOB_TTL_MS);

  const reportJob = await ReportJob.create({
    schoolId: jobData.schoolId,
    jobId,
    type: jobData.type,
    status: REPORT_STATUSES.PENDING,
    params: {
      startDate: jobData.startDate || null,
      endDate: jobData.endDate || null,
      timezone: jobData.timezone || 'UTC',
      schemaVersion: jobData.schemaVersion || null,
      format: jobData.format || 'json',
    },
    expiresAt,
  });

  try {
    await reportQueue.add(
      'generate-report',
      { jobId, ...jobData },
      { jobId }
    );
  } catch (error) {
    await ReportJob.findOneAndUpdate(
      { jobId, status: REPORT_STATUSES.PENDING },
      { status: REPORT_STATUSES.FAILED, completedAt: new Date(), 'result.error': error.message },
    );
    throw error;
  }

  logger.info('[ReportQueue] Report job enqueued', { jobId, type: jobData.type, schoolId: jobData.schoolId });
  return { jobId, reportJob };
}

function getReportJob(jobId) {
  return ReportJob.findOne({ jobId }).lean();
}

async function getJobStatus(jobId) {
  const reportJob = await ReportJob.findOne({ jobId }).lean();
  if (!reportJob) return null;

  return {
    jobId: reportJob.jobId,
    type: reportJob.type,
    status: reportJob.status,
    params: reportJob.params,
    error: reportJob.result?.error || null,
    createdAt: reportJob.createdAt,
    startedAt: reportJob.startedAt,
    completedAt: reportJob.completedAt,
    downloadUrl: reportJob.status === REPORT_STATUSES.READY ? `/api/reports/${reportJob.jobId}/download` : null,
    downloadExpiresAt: reportJob.downloadExpiresAt,
  };
}

async function setJobProcessing(jobId) {
  await ReportJob.findOneAndUpdate(
    { jobId, status: REPORT_STATUSES.PENDING },
    { status: REPORT_STATUSES.PROCESSING, startedAt: new Date() }
  );
}

async function setJobCompleted(jobId, { artifactKey, schemaVersion = null }) {
  const completedAt = new Date();
  const updated = await ReportJob.findOneAndUpdate(
    { jobId, status: REPORT_STATUSES.PROCESSING },
    {
      status: REPORT_STATUSES.READY,
      completedAt,
      downloadExpiresAt: new Date(completedAt.getTime() + 15 * 60 * 1000),
      artifactKey,
      'result.schemaVersion': schemaVersion,
    },
    { new: true }
  ).lean();

  // Notify SSE clients so they receive push completion rather than polling.
  if (updated) {
    try {
      const { createReportDownloadUrl } = require('../services/reportArtifactStorage');
      const remainingSeconds = Math.max(1, Math.floor((updated.downloadExpiresAt.getTime() - Date.now()) / 1000));
      const downloadUrl = await createReportDownloadUrl(updated.artifactKey, Math.min(15 * 60, remainingSeconds));
      sseService.emit(updated.schoolId, 'report:completed', {
        jobId: updated.jobId,
        type: updated.type,
        downloadUrl,
        expiresAt: updated.downloadExpiresAt,
      });
      const { fireWebhookToEndpoints } = require('../services/webhookService');
      await fireWebhookToEndpoints(updated.schoolId, 'report.ready', {
        jobId: updated.jobId,
        type: updated.type,
        downloadUrl,
        expiresAt: updated.downloadExpiresAt,
      });
    } catch (err) {
      // Notifications are best-effort; do not fail the job after the artifact is ready.
      logger.warn('[ReportQueue] Completion notification failed', { jobId, error: err.message });
    }

    // Issue #362 — emit report.ready on the event bus so the notification
    // subscriber creates an in-app notification for the school.
    try {
      paymentEvents.emit('report.ready', {
        schoolId: updated.schoolId,
        jobId: updated.jobId,
        reportType: updated.type,
        downloadUrl: `/api/reports/jobs/${updated.jobId}/download`,
      });
    } catch (err) {
      logger.warn('[ReportQueue] report.ready event emit failed', { jobId, error: err.message });
    }
  }
}

async function setJobFailed(jobId, error) {
  await ReportJob.findOneAndUpdate(
    { jobId, status: { $in: [REPORT_STATUSES.PENDING, REPORT_STATUSES.PROCESSING] } },
    { status: REPORT_STATUSES.FAILED, completedAt: new Date(), 'result.error': error?.message || String(error) }
  );
}

function startReportWorker(processor) {
  if (worker) return worker;

  const connection = getRedisClient();
  if (!connection) {
    logger.warn('[ReportQueue] Redis unavailable — report worker not started');
    return null;
  }

  worker = new Worker(QUEUE_NAME, processor, {
    connection,
    concurrency: parseInt(process.env.REPORT_QUEUE_CONCURRENCY, 10) || 2,
  });

  worker.on('completed', (job) => {
    logger.info('[ReportQueue] Job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('[ReportQueue] Job failed', {
      jobId: job?.id,
      error: err.message,
    });
    require('./deadLetterQueue').moveExhaustedJob(QUEUE_NAME, job, err)
      .catch((dlqError) => logger.error('[ReportQueue] Failed to move exhausted job to DLQ', { jobId: job?.id, error: dlqError.message }));
  });

  logger.info('[ReportQueue] Worker started', {
    concurrency: parseInt(process.env.REPORT_QUEUE_CONCURRENCY, 10) || 2,
  });

  return worker;
}

async function closeQueue() {
  try {
    if (reportQueue) {
      await reportQueue.close();
      reportQueue = null;
    }
    if (worker) {
      await worker.close();
      worker = null;
    }
  } catch (err) {
    logger.error('[ReportQueue] Failed to close queue', { error: err.message });
  }
}

module.exports = {
  createQueue,
  enqueueReportJob,
  getReportJob,
  getJobStatus,
  setJobProcessing,
  setJobCompleted,
  setJobFailed,
  startReportWorker,
  closeQueue,
  QUEUE_NAME,
};