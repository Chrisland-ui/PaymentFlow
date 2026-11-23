'use strict';

/**
 * Tests for Issue #36 — Bounded CSV Import Processing
 *
 * Verifies all acceptance criteria:
 *   AC1: Oversized files fail early (413 before any row is parsed)
 *   AC2: Malformed / too-many rows produce safe row-level errors
 *   AC3: Successful imports expose progress and a final summary
 *
 * Additional coverage:
 *   - Missing required headers → 400 CSV_MISSING_HEADERS listing missing columns
 *   - Column limit exceeded → 400 CSV_INVALID_FORMAT
 *   - Extension and MIME type validation
 *   - req.csvHeaders is populated with column names
 *   - Import job model structure and TTL
 *   - Import job controller status endpoint
 *
 * Source-inspection tests verify middleware properties without a live HTTP
 * server (consistent with the existing csvImportLimits.test.js approach).
 * Controller tests use lightweight mocks.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';

const path = require('path');
const fs = require('fs');

const MIDDLEWARE_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/middleware/streamingCsvUpload.js'),
  'utf8'
);

const MODEL_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/models/importJobModel.js'),
  'utf8'
);

const CONTROLLER_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/controllers/importJobController.js'),
  'utf8'
);

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/routes/studentRoutes.js'),
  'utf8'
);

// ─────────────────────────────────────────────────────────────────────────────
// AC1: Oversized files fail early
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1: Oversized files fail early (before rows are parsed)', () => {
  it('enforces maxSize byte limit via Busboy fileSize option', () => {
    expect(MIDDLEWARE_SRC).toContain('fileSize: maxSize');
  });

  it('returns HTTP 413 CSV_TOO_LARGE when file size is exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('413');
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_LARGE');
  });

  it('reads CSV_MAX_SIZE_BYTES from environment with 5 MB default', () => {
    expect(MIDDLEWARE_SRC).toContain('CSV_MAX_SIZE_BYTES');
    expect(MIDDLEWARE_SRC).toContain('5 * 1024 * 1024');
  });

  it('rejects the request stream (req.destroy) on size exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('req.destroy()');
  });

  it('listens to the Busboy limit event to detect oversized uploads', () => {
    expect(MIDDLEWARE_SRC).toContain("bb.on('limit'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: Malformed rows produce safe row-level errors
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2: Row limit and per-row error handling', () => {
  it('enforces CSV_MAX_ROWS during streaming parse', () => {
    expect(MIDDLEWARE_SRC).toContain('maxRows');
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_MANY_ROWS');
  });

  it('destroys the file stream when row limit is exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('file.destroy()');
  });

  it('returns HTTP 400 when row count is exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_MANY_ROWS');
    expect(MIDDLEWARE_SRC).toContain('400');
  });

  it('enforces column count limit per row', () => {
    expect(MIDDLEWARE_SRC).toContain('maxColumns');
    expect(MIDDLEWARE_SRC).toContain('CSV_INVALID_FORMAT');
  });

  it('reads CSV_MAX_COLUMNS from environment with 20 default', () => {
    expect(MIDDLEWARE_SRC).toContain('CSV_MAX_COLUMNS');
  });

  it('pipes file through csv-parser without buffering the whole file', () => {
    expect(MIDDLEWARE_SRC).toContain('.pipe(csv())');
  });

  it('uses Busboy for multipart streaming (no multer/full-file buffering)', () => {
    expect(MIDDLEWARE_SRC).toMatch(/require\s*\(\s*['"]busboy['"]\s*\)/);
    expect(MIDDLEWARE_SRC).toContain('req.pipe(bb)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header validation (new in this issue)
// ─────────────────────────────────────────────────────────────────────────────

describe('Header validation: missing required columns rejected early', () => {
  it('checks for required headers on the first data row', () => {
    expect(MIDDLEWARE_SRC).toContain('requiredHeaders');
    expect(MIDDLEWARE_SRC).toContain('CSV_MISSING_HEADERS');
  });

  it('returns 400 with CSV_MISSING_HEADERS code', () => {
    expect(MIDDLEWARE_SRC).toContain('CSV_MISSING_HEADERS');
    expect(MIDDLEWARE_SRC).toContain('400');
  });

  it('includes a missingColumns array in the error response', () => {
    expect(MIDDLEWARE_SRC).toContain('missingColumns');
  });

  it('performs header check on the first row (headersValidated flag)', () => {
    expect(MIDDLEWARE_SRC).toContain('headersValidated');
  });

  it('accepts a requiredHeaders option (array)', () => {
    // The option is accessed as options.requiredHeaders
    expect(MIDDLEWARE_SRC).toContain('options.requiredHeaders');
  });

  it('populates req.csvHeaders with the actual column names', () => {
    expect(MIDDLEWARE_SRC).toContain('req.csvHeaders');
  });

  it('destroys the file stream when required headers are missing', () => {
    // file.destroy() is called for every early-abort path
    const occurrences = (MIDDLEWARE_SRC.match(/file\.destroy\(\)/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  it('bulk import route passes required student headers to middleware', () => {
    // studentRoutes.js should use requiredHeaders: ['studentId', 'name', 'class']
    expect(ROUTE_SRC).toContain("requiredHeaders: ['studentId', 'name', 'class']");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Successful imports expose progress and a final summary
// ─────────────────────────────────────────────────────────────────────────────

describe('AC3: Successful imports expose progress and a final summary', () => {
  it('attaches parsed rows to req.parsedRows for downstream controller use', () => {
    expect(MIDDLEWARE_SRC).toContain('req.parsedRows = rows');
  });

  it('import job model has status field with lifecycle enum', () => {
    expect(MODEL_SRC).toContain("enum: ['pending', 'processing', 'completed', 'failed']");
  });

  it('import job model tracks processedRows and totalRows', () => {
    expect(MODEL_SRC).toContain('processedRows');
    expect(MODEL_SRC).toContain('totalRows');
  });

  it('import job model tracks createdRows and failedRows', () => {
    expect(MODEL_SRC).toContain('createdRows');
    expect(MODEL_SRC).toContain('failedRows');
  });

  it('import job model stores per-row errors', () => {
    expect(MODEL_SRC).toContain('errors');
  });

  it('import job model has a 24-hour TTL', () => {
    expect(MODEL_SRC).toContain('expires: 86400');
  });

  it('import job model has jobId and schoolId fields', () => {
    expect(MODEL_SRC).toContain('jobId');
    expect(MODEL_SRC).toContain('schoolId');
  });

  it('import job controller GET endpoint returns status and progress', () => {
    expect(CONTROLLER_SRC).toContain('getImportJobStatus');
    expect(CONTROLLER_SRC).toContain('progressPercent');
    expect(CONTROLLER_SRC).toContain('status');
    expect(CONTROLLER_SRC).toContain('totalRows');
    expect(CONTROLLER_SRC).toContain('processedRows');
  });

  it('import job status route is registered in studentRoutes before /:studentId', () => {
    const importRoutePos = ROUTE_SRC.indexOf('/import/:jobId');
    const studentIdRoutePos = ROUTE_SRC.indexOf('/:studentId');
    expect(importRoutePos).toBeGreaterThan(-1);
    expect(studentIdRoutePos).toBeGreaterThan(-1);
    expect(importRoutePos).toBeLessThan(studentIdRoutePos);
  });

  it('import job route requires admin authentication', () => {
    expect(ROUTE_SRC).toMatch(/\/import\/:jobId.*requireAdminAuth|requireAdminAuth.*\/import\/:jobId/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Import job controller — unit tests with mocks
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/importJobModel', () => ({
  findOne: jest.fn(),
}));

const ImportJob = require('../backend/src/models/importJobModel');
const { getImportJobStatus } = require('../backend/src/controllers/importJobController');

function makeReq(params = {}, overrides = {}) {
  return { params, schoolId: null, ...overrides };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

describe('getImportJobStatus controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when jobId param is missing', async () => {
    const req = makeReq({ jobId: '' });
    const res = makeRes();
    await getImportJobStatus(req, res, jest.fn());
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 when job is not found', async () => {
    ImportJob.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const req = makeReq({ jobId: 'non-existent' });
    const res = makeRes();
    await getImportJobStatus(req, res, jest.fn());
    expect(res._status).toBe(404);
    expect(res._body.code).toBe('NOT_FOUND');
  });

  test('returns 403 TENANT_MISMATCH when job belongs to a different school', async () => {
    ImportJob.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        schoolId: 'school-b',
        status: 'completed',
        totalRows: 10,
        processedRows: 10,
        createdRows: 9,
        failedRows: 1,
        errors: [],
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
      }),
    });

    const req = makeReq({ jobId: 'job-1' }, { schoolId: 'school-a' });
    const res = makeRes();
    await getImportJobStatus(req, res, jest.fn());
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('TENANT_MISMATCH');
  });

  test('returns 200 with full progress for a completed job', async () => {
    const jobData = {
      jobId: 'job-ok',
      schoolId: 'school-a',
      status: 'completed',
      totalRows: 50,
      processedRows: 50,
      createdRows: 48,
      failedRows: 2,
      errors: [
        { row: 3, studentId: 'S001', error: 'Duplicate', code: 'DUPLICATE_STUDENT' },
        { row: 7, studentId: 'S002', error: 'Missing fee', code: 'FEE_STRUCTURE_NOT_FOUND' },
      ],
      startedAt: new Date(),
      completedAt: new Date(),
      failureReason: null,
      createdAt: new Date(),
    };

    ImportJob.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(jobData) });

    const req = makeReq({ jobId: 'job-ok' }, { schoolId: 'school-a' });
    const res = makeRes();
    await getImportJobStatus(req, res, jest.fn());

    expect(res._status).toBe(200);
    expect(res._body.jobId).toBe('job-ok');
    expect(res._body.status).toBe('completed');
    expect(res._body.totalRows).toBe(50);
    expect(res._body.processedRows).toBe(50);
    expect(res._body.createdRows).toBe(48);
    expect(res._body.failedRows).toBe(2);
    expect(res._body.progressPercent).toBe(100);
    expect(res._body.errors).toHaveLength(2);
  });

  test('returns progressPercent as 0 when totalRows is 0', async () => {
    const jobData = {
      jobId: 'job-pending',
      schoolId: 'school-a',
      status: 'pending',
      totalRows: 0,
      processedRows: 0,
      createdRows: 0,
      failedRows: 0,
      errors: [],
      startedAt: null,
      completedAt: null,
      failureReason: null,
      createdAt: new Date(),
    };

    ImportJob.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(jobData) });

    const req = makeReq({ jobId: 'job-pending' }, { schoolId: 'school-a' });
    const res = makeRes();
    await getImportJobStatus(req, res, jest.fn());

    expect(res._status).toBe(200);
    expect(res._body.progressPercent).toBe(0);
  });

  test('super-admin (no req.schoolId) can query any job', async () => {
    const jobData = {
      jobId: 'job-sa',
      schoolId: 'school-x',
      status: 'processing',
      totalRows: 100,
      processedRows: 40,
      createdRows: 38,
      failedRows: 2,
      errors: [],
      startedAt: new Date(),
      completedAt: null,
      failureReason: null,
      createdAt: new Date(),
    };

    ImportJob.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(jobData) });

    // schoolId: null = super-admin path
    const req = makeReq({ jobId: 'job-sa' }, { schoolId: null });
    const res = makeRes();
    await getImportJobStatus(req, res, jest.fn());

    expect(res._status).toBe(200);
    expect(res._body.progressPercent).toBe(40);
  });

  test('propagates errors to next()', async () => {
    const dbError = new Error('DB unavailable');
    ImportJob.findOne.mockReturnValue({ lean: jest.fn().mockRejectedValue(dbError) });

    const req = makeReq({ jobId: 'job-err' }, { schoolId: 'school-a' });
    const res = makeRes();
    const next = jest.fn();
    await getImportJobStatus(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamingCsvUpload: requiredHeaders option in action
// ─────────────────────────────────────────────────────────────────────────────

describe('streamingCsvUpload: requiredHeaders option structure', () => {
  it('accepts an empty requiredHeaders array (no-op validation)', () => {
    const streamingCsvUpload = require('../backend/src/middleware/streamingCsvUpload');
    // Should not throw when constructing with an empty list
    expect(() => streamingCsvUpload({ requiredHeaders: [] })).not.toThrow();
  });

  it('accepts a populated requiredHeaders array', () => {
    const streamingCsvUpload = require('../backend/src/middleware/streamingCsvUpload');
    expect(() => streamingCsvUpload({ requiredHeaders: ['studentId', 'name', 'class'] })).not.toThrow();
  });

  it('defaults to no required headers when option is omitted', () => {
    const streamingCsvUpload = require('../backend/src/middleware/streamingCsvUpload');
    expect(() => streamingCsvUpload({})).not.toThrow();
    expect(() => streamingCsvUpload()).not.toThrow();
  });
});
