'use strict';

const logger = require('../utils/logger').child('ErrorHandler');

const { TAXONOMY, mapErrorToResponse, getErrorCategory } = require('../errors/paymentErrorTaxonomy');

const ERROR_STATUS_MAP = {
  TX_FAILED: 400, MISSING_MEMO: 400, INVALID_DESTINATION: 400, UNSUPPORTED_ASSET: 400,
  VALIDATION_ERROR: 400, UNDERPAID: 400, MISSING_SCHOOL_CONTEXT: 400,
  MISSING_IDEMPOTENCY_KEY: 400, INVALID_AMOUNT: 400, AMOUNT_TOO_LOW: 400,
  AMOUNT_TOO_HIGH: 400, INVALID_HASH_FORMAT: 400,
  INVALID_TRANSITION: 400, MISSING_XDR: 400, INVALID_MEMO: 400,
  ASSET_NOT_ACCEPTED: 400, INVALID_FEE_CATEGORY: 400,
  UNAUTHORIZED: 401, INVALID_TOKEN: 401, TOKEN_EXPIRED: 401,
  FORBIDDEN: 403, INTENT_MISMATCH: 403, TENANT_ACCESS_DENIED: 403,
  NOT_FOUND: 404, SCHOOL_NOT_FOUND: 404, STUDENT_NOT_FOUND: 404, PAYMENT_NOT_FOUND: 404, INTENT_NOT_FOUND: 404,
  DUPLICATE_TX: 409, DUPLICATE_SCHOOL: 409, DUPLICATE_STUDENT: 409, DUPLICATE_IDEMPOTENCY_KEY: 409,
  DUPLICATE_PAYMENT_INTENT: 409, SYNC_IN_PROGRESS: 409, STATE_CONFLICT: 409,
  STELLAR_NETWORK_ERROR: 502, HORIZON_ERROR: 502, PROVIDER_ERROR: 502, TX_SUBMISSION_FAILED: 502, ONCHAIN_FAILURE: 502,
  REQUEST_TIMEOUT: 503, SERVICE_UNAVAILABLE: 503, HORIZON_UNAVAILABLE: 503, QUEUE_UNAVAILABLE: 503, TRANSIENT_FAILURE: 503,
  RATE_LIMITED: 429,
};

function errorResponse(message, code = 'INTERNAL_ERROR', details = null, category = null) {
  const resolvedCategory = category || getErrorCategory(code);
  const r = { success: false, error: { message, code, category: resolvedCategory } };
  if (details) r.error.details = details;
  return r;
}

function successResponse(data, message = null, meta = {}) {
  const r = { success: true, data };
  if (message) r.message = message;
  if (Object.keys(meta).length > 0) r.meta = meta;
  return r;
}

function globalErrorHandler(err, req, res, next) {
  const { statusCode, body, diagnosticContext } = mapErrorToResponse(err, process.env.NODE_ENV === 'production');
  const logCtx = {
    ...diagnosticContext,
    path: req.path,
    method: req.method,
    requestId: req.requestId,
    schoolId: req.schoolId,
  };
  if (err?.type === 'entity.too.large') {
    logger.warn('Request body exceeded the configured size limit', {
      ...logCtx,
      contentLength: req.headers['content-length'],
    });
    return res.status(413).json({
      errors: [{ field: 'body', message: 'Request body must not exceed 50KB' }],
      code: 'PAYLOAD_TOO_LARGE',
    });
  }
  statusCode >= 500 ? logger.error('Server error', logCtx) : logger.warn('Client error', logCtx);

  if (process.env.NODE_ENV === 'development' && err.stack) {
    body.error.stack = err.stack;
  }
  res.status(statusCode).json(body);
}

function notFoundHandler(req, res) {
  res.status(404).json(errorResponse(`Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND'));
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { successResponse, errorResponse, globalErrorHandler, notFoundHandler, asyncHandler };
