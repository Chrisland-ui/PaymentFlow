'use strict';

/**
 * Import Job Controller
 *
 * Exposes progress and summary information for bulk student import jobs.
 *
 * Routes:
 *   GET /api/students/import/:jobId — return current job status and progress
 */

const ImportJob = require('../models/importJobModel');

/**
 * GET /api/students/import/:jobId
 *
 * Returns the current status, progress counters, and per-row error list for
 * a bulk import job.  Only jobs belonging to req.schoolId are accessible
 * (tenant-scoped via requireAdminAuth + resolveSchool upstream).
 */
async function getImportJobStatus(req, res, next) {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== 'string' || !jobId.trim()) {
      return res.status(400).json({ error: 'jobId is required', code: 'VALIDATION_ERROR' });
    }

    const job = await ImportJob.findOne({ jobId: jobId.trim() }).lean();

    if (!job) {
      return res.status(404).json({ error: 'Import job not found', code: 'NOT_FOUND' });
    }

    // Tenant isolation — only allow access to jobs belonging to the calling school.
    // Super-admins (req.schoolId unset) are permitted to query any job.
    if (req.schoolId && job.schoolId !== req.schoolId) {
      return res.status(403).json({
        error: 'Forbidden. This job belongs to a different school.',
        code: 'TENANT_MISMATCH',
      });
    }

    const progressPercent = job.totalRows > 0
      ? Math.round((job.processedRows / job.totalRows) * 100)
      : 0;

    return res.status(200).json({
      jobId: job.jobId,
      schoolId: job.schoolId,
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      createdRows: job.createdRows,
      succeededRows: job.createdRows,
      failedRows: job.failedRows,
      progressPercent,
      errors: job.errors || [],
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      failureReason: job.failureReason || null,
      createdAt: job.createdAt,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getImportJobStatus };
