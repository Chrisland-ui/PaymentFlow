'use strict';

/**
 * sanitizeRequest middleware — Issue #826
 *
 * Two protections:
 *  1. JSON depth / array-length bomb guard  (applied after express.json parses the body)
 *  2. Query-parameter de-pollution — duplicated scalar params (arrays) are
 *     collapsed to their last value; arrays are disallowed on scalar fields.
 */

const MAX_DEPTH        = parseInt(process.env.JSON_MAX_DEPTH         || '10', 10);
const MAX_ARRAY_LENGTH = parseInt(process.env.JSON_MAX_ARRAY_LENGTH  || '100', 10);

// ── Depth / array-length checker ──────────────────────────────────────────────

function collectComplexityErrors(value, currentDepth, path, errors) {
  if (currentDepth > MAX_DEPTH) {
    errors.push({ field: path || 'body', message: `must not exceed ${MAX_DEPTH} levels of nesting` });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      errors.push({ field: path || 'body', message: `must not contain more than ${MAX_ARRAY_LENGTH} items` });
      return;
    }
    value.forEach((item, index) => collectComplexityErrors(item, currentDepth + 1, `${path}[${index}]`, errors));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectComplexityErrors(child, currentDepth + 1, path ? `${path}.${key}` : key, errors);
    }
  }
}

function jsonDepthGuard(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    const errors = [];
    collectComplexityErrors(req.body, 1, '', errors);
    if (errors.length) {
      return res.status(400).json({ errors, code: 'VALIDATION_ERROR' });
    }
  }
  return next();
}

// ── Query-param de-pollution ───────────────────────────────────────────────────
// When Express parses ?a=1&a=2 it produces { a: ['1','2'] }.
// Collapse arrays to their last value so downstream code always gets a scalar.

function deduplicateQueryParams(req, res, next) {
  if (req.query && typeof req.query === 'object') {
    for (const [key, val] of Object.entries(req.query)) {
      if (Array.isArray(val)) {
        req.query[key] = val[val.length - 1];
      }
    }
  }
  return next();
}

module.exports = { jsonDepthGuard, deduplicateQueryParams };
