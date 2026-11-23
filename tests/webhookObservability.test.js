'use strict';

/**
 * Tests for webhook delivery observability improvements:
 *   1. Bounded backoff: jitter applied, WEBHOOK_MAX_BACKOFF_MS cap respected
 *   2. 4xx vs 5xx policy: 4xx never queued for retry, 5xx is retried
 *   3. Metrics: status_class label, attempt counter, terminal-outcome counter
 */

process.env.MONGO_URI            = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: mockAxiosPost, create: () => ({ post: mockAxiosPost }) }));
jest.mock('uuid', () => ({ v4: () => 'test-uuid-observability' }));

jest.mock('../backend/src/models/webhookRetryModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/models/webhookDeliveryModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/utils/validateWebhookUrl', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
  validateResolvedIp: jest.fn().mockReturnValue({ blocked: false }),
}));

jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../backend/src/config/redisClient', () => ({
  isRedisReady: jest.fn().mockReturnValue(true),
  getRedisClient: jest.fn().mockReturnValue({
    set: jest.fn().mockResolvedValue('1'),
  }),
}));

jest.mock('../backend/src/utils/dnsCache', () => ({
  resolveDnsWithCache: jest.fn().mockResolvedValue(['203.0.113.1']),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  find:      jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  findOne:   jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/utils/buildWebhookPayload', () => ({
  buildWebhookPayload: jest.fn((payload) => payload),
}));

jest.mock('../backend/src/models/webhookEndpointModel', () => ({
  find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
}));

// Metrics mocks — we want to assert on calls, not hit a real prom-client registry
const mockRecordDeliverySuccess  = jest.fn();
const mockRecordDeliveryFailure  = jest.fn();
const mockRecordRetryAttempt     = jest.fn();
const mockRecordTerminalOutcome  = jest.fn();
const mockRefreshDeadLetterGauge = jest.fn().mockResolvedValue(undefined);

jest.mock('../backend/src/metrics/webhookMetrics', () => ({
  recordDeliverySuccess:     mockRecordDeliverySuccess,
  recordDeliveryFailure:     mockRecordDeliveryFailure,
  recordRetryAttempt:        mockRecordRetryAttempt,
  recordTerminalOutcome:     mockRecordTerminalOutcome,
  refreshDeadLetterGauge:    mockRefreshDeadLetterGauge,
  classifyStatus:            jest.requireActual('../backend/src/metrics/webhookMetrics').classifyStatus,
}));

const WebhookRetry = require('../backend/src/models/webhookRetryModel');

const {
  fireWebhook,
  retryWebhook,
  getBackoffDelay,
  isPermanentError,
  WEBHOOK_MAX_BACKOFF_MS,
} = require('../backend/src/services/webhookService');

const { classifyStatus } = require('../backend/src/metrics/webhookMetrics');

const BASE_RETRY = {
  _id:         'retry-obs-id',
  url:         'https://example.com/webhook',
  event:       'payment.confirmed',
  payload:     { studentId: 'STU001', amount: 200 },
  secret:      null,
  deliveryId:  'delivery-obs',
  correlationId: null,
  endpointId:  null,
  schoolId:    'SCH-001',
  status:      'processing',
  attemptCount: 0,
  maxAttempts: 3,
  nextRetryAt: new Date(),
  lastError:   null,
  errorLog:    [],
};

beforeEach(() => {
  jest.clearAllMocks();
  WebhookRetry.create.mockResolvedValue({});
  WebhookRetry.updateOne.mockResolvedValue({});
  WebhookRetry.findOneAndUpdate.mockResolvedValue(null);

  const redisClient = require('../backend/src/config/redisClient');
  redisClient.isRedisReady.mockReturnValue(true);
  redisClient.getRedisClient.mockReturnValue({ set: jest.fn().mockResolvedValue('1') });
});

// ── classifyStatus ────────────────────────────────────────────────────────────

describe('classifyStatus', () => {
  test('200 → 2xx', () => expect(classifyStatus(200)).toBe('2xx'));
  test('201 → 2xx', () => expect(classifyStatus(201)).toBe('2xx'));
  test('400 → 4xx', () => expect(classifyStatus(400)).toBe('4xx'));
  test('401 → 4xx', () => expect(classifyStatus(401)).toBe('4xx'));
  test('404 → 4xx', () => expect(classifyStatus(404)).toBe('4xx'));
  test('500 → 5xx', () => expect(classifyStatus(500)).toBe('5xx'));
  test('503 → 5xx', () => expect(classifyStatus(503)).toBe('5xx'));
  test('301 → redirect_blocked', () => expect(classifyStatus(301)).toBe('redirect_blocked'));
  test('null + timeout message → timeout', () => expect(classifyStatus(null, 'Connection timeout')).toBe('timeout'));
  test('null + SSRF message → ssrf_blocked', () => expect(classifyStatus(null, 'SSRF_BLOCKED: reason')).toBe('ssrf_blocked'));
  test('null + no message → network_error', () => expect(classifyStatus(null)).toBe('network_error'));
});

// ── isPermanentError ──────────────────────────────────────────────────────────

describe('isPermanentError', () => {
  test('400 is permanent',  () => expect(isPermanentError(400)).toBe(true));
  test('401 is permanent',  () => expect(isPermanentError(401)).toBe(true));
  test('403 is permanent',  () => expect(isPermanentError(403)).toBe(true));
  test('404 is permanent',  () => expect(isPermanentError(404)).toBe(true));
  test('410 is permanent',  () => expect(isPermanentError(410)).toBe(true));
  test('422 is permanent',  () => expect(isPermanentError(422)).toBe(true));
  test('408 is NOT permanent (request timeout — retriable)', () => expect(isPermanentError(408)).toBe(false));
  test('429 is NOT permanent (rate limit — retriable)',       () => expect(isPermanentError(429)).toBe(false));
  test('425 is NOT permanent (too early — retriable)',        () => expect(isPermanentError(425)).toBe(false));
  test('500 is NOT permanent',  () => expect(isPermanentError(500)).toBe(false));
  test('503 is NOT permanent',  () => expect(isPermanentError(503)).toBe(false));
  test('null is NOT permanent', () => expect(isPermanentError(null)).toBe(false));
});

// ── getBackoffDelay ───────────────────────────────────────────────────────────

describe('getBackoffDelay — bounded backoff with jitter', () => {
  test('attempt 0 is within ±10% of 60 000 ms', () => {
    const delay = getBackoffDelay(0);
    expect(delay).toBeGreaterThanOrEqual(54000);  // 60000 * 0.9
    expect(delay).toBeLessThanOrEqual(66000);     // 60000 * 1.1
  });

  test('attempt 1 is within ±10% of 300 000 ms', () => {
    const delay = getBackoffDelay(1);
    expect(delay).toBeGreaterThanOrEqual(270000);
    expect(delay).toBeLessThanOrEqual(330000);
  });

  test('attempt 2 is within ±10% of 900 000 ms', () => {
    const delay = getBackoffDelay(2);
    expect(delay).toBeGreaterThanOrEqual(810000);
    expect(delay).toBeLessThanOrEqual(990000);
  });

  test('high attempt number never exceeds WEBHOOK_MAX_BACKOFF_MS * 1.1', () => {
    for (let i = 0; i < 20; i++) {
      const delay = getBackoffDelay(99);
      expect(delay).toBeLessThanOrEqual(Math.round(WEBHOOK_MAX_BACKOFF_MS * 1.1));
    }
  });

  test('WEBHOOK_MAX_BACKOFF_MS cap is respected when env var is set', () => {
    const saved = process.env.WEBHOOK_MAX_BACKOFF_MS;
    process.env.WEBHOOK_MAX_BACKOFF_MS = '120000'; // 2 min cap
    jest.resetModules();
    const svc = require('../backend/src/services/webhookService');
    // attempt 2 would normally be 15 min; cap is 2 min
    const delay = svc.getBackoffDelay(2);
    expect(delay).toBeLessThanOrEqual(Math.round(120000 * 1.1));
    if (saved === undefined) delete process.env.WEBHOOK_MAX_BACKOFF_MS;
    else process.env.WEBHOOK_MAX_BACKOFF_MS = saved;
  });

  test('returns different values on repeated calls (jitter is applied)', () => {
    const results = new Set(Array.from({ length: 20 }, () => getBackoffDelay(1)));
    // With 20 samples and ±10% jitter range the probability of all being equal is negligible
    expect(results.size).toBeGreaterThan(1);
  });
});

// ── 4xx policy: permanent errors skip the retry queue ────────────────────────

describe('4xx policy — permanent errors are not retried', () => {
  test('fireWebhook with 400 response does NOT queue a retry', async () => {
    const axiosError = Object.assign(new Error('HTTP 400'), {
      response: { status: 400, statusText: 'Bad Request', data: 'bad payload' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    const result = await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(result.success).toBe(false);
    expect(result.queued).toBe(false);
    expect(WebhookRetry.create).not.toHaveBeenCalled();
  });

  test('fireWebhook with 403 response does NOT queue a retry', async () => {
    const axiosError = Object.assign(new Error('HTTP 403'), {
      response: { status: 403, statusText: 'Forbidden', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    const result = await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(result.queued).toBe(false);
    expect(WebhookRetry.create).not.toHaveBeenCalled();
  });

  test('fireWebhook with 500 response DOES queue a retry', async () => {
    const axiosError = Object.assign(new Error('HTTP 500'), {
      response: { status: 500, statusText: 'Internal Server Error', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    const result = await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(result.queued).toBe(true);
    expect(WebhookRetry.create).toHaveBeenCalledTimes(1);
  });

  test('fireWebhook with 429 (rate limit) DOES queue a retry', async () => {
    const axiosError = Object.assign(new Error('HTTP 429'), {
      response: { status: 429, statusText: 'Too Many Requests', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    const result = await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(result.queued).toBe(true);
    expect(WebhookRetry.create).toHaveBeenCalledTimes(1);
  });

  test('retryWebhook with 400 response marks status failed immediately without re-queuing', async () => {
    const axiosError = Object.assign(new Error('HTTP 400'), {
      response: { status: 400, statusText: 'Bad Request', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    const setFields = WebhookRetry.updateOne.mock.calls[0][1].$set;
    expect(setFields.status).toBe('failed');
    // Should NOT be left as pending for another retry
    expect(setFields.nextRetryAt).toBeUndefined();
  });

  test('retryWebhook with 400 records permanent_error terminal outcome', async () => {
    const axiosError = Object.assign(new Error('HTTP 400'), {
      response: { status: 400, statusText: 'Bad Request', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    expect(mockRecordTerminalOutcome).toHaveBeenCalledWith('payment.confirmed', 'permanent_error');
  });

  test('retryWebhook with 503 re-queues (status stays pending)', async () => {
    const axiosError = Object.assign(new Error('HTTP 503'), {
      response: { status: 503, statusText: 'Service Unavailable', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    const setFields = WebhookRetry.updateOne.mock.calls[0][1].$set;
    expect(setFields.status).toBe('pending');
    expect(setFields.nextRetryAt).toBeInstanceOf(Date);
  });
});

// ── Metrics: attempt counter ──────────────────────────────────────────────────

describe('metrics — attempt counter', () => {
  test('retryWebhook success records attempt number', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    await retryWebhook({ ...BASE_RETRY, attemptCount: 1, maxAttempts: 3 });

    expect(mockRecordRetryAttempt).toHaveBeenCalledWith('payment.confirmed', 2);
  });

  test('retryWebhook failure records attempt number even when re-queued', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('network error'));

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    expect(mockRecordRetryAttempt).toHaveBeenCalledWith('payment.confirmed', 1);
  });

  test('retryWebhook exhaustion records attempt number', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('still down'));

    await retryWebhook({ ...BASE_RETRY, attemptCount: 2, maxAttempts: 3 });

    expect(mockRecordRetryAttempt).toHaveBeenCalledWith('payment.confirmed', 3);
  });
});

// ── Metrics: terminal outcome counter ────────────────────────────────────────

describe('metrics — terminal outcome counter', () => {
  test('retryWebhook success records succeeded terminal outcome', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0 });

    expect(mockRecordTerminalOutcome).toHaveBeenCalledWith('payment.confirmed', 'succeeded');
  });

  test('retryWebhook exhaustion records dead_lettered terminal outcome', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('still down'));

    await retryWebhook({ ...BASE_RETRY, attemptCount: 2, maxAttempts: 3 });

    expect(mockRecordTerminalOutcome).toHaveBeenCalledWith('payment.confirmed', 'dead_lettered');
  });

  test('retryWebhook exhaustion calls refreshDeadLetterGauge', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('still down'));

    await retryWebhook({ ...BASE_RETRY, attemptCount: 2, maxAttempts: 3 });

    expect(mockRefreshDeadLetterGauge).toHaveBeenCalled();
  });
});

// ── Metrics: status_class label on delivery failure ──────────────────────────

describe('metrics — status_class label on delivery failure', () => {
  test('5xx failure records with correct status_class via recordDeliveryFailure', async () => {
    const axiosError = Object.assign(new Error('HTTP 503'), {
      response: { status: 503, statusText: 'Service Unavailable', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    // recordDeliveryFailure called with (event, duration, isDeadLetter, schoolId, statusCode, errorMsg)
    expect(mockRecordDeliveryFailure).toHaveBeenCalledWith(
      'payment.confirmed',
      expect.any(Number),
      false,
      null,   // schoolId null for fireWebhook without schoolId
      503,
      expect.any(String),
    );
  });

  test('4xx failure records with statusCode passed to recordDeliveryFailure', async () => {
    const axiosError = Object.assign(new Error('HTTP 401'), {
      response: { status: 401, statusText: 'Unauthorized', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(mockRecordDeliveryFailure).toHaveBeenCalledWith(
      'payment.confirmed',
      expect.any(Number),
      false,
      null,
      401,
      expect.any(String),
    );
  });

  test('successful delivery records statusCode via recordDeliverySuccess', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 201, data: 'ok' });

    await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(mockRecordDeliverySuccess).toHaveBeenCalledWith(
      'payment.confirmed',
      expect.any(Number),
      201,
    );
  });
});

// ── responseClass persistence on WebhookRetry document ───────────────────────

describe('responseClass — persisted on WebhookRetry document', () => {
  test('5xx failure persists responseClass="5xx" on errorLog entry and $set', async () => {
    const axiosError = Object.assign(new Error('HTTP 503'), {
      response: { status: 503, statusText: 'Service Unavailable', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    const call = WebhookRetry.updateOne.mock.calls[0][1];
    expect(call.$set.responseClass).toBe('5xx');
    expect(call.$push.errorLog.responseClass).toBe('5xx');
    expect(call.$push.errorLog.statusCode).toBe(503);
  });

  test('4xx permanent failure persists responseClass="4xx" and terminalOutcome="permanent_error"', async () => {
    const axiosError = Object.assign(new Error('HTTP 403'), {
      response: { status: 403, statusText: 'Forbidden', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    const call = WebhookRetry.updateOne.mock.calls[0][1];
    expect(call.$set.responseClass).toBe('4xx');
    expect(call.$set.terminalOutcome).toBe('permanent_error');
    expect(call.$push.errorLog.responseClass).toBe('4xx');
    expect(call.$push.errorLog.statusCode).toBe(403);
  });

  test('exhausted retry persists responseClass and terminalOutcome="dead_lettered"', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('connection refused'));

    await retryWebhook({ ...BASE_RETRY, attemptCount: 2, maxAttempts: 3 });

    const call = WebhookRetry.updateOne.mock.calls[0][1];
    expect(call.$set.terminalOutcome).toBe('dead_lettered');
    // responseClass for a connection-refused error should be 'network_error'
    expect(call.$set.responseClass).toBe('network_error');
  });

  test('successful retry persists terminalOutcome="succeeded"', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    const call = WebhookRetry.updateOne.mock.calls[0][1];
    expect(call.$set.terminalOutcome).toBe('succeeded');
    expect(call.$set.status).toBe('succeeded');
  });

  test('fireWebhook with 500 queues retry with responseClass="5xx" in initial errorLog', async () => {
    const axiosError = Object.assign(new Error('HTTP 500'), {
      response: { status: 500, statusText: 'Internal Server Error', data: '' },
    });
    mockAxiosPost.mockRejectedValueOnce(axiosError);

    await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(WebhookRetry.create).toHaveBeenCalledTimes(1);
    const created = WebhookRetry.create.mock.calls[0][0];
    // responseClass on the retry document itself
    expect(created.responseClass).toBe('5xx');
    // initial errorLog entry also has the class
    expect(created.errorLog[0].responseClass).toBe('5xx');
  });

  test('timeout error persists responseClass="timeout"', async () => {
    const timeoutError = Object.assign(new Error('Connection timeout'), { code: 'ECONNABORTED' });
    mockAxiosPost.mockRejectedValueOnce(timeoutError);

    await retryWebhook({ ...BASE_RETRY, attemptCount: 0, maxAttempts: 3 });

    const call = WebhookRetry.updateOne.mock.calls[0][1];
    expect(call.$set.responseClass).toBe('timeout');
    expect(call.$push.errorLog.responseClass).toBe('timeout');
  });
});
