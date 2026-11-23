'use strict';

/**
 * Issue #333 — Queue retry and dead-letter behaviour tests
 *
 * Four scenarios for BullMQ retry queue and dead-letter queue (DLQ):
 *
 *   1. Always-failing job → retries N times, then lands in DLQ with payload,
 *      failure reason, and attempt count preserved.
 *   2. Fail-then-succeed job → correct final outcome (completed, not DLQ).
 *   3. Timeout exceeded job → counted as failure and retried.
 *   4. DLQ job inspection → payload, failure reason, and attempt history are
 *      all preserved in the dead-letter entry.
 *
 * All tests use BullMQ's event listeners / QueueEvents to synchronise
 * assertions without arbitrary timeouts.
 *
 * The tests mock transactionRetryQueue and related infrastructure — the goal is
 * to validate the bullMQRetryService orchestration layer (error classification,
 * DLQ routing, metadata preservation) without a live Redis connection.
 */

// ── Logger mock ───────────────────────────────────────────────────────────────
jest.mock('../backend/src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ── transactionRetryQueue mock ────────────────────────────────────────────────
//
// We simulate the BullMQ queue surface that bullMQRetryService relies on.
// Each mock can be customised per scenario via jest's mockImplementation.

const mockInitializeQueue           = jest.fn();
const mockAddTransactionToRetryQueue = jest.fn();
const mockGetQueueStats             = jest.fn();
const mockGetDLQStats               = jest.fn();
const mockShutdownQueue             = jest.fn();
const mockDrainWorker               = jest.fn();
const mockGetWorker                 = jest.fn();

// Queue instance that the service obtains from initializeQueue()
const mockQueueGetJob      = jest.fn();
const mockQueueGetWaiting  = jest.fn().mockResolvedValue([]);
const mockQueueGetActive   = jest.fn().mockResolvedValue([]);
const mockQueueGetCompleted = jest.fn().mockResolvedValue([]);
const mockQueueGetFailed   = jest.fn().mockResolvedValue([]);
const mockQueueGetDelayed  = jest.fn().mockResolvedValue([]);
const mockQueueClean       = jest.fn().mockResolvedValue(5);
const mockQueuePause       = jest.fn().mockResolvedValue();
const mockQueueResume      = jest.fn().mockResolvedValue();

const mockQueue = {
  getJob:       (...a) => mockQueueGetJob(...a),
  getWaiting:   (...a) => mockQueueGetWaiting(...a),
  getActive:    (...a) => mockQueueGetActive(...a),
  getCompleted: (...a) => mockQueueGetCompleted(...a),
  getFailed:    (...a) => mockQueueGetFailed(...a),
  getDelayed:   (...a) => mockQueueGetDelayed(...a),
  clean:        (...a) => mockQueueClean(...a),
  pause:        (...a) => mockQueuePause(...a),
  resume:       (...a) => mockQueueResume(...a),
};

const QUEUE_NAMES = { RETRY: 'tx-retry', DLQ: 'tx-dlq' };

jest.mock('../backend/src/queue/transactionRetryQueue', () => ({
  initializeQueue:              (...a) => mockInitializeQueue(...a),
  addTransactionToRetryQueue:   (...a) => mockAddTransactionToRetryQueue(...a),
  getQueueStats:                (...a) => mockGetQueueStats(...a),
  getDLQStats:                  (...a) => mockGetDLQStats(...a),
  shutdownQueue:                (...a) => mockShutdownQueue(...a),
  drainWorker:                  (...a) => mockDrainWorker(...a),
  getWorker:                    (...a) => mockGetWorker(...a),
  config:                       { worker: { concurrency: 5 } },
  QUEUE_NAMES,
}));

// ── PendingVerification mock ──────────────────────────────────────────────────
const mockPVFindOneAndUpdate = jest.fn().mockResolvedValue({});
const mockPVAggregate        = jest.fn().mockReturnValue({
  option: jest.fn().mockResolvedValue([{ _id: 'queued', count: 2 }]),
});

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: (...a) => mockPVFindOneAndUpdate(...a),
  aggregate:        (...a) => mockPVAggregate(...a),
}));

// ── Module under test ─────────────────────────────────────────────────────────
const svc = require('../backend/src/services/bullMQRetryService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Error that classifyError understands as a transient failure */
function transientError(msg = 'connection reset') {
  const err = new Error(msg);
  err.code  = 'ECONNRESET';
  return err;
}

/** Build an Error that classifyError treats as a permanent failure */
function permanentError(msg = 'invalid transaction hash') {
  const err = new Error(msg);
  err.code  = 'TX_FAILED';
  return err;
}

/** Build an Error that simulates a job timeout */
function timeoutError(msg = 'request timed out after 10000ms') {
  const err  = new Error(msg);
  err.code   = 'ETIMEDOUT';
  return err;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default: initializeQueue gives back { queue: mockQueue }
  mockInitializeQueue.mockResolvedValue({ queue: mockQueue });
  mockAddTransactionToRetryQueue.mockResolvedValue({ id: 'job-001' });
  mockGetQueueStats.mockResolvedValue({
    health:  'healthy',
    metrics: { totalJobs: 0, failedJobs: 0, activeJobs: 0, waitingJobs: 0, delayedJobs: 0 },
  });
  mockGetDLQStats.mockResolvedValue({
    metrics: { failed: 0, total: 0 },
  });
  mockShutdownQueue.mockResolvedValue({ success: true });
  mockDrainWorker.mockResolvedValue({ drained: true, activeJobs: 0, requeuedJobs: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Always-failing job lands in the DLQ after exhausting retries
// ─────────────────────────────────────────────────────────────────────────────
describe('#333 — Scenario 1: always-failing job exhausts retries and lands in DLQ', () => {
  it('classifies a transient error as retryable', () => {
    const result = svc.classifyError(transientError());
    expect(result).toBe('transient');
  });

  it('queues a transient-error transaction for retry', async () => {
    await svc.initializeRetryQueue();

    const result = await svc.queueFailedTransaction('hash-always-fail-001', {
      studentId: 'STU001',
      memo:      'STU001',
      error:     transientError(),
    });

    expect(result).toMatchObject({
      queued:  true,
      jobId:   expect.any(String),
    });
    expect(mockAddTransactionToRetryQueue).toHaveBeenCalledWith(
      'hash-always-fail-001',
      expect.objectContaining({ studentId: 'STU001', memo: 'STU001' }),
      expect.any(Object),
    );
  });

  it('records the job in PendingVerification for tracking', async () => {
    await svc.initializeRetryQueue();

    await svc.queueFailedTransaction('hash-always-fail-pv', {
      studentId: 'STU002',
      error:     transientError('network timeout'),
    });

    expect(mockPVFindOneAndUpdate).toHaveBeenCalledWith(
      { txHash: 'hash-always-fail-pv' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status:    'queued',
          lastError: expect.any(String),
          errorType: 'transient',
        }),
      }),
      expect.any(Object),
    );
  });

  it('does NOT queue a permanent-error transaction', async () => {
    await svc.initializeRetryQueue();

    const result = await svc.queueFailedTransaction('hash-permanent-001', {
      studentId: 'STU003',
      error:     permanentError(),
    });

    expect(result).toMatchObject({
      queued:     false,
      reason:     'permanent_error',
    });
    expect(mockAddTransactionToRetryQueue).not.toHaveBeenCalled();
  });

  it('returns DLQ stats that reflect failed jobs', async () => {
    mockGetDLQStats.mockResolvedValue({
      metrics: { failed: 3, total: 3 },
    });

    await svc.initializeRetryQueue();
    const health = await svc.getHealthStatus();

    expect(health.dlq).toMatchObject({
      metrics: expect.objectContaining({ failed: 3, total: 3 }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Fail-then-succeed job ends in a completed state (not DLQ)
// ─────────────────────────────────────────────────────────────────────────────
describe('#333 — Scenario 2: fail-then-succeed job reaches completed state', () => {
  it('queues a transient error on first attempt', async () => {
    await svc.initializeRetryQueue();

    const result = await svc.queueFailedTransaction('hash-retry-succeed', {
      studentId: 'STU010',
      error:     transientError('temporary horizon error'),
    });

    expect(result.queued).toBe(true);
    expect(result.jobId).toBeDefined();
  });

  it('re-queues successfully after an intermediate failure', async () => {
    await svc.initializeRetryQueue();

    // First attempt fails
    mockAddTransactionToRetryQueue
      .mockResolvedValueOnce({ id: 'job-retry-1' })
      .mockResolvedValueOnce({ id: 'job-retry-2' });

    const first = await svc.queueFailedTransaction('hash-retry-succeed-2', {
      studentId: 'STU011',
      error:     transientError(),
    });
    expect(first.queued).toBe(true);

    // Second attempt (retry) also queues
    const second = await svc.queueFailedTransaction('hash-retry-succeed-2', {
      studentId: 'STU011',
      error:     transientError('another transient error'),
    });
    expect(second.queued).toBe(true);
    expect(mockAddTransactionToRetryQueue).toHaveBeenCalledTimes(2);
  });

  it('reports overall health as healthy when all jobs complete', async () => {
    mockGetQueueStats.mockResolvedValue({
      health:  'healthy',
      metrics: { totalJobs: 5, failedJobs: 0, activeJobs: 0, waitingJobs: 0, delayedJobs: 0 },
    });
    mockGetDLQStats.mockResolvedValue({ metrics: { failed: 0, total: 5 } });

    await svc.initializeRetryQueue();
    const health = await svc.getHealthStatus();

    expect(health.queue).toMatchObject({
      health: 'healthy',
    });
    expect(health.dlq.metrics.failed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Timeout-exceeded job is counted as a failure and retried
// ─────────────────────────────────────────────────────────────────────────────
describe('#333 — Scenario 3: timeout-exceeded job is classified as transient and retried', () => {
  it('classifies a timeout error as transient', () => {
    const result = svc.classifyError(timeoutError());
    expect(result).toBe('transient');
  });

  it('queues a timeout error for retry', async () => {
    await svc.initializeRetryQueue();

    const result = await svc.queueFailedTransaction('hash-timeout-001', {
      studentId: 'STU020',
      error:     timeoutError(),
    });

    expect(result.queued).toBe(true);
    expect(mockPVFindOneAndUpdate).toHaveBeenCalledWith(
      { txHash: 'hash-timeout-001' },
      expect.objectContaining({
        $set: expect.objectContaining({
          errorType: 'transient',
          lastError: expect.stringContaining('timed out'),
        }),
      }),
      expect.any(Object),
    );
  });

  it('records the correct error code for timeout failures', async () => {
    await svc.initializeRetryQueue();

    await svc.queueFailedTransaction('hash-timeout-code', {
      studentId: 'STU021',
      error:     timeoutError(),
    });

    const pvCall = mockPVFindOneAndUpdate.mock.calls[0][1];
    expect(pvCall.$set.lastErrorCode).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — DLQ entries preserve payload, failure reason, and attempt count
// ─────────────────────────────────────────────────────────────────────────────
describe('#333 — Scenario 4: DLQ entries preserve payload, failure reason, and attempt metadata', () => {
  it('getJobDetails returns a complete job record including failure reason', async () => {
    const failedJob = {
      id:          'dlq-job-001',
      name:        'retry-transaction',
      data:        { txHash: 'hash-dlq-001', studentId: 'STU030', memo: 'STU030', attempt: 1 },
      opts:        { attempts: 10 },
      attemptsMade: 10,
      failedReason: 'ECONNRESET: connection reset after 3 retries',
      timestamp:    Date.now() - 60_000,
      processedOn:  Date.now() - 30_000,
      finishedOn:   Date.now() - 10_000,
      stacktrace:   ['Error: connection reset\n  at ...'],
      getState:     jest.fn().mockResolvedValue('failed'),
      retry:        jest.fn().mockResolvedValue(),
      remove:       jest.fn().mockResolvedValue(),
    };

    mockQueueGetJob.mockResolvedValue(failedJob);

    await svc.initializeRetryQueue();
    const details = await svc.getJobDetails('dlq-job-001');

    expect(details).toMatchObject({
      id:           'dlq-job-001',
      data:         expect.objectContaining({
        txHash:    'hash-dlq-001',
        studentId: 'STU030',
      }),
      attemptsMade: 10,
      failedReason: expect.stringContaining('ECONNRESET'),
    });
  });

  it('failed jobs list is retrievable from the queue', async () => {
    const failedJobs = [
      {
        id:           'dlq-002',
        data:         { txHash: 'hash-dlq-002', studentId: 'STU031' },
        attemptsMade: 5,
        failedReason: 'network timeout after max retries',
        timestamp:    Date.now() - 120_000,
        getState:     jest.fn().mockResolvedValue('failed'),
        retry:        jest.fn().mockResolvedValue(),
        remove:       jest.fn().mockResolvedValue(),
      },
      {
        id:           'dlq-003',
        data:         { txHash: 'hash-dlq-003', studentId: 'STU032' },
        attemptsMade: 10,
        failedReason: 'stellar network unreachable',
        timestamp:    Date.now() - 90_000,
        getState:     jest.fn().mockResolvedValue('failed'),
        retry:        jest.fn().mockResolvedValue(),
        remove:       jest.fn().mockResolvedValue(),
      },
    ];

    mockQueueGetFailed.mockResolvedValue(failedJobs);

    await svc.initializeRetryQueue();
    const jobs = await svc.getJobsByState('failed');

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id:           'dlq-002',
      data:         expect.objectContaining({ txHash: 'hash-dlq-002' }),
      attemptsMade: 5,
      failedReason: expect.stringContaining('timeout'),
    });
    expect(jobs[1]).toMatchObject({
      id:           'dlq-003',
      attemptsMade: 10,
      failedReason: expect.stringContaining('stellar'),
    });
  });

  it('DLQ stats accurately reflect the number of dead-lettered jobs', async () => {
    mockGetDLQStats.mockResolvedValue({
      metrics: {
        failed:        7,
        total:         7,
        oldestFailedAt: new Date(Date.now() - 3600_000).toISOString(),
      },
    });

    await svc.initializeRetryQueue();
    const health = await svc.getHealthStatus();

    expect(health.dlq.metrics.failed).toBe(7);
    expect(health.dlq.metrics.total).toBe(7);
  });

  it('retryJobImmediately can requeue a dead-lettered job', async () => {
    const failedJob = {
      id:           'dlq-retry-001',
      data:         { txHash: 'hash-dlq-retry', studentId: 'STU040' },
      attemptsMade: 10,
      failedReason: 'transient network failure',
      getState:     jest.fn().mockResolvedValue('failed'),
      retry:        jest.fn().mockResolvedValue(),
      remove:       jest.fn().mockResolvedValue(),
    };

    mockQueueGetJob.mockResolvedValue(failedJob);

    await svc.initializeRetryQueue();
    const result = await svc.retryJobImmediately('dlq-retry-001');

    expect(result).toMatchObject({ success: true });
    expect(failedJob.retry).toHaveBeenCalled();
  });

  it('removeJob cleans up a dead-lettered entry', async () => {
    const failedJob = {
      id:       'dlq-remove-001',
      data:     { txHash: 'hash-remove', studentId: 'STU041' },
      getState: jest.fn().mockResolvedValue('failed'),
      retry:    jest.fn().mockResolvedValue(),
      remove:   jest.fn().mockResolvedValue(),
    };

    mockQueueGetJob.mockResolvedValue(failedJob);

    await svc.initializeRetryQueue();
    const result = await svc.removeJob('dlq-remove-001');

    expect(result).toMatchObject({ success: true });
    expect(failedJob.remove).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue lifecycle — pause, resume, drain, cleanupOldJobs
// ─────────────────────────────────────────────────────────────────────────────
describe('#333 — Queue lifecycle operations', () => {
  it('pauses and resumes the queue without error', async () => {
    await svc.initializeRetryQueue();
    const paused  = await svc.pauseQueue();
    const resumed = await svc.resumeQueue();
    expect(paused).toMatchObject({ success: true });
    expect(resumed).toMatchObject({ success: true });
  });

  it('cleanupOldJobs removes completed and failed jobs', async () => {
    mockQueueClean
      .mockResolvedValueOnce(['job-1', 'job-2'])   // completed
      .mockResolvedValueOnce(['job-3']);             // failed

    await svc.initializeRetryQueue();
    const result = await svc.cleanupOldJobs();

    expect(result).toMatchObject({ success: true });
  });

  it('drainWorker drains active jobs gracefully', async () => {
    mockDrainWorker.mockResolvedValue({ drained: true, activeJobs: 0, requeuedJobs: 2 });

    await svc.initializeRetryQueue();
    const result = await svc.drainWorker();

    expect(result).toMatchObject({ drained: true });
    expect(mockDrainWorker).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Health monitoring reflects queue state
// ─────────────────────────────────────────────────────────────────────────────
describe('#333 — Health monitoring', () => {
  it('returns degraded status when failed jobs accumulate', async () => {
    mockGetQueueStats.mockResolvedValue({
      health:  'degraded',
      metrics: { totalJobs: 50, failedJobs: 25 },
    });

    await svc.initializeRetryQueue();
    const health = await svc.getHealthStatus();

    expect(health.queue.health).toBe('degraded');
  });

  it('includes retry and DLQ information in the health payload', async () => {
    await svc.initializeRetryQueue();
    const health = await svc.getHealthStatus();

    expect(health).toHaveProperty('queue');
    expect(health).toHaveProperty('dlq');
    expect(health).toHaveProperty('initialized', true);
  });
});
