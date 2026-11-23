'use strict';

const {
  sanitizeJobPayload,
  moveToDeadLetterQueue,
} = require('../backend/src/queue/transactionRetryQueue');
const bullMQRetryService = require('../backend/src/services/bullMQRetryService');
const PendingVerification = require('../backend/src/models/pendingVerificationModel');
const Payment = require('../backend/src/models/paymentModel');

// Mocks
const mockDLQAdd = jest.fn();
const mockDLQGetJob = jest.fn();
const mockDLQGetWaiting = jest.fn();
const mockDLQGetWaitingCount = jest.fn();
const mockRetryQueueAdd = jest.fn();

const mockDLQ = {
  add: mockDLQAdd,
  getJob: mockDLQGetJob,
  getWaiting: mockDLQGetWaiting,
  getWaitingCount: mockDLQGetWaitingCount,
};

const mockRetryQueue = {
  add: mockRetryQueueAdd,
  getJob: jest.fn().mockResolvedValue(null),
};

jest.mock('../backend/src/queue/transactionRetryQueue', () => {
  const original = jest.requireActual('../backend/src/queue/transactionRetryQueue');
  return {
    ...original,
    createDeadLetterQueue: jest.fn(() => mockDLQ),
    getDeadLetterQueue: jest.fn(() => mockDLQ),
    addTransactionToRetryQueue: jest.fn((...args) => mockRetryQueueAdd(...args)),
  };
});

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockReturnValue({ option: jest.fn().mockResolvedValue([]) }),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn(),
}));

describe('Dead-Letter Queue Handling (#37)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Payload Sanitization (Sensitive Data Protection)', () => {
    it('redacts sensitive credentials, tokens, passwords, and private keys', () => {
      const sensitiveData = {
        transactionHash: 'a'.repeat(64),
        studentId: 'STU-12345',
        jwtToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
        password: 'super-secret-password',
        schoolSecret: 'secret_key_9999',
        privateKey: 'private-data',
        authHeader: 'Bearer token-xyz',
        nested: {
          credentialInfo: 'sensitive-cred',
          safeField: 'safe-value',
        },
      };

      const sanitized = sanitizeJobPayload(sensitiveData);

      expect(sanitized.transactionHash).toBe('a'.repeat(64));
      expect(sanitized.studentId).toBe('STU-12345');
      expect(sanitized.jwtToken).toBe('[REDACTED]');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.schoolSecret).toBe('[REDACTED]');
      expect(sanitized.privateKey).toBe('[REDACTED]');
      expect(sanitized.authHeader).toBe('[REDACTED]');
      expect(sanitized.nested.credentialInfo).toBe('[REDACTED]');
      expect(sanitized.nested.safeField).toBe('safe-value');
    });

    it('redacts Stellar secret keys (S... format)', () => {
      const dataWithStellarKey = {
        txHash: 'b'.repeat(64),
        stellarSecret: 'SB7W24M55K3F5T4F4HOG4M6ZCY5I56D76766K6S7N2QJJ33433722234',
        memo: 'student-memo',
      };

      const sanitized = sanitizeJobPayload(dataWithStellarKey);
      expect(sanitized.stellarSecret).toBe('[REDACTED]');
      expect(sanitized.memo).toBe('student-memo');
    });

    it('masks email addresses in payloads', () => {
      const data = {
        userEmail: 'student.parent@example.com',
        amount: '150.00',
      };

      const sanitized = sanitizeJobPayload(data);
      expect(sanitized.userEmail).toBe('st***@example.com');
      expect(sanitized.amount).toBe('150.00');
    });
  });

  describe('moveToDeadLetterQueue', () => {
    it('stores exhausted job in DLQ with failure reason, correlation ID, attempt history, and safe payload', async () => {
      const job = {
        id: 'retry-job-99',
        attemptsMade: 4,
        data: {
          transactionHash: 'c'.repeat(64),
          studentId: 'STU-99',
          correlationId: 'corr-id-123',
          secretAuthToken: 'secret-xyz',
          attemptHistory: [
            { attemptNumber: 1, error: 'Network timeout', errorCode: 'TIMEOUT' },
            { attemptNumber: 2, error: 'Network timeout', errorCode: 'TIMEOUT' },
          ],
        },
      };

      const terminalError = new Error('Stellar account does not exist');
      terminalError.code = 'INVALID_DESTINATION';

      await moveToDeadLetterQueue(job, terminalError);

      expect(mockDLQAdd).toHaveBeenCalledTimes(1);
      const [jobName, dlqData] = mockDLQAdd.mock.calls[0];

      expect(jobName).toBe('dead-letter');
      expect(dlqData.originalJobId).toBe('retry-job-99');
      expect(dlqData.transactionHash).toBe('c'.repeat(64));
      expect(dlqData.studentId).toBe('STU-99');
      expect(dlqData.correlationId).toBe('corr-id-123');
      expect(dlqData.failureReason).toBe('Stellar account does not exist');
      expect(dlqData.failureCode).toBe('INVALID_DESTINATION');
      expect(dlqData.failedAttempts).toBe(5);
      expect(dlqData.attemptHistory.length).toBe(3);
      expect(dlqData.safePayload.secretAuthToken).toBe('[REDACTED]');

      expect(PendingVerification.findOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'c'.repeat(64) },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'dead_letter',
            correlationId: 'corr-id-123',
            failureCode: 'INVALID_DESTINATION',
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('Operator Inspection and Replay', () => {
    it('allows operators to list and inspect dead-letter jobs', async () => {
      mockDLQGetWaiting.mockResolvedValueOnce([
        {
          id: 'dlq-1',
          timestamp: 1600000000000,
          data: {
            originalJobId: 'orig-1',
            transactionHash: 'd'.repeat(64),
            studentId: 'STU-1',
            correlationId: 'corr-1',
            failureReason: 'Connection refused',
            failureCode: 'CONN_ERR',
            failedAttempts: 3,
            attemptHistory: [],
            safePayload: { amount: '200' },
            failedAt: new Date().toISOString(),
          },
        },
      ]);
      mockDLQGetWaitingCount.mockResolvedValueOnce(1);

      const result = await bullMQRetryService.listDeadLetterJobs({ limit: 10, offset: 0 });

      expect(result.total).toBe(1);
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].jobId).toBe('dlq-1');
      expect(result.jobs[0].transactionHash).toBe('d'.repeat(64));
    });

    it('performs idempotent replay: skips re-enqueue if transaction is already confirmed', async () => {
      const mockRemove = jest.fn().mockResolvedValue({});
      mockDLQGetJob.mockResolvedValueOnce({
        id: 'dlq-job-done',
        data: {
          transactionHash: 'e'.repeat(64),
          studentId: 'STU-2',
          correlationId: 'corr-2',
          safePayload: {},
        },
        remove: mockRemove,
      });

      // Payment already confirmed
      Payment.findOne.mockResolvedValueOnce({
        txHash: 'e'.repeat(64),
        status: 'SUCCESS',
      });

      const replayResult = await bullMQRetryService.replayDeadLetterJob('dlq-job-done', {
        performedBy: 'admin-user-1',
      });

      expect(replayResult.success).toBe(true);
      expect(replayResult.replayed).toBe(false);
      expect(replayResult.idempotent).toBe(true);
      expect(mockRetryQueueAdd).not.toHaveBeenCalled();
      expect(mockRemove).toHaveBeenCalled();
    });

    it('replays safe job when transaction is not yet confirmed', async () => {
      const mockRemove = jest.fn().mockResolvedValue({});
      mockDLQGetJob.mockResolvedValueOnce({
        id: 'dlq-job-safe',
        data: {
          transactionHash: 'f'.repeat(64),
          studentId: 'STU-3',
          correlationId: 'corr-3',
          safePayload: { amount: '100' },
        },
        remove: mockRemove,
      });

      // Payment not yet recorded/confirmed
      Payment.findOne.mockResolvedValueOnce(null);
      mockRetryQueueAdd.mockResolvedValueOnce({ id: 'new-retry-job-1' });

      const replayResult = await bullMQRetryService.replayDeadLetterJob('dlq-job-safe', {
        performedBy: 'admin-user-1',
      });

      expect(replayResult.success).toBe(true);
      expect(replayResult.replayed).toBe(true);
      expect(replayResult.idempotent).toBe(false);
      expect(mockRetryQueueAdd).toHaveBeenCalledWith(
        'f'.repeat(64),
        'STU-3',
        expect.objectContaining({
          correlationId: 'corr-3',
          replayedFromDLQ: true,
          replayedJobId: 'dlq-job-safe',
        })
      );
      expect(mockRemove).toHaveBeenCalled();
      expect(PendingVerification.findOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'f'.repeat(64) },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'pending',
            attempts: 0,
          }),
          $inc: { replayCount: 1 },
        }),
        expect.any(Object)
      );
    });
  });
});
