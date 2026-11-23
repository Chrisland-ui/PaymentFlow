'use strict';

/**
 * Tests for Issue #45 — API response envelope compatibility.
 *
 * Defines and tests envelope schemas for:
 *   - Success responses
 *   - Paginated responses
 *   - Validation error responses
 *   - Server error responses
 *
 * Acceptance criteria verified here:
 *   ✓ CI catches missing fields and wrong types
 *   ✓ Versioning behaviour is explicit (all routes under /api/)
 *   ✓ Error responses never include stack traces in production mode
 *
 * All tests run without a live server or database.
 */

jest.mock('../backend/src/utils/logger', () => ({
  child:  () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
  error:  jest.fn(),
  warn:   jest.fn(),
  info:   jest.fn(),
}));

const path = require('path');
const fs   = require('fs');

const {
  assertSuccessEnvelope,
  assertPaginatedEnvelope,
  assertErrorEnvelope,
  assertNoStackTrace,
} = require('./envelopeSchemas');

// ── responseHelper.js ─────────────────────────────────────────────────────────

const { sendSuccess, sendPaginated, sendError } = require('../backend/src/utils/responseHelper');

function makeMockRes() {
  const res = {
    _status: 200,
    _body:   null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
  };
  return res;
}

describe('responseHelper — sendSuccess', () => {
  test('returns success envelope shape', () => {
    const res = makeMockRes();
    sendSuccess(res, { id: 1 });
    assertSuccessEnvelope(res._body);
    expect(res._body.data).toEqual({ id: 1 });
    expect(res._status).toBe(200);
  });

  test('includes optional message when provided', () => {
    const res = makeMockRes();
    sendSuccess(res, {}, 'Created successfully', 201);
    expect(res._body.message).toBe('Created successfully');
    expect(res._status).toBe(201);
  });

  test('includes meta when provided', () => {
    const res = makeMockRes();
    sendSuccess(res, [], null, 200, { extra: 'info' });
    expect(res._body.meta).toEqual({ extra: 'info' });
  });

  test('does not include stack in response', () => {
    const res = makeMockRes();
    sendSuccess(res, { stack: 'should not appear' });
    // The top-level body must not have 'stack'; the data field may mirror
    // what is passed, but the envelope itself must not expose one.
    assertNoStackTrace({ success: res._body.success, message: res._body.message, meta: res._body.meta });
  });
});

describe('responseHelper — sendPaginated', () => {
  test('returns paginated envelope shape with all six pagination fields', () => {
    const res = makeMockRes();
    sendPaginated(res, [{ id: 1 }, { id: 2 }], 1, 10, 25);
    assertPaginatedEnvelope(res._body);
  });

  test('hasNext is true when more pages exist', () => {
    const res = makeMockRes();
    sendPaginated(res, [], 1, 10, 25);
    expect(res._body.meta.pagination.hasNext).toBe(true);
  });

  test('hasPrev is false on first page', () => {
    const res = makeMockRes();
    sendPaginated(res, [], 1, 10, 25);
    expect(res._body.meta.pagination.hasPrev).toBe(false);
  });

  test('hasPrev is true on second page', () => {
    const res = makeMockRes();
    sendPaginated(res, [], 2, 10, 25);
    expect(res._body.meta.pagination.hasPrev).toBe(true);
  });

  test('hasNext is false on last page', () => {
    const res = makeMockRes();
    sendPaginated(res, [], 3, 10, 25); // 3 pages for 25 items at 10/page
    expect(res._body.meta.pagination.hasNext).toBe(false);
  });

  test('totalPages equals ceil(total / limit)', () => {
    const res = makeMockRes();
    sendPaginated(res, [], 1, 10, 25);
    expect(res._body.meta.pagination.totalPages).toBe(3);
  });

  test('does not contain a stack trace', () => {
    const res = makeMockRes();
    sendPaginated(res, [], 1, 10, 0);
    assertNoStackTrace(res._body);
  });
});

describe('responseHelper — sendError', () => {
  test('returns error envelope shape (shape C)', () => {
    const res = makeMockRes();
    sendError(res, 'Not found', 'NOT_FOUND', 404);
    assertErrorEnvelope(res._body);
    expect(res._status).toBe(404);
  });

  test('success is false', () => {
    const res = makeMockRes();
    sendError(res, 'Bad request', 'VALIDATION_ERROR', 400);
    expect(res._body.success).toBe(false);
  });

  test('error.message is the provided message', () => {
    const res = makeMockRes();
    sendError(res, 'Something went wrong', 'INTERNAL_ERROR', 500);
    expect(res._body.error.message).toBe('Something went wrong');
  });

  test('error.code is the provided code', () => {
    const res = makeMockRes();
    sendError(res, 'Bad', 'VALIDATION_ERROR', 400);
    expect(res._body.error.code).toBe('VALIDATION_ERROR');
  });

  test('does not contain a stack trace', () => {
    const res = makeMockRes();
    sendError(res, 'Error', 'INTERNAL_ERROR', 500);
    assertNoStackTrace(res._body);
  });
});

// ── globalErrorHandler — production vs development ────────────────────────────

const { globalErrorHandler } = require('../backend/src/middleware/errorHandler');

function makeErrReq() {
  return { path: '/api/test', method: 'GET', requestId: 'r1', schoolId: null };
}

function makeErrRes() {
  const res = makeMockRes();
  return res;
}

describe('globalErrorHandler — stack trace exposure', () => {
  const savedEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = savedEnv; });

  test('production: no stack trace in response body', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('db failure');
    err.stack = 'Error: db failure\n    at server.js:1';
    const res = makeErrRes();
    globalErrorHandler(err, makeErrReq(), res, jest.fn());
    assertNoStackTrace(res._body);
  });

  test('production: 5xx message is generic', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('internal secret: mongodb://user:pass@host');
    const res = makeErrRes();
    globalErrorHandler(err, makeErrReq(), res, jest.fn());
    expect(res._body.error.message).toBe('An internal server error occurred.');
  });

  test('production: 4xx message is preserved', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('studentId is required');
    err.code = 'VALIDATION_ERROR';
    const res = makeErrRes();
    globalErrorHandler(err, makeErrReq(), res, jest.fn());
    expect(res._body.error.message).toBe('studentId is required');
  });

  test('development: stack may be included', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at test.js:1';
    const res = makeErrRes();
    globalErrorHandler(err, makeErrReq(), res, jest.fn());
    // In development the stack CAN be present in error.stack — we just assert
    // the shape is still a valid error envelope
    assertErrorEnvelope(res._body);
  });

  test('non-production, non-development: no stack trace', () => {
    process.env.NODE_ENV = 'staging';
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at test.js:1';
    const res = makeErrRes();
    globalErrorHandler(err, makeErrReq(), res, jest.fn());
    // staging is not 'development', so stack should not appear
    expect(res._body).not.toHaveProperty('stack');
    expect(res._body.error).not.toHaveProperty('stack');
  });

  test('404 uses code ROUTE_NOT_FOUND', () => {
    const { notFoundHandler } = require('../backend/src/middleware/errorHandler');
    const req = { method: 'GET', path: '/api/does-not-exist' };
    const res = makeErrRes();
    notFoundHandler(req, res);
    expect(res._status).toBe(404);
    assertErrorEnvelope(res._body);
    expect(res._body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

// ── Validation error shape ────────────────────────────────────────────────────

const { validate } = require('../backend/src/middleware/validate');
const Joi = require('joi');

describe('validation error envelope', () => {
  const testSchema = Joi.object({
    name:  Joi.string().required(),
    limit: Joi.number().max(200).required(),
  });

  function runValidate(body) {
    const mw  = validate(testSchema, 'body');
    const req = { body };
    const res = makeMockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
  }

  test('validation failure returns 400 with errors array', () => {
    const { res, nextCalled } = runValidate({});
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    expect(Array.isArray(res._body.errors)).toBe(true);
  });

  test('each error entry has field and message', () => {
    const { res } = runValidate({});
    for (const err of res._body.errors) {
      expect(typeof err.field).toBe('string');
      expect(typeof err.message).toBe('string');
    }
  });

  test('error names the specific field that failed', () => {
    const { res } = runValidate({ limit: 999 }); // name missing, limit too high
    const fields = res._body.errors.map((e) => e.field);
    expect(fields).toContain('name');
    expect(fields).toContain('limit');
  });

  test('does not contain a stack trace', () => {
    const { res } = runValidate({});
    assertNoStackTrace(res._body);
  });

  test('valid input calls next and does not set response', () => {
    const { nextCalled, res } = runValidate({ name: 'Alice', limit: 50 });
    expect(nextCalled).toBe(true);
    expect(res._body).toBeNull();
  });
});

// ── API route versioning — all routes under /api/ ─────────────────────────────

describe('API versioning', () => {
  test('app.js mounts all API routes under /api/', () => {
    const appSrc = fs.readFileSync(
      path.join(__dirname, '../backend/src/app.js'),
      'utf8',
    );
    // Every app.use line that references a route file should use /api/ prefix
    const mountLines = appSrc
      .split('\n')
      .filter((l) => /app\.use\(/.test(l) && /Routes/.test(l));

    expect(mountLines.length).toBeGreaterThan(0);

    for (const line of mountLines) {
      // Each route mount should use '/api/' or a non-api path like '/metrics'
      const isApiRoute   = line.includes("'/api/");
      const isNonApi     = line.includes("'/metrics") || line.includes('metricsRoute');
      expect(isApiRoute || isNonApi).toBe(true);
    }
  });

  test('health and metrics endpoints are accessible outside /api/', () => {
    const appSrc = fs.readFileSync(
      path.join(__dirname, '../backend/src/app.js'),
      'utf8',
    );
    expect(appSrc).toContain("'/health'");
    expect(appSrc).toContain("'/metrics'");
  });
});

// ── Source scan: no err.stack written directly to responses ───────────────────

describe('source scan — no stack traces in controller responses', () => {
  const controllersDir = path.join(__dirname, '../backend/src/controllers');

  test('no controller directly writes err.stack into res.json / res.send', () => {
    const files = fs.readdirSync(controllersDir).filter((f) => f.endsWith('.js'));
    const violations = [];

    for (const file of files) {
      const src = fs.readFileSync(path.join(controllersDir, file), 'utf8');
      // Look for patterns like res.json({ ... stack ... }) or
      // res.json({ ..., stack: err.stack ... })
      const lines = src.split('\n');
      lines.forEach((line, idx) => {
        // Detect explicit stack exposure patterns: `stack: err.stack` or
        // `"stack"` inside a res.json / res.send call
        if (/\bstack\s*:\s*(err|error)\.stack\b/.test(line)) {
          violations.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `Found controller(s) that may expose stack traces in responses:\n${violations.join('\n')}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  test('errorHandler.js only exposes stack in development mode', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../backend/src/middleware/errorHandler.js'),
      'utf8',
    );
    // The guard must be there: only set body.error.stack when NODE_ENV === development
    expect(src).toContain("'development'");
    expect(src).toContain('err.stack');
    // Confirm the stack assignment is guarded by a development check
    const devGuardIdx  = src.indexOf("'development'");
    const stackAssignIdx = src.indexOf('body.error.stack');
    // stack assignment should come after the development guard
    expect(stackAssignIdx).toBeGreaterThan(devGuardIdx);
  });
});

// ── assertNoStackTrace helper ─────────────────────────────────────────────────

describe('assertNoStackTrace helper', () => {
  test('passes for objects without stack', () => {
    expect(() => assertNoStackTrace({ success: true, data: {} })).not.toThrow();
  });

  test('fails for top-level stack key', () => {
    expect(() => assertNoStackTrace({ stack: 'trace' })).toThrow();
  });

  test('fails for nested stack key', () => {
    expect(() => assertNoStackTrace({ error: { stack: 'trace' } })).toThrow();
  });

  test('passes for null and primitives', () => {
    expect(() => assertNoStackTrace(null)).not.toThrow();
    expect(() => assertNoStackTrace('string')).not.toThrow();
    expect(() => assertNoStackTrace(42)).not.toThrow();
  });
});
