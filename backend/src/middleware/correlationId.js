'use strict';

/**
 * Correlation ID middleware.
 *
 * Accepts or generates a correlation ID for every incoming request and attaches
 * it to `req.correlationId` and the `X-Correlation-ID` response header so that
 * a single trace identifier flows across HTTP, queues, provider calls, and logs.
 *
 * Incoming ID handling:
 *   - If the `X-Correlation-ID` request header is present it is sanitized
 *     (stripped to a safe charset, max 128 chars) and used as-is so callers
 *     (frontend, external services, integration tests) can maintain their own
 *     trace chain.
 *   - If the header is absent, empty, or becomes empty after sanitization a
 *     fresh ID is generated via `generateCorrelationId()`.
 *
 * Security:
 *   - Only alphanumerics plus `_`, `:`, `.`, and `-` are allowed. Everything
 *     else is stripped before the value is stored or reflected. This prevents
 *     log-injection and header-injection attacks.
 *   - IDs are capped at MAX_LENGTH characters before reflection so a caller
 *     cannot flood logs with arbitrarily long strings.
 */

const { generateCorrelationId, isValidUuidV4, generateUuidV4 } = require('../utils/correlationId');
const { asyncLocalStorage } = require('../utils/logger');

/**
 * Characters outside this set are stripped from incoming IDs.
 * Allows: a-z A-Z 0-9 _ : . -
 */
const UNSAFE_CHARS = /[^a-zA-Z0-9_:.-]/g;
const MAX_LENGTH = 128;

/**
 * Sanitize a raw correlation ID supplied by the caller.
 *
 * @param {*} raw  Raw header value (may be undefined, null, or any type).
 * @returns {string|null}  Cleaned ID, or null when nothing usable remains.
 */
function sanitizeCorrelationId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(UNSAFE_CHARS, '').slice(0, MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Express middleware.  Must be mounted BEFORE `requestLogger` so the logger
 * can use the already-resolved ID rather than generating a second one.
 *
 * Validates UUID v4 if provided; if invalid or missing, generates a new UUID v4.
 * Attaches to req.correlationId & req.requestId, sets X-Request-ID & X-Correlation-ID response headers,
 * and enters asyncLocalStorage so all request logs include correlationId.
 */
function correlationIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  let correlationId;

  if (incoming && typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (isValidUuidV4(trimmed)) {
      correlationId = trimmed;
    } else {
      const sanitized = sanitizeCorrelationId(trimmed);
      correlationId = sanitized || generateUuidV4();
    }
  } else {
    correlationId = generateUuidV4();
  }

  req.correlationId = correlationId;
  req.requestId = correlationId;

  res.setHeader('X-Request-ID', correlationId);
  res.setHeader('X-Correlation-ID', correlationId);

  if (asyncLocalStorage && typeof asyncLocalStorage.run === 'function') {
    asyncLocalStorage.run({ correlationId, requestId: correlationId }, () => {
      next();
    });
  } else {
    next();
  }
}

module.exports = { correlationIdMiddleware, sanitizeCorrelationId };
