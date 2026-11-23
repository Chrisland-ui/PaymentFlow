'use strict';

const { Queue, Worker } = require('bullmq');
const { getRedisClient } = require('../config/redisClient');
const logger = require('../utils/logger').child('RetentionQueue');

const QUEUE_NAME = 'data-retention';
const INTERVAL_MS = Math.max(60_000, parseInt(process.env.DATA_RETENTION_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000);
let queue = null;
let worker = null;
let starting = null;

async function startRetentionScheduler() {
  if (queue || starting) return starting;
  starting = (async () => {
    const connection = getRedisClient();
    if (!connection) {
      logger.warn('Retention schedule unavailable because Redis is not configured');
      return;
    }

    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    });

    worker = new Worker(QUEUE_NAME, async () => {
      const { runRetention } = require('./retentionService');
      const automaticPurgeEnabled = process.env.DATA_RETENTION_AUTO_PURGE === 'true';
      const report = await runRetention({
        dryRun: !automaticPurgeEnabled,
        performedBy: 'retention-scheduler',
      });
      logger.info('Scheduled retention run completed', {
        dryRun: report.dryRun,
        candidates: report.totals.candidates,
        deleted: report.totals.deleted,
      });
      return report.totals;
    }, { connection, concurrency: 1 });

    worker.on('failed', (job, error) => {
      logger.error('Scheduled retention job failed', { jobId: job?.id, error: error.message });
    });

    await queue.upsertJobScheduler(
      'daily-data-retention',
      { every: INTERVAL_MS },
      { name: 'enforce-data-retention', data: {} },
    );
    logger.info('Retention job scheduled', { intervalMs: INTERVAL_MS });
  })().catch(async (error) => {
    logger.error('Failed to initialize retention queue', { error: error.message });
    if (worker) await worker.close().catch(() => {});
    if (queue) await queue.close().catch(() => {});
    worker = null;
    queue = null;
  }).finally(() => {
    starting = null;
  });
  return starting;
}

async function stopRetentionScheduler() {
  if (starting) await starting;
  const activeWorker = worker;
  const activeQueue = queue;
  worker = null;
  queue = null;
  if (activeWorker) await activeWorker.close();
  if (activeQueue) await activeQueue.close();
}

module.exports = { startRetentionScheduler, stopRetentionScheduler };
