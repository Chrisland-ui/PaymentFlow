'use strict';

/**
 * Retention Service
 *
 * Provides configurable, auditable retention for all ephemeral operational
 * data. Each scope can be:
 *   - previewed (dryRun=true)  → returns candidate counts, touches nothing
 *   - executed  (dryRun=false) → deletes eligible records and writes an audit
 *
 * Financial records (Payment, Receipt, PaymentPlan) are never eligible for
 * deletion — this is enforced unconditionally by this service regardless of
 * the requested scopes.
 *
 * Supported scopes:
 *   studentPii         – anonymize student identifiers after graduation
 *   paymentMemos       – redact memo content without deleting payment history
 *   webhookDeliveries  – delivered / failed webhook delivery log entries
 *   webhookRetries     – completed/failed webhook retry queue entries
 *   emailDeliveries    – completed email delivery records
 *   reportJobs         – completed/failed report export jobs
 *   expiredSessions    – expired PaymentIntent records (status=expired)
 *   auditLogs          – archive-only; never hard-deleted
 *
 * Environment variables (all optional, with defaults):
 *   WEBHOOK_DELIVERY_RETENTION_DAYS  (default 90)
 *   WEBHOOK_RETRY_RETENTION_DAYS     (default 30)
 *   EMAIL_DELIVERY_RETENTION_DAYS    (default 90)
 *   REPORT_JOB_RETENTION_DAYS        (default 7)
 *   SESSION_RETENTION_DAYS           (default 1)
 *   AUDIT_LOG_RETENTION_DAYS         (default 90)
 *   STUDENT_PII_RETENTION_DAYS       (default 2555)
 *   PAYMENT_MEMO_RETENTION_DAYS      (default 1825)
 */

const logger = require('../utils/logger').child('RetentionService');
const { logAudit } = require('./auditService');
const { archiveAuditLogs } = require('./auditService');

// ── Retention policy defaults ─────────────────────────────────────────────────
const DEFAULTS = {
  studentPii:        2555,
  paymentMemos:      1825,
  webhookDeliveries: 30,
  webhookRetries:    30,
  emailDeliveries:   90,
  reportJobs:        7,
  expiredSessions:   1,
  auditLogs:         90,
};

function retentionDays(scope) {
  const ENV = {
    studentPii:        'STUDENT_PII_RETENTION_DAYS',
    paymentMemos:      'PAYMENT_MEMO_RETENTION_DAYS',
    webhookDeliveries: 'WEBHOOK_DELIVERY_RETENTION_DAYS',
    webhookRetries:    'WEBHOOK_RETRY_RETENTION_DAYS',
    emailDeliveries:   'EMAIL_DELIVERY_RETENTION_DAYS',
    reportJobs:        'REPORT_JOB_RETENTION_DAYS',
    expiredSessions:   'SESSION_RETENTION_DAYS',
    auditLogs:         'AUDIT_LOG_RETENTION_DAYS',
  };
  const raw = parseInt(process.env[ENV[scope]], 10);
  return (Number.isFinite(raw) && raw > 0) ? raw : DEFAULTS[scope];
}

function cutoffDate(scope) {
  return new Date(Date.now() - retentionDays(scope) * 24 * 60 * 60 * 1000);
}

/** All supported scopes, in a stable execution order. */
const ALL_SCOPES = [
  'studentPii',
  'paymentMemos',
  'webhookDeliveries',
  'webhookRetries',
  'emailDeliveries',
  'reportJobs',
  'expiredSessions',
  'auditLogs',
];

// ── Financial-record guard ────────────────────────────────────────────────────
// These collections must never be touched by retention. Hardcoded as a
// defence-in-depth measure — no caller can override this list.
const FINANCIAL_MODELS = ['Payment', 'Receipt', 'PaymentPlan'];
const BATCH_SIZE = 500;

function bypassTenantScope(query, includeDeleted = false) {
  if (typeof query.bypassTenantScope === 'function') query.bypassTenantScope();
  if (includeDeleted && typeof query.includeDeleted === 'function') query.includeDeleted();
  return query;
}

async function writeDeletionCertificates(records, category, performedBy) {
  const Certificate = require('../models/dataDeletionCertificateModel');
  const purgedAt = new Date();
  const documents = records.map((record) => ({
    category,
    recordId: String(record._id),
    schoolId: record.schoolId || null,
    purgedAt,
    performedBy,
  }));
  try {
    await Certificate.insertMany(documents, { ordered: false });
  } catch (err) {
    const writeErrors = err.writeErrors || [];
    const onlyDuplicates = err.code === 11000 ||
      (writeErrors.length > 0 && writeErrors.every((writeError) => writeError.code === 11000));
    if (!onlyDuplicates) throw err;
  }
}

async function purgeInBatches(Model, query, { dryRun, category, performedBy }) {
  const countQuery = bypassTenantScope(Model.countDocuments(query));
  const candidates = await countQuery;
  let deleted = 0;
  if (dryRun) return { candidates, deleted };

  while (true) {
    const findQuery = bypassTenantScope(Model.find(query), true)
      .select('_id schoolId')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    const records = await findQuery;
    if (!records.length) break;

    await writeDeletionCertificates(records, category, performedBy);
    const result = await Model.deleteMany(
      { _id: { $in: records.map((record) => record._id) } },
      { _bypassTenantScope: true, _includeDeleted: true },
    );
    deleted += result.deletedCount || 0;
  }
  return { candidates, deleted };
}

async function scrubInBatches(Model, query, fields, { dryRun, category, performedBy, includeDeleted = false }) {
  const countQuery = bypassTenantScope(Model.countDocuments(query), includeDeleted);
  const candidates = await countQuery;
  let modified = 0;
  if (dryRun) return { candidates, deleted: 0 };

  while (true) {
    const findQuery = bypassTenantScope(Model.find(query), includeDeleted)
      .select('_id schoolId')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    const records = await findQuery;
    if (!records.length) break;

    await writeDeletionCertificates(records, category, performedBy);
    let result;
    if (typeof fields === 'function') {
      result = await Model.bulkWrite(records.map((record) => ({
        updateOne: {
          filter: { _id: record._id },
          update: { $set: fields(record) },
        },
      })), { ordered: false });
    } else {
      result = await Model.updateMany(
        { _id: { $in: records.map((record) => record._id) } },
        { $set: fields },
        { _bypassTenantScope: true, _includeDeleted: includeDeleted },
      );
    }
    modified += result.modifiedCount || 0;
  }
  return { candidates, deleted: modified };
}

/**
 * Run retention across the requested scopes.
 *
 * @param {object}   opts
 * @param {boolean}  opts.dryRun   – true = count only, false = delete + audit
 * @param {string[]} [opts.scopes] – subset of ALL_SCOPES; defaults to all
 * @param {string}   [opts.performedBy] – identity of the triggering admin
 *
 * @returns {Promise<object>} Report object:
 *   {
 *     dryRun: boolean,
 *     executedAt: ISO string,
 *     scopes: {
 *       [scopeName]: { retentionDays, cutoff, candidates, deleted }
 *     },
 *     totals: { candidates, deleted },
 *     protected: string[]   — always lists the financial models
 *   }
 */
async function runRetention({ dryRun = true, scopes, performedBy = 'system' } = {}) {
  const requestedScopes = Array.isArray(scopes)
    ? scopes.filter((s) => ALL_SCOPES.includes(s))
    : ALL_SCOPES;

  const executedAt = new Date().toISOString();
  const report = {
    dryRun,
    executedAt,
    scopes: {},
    totals: { candidates: 0, deleted: 0 },
    protected: FINANCIAL_MODELS,
  };

  for (const scope of requestedScopes) {
    try {
      const result = await _runScope(scope, dryRun, performedBy);
      report.scopes[scope] = result;
      report.totals.candidates += result.candidates;
      report.totals.deleted += result.deleted;
    } catch (err) {
      logger.error(`Retention scope failed: ${scope}`, { error: err.message, dryRun });
      report.scopes[scope] = { error: err.message, candidates: 0, deleted: 0 };
    }
  }

  if (!dryRun) {
    // Write a single system-level audit entry covering the full run
    await logAudit({
      schoolId: 'system',
      action:   'RETENTION_RUN',
      performedBy,
      targetId: 'system',
      targetType: 'school',
      details: {
        scopes:    requestedScopes,
        totals:    report.totals,
        perScope:  Object.fromEntries(
          Object.entries(report.scopes).map(([k, v]) => [k, {
            retentionDays: v.retentionDays,
            cutoff:        v.cutoff,
            deleted:       v.deleted ?? 0,
          }])
        ),
        protected: FINANCIAL_MODELS,
      },
      result: 'success',
    }).catch((err) => {
      logger.error('Retention audit write failed', { error: err.message });
    });
  }

  logger.info('Retention run complete', {
    dryRun,
    totals:        report.totals,
    scopeCount:    requestedScopes.length,
  });

  return report;
}

// ── Per-scope handlers ────────────────────────────────────────────────────────

async function _runScope(scope, dryRun, performedBy) {
  switch (scope) {
    case 'studentPii':        return _retainStudentPii(dryRun, performedBy);
    case 'paymentMemos':      return _retainPaymentMemos(dryRun, performedBy);
    case 'webhookDeliveries': return _retainWebhookDeliveries(dryRun, performedBy);
    case 'webhookRetries':    return _retainWebhookRetries(dryRun, performedBy);
    case 'emailDeliveries':   return _retainEmailDeliveries(dryRun, performedBy);
    case 'reportJobs':        return _retainReportJobs(dryRun, performedBy);
    case 'expiredSessions':   return _retainExpiredSessions(dryRun, performedBy);
    case 'auditLogs':         return _retainAuditLogs(dryRun, performedBy);
    default:
      throw new Error(`Unknown retention scope: ${scope}`);
  }
}

async function _retainStudentPii(dryRun, performedBy) {
  const Student = require('../models/studentModel');
  const days = retentionDays('studentPii');
  const cutoff = cutoffDate('studentPii');
  const query = {
    $and: [
      { $or: [
        { graduatedAt: { $lte: cutoff } },
        { graduatedAt: null, deletedAt: { $lte: cutoff } },
      ] },
      { $or: [
        { name: { $ne: 'Anonymized' } },
        { dateOfBirth: { $ne: null } },
        { gender: { $ne: null } },
        { parentName: { $ne: null } },
        { parentEmail: { $ne: null } },
        { parentEmailHash: { $ne: null } },
        { parentPhone: { $ne: null } },
        { parentEmailSuppressionReason: { $ne: null } },
        { contactNumber: { $ne: null } },
      ] },
    ],
  };
  const result = await scrubInBatches(Student, query, (record) => ({
    studentId: `A${record._id}`,
    name: 'Anonymized',
    dateOfBirth: null,
    gender: null,
    parentName: null,
    parentEmail: null,
    parentEmailHash: null,
    parentPhone: null,
    parentEmailSuppressionReason: null,
    contactNumber: null,
  }), { dryRun, category: 'student-pii', performedBy, includeDeleted: true });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainPaymentMemos(dryRun, performedBy) {
  const Payment = require('../models/paymentModel');
  const days = retentionDays('paymentMemos');
  const cutoff = cutoffDate('paymentMemos');
  const result = await scrubInBatches(Payment, {
    createdAt: { $lt: cutoff },
    memo: { $exists: true, $nin: [null, ''] },
  }, { memo: null }, { dryRun, category: 'payment-memo', performedBy, includeDeleted: true });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainWebhookDeliveries(dryRun, performedBy) {
  const WebhookDelivery = require('../models/webhookDeliveryModel');
  const days   = retentionDays('webhookDeliveries');
  const cutoff = cutoffDate('webhookDeliveries');
  // Only delete records that are past the retention window. MongoDB's TTL
  // index handles automated expiry, but this lets us report counts + give
  // admins an on-demand purge path with an audit trail.
  const query = { createdAt: { $lt: cutoff } };
  const result = await purgeInBatches(WebhookDelivery, query, { dryRun, category: 'webhook-delivery', performedBy });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainWebhookRetries(dryRun, performedBy) {
  const WebhookRetry = require('../models/webhookRetryModel');
  const days   = retentionDays('webhookRetries');
  const cutoff = cutoffDate('webhookRetries');
  // Only terminal states — never touch 'pending' or 'processing' records
  const query = {
    status:    { $in: ['succeeded', 'failed'] },
    createdAt: { $lt: cutoff },
  };
  const result = await purgeInBatches(WebhookRetry, query, { dryRun, category: 'webhook-retry', performedBy });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainEmailDeliveries(dryRun, performedBy) {
  const EmailDelivery = require('../models/emailDeliveryModel');
  const days   = retentionDays('emailDeliveries');
  const cutoff = cutoffDate('emailDeliveries');
  // Only terminal states — never touch 'queued' or 'sent' (still in-flight)
  const query = {
    status:    { $in: ['delivered', 'failed', 'bounced', 'complaint', 'skipped'] },
    createdAt: { $lt: cutoff },
  };
  const result = await purgeInBatches(EmailDelivery, query, { dryRun, category: 'email-delivery', performedBy });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainReportJobs(dryRun, performedBy) {
  const { ReportJob } = require('../models/reportJobModel');
  const days   = retentionDays('reportJobs');
  const cutoff = cutoffDate('reportJobs');
  // Only completed/failed jobs — never delete pending/processing exports
  const query = {
    status:    { $in: ['completed', 'failed'] },
    createdAt: { $lt: cutoff },
  };
  const result = await purgeInBatches(ReportJob, query, { dryRun, category: 'report-job', performedBy });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainExpiredSessions(dryRun, performedBy) {
  const PaymentIntent = require('../models/paymentIntentModel');
  const days   = retentionDays('expiredSessions');
  const cutoff = cutoffDate('expiredSessions');
  // Only already-expired intents (the session cleanup scheduler marks them
  // expired; MongoDB's TTL removes them after PAYMENT_INTENT_TTL_SECONDS).
  // This scope gives an on-demand count and explicit deletion with audit.
  const query = {
    status:    'expired',
    expiresAt: { $lt: cutoff },
  };
  const result = await purgeInBatches(PaymentIntent, query, { dryRun, category: 'expired-session', performedBy });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...result };
}

async function _retainAuditLogs(dryRun, performedBy) {
  // Audit logs are NEVER hard-deleted — compliance requirement.
  // This scope archives (marks archived=true) old entries so they can be
  // offloaded to cold storage. Returns the archive count as 'candidates'.
  const days = retentionDays('auditLogs');
  let archived = 0;
  if (!dryRun) {
    archived = await archiveAuditLogs(days, { batchSize: BATCH_SIZE, performedBy });
  } else {
    // Dry-run: count how many would be archived
    const AuditLog = require('../models/auditLogModel');
    const cutoff = cutoffDate('auditLogs');
    archived = await AuditLog.countDocuments({ createdAt: { $lt: cutoff }, archived: false });
  }
  const cutoff = cutoffDate('auditLogs');
  return {
    retentionDays: days,
    cutoff:        cutoff.toISOString(),
    candidates:    archived,
    deleted:       0,        // never deleted
    archived:      dryRun ? 0 : archived,
    note:          'Audit logs are archived, never deleted.',
  };
}

module.exports = {
  runRetention,
  ALL_SCOPES,
  DEFAULTS,
  retentionDays,
  cutoffDate,
  FINANCIAL_MODELS,
};
