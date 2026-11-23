'use strict';

/**
 * Standardized API Response Envelope Helper (Issue #298)
 *
 * Provides a canonical response envelope structure:
 * {
 *   success: boolean,
 *   data: any,
 *   meta: { page?, limit?, total?, totalPages?, hasNext?, hasPrev?, nextCursor? },
 *   error: { message, code, details? } | null
 * }
 */

const API_VERSION = process.env.API_VERSION || '1.0.0';

function formatEnvelope({ data = null, meta = {}, error = null, success = true }) {
  const envelope = {
    success: Boolean(success),
    data: data !== undefined ? data : null,
    meta: Object.keys(meta || {}).length > 0 ? meta : {},
    error: error || null,
  };
  return envelope;
}

function sendEnvelope(res, { data = null, meta = {}, error = null, statusCode = 200 }) {
  res.setHeader('X-API-Version', API_VERSION);
  const success = statusCode >= 200 && statusCode < 400;
  return res.status(statusCode).json(formatEnvelope({ data, meta, error, success }));
}

function sendSuccess(res, data, message = null, statusCode = 200, meta = {}) {
  res.setHeader('X-API-Version', API_VERSION);
  const response = { success: true, data };
  if (message) response.message = message;
  if (meta && Object.keys(meta).length > 0) response.meta = meta;
  return res.status(statusCode).json(response);
}

function sendError(res, message, code = 'INTERNAL_ERROR', statusCode = 500, details = null) {
  res.setHeader('X-API-Version', API_VERSION);
  const response = { success: false, error: { message, code } };
  if (details) response.error.details = details;
  return res.status(statusCode).json(response);
}

function sendPaginated(res, data, page, limit, total, nextCursor = null) {
  res.setHeader('X-API-Version', API_VERSION);
  const totalPages = Math.ceil(total / limit);
  const pagination = {
    page: Number(page),
    limit: Number(limit),
    total: Number(total),
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    ...(nextCursor ? { nextCursor } : {}),
  };
  return sendSuccess(res, data, null, 200, {
    pagination,
    page: Number(page),
    limit: Number(limit),
    total: Number(total),
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    ...(nextCursor ? { nextCursor } : {}),
  });
}

module.exports = {
  formatEnvelope,
  sendEnvelope,
  sendSuccess,
  sendError,
  sendPaginated,
  API_VERSION,
};
