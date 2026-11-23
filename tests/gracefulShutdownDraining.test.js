'use strict';

/**
 * Graceful Shutdown and Drain Tests (Issue #296)
 *
 * Verifies:
 *   - Readiness probe flips to false immediately on shutdown start
 *   - Shutdown manager coordinates worker drain and queue closure
 */

const {
  setReady,
  isReady,
  isShutdownInProgress,
  drainWorkers,
  closeQueues,
} = require('../backend/src/services/shutdownManager');

jest.mock('../backend/src/queue/transactionQueue', () => ({
  drainWorker: jest.fn().mockResolvedValue({ drained: true }),
  closeQueue: jest.fn().mockResolvedValue(true),
}));

jest.mock('../backend/src/queue/transactionRetryQueue', () => ({
  drainWorker: jest.fn().mockResolvedValue({ drained: true }),
  closeQueue: jest.fn().mockResolvedValue(true),
}));

describe('Graceful Shutdown Manager (#296)', () => {
  test('readiness flips to false and marks shutdown in progress', () => {
    setReady(false);
    expect(isReady()).toBe(false);
    expect(isShutdownInProgress()).toBe(true);
  });

  test('drainWorkers drains queues within timeout', async () => {
    const results = await drainWorkers();
    expect(results.txQueue).toBe(true);
    expect(results.retryQueue).toBe(true);
  });

  test('closeQueues closes all queue instances without error', async () => {
    await expect(closeQueues()).resolves.not.toThrow();
  });
});
