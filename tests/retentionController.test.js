'use strict';

/**
 * Tests for retentionController.js — the admin HTTP endpoints.
 */

process.env.MONGO_URI   = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET  = 'test-secret-that-is-at-least-32-characters-long';

jest.mock('../backend/src/services/retentionService', () => ({
  runRetention: jest.fn(),
  ALL_SCOPES:   [
    'webhookDeliveries',
    'webhookRetries',
    'emailDeliveries',
    'reportJobs',
    'expiredSessions',
    'auditLogs',
  ],
}));

jest.mock('../backend/src/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  log.child = jest.fn(() => log);
  return log;
});

// Obtain references after jest.mock so we're on the mocked module
const { runRetention: runRetentionMock } = require('../backend/src/services/retentionService');
const { runRetentionHandler, previewRetentionHandler } =
  require('../backend/src/controllers/retentionController');

const mockDryReport = {
  dryRun:    true,
  executedAt: '2026-01-01T00:00:00.000Z',
  scopes:    { webhookDeliveries: { candidates: 5, deleted: 0 } },
  totals:    { candidates: 5, deleted: 0 },
  protected: ['Payment', 'Receipt', 'PaymentPlan'],
};

const mockLiveReport = {
  dryRun:    false,
  executedAt: '2026-01-01T00:00:00.000Z',
  scopes:    { webhookDeliveries: { candidates: 5, deleted: 5 } },
  totals:    { candidates: 5, deleted: 5 },
  protected: ['Payment', 'Receipt', 'PaymentPlan'],
};

function makeRes() {
  const res = {
    _status: 200,
    _body:   null,
    status: jest.fn(function (code) { this._status = code; return this; }),
    json:   jest.fn(function (body)  { this._body  = body;  return this; }),
  };
  return res;
}

describe('retentionController — POST /api/admin/retention/run', () => {
  beforeEach(() => jest.clearAllMocks());

  test('defaults dryRun=true when body is empty', async () => {
    runRetentionMock.mockResolvedValue(mockDryReport);
    const req = { body: {}, user: { id: 'admin1' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(runRetentionMock).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
    expect(res._status).toBe(200);
  });

  test('passes dryRun=false when explicitly set', async () => {
    runRetentionMock.mockResolvedValue(mockLiveReport);
    const req = { body: { dryRun: false }, user: { id: 'admin1' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(runRetentionMock).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false })
    );
  });

  test('passes scopes when provided', async () => {
    runRetentionMock.mockResolvedValue(mockDryReport);
    const req = { body: { dryRun: true, scopes: ['webhookDeliveries'] }, user: { id: 'admin1' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(runRetentionMock).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['webhookDeliveries'] })
    );
  });

  test('returns 400 for an unrecognised scope name', async () => {
    const req = { body: { scopes: ['not_a_real_scope'] }, user: { id: 'admin1' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('VALIDATION_ERROR');
    expect(runRetentionMock).not.toHaveBeenCalled();
  });

  test('returns 400 for an empty scopes array', async () => {
    const req = { body: { scopes: [] }, user: { id: 'admin1' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 500 when runRetention throws', async () => {
    runRetentionMock.mockRejectedValue(new Error('db error'));
    const req = { body: {}, user: { id: 'admin1' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(res._status).toBe(500);
    expect(res._body.code).toBe('INTERNAL_ERROR');
  });

  test('passes performedBy from req.user.id', async () => {
    runRetentionMock.mockResolvedValue(mockDryReport);
    const req = { body: {}, user: { id: 'user-xyz' } };
    const res = makeRes();

    await runRetentionHandler(req, res);

    expect(runRetentionMock).toHaveBeenCalledWith(
      expect.objectContaining({ performedBy: 'user-xyz' })
    );
  });
});

describe('retentionController — GET /api/admin/retention/preview', () => {
  beforeEach(() => jest.clearAllMocks());

  test('always calls runRetention with dryRun=true', async () => {
    runRetentionMock.mockResolvedValue(mockDryReport);
    const req = {};
    const res = makeRes();

    await previewRetentionHandler(req, res);

    expect(runRetentionMock).toHaveBeenCalledWith({ dryRun: true });
    expect(res._status).toBe(200);
    expect(res._body.dryRun).toBe(true);
  });

  test('returns 500 on failure', async () => {
    runRetentionMock.mockRejectedValue(new Error('fail'));
    const req = {};
    const res = makeRes();

    await previewRetentionHandler(req, res);

    expect(res._status).toBe(500);
    expect(res._body.code).toBe('INTERNAL_ERROR');
  });
});
