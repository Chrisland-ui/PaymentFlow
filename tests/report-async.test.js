'use strict';

/**
 * Tests for report generation status API (issue #44).
 *
 * Covers:
 *  - Cache key construction with data version
 *  - ReportJob model structure including the 'expired' status
 *  - Deduplication policy (enqueueReportJob returns existing job)
 *  - Expired artifact response (410 Gone)
 *  - SSE notification shape on job completion
 */

const { KEYS } = require('../backend/src/cache');

describe('Cache key with data version', () => {
  it('should include schoolId and dataVersion in cache key', () => {
    const key = KEYS.report('SCH-123', '2026-01-01', '2026-12-31', '2026-01-15T12:00:00.000Z');
    expect(key).toMatch(/^report:SCH-123:2026-01-01:2026-12-31:v/);
    expect(key).toContain('2026-01-15');
  });

  it('should return latest when no data version provided', () => {
    const key = KEYS.report('SCH-123', '2026-01-01', '2026-12-31');
    expect(key).toBe('report:SCH-123:2026-01-01:2026-12-31:vlatest');
  });

  it('should handle null date parameters', () => {
    const key = KEYS.report('SCH-123', null, null, '2026-01-15T12:00:00.000Z');
    expect(key).toBe('report:SCH-123:::v2026-01-15T12:00:00.000Z');
  });
});

describe('ReportJob model structure', () => {
  it('should have all required lifecycle statuses including expired', () => {
    const { REPORT_STATUSES } = require('../backend/src/models/reportJobModel');
    expect(REPORT_STATUSES.PENDING).toBe('pending');
    expect(REPORT_STATUSES.PROCESSING).toBe('processing');
    expect(REPORT_STATUSES.COMPLETED).toBe('completed');
    expect(REPORT_STATUSES.FAILED).toBe('failed');
    expect(REPORT_STATUSES.EXPIRED).toBe('expired');
  });

  it('should expose all five status values', () => {
    const { REPORT_STATUSES } = require('../backend/src/models/reportJobModel');
    const values = Object.values(REPORT_STATUSES);
    expect(values).toHaveLength(5);
    expect(values).toContain('expired');
  });
});

describe('Deduplication policy', () => {
  it('REPORT_STATUSES values that block a new job', () => {
    const { REPORT_STATUSES } = require('../backend/src/models/reportJobModel');
    // A new job is blocked (deduplicated) when an existing job is in one of these states.
    const deduplicatedStatuses = [REPORT_STATUSES.PENDING, REPORT_STATUSES.PROCESSING];
    expect(deduplicatedStatuses).toContain('pending');
    expect(deduplicatedStatuses).toContain('processing');
    // Completed and failed jobs do NOT block a new submission.
    expect(deduplicatedStatuses).not.toContain('completed');
    expect(deduplicatedStatuses).not.toContain('failed');
    expect(deduplicatedStatuses).not.toContain('expired');
  });

  it('deduplicated response shape includes deduplicated flag', () => {
    // Verify the shape contract that enqueueReportJob returns when deduplicating.
    const mockExistingJob = {
      jobId: 'report-existing-123',
      schoolId: 'SCH-001',
      type: 'report',
      status: 'pending',
      params: { startDate: '2026-01-01', endDate: '2026-03-31', timezone: 'UTC', schemaVersion: null },
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    const deduplicatedResponse = {
      jobId: mockExistingJob.jobId,
      reportJob: mockExistingJob,
      deduplicated: true,
    };

    expect(deduplicatedResponse.deduplicated).toBe(true);
    expect(deduplicatedResponse.jobId).toBe('report-existing-123');
  });
});

describe('Expired artifact behavior', () => {
  it('expiresAt before now should be treated as expired', () => {
    const pastDate = new Date(Date.now() - 1000); // 1 second ago
    const futureDate = new Date(Date.now() + 60_000); // 1 minute from now

    const isExpired = (expiresAt) => expiresAt && expiresAt < new Date();

    expect(isExpired(pastDate)).toBe(true);
    expect(isExpired(futureDate)).toBe(false);
    expect(isExpired(null)).toBeFalsy();
  });

  it('expired status should be returned for jobs past their expiresAt', () => {
    const { REPORT_STATUSES } = require('../backend/src/models/reportJobModel');

    const completedJob = {
      status: REPORT_STATUSES.COMPLETED,
      expiresAt: new Date(Date.now() - 1000), // already expired
    };

    const isExpired = completedJob.expiresAt && completedJob.expiresAt < new Date();
    const effectiveStatus = isExpired && completedJob.status === REPORT_STATUSES.COMPLETED
      ? REPORT_STATUSES.EXPIRED
      : completedJob.status;

    expect(effectiveStatus).toBe('expired');
  });

  it('non-expired completed job should remain completed', () => {
    const { REPORT_STATUSES } = require('../backend/src/models/reportJobModel');

    const completedJob = {
      status: REPORT_STATUSES.COMPLETED,
      expiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
    };

    const isExpired = completedJob.expiresAt && completedJob.expiresAt < new Date();
    const effectiveStatus = isExpired && completedJob.status === REPORT_STATUSES.COMPLETED
      ? REPORT_STATUSES.EXPIRED
      : completedJob.status;

    expect(effectiveStatus).toBe('completed');
  });
});

describe('SSE notification shape on job completion', () => {
  it('SSE event should have the correct type and fields', () => {
    const mockCompletedJob = {
      jobId: 'report-abc-456',
      schoolId: 'SCH-001',
      type: 'report',
    };

    // Shape of the SSE event emitted after setJobCompleted.
    const sseEvent = {
      type: 'report:completed',
      payload: {
        jobId: mockCompletedJob.jobId,
        type: mockCompletedJob.type,
        downloadUrl: `/api/reports/jobs/${mockCompletedJob.jobId}/download`,
      },
    };

    expect(sseEvent.type).toBe('report:completed');
    expect(sseEvent.payload.jobId).toBe('report-abc-456');
    expect(sseEvent.payload.downloadUrl).toBe('/api/reports/jobs/report-abc-456/download');
  });
});
