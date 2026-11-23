'use strict';

const { Queue, Worker } = require('bullmq');
const { getRedisClient } = require('../config/redisClient');
const ImportJob = require('../models/importJobModel');
const logger = require('../utils/logger');

const QUEUE_NAME = 'student-bulk-import';
let queue = null;
let worker = null;

function createQueue() {
  if (queue) return queue;
  const connection = getRedisClient();
  if (!connection) return null;

  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 10000 },
    },
  });
  return queue;
}

async function enqueueStudentImport(data) {
  const importQueue = createQueue();
  if (!importQueue) {
    const error = new Error('Student import queue is unavailable');
    error.code = 'QUEUE_UNAVAILABLE';
    throw error;
  }
  return importQueue.add('import-students', data, { jobId: data.jobId });
}

function startWorker(processor) {
  if (worker) return worker;
  const connection = getRedisClient();
  if (!connection) {
    logger.warn('[StudentImportQueue] Redis unavailable; worker not started');
    return null;
  }

  worker = new Worker(QUEUE_NAME, processor, {
    connection,
    concurrency: parseInt(process.env.STUDENT_IMPORT_CONCURRENCY, 10) || 2,
  });
  worker.on('completed', (job) => {
    logger.info('[StudentImportQueue] Import completed', { jobId: job.id });
  });
  worker.on('failed', async (job, error) => {
    logger.error('[StudentImportQueue] Import attempt failed', { jobId: job?.id, error: error.message });
    if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;

    await ImportJob.findOneAndUpdate(
      { jobId: job.data.jobId, status: { $in: ['pending', 'processing'] } },
      { status: 'failed', completedAt: new Date(), failureReason: error.message }
    ).catch((updateError) => logger.error('[StudentImportQueue] Failed to mark job failed', {
      jobId: job.id,
      error: updateError.message,
    }));

    const mongoose = require('mongoose');
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'studentImports' });
    bucket.delete(new mongoose.mongo.ObjectId(job.data.fileId)).catch(() => {});
  });
  return worker;
}

async function closeQueue() {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

module.exports = { createQueue, enqueueStudentImport, startWorker, closeQueue, QUEUE_NAME };
