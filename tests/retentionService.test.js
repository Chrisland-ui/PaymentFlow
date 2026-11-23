'use strict';

/**
 * Tests for retentionService.js
 *
 * Acceptance criteria:
 *   1. Dry runs report candidate counts without deleting anything
 *   2. Deletion is scoped — each scope only targets its own collection
 *   3. Financial records (Payment, Receipt, PaymentPlan) are never eligible
 *   4. Each live run writes an audit entry
 *   5. Individual scopes can be targeted
 */

process.env.MONGO_URI   = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET  = 'test-secret-that-is-at-least-32-characters-long';

// ── Model mocks ───────────────────────────────────────────────────────────────
// Each model mock is defined inline so jest's babel transform can hoist the
// jest.mock() calls without hitting the "out-of-scope variable" restriction.

jest.mock('../backend/src/models/webhookDeliveryModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(5),
  deleteMany:     jest.fn().mockResolvedValue({ deletedCount: 5 }),
}));

jest.mock('../backend/src/models/webhookRetryModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(3),
  deleteMany:     jest.fn().mockResolvedValue({ deletedCount: 3 }),
}));

jest.mock('../backend/src/models/emailDeliveryModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(7),
  deleteMany:     jest.fn().mockResolvedValue({ deletedCount: 7 }),
}));

jest.mock('../backend/src/models/reportJobModel', () => ({
  ReportJob: {
    countDocuments: jest.fn().mockResolvedValue(2),
    deleteMany:     jest.fn().mockResolvedValue({ deletedCount: 2 }),
  },
  REPORT_STATUSES: { PENDING: 'pending', PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed' },
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(4),
  deleteMany:     jest.fn().mockResolvedValue({ deletedCount: 4 }),
}));

jest.mock('../backend/src/models/auditLogModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(10),
  updateMany:     jest.fn().mockResolvedValue({ modifiedCount: 8 }),
}));

// Financial models — must never be accessed by the retention service
jest.mock('../backend/src/models/paymentModel', () => ({
  countDocuments: jest.fn(),
  deleteMany:     jest.fn(),
}));

jest.mock('../backend/src/models/receiptModel', () => ({
  countDocuments: jest.fn(),
  deleteMany:     jest.fn(),
}));

jest.mock('../backend/src/models/paymentPlanModel', () => ({
  countDocuments: jest.fn(),
  deleteMany:     jest.fn(),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:         jest.fn().mockResolvedValue(undefined),
  archiveAuditLogs: jest.fn().mockResolvedValue(8),
}));

jest.mock('../backend/src/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  log.child = jest.fn(() => log);
  return log;
});

// ── Load service and mocks under test ────────────────────────────────────────

const {
  runRetention,
  ALL_SCOPES,
  DEFAULTS,
  retentionDays,
  FINANCIAL_MODELS,
} = require('../backend/src/services/retentionService');

const { logAudit: logAuditMock, archiveAuditLogs: archiveAuditMock } =
  require('../backend/src/services/auditService');

const paymentMock     = require('../backend/src/models/paymentModel');
const receiptMock     = require('../backend/src/models/receiptModel');
const paymentPlanMock = require('../backend/src/models/paymentPlanModel');

// Expected candidate totals from the mock values above
const TOTAL_CANDIDATES = 5 + 3 + 7 + 2 + 4 + 10; // 31

// ── Test suites ───────────────────────────────────────────────────────────────

describe('retentionService — configuration', () => {
  test('ALL_SCOPES lists all six scopes', () => {
    expect(ALL_SCOPES).toEqual([
      'webhookDeliveries',
      'webhookRetries',
      'emailDeliveries',
      'reportJobs',
      'expiredSessions',
      'auditLogs',
    ]);
  });

  test('FINANCIAL_MODELS lists Payment, Receipt, PaymentPlan', () => {
    expect(FINANCIAL_MODELS).toEqual(['Payment', 'Receipt', 'PaymentPlan']);
  });

  test('DEFAULTS has a positive integer for every scope', () => {
    for (const scope of ALL_SCOPES) {
      expect(DEFAULTS[scope]).toBeGreaterThan(0);
    }
  });

  test('retentionDays() reads from env var, falling back to default', () => {
    const savedEnv = process.env.WEBHOOK_RETRY_RETENTION_DAYS;
    process.env.WEBHOOK_RETRY_RETENTION_DAYS = '45';
    jest.resetModules();
    const svc = require('../backend/src/services/retentionService');
    expect(svc.retentionDays('webhookRetries')).toBe(45);
    if (savedEnv === undefined) delete process.env.WEBHOOK_RETRY_RETENTION_DAYS;
    else process.env.WEBHOOK_RETRY_RETENTION_DAYS = savedEnv;
  });

  test('retentionDays() falls back to default for invalid env value', () => {
    const savedEnv = process.env.EMAIL_DELIVERY_RETENTION_DAYS;
    process.env.EMAIL_DELIVERY_RETENTION_DAYS = 'forever';
    jest.resetModules();
    const svc = require('../backend/src/services/retentionService');
    expect(svc.retentionDays('emailDeliveries')).toBe(DEFAULTS.emailDeliveries);
    if (savedEnv === undefined) delete process.env.EMAIL_DELIVERY_RETENTION_DAYS;
    else process.env.EMAIL_DELIVERY_RETENTION_DAYS = savedEnv;
  });
});

describe('retentionService — dry-run reports candidate counts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('dryRun=true returns candidate counts for all scopes', async () => {
    const report = await runRetention({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.scopes.webhookDeliveries.candidates).toBe(5);
    expect(report.scopes.webhookRetries.candidates).toBe(3);
    expect(report.scopes.emailDeliveries.candidates).toBe(7);
    expect(report.scopes.reportJobs.candidates).toBe(2);
    expect(report.scopes.expiredSessions.candidates).toBe(4);
    expect(report.scopes.auditLogs.candidates).toBe(10);
  });

  test('dryRun=true reports deleted=0 for every non-archive scope', async () => {
    const report = await runRetention({ dryRun: true });
    for (const scope of ALL_SCOPES.filter((s) => s !== 'auditLogs')) {
      expect(report.scopes[scope].deleted).toBe(0);
    }
  });

  test('dryRun=true never calls deleteMany on any model', async () => {
    const WebhookDelivery = require('../backend/src/models/webhookDeliveryModel');
    const WebhookRetry    = require('../backend/src/models/webhookRetryModel');
    const EmailDelivery   = require('../backend/src/models/emailDeliveryModel');
    const { ReportJob }   = require('../backend/src/models/reportJobModel');
    const PaymentIntent   = require('../backend/src/models/paymentIntentModel');

    await runRetention({ dryRun: true });

    expect(WebhookDelivery.deleteMany).not.toHaveBeenCalled();
    expect(WebhookRetry.deleteMany).not.toHaveBeenCalled();
    expect(EmailDelivery.deleteMany).not.toHaveBeenCalled();
    expect(ReportJob.deleteMany).not.toHaveBeenCalled();
    expect(PaymentIntent.deleteMany).not.toHaveBeenCalled();
  });

  test('dryRun=true does not archive audit logs', async () => {
    await runRetention({ dryRun: true });
    expect(archiveAuditMock).not.toHaveBeenCalled();
  });

  test('dryRun=true does not write an audit entry', async () => {
    await runRetention({ dryRun: true });
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  test('totals.candidates sums all scope candidates', async () => {
    const report = await runRetention({ dryRun: true });
    expect(report.totals.candidates).toBe(TOTAL_CANDIDATES);
  });

  test('each scope result includes retentionDays and cutoff ISO string', async () => {
    const report = await runRetention({ dryRun: true });
    for (const scope of ALL_SCOPES) {
      expect(report.scopes[scope].retentionDays).toBeGreaterThan(0);
      expect(report.scopes[scope].cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe('retentionService — live run deletes and audits', () => {
  beforeEach(() => jest.clearAllMocks());

  test('dryRun=false calls deleteMany on each non-audit scope', async () => {
    const WebhookDelivery = require('../backend/src/models/webhookDeliveryModel');
    const WebhookRetry    = require('../backend/src/models/webhookRetryModel');
    const EmailDelivery   = require('../backend/src/models/emailDeliveryModel');
    const { ReportJob }   = require('../backend/src/models/reportJobModel');
    const PaymentIntent   = require('../backend/src/models/paymentIntentModel');

    await runRetention({ dryRun: false });

    expect(WebhookDelivery.deleteMany).toHaveBeenCalledTimes(1);
    expect(WebhookRetry.deleteMany).toHaveBeenCalledTimes(1);
    expect(EmailDelivery.deleteMany).toHaveBeenCalledTimes(1);
    expect(ReportJob.deleteMany).toHaveBeenCalledTimes(1);
    expect(PaymentIntent.deleteMany).toHaveBeenCalledTimes(1);
  });

  test('dryRun=false calls archiveAuditLogs instead of deleting audit records', async () => {
    await runRetention({ dryRun: false });
    expect(archiveAuditMock).toHaveBeenCalledTimes(1);
  });

  test('dryRun=false writes one RETENTION_RUN audit entry', async () => {
    await runRetention({ dryRun: false });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action:  'RETENTION_RUN',
        result:  'success',
        details: expect.objectContaining({
          protected: FINANCIAL_MODELS,
        }),
      })
    );
  });

  test('deleted counts in report match what deleteMany returns', async () => {
    const report = await runRetention({ dryRun: false });
    expect(report.scopes.webhookDeliveries.deleted).toBe(5);
    expect(report.scopes.webhookRetries.deleted).toBe(3);
    expect(report.scopes.emailDeliveries.deleted).toBe(7);
    expect(report.scopes.reportJobs.deleted).toBe(2);
    expect(report.scopes.expiredSessions.deleted).toBe(4);
  });

  test('audit logs scope has deleted=0 (archive only)', async () => {
    const report = await runRetention({ dryRun: false });
    expect(report.scopes.auditLogs.deleted).toBe(0);
  });
});

describe('retentionService — scoped execution', () => {
  beforeEach(() => jest.clearAllMocks());

  test('restricts execution to the requested scopes', async () => {
    const WebhookDelivery = require('../backend/src/models/webhookDeliveryModel');
    const WebhookRetry    = require('../backend/src/models/webhookRetryModel');

    const report = await runRetention({
      dryRun: false,
      scopes: ['webhookDeliveries'],
    });

    expect(WebhookDelivery.deleteMany).toHaveBeenCalledTimes(1);
    expect(WebhookRetry.deleteMany).not.toHaveBeenCalled();
    expect(Object.keys(report.scopes)).toEqual(['webhookDeliveries']);
  });

  test('runs multiple explicit scopes', async () => {
    const report = await runRetention({
      dryRun: true,
      scopes: ['webhookRetries', 'emailDeliveries'],
    });
    expect(Object.keys(report.scopes)).toEqual(['webhookRetries', 'emailDeliveries']);
  });

  test('ignores invalid scope names — only known scopes run', async () => {
    const report = await runRetention({
      dryRun: true,
      scopes: ['webhookDeliveries', 'nonExistentScope'],
    });
    expect(Object.keys(report.scopes)).toEqual(['webhookDeliveries']);
  });

  test('runs all scopes when scopes is undefined', async () => {
    const report = await runRetention({ dryRun: true });
    expect(Object.keys(report.scopes)).toEqual(ALL_SCOPES);
  });
});

describe('retentionService — financial record protection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Payment model is never accessed by any scope', async () => {
    await runRetention({ dryRun: false });
    expect(paymentMock.countDocuments).not.toHaveBeenCalled();
    expect(paymentMock.deleteMany).not.toHaveBeenCalled();
  });

  test('Receipt model is never accessed by any scope', async () => {
    await runRetention({ dryRun: false });
    expect(receiptMock.countDocuments).not.toHaveBeenCalled();
    expect(receiptMock.deleteMany).not.toHaveBeenCalled();
  });

  test('PaymentPlan model is never accessed by any scope', async () => {
    await runRetention({ dryRun: false });
    expect(paymentPlanMock.countDocuments).not.toHaveBeenCalled();
    expect(paymentPlanMock.deleteMany).not.toHaveBeenCalled();
  });

  test('report always lists financial models in the protected field', async () => {
    const dryReport  = await runRetention({ dryRun: true });
    const liveReport = await runRetention({ dryRun: false });
    expect(dryReport.protected).toEqual(FINANCIAL_MODELS);
    expect(liveReport.protected).toEqual(FINANCIAL_MODELS);
  });

  test('audit entry includes the protected list', async () => {
    await runRetention({ dryRun: false });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ protected: FINANCIAL_MODELS }),
      })
    );
  });
});

describe('retentionService — webhook retry query correctness', () => {
  beforeEach(() => jest.clearAllMocks());

  test('only queries terminal states (succeeded, failed) — never pending/processing', async () => {
    const WebhookRetry = require('../backend/src/models/webhookRetryModel');
    await runRetention({ dryRun: false, scopes: ['webhookRetries'] });
    const [query] = WebhookRetry.deleteMany.mock.calls[0];
    expect(query.status.$in).toContain('succeeded');
    expect(query.status.$in).toContain('failed');
    expect(query.status.$in).not.toContain('pending');
    expect(query.status.$in).not.toContain('processing');
  });
});

describe('retentionService — email delivery query correctness', () => {
  beforeEach(() => jest.clearAllMocks());

  test('only queries terminal states — never queued or sent', async () => {
    const EmailDelivery = require('../backend/src/models/emailDeliveryModel');
    await runRetention({ dryRun: false, scopes: ['emailDeliveries'] });
    const [query] = EmailDelivery.deleteMany.mock.calls[0];
    expect(query.status.$in).not.toContain('queued');
    expect(query.status.$in).not.toContain('sent');
    expect(query.status.$in).toContain('delivered');
    expect(query.status.$in).toContain('failed');
  });
});

describe('retentionService — report job query correctness', () => {
  beforeEach(() => jest.clearAllMocks());

  test('only queries completed/failed jobs — never pending/processing', async () => {
    const { ReportJob } = require('../backend/src/models/reportJobModel');
    await runRetention({ dryRun: false, scopes: ['reportJobs'] });
    const [query] = ReportJob.deleteMany.mock.calls[0];
    expect(query.status.$in).toContain('completed');
    expect(query.status.$in).toContain('failed');
    expect(query.status.$in).not.toContain('pending');
    expect(query.status.$in).not.toContain('processing');
  });
});

describe('retentionService — report structure', () => {
  beforeEach(() => jest.clearAllMocks());

  test('report contains executedAt ISO timestamp', async () => {
    const report = await runRetention({ dryRun: true });
    expect(report.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('report.dryRun reflects the requested mode', async () => {
    const dry  = await runRetention({ dryRun: true });
    const live = await runRetention({ dryRun: false });
    expect(dry.dryRun).toBe(true);
    expect(live.dryRun).toBe(false);
  });

  test('auditLogs scope notes it is archive-only', async () => {
    const report = await runRetention({ dryRun: true, scopes: ['auditLogs'] });
    expect(report.scopes.auditLogs.note).toMatch(/archive/i);
  });
});
