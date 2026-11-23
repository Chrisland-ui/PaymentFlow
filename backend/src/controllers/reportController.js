'use strict';

const {
  generateReport,
  reportToCsv,
  getDashboardMetrics,
  generateAccountingCsv,
  ACCOUNTING_SCHEMA_VERSION,
  getDataVersion,
} = require('../services/reportService');
const { get, set, getSafe, KEYS, TTL } = require('../cache');
const {
  enqueueReportJob,
} = require('../queue/reportQueue');
const { ReportJob, REPORT_STATUSES } = require('../models/reportJobModel');
const School = require('../models/schoolModel');
const { createReportDownloadUrl, SIGNED_URL_TTL_SECONDS } = require('../services/reportArtifactStorage');

const LARGE_REPORT_THRESHOLD_DAYS = parseInt(process.env.LARGE_REPORT_THRESHOLD_DAYS || '30', 10);

function getDaysBetween(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

async function getReport(req, res, next) {
  try {
    const { startDate, endDate, format = 'json', schema_version } = req.query;
    // req.query values are always strings; coerce explicitly so ?async=false is
    // treated as false rather than the truthy string "false".
    const isAsync = req.query.async === 'true';
    const isLargeReport = !startDate || !endDate || getDaysBetween(startDate, endDate) >= LARGE_REPORT_THRESHOLD_DAYS;

    // Audit report exports — exports can contain PII so they are a privileged read
    if (req.auditContext) {
      const { logAudit } = require('../services/auditService');
      await logAudit({
        schoolId:    req.schoolId,
        action:      'report_export',
        performedBy: req.auditContext.performedBy,
        targetId:    req.schoolId,
        targetType:  'report',
        details: {
          format,
          startDate: startDate || null,
          endDate:   endDate   || null,
          async:     isAsync,
        },
        result:    'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    if (isAsync || isLargeReport) {
      try {
        const job = await enqueueReportJob({
          schoolId: req.schoolId,
          type: format === 'accounting_csv' ? 'accounting_csv' : 'report',
          format,
          startDate,
          endDate,
          timezone: (await School.findOne({ schoolId: req.schoolId }).lean())?.timezone || 'UTC',
          schemaVersion: schema_version || (format === 'accounting_csv' ? ACCOUNTING_SCHEMA_VERSION : null),
        });

        return res.status(202).json({
          reportJobId: job.jobId,
          jobId: job.jobId,
          status: REPORT_STATUSES.PENDING,
          message: 'Report generation started.',
          statusUrl: `/api/reports/${job.jobId}/status`,
        });
      } catch (err) {
        if (err.code === 'QUEUE_UNAVAILABLE' || err.message?.includes('Redis') || err.message?.includes('queue')) {
          return res.status(503).json({
            error: 'Async report queue is temporarily unavailable. Please retry synchronously or try again later.',
            code: 'QUEUE_UNAVAILABLE',
            actionable: true,
            retryAfterSeconds: 30,
            details: 'Queue dependency outage detected; async report mutation cannot be queued at this time.',
          });
        }
        throw err;
      }
    }

    if (format === 'accounting_csv') {
      const dataVersion = await getDataVersion(req.schoolId);
      const timezone = (await School.findOne({ schoolId: req.schoolId }).lean())?.timezone || 'UTC';
      const cacheKey = KEYS.report(req.schoolId, startDate, endDate, dataVersion, timezone);
      let cached = get(cacheKey);
      if (cached !== undefined) {
        const csv = cached.csv;
        const version = cached.schemaVersion;
        const s = startDate || null;
        const e = endDate || null;
        let filename;
        if (s && e) filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-${s}-to-${e}.csv`;
        else if (s) filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-${s}-onwards.csv`;
        else if (e) filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-to-${e}.csv`;
        else filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-all-time.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('X-Export-Schema-Version', String(ACCOUNTING_SCHEMA_VERSION));
        return res.send(csv);
      }

      const { csv, schemaVersion } = await generateAccountingCsv({ schoolId: req.schoolId, startDate, endDate, timezone });
      set(cacheKey, { csv, schemaVersion }, TTL.REPORT);

      const s = startDate || null;
      const e = endDate || null;
      let filename;
      if (s && e) filename = `accounting-v${schemaVersion}-${s}-to-${e}.csv`;
      else if (s) filename = `accounting-v${schemaVersion}-${s}-onwards.csv`;
      else if (e) filename = `accounting-v${schemaVersion}-to-${e}.csv`;
      else filename = `accounting-v${schemaVersion}-all-time.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Export-Schema-Version', String(schemaVersion));
      return res.send(csv);
    }

    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const timezone = school?.timezone || 'UTC';
    const dataVersion = await getDataVersion(req.schoolId);
    const cacheKey = KEYS.report(req.schoolId, startDate, endDate, dataVersion, timezone);
    let report = get(cacheKey);
    if (report === undefined) {
      report = await generateReport({ schoolId: req.schoolId, startDate, endDate, timezone });
      set(cacheKey, report, TTL.REPORT);
    }

    if (format === 'csv') {
      const s = startDate || null;
      const e = endDate || null;
      let filename;
      if (s && e) filename = `report-${s}-to-${e}.csv`;
      else if (s) filename = `report-${s}-to-all-time.csv`;
      else if (e) filename = `report-all-time-to-${e}.csv`;
      else filename = 'report-all-time.csv';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(reportToCsv(report));
    }

    res.json(report);
  } catch (err) { next(err); }
}

async function getDashboard(req, res, next) {
  try {
    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const cacheKey = `dashboard:${req.schoolId}`;
    const metrics = await getSafe(
      cacheKey,
      () => getDashboardMetrics({ schoolId: req.schoolId, timezone: school?.timezone || 'UTC' }),
      { ttl: TTL.REPORT, cacheName: 'dashboard' }
    );
    res.json(metrics);
  } catch (err) { next(err); }
}

async function getReportJob(req, res, next) {
  try {
    const { jobId } = req.params;
    const job = await ReportJob.findOne({ jobId, schoolId: req.schoolId }).lean();

    if (!job) {
      return res.status(404).json({ error: 'Report job not found' });
    }

    res.json({
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      params: job.params,
      error: job.result?.error || null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      downloadUrl: job.status === REPORT_STATUSES.READY && job.downloadExpiresAt > new Date()
        ? `/api/reports/${jobId}/download`
        : null,
      downloadExpiresAt: job.downloadExpiresAt,
    });
  } catch (err) { next(err); }
}

async function downloadReportJob(req, res, next) {
  try {
    const { jobId } = req.params;
    const job = await ReportJob.findOne({ jobId, schoolId: req.schoolId }).lean();

    if (!job) {
      return res.status(404).json({ error: 'Report job not found' });
    }

    if (job.status === REPORT_STATUSES.EXPIRED || (job.downloadExpiresAt && job.downloadExpiresAt <= new Date())) {
      return res.status(410).json({ error: 'Report download URL has expired', code: 'REPORT_EXPIRED' });
    }

    if (job.status !== REPORT_STATUSES.READY) {
      return res.status(409).json({
        error: 'Report not ready',
        status: job.status,
        message: 'Report generation is not complete. Poll status endpoint.',
      });
    }

    if (!job.artifactKey) {
      return res.status(410).json({ error: 'Report artifact is no longer available', code: 'REPORT_EXPIRED' });
    }
    const remainingSeconds = Math.floor((new Date(job.downloadExpiresAt).getTime() - Date.now()) / 1000);
    if (remainingSeconds <= 0) {
      return res.status(410).json({ error: 'Report download URL has expired', code: 'REPORT_EXPIRED' });
    }
    const downloadUrl = await createReportDownloadUrl(
      job.artifactKey,
      Math.min(SIGNED_URL_TTL_SECONDS, remainingSeconds),
    );
    return res.json({
      reportJobId: job.jobId,
      downloadUrl,
      expiresAt: job.downloadExpiresAt,
    });
  } catch (err) { next(err); }
}

module.exports = { getReport, getDashboard, getReportJob, downloadReportJob };