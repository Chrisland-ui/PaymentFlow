'use strict';

/**
 * Shared envelope schema assertion helpers — Issue #45.
 *
 * Import these in any test file to assert that an API response body matches
 * the documented envelope shape without duplicating checks across test files.
 */

/**
 * Assert that `body` is a success envelope:
 *   { success: true, data: any, message?: string, meta?: object }
 */
function assertSuccessEnvelope(body) {
  expect(body).toBeDefined();
  expect(body.success).toBe(true);
  expect(body).toHaveProperty('data');
  // success envelopes must never carry a stack trace
  assertNoStackTrace(body);
}

/**
 * Assert that `body` is a paginated success envelope:
 *   { success: true, data: Array, meta: { pagination: { page, limit, total, totalPages, hasNext, hasPrev } } }
 */
function assertPaginatedEnvelope(body) {
  assertSuccessEnvelope(body);
  expect(Array.isArray(body.data)).toBe(true);
  expect(body).toHaveProperty('meta');
  expect(body.meta).toHaveProperty('pagination');

  const p = body.meta.pagination;
  expect(typeof p.page).toBe('number');
  expect(typeof p.limit).toBe('number');
  expect(typeof p.total).toBe('number');
  expect(typeof p.totalPages).toBe('number');
  expect(typeof p.hasNext).toBe('boolean');
  expect(typeof p.hasPrev).toBe('boolean');
}

/**
 * Assert that `body` is one of the recognised error envelope shapes:
 *   a) { error: string, code: string }
 *   b) { errors: Array<{ field: string, message: string }> }
 *   c) { success: false, error: { message: string, code: string } }
 *
 * In all cases the response must not contain a stack trace.
 */
function assertErrorEnvelope(body) {
  expect(body).toBeDefined();
  assertNoStackTrace(body);

  const hasShapeA = typeof body.error === 'string' && typeof body.code === 'string';
  const hasShapeB = Array.isArray(body.errors);
  const hasShapeC =
    body.success === false &&
    body.error != null &&
    typeof body.error === 'object' &&
    typeof body.error.message === 'string' &&
    typeof body.error.code === 'string';

  expect(hasShapeA || hasShapeB || hasShapeC).toBe(true);
}

/**
 * Recursively assert that `body` and all its nested values contain no 'stack'
 * key. This catches accidental stack trace exposure in any part of the response.
 */
function assertNoStackTrace(body) {
  if (body === null || typeof body !== 'object') return;
  expect(Object.keys(body)).not.toContain('stack');
  for (const val of Object.values(body)) {
    assertNoStackTrace(val);
  }
}

module.exports = {
  assertSuccessEnvelope,
  assertPaginatedEnvelope,
  assertErrorEnvelope,
  assertNoStackTrace,
};
