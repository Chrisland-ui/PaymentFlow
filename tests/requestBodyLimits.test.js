'use strict';

/**
 * Tests for Issue #41 — API request body and parameter limits.
 *
 * Verifies that all limit-enforcing middleware:
 *   - rejects inputs that exceed the documented bound
 *   - names the offending field in the error response
 *   - passes valid inputs through unchanged
 *
 * All tests run without a live server or database.
 */

const {
  paginationSchema,
  exportPaginationSchema,
  auditQuerySchema,
  updateStudentSchema,
  createDisputeSchema,
  createFeeAdjustmentSchema,
  createWebhookEndpointSchema,
  MAX_FILTER_STRING,
  MAX_BULK_ITEMS,
} = require('../backend/src/middleware/schemas/requestLimitSchemas');

const {
  validatePagination,
  validateExportPagination,
  validateAuditQuery,
  validateUpdateStudent,
  validateCreateDispute,
  validateCreateFeeAdjustment,
} = require('../backend/src/middleware/validate');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRes() {
  const body = {};
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(b)      { this._body = b; return this; },
  };
  return res;
}

function runMiddleware(mw, reqOverride = {}) {
  const req = { body: {}, query: {}, params: {}, ...reqOverride };
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

// ── Pagination ────────────────────────────────────────────────────────────────

describe('validatePagination middleware', () => {
  test('passes valid page and limit through', () => {
    const { nextCalled, res } = runMiddleware(validatePagination, { query: { page: '2', limit: '20' } });
    expect(nextCalled).toBe(true);
    expect(res._status).toBeNull();
  });

  test('defaults page to 1 and limit to 50 when absent', () => {
    const { req, nextCalled } = runMiddleware(validatePagination, { query: {} });
    expect(nextCalled).toBe(true);
    expect(req.query.page).toBe(1);
    expect(req.query.limit).toBe(50);
  });

  test('rejects limit above 200', () => {
    const { res, nextCalled } = runMiddleware(validatePagination, { query: { limit: '201' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'limit');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/200/);
  });

  test('rejects page 0', () => {
    const { res, nextCalled } = runMiddleware(validatePagination, { query: { page: '0' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'page');
    expect(err).toBeDefined();
  });

  test('rejects non-integer limit', () => {
    const { res, nextCalled } = runMiddleware(validatePagination, { query: { limit: 'abc' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('allows unknown query params through', () => {
    const { nextCalled, req } = runMiddleware(validatePagination, { query: { page: '1', limit: '10', status: 'PENDING' } });
    expect(nextCalled).toBe(true);
    expect(req.query.status).toBe('PENDING');
  });
});

describe('validateExportPagination middleware', () => {
  test('allows limit up to 10000', () => {
    const { nextCalled } = runMiddleware(validateExportPagination, { query: { limit: '10000' } });
    expect(nextCalled).toBe(true);
  });

  test('rejects limit above 10000', () => {
    const { res, nextCalled } = runMiddleware(validateExportPagination, { query: { limit: '10001' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'limit');
    expect(err).toBeDefined();
  });
});

// ── Audit query filters ───────────────────────────────────────────────────────

describe('validateAuditQuery middleware', () => {
  test('passes valid filters', () => {
    const { nextCalled } = runMiddleware(validateAuditQuery, {
      query: { action: 'student_create', result: 'success', limit: '50' },
    });
    expect(nextCalled).toBe(true);
  });

  test('rejects action exceeding MAX_FILTER_STRING chars', () => {
    const longAction = 'a'.repeat(MAX_FILTER_STRING + 1);
    const { res, nextCalled } = runMiddleware(validateAuditQuery, { query: { action: longAction } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'action');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/action/i);
  });

  test('rejects performedBy exceeding max length', () => {
    const long = 'x'.repeat(MAX_FILTER_STRING + 1);
    const { res, nextCalled } = runMiddleware(validateAuditQuery, { query: { performedBy: long } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'performedBy');
    expect(err).toBeDefined();
  });

  test('rejects search exceeding max length', () => {
    const long = 's'.repeat(MAX_FILTER_STRING + 1);
    const { res, nextCalled } = runMiddleware(validateAuditQuery, { query: { search: long } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('rejects invalid result value', () => {
    const { res, nextCalled } = runMiddleware(validateAuditQuery, { query: { result: 'maybe' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'result');
    expect(err).toBeDefined();
  });

  test('rejects unknown query params', () => {
    const { res, nextCalled } = runMiddleware(validateAuditQuery, { query: { unknownField: 'val' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('caps limit at 200', () => {
    const { res, nextCalled } = runMiddleware(validateAuditQuery, { query: { limit: '999' } });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('error response includes code VALIDATION_ERROR', () => {
    const long = 'a'.repeat(MAX_FILTER_STRING + 1);
    const { res } = runMiddleware(validateAuditQuery, { query: { action: long } });
    expect(res._body.code).toBe('VALIDATION_ERROR');
  });
});

// ── Update student body ───────────────────────────────────────────────────────

describe('validateUpdateStudent middleware', () => {
  test('passes a valid update body', () => {
    const { nextCalled } = runMiddleware(validateUpdateStudent, {
      body: { name: 'Alice', class: 'Grade 5' },
    });
    expect(nextCalled).toBe(true);
  });

  test('rejects name longer than 200 characters', () => {
    const { res, nextCalled } = runMiddleware(validateUpdateStudent, {
      body: { name: 'N'.repeat(201) },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'name');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/name/i);
  });

  test('rejects class longer than 100 characters', () => {
    const { res, nextCalled } = runMiddleware(validateUpdateStudent, {
      body: { class: 'C'.repeat(101) },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'class');
    expect(err).toBeDefined();
  });

  test('rejects parentEmail longer than 254 chars', () => {
    const { res, nextCalled } = runMiddleware(validateUpdateStudent, {
      body: { parentEmail: 'a'.repeat(245) + '@test.com' },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('rejects unknown fields', () => {
    const { res, nextCalled } = runMiddleware(validateUpdateStudent, {
      body: { injectedField: 'evil' },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('allows empty body (no-op update)', () => {
    const { nextCalled } = runMiddleware(validateUpdateStudent, { body: {} });
    expect(nextCalled).toBe(true);
  });
});

// ── Create dispute body ───────────────────────────────────────────────────────

describe('validateCreateDispute middleware', () => {
  const validDispute = {
    studentId: 'STU001',
    txHash:    'a'.repeat(64),
    reason:    'Duplicate charge',
  };

  test('passes a valid dispute', () => {
    const { nextCalled } = runMiddleware(validateCreateDispute, { body: { ...validDispute } });
    expect(nextCalled).toBe(true);
  });

  test('rejects reason longer than 2000 characters', () => {
    const { res, nextCalled } = runMiddleware(validateCreateDispute, {
      body: { ...validDispute, reason: 'r'.repeat(2001) },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'reason');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/2000/);
  });

  test('rejects evidence array with more than 20 items', () => {
    const evidence = Array.from({ length: 21 }, (_, i) => ({
      type: 'document', description: `Item ${i}`,
    }));
    const { res, nextCalled } = runMiddleware(validateCreateDispute, {
      body: { ...validDispute, evidence },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'evidence');
    expect(err).toBeDefined();
  });

  test('rejects missing reason', () => {
    const { studentId, txHash } = validDispute;
    const { res, nextCalled } = runMiddleware(validateCreateDispute, {
      body: { studentId, txHash },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'reason');
    expect(err).toBeDefined();
  });

  test('rejects invalid txHash format', () => {
    const { res, nextCalled } = runMiddleware(validateCreateDispute, {
      body: { ...validDispute, txHash: 'not-a-hex-hash' },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('error response names the bounded field', () => {
    const { res } = runMiddleware(validateCreateDispute, {
      body: { ...validDispute, reason: 'r'.repeat(2001) },
    });
    expect(res._body.errors[0].field).toBe('reason');
  });
});

// ── Create fee adjustment body ────────────────────────────────────────────────

describe('validateCreateFeeAdjustment middleware', () => {
  const validAdjustment = { name: 'Early payment discount', type: 'percentage', value: 10 };

  test('passes a valid fee adjustment', () => {
    const { nextCalled } = runMiddleware(validateCreateFeeAdjustment, { body: { ...validAdjustment } });
    expect(nextCalled).toBe(true);
  });

  test('rejects name longer than 200 characters', () => {
    const { res, nextCalled } = runMiddleware(validateCreateFeeAdjustment, {
      body: { ...validAdjustment, name: 'N'.repeat(201) },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'name');
    expect(err).toBeDefined();
  });

  test('rejects description longer than 1000 characters', () => {
    const { res, nextCalled } = runMiddleware(validateCreateFeeAdjustment, {
      body: { ...validAdjustment, description: 'd'.repeat(1001) },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'description');
    expect(err).toBeDefined();
  });

  test('rejects invalid type', () => {
    const { res, nextCalled } = runMiddleware(validateCreateFeeAdjustment, {
      body: { ...validAdjustment, type: 'unknown_type' },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  test('rejects missing name', () => {
    const { res, nextCalled } = runMiddleware(validateCreateFeeAdjustment, {
      body: { type: 'fixed', value: 50 },
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    const err = res._body.errors.find((e) => e.field === 'name');
    expect(err).toBeDefined();
  });
});

// ── Schema unit tests ─────────────────────────────────────────────────────────

describe('paginationSchema', () => {
  test('coerces string "3" to integer 3', () => {
    const { value } = paginationSchema.validate({ page: '3', limit: '25' }, { convert: true });
    expect(value.page).toBe(3);
    expect(value.limit).toBe(25);
  });

  test('rejects limit 0', () => {
    const { error } = paginationSchema.validate({ limit: 0 });
    expect(error).toBeDefined();
  });

  test('rejects limit 201', () => {
    const { error } = paginationSchema.validate({ limit: 201 });
    expect(error).toBeDefined();
    expect(error.details[0].context.key).toBe('limit');
  });
});

describe('auditQuerySchema', () => {
  test('accepts cursor up to 2048 chars', () => {
    const { error } = auditQuerySchema.validate({ cursor: 'x'.repeat(2048) });
    expect(error).toBeUndefined();
  });

  test('rejects cursor exceeding 2048 chars', () => {
    const { error } = auditQuerySchema.validate({ cursor: 'x'.repeat(2049) });
    expect(error).toBeDefined();
    expect(error.details[0].context.key).toBe('cursor');
  });
});

describe('createDisputeSchema', () => {
  test('evidence array exactly 20 items is valid', () => {
    const evidence = Array.from({ length: 20 }, () => ({ type: 't', description: 'd' }));
    const { error } = createDisputeSchema.validate({
      studentId: 'STU001',
      txHash: 'a'.repeat(64),
      reason: 'test',
      evidence,
    });
    expect(error).toBeUndefined();
  });
});
