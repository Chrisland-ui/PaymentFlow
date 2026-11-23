'use strict';

/**
 * Correlation ID helpers for tracing a payment across the async pipeline:
 * polling -> queue job -> processor -> webhook -> SSE.
 *
 * IDs are derived deterministically from txHash (sha256, truncated) rather
 * than randomly generated. This means any pipeline stage that has the
 * txHash can independently recompute the same correlationId even if an
 * upstream hop forgot to propagate it explicitly — there is no single point
 * of failure for the correlation chain.
 */

const crypto = require('crypto');

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PREFIX = 'corr_';

/**
 * Validates whether a string is a valid UUID v4.
 * @param {string} id
 * @returns {boolean}
 */
function isValidUuidV4(id) {
  if (!id || typeof id !== 'string') return false;
  return UUID_V4_REGEX.test(id.trim());
}

/**
 * Generate a standard UUID v4.
 * @returns {string}
 */
function generateUuidV4() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return [
    crypto.randomBytes(4).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    '4' + crypto.randomBytes(2).toString('hex').slice(1),
    ((parseInt(crypto.randomBytes(1).toString('hex'), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + crypto.randomBytes(1).toString('hex'),
    crypto.randomBytes(6).toString('hex'),
  ].join('-');
}

/**
 * Characters outside this set are stripped from untrusted incoming IDs.
 * Allows: a-z A-Z 0-9 _ : . -
 */
const UNSAFE_CHARS = /[^a-zA-Z0-9_:.-]/g;
const MAX_ACCEPTED_LENGTH = 128;

/**
 * Derive a correlationId from a transaction hash. Deterministic: the same
 * txHash always yields the same correlationId.
 */
function deriveCorrelationId(txHash) {
  if (!txHash) return generateCorrelationId();
  return `${PREFIX}${crypto.createHash('sha256').update(String(txHash)).digest('hex').slice(0, 16)}`;
}

/**
 * Generate a random correlationId for flows that have no txHash yet.
 * Returns standard UUID v4.
 */
function generateCorrelationId() {
  return generateUuidV4();
}

/**
 * Use an explicit correlationId if one was already propagated, otherwise
 * derive it fresh from txHash or async context.
 */
function resolveCorrelationId(explicitCorrelationId, txHash) {
  if (explicitCorrelationId) return explicitCorrelationId;
  try {
    const logger = require('./logger');
    const store = logger.asyncLocalStorage?.getStore();
    if (store?.correlationId || store?.requestId) {
      return store.correlationId || store.requestId;
    }
  } catch (_) {}
  return txHash ? deriveCorrelationId(txHash) : generateCorrelationId();
}

/**
 * Accept and sanitize a correlation ID coming from an untrusted source
 * (e.g. a queue job payload, webhook header, or incoming HTTP request header).
 *
 * Strips characters outside the safe set and caps at MAX_ACCEPTED_LENGTH.
 * Returns a freshly generated ID when nothing usable remains.
 *
 * @param {*} raw  Untrusted raw ID string.
 * @returns {string}  A safe, non-empty correlation ID.
 */
function acceptCorrelationId(raw) {
  if (!raw || typeof raw !== 'string') return generateCorrelationId();
  const cleaned = raw.replace(UNSAFE_CHARS, '').slice(0, MAX_ACCEPTED_LENGTH);
  return cleaned.length > 0 ? cleaned : generateCorrelationId();
}

module.exports = {
  isValidUuidV4,
  generateUuidV4,
  deriveCorrelationId,
  generateCorrelationId,
  resolveCorrelationId,
  acceptCorrelationId,
};
