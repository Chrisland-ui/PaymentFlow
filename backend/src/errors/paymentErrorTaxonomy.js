'use strict';

/**
 * Payment Error Taxonomy
 *
 * Provides a stable, documented error taxonomy covering payment workflows.
 * Enables API consumers to reliably distinguish between:
 *   - VALIDATION: Client provided malformed or invalid inputs (400)
 *   - AUTHORIZATION: Authentication or permissions missing/invalid (401/403)
 *   - CONFLICT: State or concurrency conflict, such as duplicates or locks (409)
 *   - PROVIDER: Upstream payment/blockchain provider failure (502)
 *   - TRANSIENT: Temporary service failure, safe to retry with backoff (503/429/504)
 *
 * Ensures internal details (connection strings, stack traces, raw provider dumps)
 * are redacted from public responses while preserved in diagnostic logs.
 */

const PAYMENT_ERROR_CATEGORIES = Object.freeze({
  VALIDATION: 'VALIDATION',
  AUTHORIZATION: 'AUTHORIZATION',
  CONFLICT: 'CONFLICT',
  PROVIDER: 'PROVIDER',
  TRANSIENT: 'TRANSIENT',
  INTERNAL: 'INTERNAL',
});

const TAXONOMY = Object.freeze({
  // ── VALIDATION ERRORS (400) ──────────────────────────────────────────────────
  VALIDATION_ERROR: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The request payload or parameter failed validation.',
    retryable: false,
  },
  INVALID_AMOUNT: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The payment amount is invalid.',
    retryable: false,
  },
  AMOUNT_TOO_LOW: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The payment amount is below the minimum allowed threshold.',
    retryable: false,
  },
  AMOUNT_TOO_HIGH: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The payment amount exceeds the maximum allowed limit.',
    retryable: false,
  },
  INVALID_HASH_FORMAT: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The transaction hash format is invalid.',
    retryable: false,
  },
  MISSING_MEMO: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The transaction is missing a required student identification memo.',
    retryable: false,
  },
  INVALID_MEMO: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The transaction memo format is invalid or unsupported.',
    retryable: false,
  },
  MISSING_XDR: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The transaction envelope XDR is required.',
    retryable: false,
  },
  INVALID_DESTINATION: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The transaction destination account does not match the school wallet.',
    retryable: false,
  },
  UNSUPPORTED_ASSET: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The asset used in the transaction is not supported.',
    retryable: false,
  },
  ASSET_NOT_ACCEPTED: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The asset is not accepted by this school.',
    retryable: false,
  },
  INVALID_FEE_CATEGORY: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The specified fee category was not found for this student.',
    retryable: false,
  },
  MISSING_SCHOOL_CONTEXT: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'School tenant context header or identifier is required.',
    retryable: false,
  },
  MISSING_IDEMPOTENCY_KEY: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'Idempotency-Key header is required for this operation.',
    retryable: false,
  },
  UNDERPAID: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The payment amount is less than the required fee.',
    retryable: false,
  },
  INVALID_TRANSITION: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 400,
    safeMessage: 'The requested payment status transition is invalid.',
    retryable: false,
  },
  STUDENT_NOT_FOUND: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 404,
    safeMessage: 'The associated student could not be found.',
    retryable: false,
  },
  PAYMENT_NOT_FOUND: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 404,
    safeMessage: 'The requested payment was not found.',
    retryable: false,
  },
  NOT_FOUND: {
    category: PAYMENT_ERROR_CATEGORIES.VALIDATION,
    status: 404,
    safeMessage: 'The requested resource was not found.',
    retryable: false,
  },

  // ── AUTHORIZATION ERRORS (401 / 403) ────────────────────────────────────────
  UNAUTHORIZED: {
    category: PAYMENT_ERROR_CATEGORIES.AUTHORIZATION,
    status: 401,
    safeMessage: 'Authentication credentials are required or invalid.',
    retryable: false,
  },
  INVALID_TOKEN: {
    category: PAYMENT_ERROR_CATEGORIES.AUTHORIZATION,
    status: 401,
    safeMessage: 'The authentication token provided is invalid or expired.',
    retryable: false,
  },
  TOKEN_EXPIRED: {
    category: PAYMENT_ERROR_CATEGORIES.AUTHORIZATION,
    status: 401,
    safeMessage: 'The authentication token has expired.',
    retryable: false,
  },
  FORBIDDEN: {
    category: PAYMENT_ERROR_CATEGORIES.AUTHORIZATION,
    status: 403,
    safeMessage: 'You do not have permission to perform this payment action.',
    retryable: false,
  },
  INTENT_MISMATCH: {
    category: PAYMENT_ERROR_CATEGORIES.AUTHORIZATION,
    status: 403,
    safeMessage: 'The payment intent does not belong to the authenticated school context.',
    retryable: false,
  },
  TENANT_ACCESS_DENIED: {
    category: PAYMENT_ERROR_CATEGORIES.AUTHORIZATION,
    status: 403,
    safeMessage: 'Access to this school tenant is denied.',
    retryable: false,
  },

  // ── CONFLICT ERRORS (409) ───────────────────────────────────────────────────
  DUPLICATE_TX: {
    category: PAYMENT_ERROR_CATEGORIES.CONFLICT,
    status: 409,
    safeMessage: 'This transaction has already been recorded and processed.',
    retryable: false,
  },
  DUPLICATE_PAYMENT_INTENT: {
    category: PAYMENT_ERROR_CATEGORIES.CONFLICT,
    status: 409,
    safeMessage: 'A payment intent with this memo already exists.',
    retryable: false,
  },
  DUPLICATE_IDEMPOTENCY_KEY: {
    category: PAYMENT_ERROR_CATEGORIES.CONFLICT,
    status: 409,
    safeMessage: 'A request with this Idempotency-Key is currently processing or had different parameters.',
    retryable: false,
  },
  SYNC_IN_PROGRESS: {
    category: PAYMENT_ERROR_CATEGORIES.CONFLICT,
    status: 409,
    safeMessage: 'A synchronization or verification operation is already in progress for this resource.',
    retryable: true,
  },
  STATE_CONFLICT: {
    category: PAYMENT_ERROR_CATEGORIES.CONFLICT,
    status: 409,
    safeMessage: 'The payment resource is in a state that conflicts with the requested action.',
    retryable: false,
  },

  // ── PROVIDER ERRORS (502) ───────────────────────────────────────────────────
  PROVIDER_ERROR: {
    category: PAYMENT_ERROR_CATEGORIES.PROVIDER,
    status: 502,
    safeMessage: 'The upstream payment provider encountered an unexpected failure.',
    retryable: true,
  },
  STELLAR_NETWORK_ERROR: {
    category: PAYMENT_ERROR_CATEGORIES.PROVIDER,
    status: 502,
    safeMessage: 'Communication with the Stellar network failed.',
    retryable: true,
  },
  HORIZON_ERROR: {
    category: PAYMENT_ERROR_CATEGORIES.PROVIDER,
    status: 502,
    safeMessage: 'The Stellar Horizon endpoint returned an error.',
    retryable: true,
  },
  TX_FAILED: {
    category: PAYMENT_ERROR_CATEGORIES.PROVIDER,
    status: 400,
    safeMessage: 'The transaction was processed on-chain but resulted in failure.',
    retryable: false,
  },
  TX_SUBMISSION_FAILED: {
    category: PAYMENT_ERROR_CATEGORIES.PROVIDER,
    status: 502,
    safeMessage: 'Failed to submit transaction to the Stellar network.',
    retryable: true,
  },
  ONCHAIN_FAILURE: {
    category: PAYMENT_ERROR_CATEGORIES.PROVIDER,
    status: 502,
    safeMessage: 'Transaction execution failed on the ledger.',
    retryable: false,
  },

  // ── TRANSIENT ERRORS (503 / 504 / 429) ──────────────────────────────────────
  TRANSIENT_FAILURE: {
    category: PAYMENT_ERROR_CATEGORIES.TRANSIENT,
    status: 503,
    safeMessage: 'A transient error occurred. Please retry your request shortly.',
    retryable: true,
  },
  SERVICE_UNAVAILABLE: {
    category: PAYMENT_ERROR_CATEGORIES.TRANSIENT,
    status: 503,
    safeMessage: 'The payment service is temporarily unavailable. Please retry shortly.',
    retryable: true,
  },
  HORIZON_UNAVAILABLE: {
    category: PAYMENT_ERROR_CATEGORIES.TRANSIENT,
    status: 503,
    safeMessage: 'Stellar Horizon is temporarily unreachable. Please retry shortly.',
    retryable: true,
  },
  QUEUE_UNAVAILABLE: {
    category: PAYMENT_ERROR_CATEGORIES.TRANSIENT,
    status: 503,
    safeMessage: 'Async payment processing queue is temporarily unavailable. Please retry shortly.',
    retryable: true,
  },
  REQUEST_TIMEOUT: {
    category: PAYMENT_ERROR_CATEGORIES.TRANSIENT,
    status: 504,
    safeMessage: 'The request timed out waiting for downstream dependencies.',
    retryable: true,
  },
  RATE_LIMITED: {
    category: PAYMENT_ERROR_CATEGORIES.TRANSIENT,
    status: 429,
    safeMessage: 'Too many payment requests. Please throttle your requests.',
    retryable: true,
  },

  // ── INTERNAL ERROR (500) ────────────────────────────────────────────────────
  INTERNAL_ERROR: {
    category: PAYMENT_ERROR_CATEGORIES.INTERNAL,
    status: 500,
    safeMessage: 'An internal server error occurred.',
    retryable: false,
  },
});

/**
 * Standard PaymentError class for service and controller boundaries.
 */
class PaymentError extends Error {
  /**
   * @param {string} code Error code from TAXONOMY
   * @param {string} [customMessage] Safe client-facing message override
   * @param {object} [diagnosticContext] Non-public context preserved only in logs
   * @param {object} [details] Public details (validation errors, field names)
   */
  constructor(code, customMessage = null, diagnosticContext = null, details = null) {
    const entry = TAXONOMY[code] || TAXONOMY.INTERNAL_ERROR;
    const message = customMessage || entry.safeMessage;
    super(message);
    this.name = 'PaymentError';
    this.code = code in TAXONOMY ? code : 'INTERNAL_ERROR';
    this.category = entry.category;
    this.statusCode = entry.status;
    this.status = entry.status;
    this.retryable = entry.retryable;
    this.diagnosticContext = diagnosticContext;
    this.details = details;
  }
}

/**
 * Classifies an error code into one of the 5 taxonomy categories.
 *
 * @param {string} code
 * @returns {string} Category name
 */
function getErrorCategory(code) {
  const entry = TAXONOMY[code];
  return entry ? entry.category : PAYMENT_ERROR_CATEGORIES.INTERNAL;
}

/**
 * Determines if an error is considered transient/retryable.
 *
 * @param {string|Error} errorOrCode
 * @returns {boolean}
 */
function isTransientError(errorOrCode) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code;
  const entry = TAXONOMY[code];
  if (entry) return Boolean(entry.retryable);
  if (typeof errorOrCode === 'object' && errorOrCode !== null) {
    return Boolean(errorOrCode.retryable);
  }
  return false;
}

/**
 * Safely maps any caught error or exception to a standardized response object,
 * preventing leaking of internals (stack traces, SQL/Mongo queries, credentials).
 *
 * @param {Error|object} err
 * @param {boolean} [isProduction=true]
 * @returns {{ statusCode: number, body: object, diagnosticContext: object }}
 */
function mapErrorToResponse(err, isProduction = (process.env.NODE_ENV === 'production')) {
  const code = err?.code || (err?.statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR');
  const entry = TAXONOMY[code];

  const statusCode = entry?.status || err?.statusCode || err?.status || 500;
  const category = entry?.category || (
    statusCode >= 500 ? PAYMENT_ERROR_CATEGORIES.INTERNAL :
    statusCode === 409 ? PAYMENT_ERROR_CATEGORIES.CONFLICT :
    statusCode === 401 || statusCode === 403 ? PAYMENT_ERROR_CATEGORIES.AUTHORIZATION :
    PAYMENT_ERROR_CATEGORIES.VALIDATION
  );

  let clientMessage;
  if (isProduction && statusCode >= 500) {
    clientMessage = entry?.safeMessage || TAXONOMY.INTERNAL_ERROR.safeMessage;
  } else {
    clientMessage = err?.message || entry?.safeMessage || TAXONOMY.INTERNAL_ERROR.safeMessage;
  }

  const responseBody = {
    success: false,
    error: {
      code,
      message: clientMessage,
      category,
    },
  };

  if (err?.details) {
    responseBody.error.details = err.details;
  }

  // Diagnostic context for server logs
  const diagnosticContext = {
    code,
    category,
    statusCode,
    internalMessage: err?.message,
    originalCode: err?.code,
    diagnostic: err?.diagnosticContext || null,
    stack: err?.stack,
  };

  return { statusCode, body: responseBody, diagnosticContext };
}

module.exports = {
  PAYMENT_ERROR_CATEGORIES,
  TAXONOMY,
  PaymentError,
  getErrorCategory,
  isTransientError,
  mapErrorToResponse,
};
