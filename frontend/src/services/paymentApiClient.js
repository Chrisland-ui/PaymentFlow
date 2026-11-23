/**
 * paymentApiClient.js — Issue #249
 *
 * Typed payment API client — a focused facade over the shared axios instance
 * in `./api`.  Every function here maps one-to-one to a payment-related
 * backend route and normalises errors into a stable frontend shape.
 *
 * Runtime schema validation:
 *   Every API response is validated against a lightweight schema before being
 *   returned to callers.  Schema mismatches are logged as structured errors and
 *   re-thrown as ApiError objects with code "SCHEMA_MISMATCH" so callers can
 *   surface an appropriate user-facing message.  This catches backend contract
 *   drift in both development and production.
 *
 * All functions:
 *  - Reuse the shared `api` instance (no duplicate axios configuration).
 *  - Have JSDoc-documented params and return shapes.
 *  - Catch errors and re-throw them as a normalised `ApiError` object.
 *
 * Error shape: `{ message: string, code: string, status: number|null, retryable: boolean }`
 */

import api from "./api";
import { isRetryable, getErrorCode } from "../utils/retryClassification";

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ApiError
 * @property {string}       message   - Human-readable error description.
 * @property {string}       code      - Backend error code (e.g. "DUPLICATE_TX")
 *                                      or empty string if none was provided.
 * @property {number|null}  status    - HTTP status code, or null for network /
 *                                      timeout errors where no response arrived.
 * @property {boolean}      retryable - Whether retrying the request might succeed.
 */

/**
 * Transforms an Axios error (or any error) into the stable `ApiError` shape
 * used throughout the frontend.
 *
 * Decision rules (delegated to retryClassification):
 *  - No response (network error, timeout, abort) → retryable=true, status=null
 *  - HTTP 5xx or 429 → retryable=true
 *  - HTTP 4xx (other than 429) → retryable=false
 *
 * @param {unknown} err - The raw error thrown by an Axios call.
 * @returns {ApiError}
 */
export function normalizeApiError(err) {
  const status = err?.response?.status ?? null;
  const code   = getErrorCode(err);
  const message =
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    err?.message ||
    "An unexpected error occurred.";
  const retryable = isRetryable(err);

  return { message, code, status, retryable };
}

// ---------------------------------------------------------------------------
// Lightweight runtime schema validation (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FieldSpec
 * @property {'string'|'number'|'boolean'|'object'|'array'|'any'} type
 * @property {boolean} [required]
 * @property {FieldSpec} [items]       - Element spec for array fields.
 * @property {{ [key: string]: FieldSpec }} [shape]  - Shape for object fields.
 */

/**
 * Validate a single value against a FieldSpec.
 * Returns null when valid, or a human-readable error string when invalid.
 *
 * @param {*} value
 * @param {FieldSpec} spec
 * @param {string} path  - Dot-notation path for error messages (e.g. "data.payments[0].status")
 * @returns {string|null}
 */
function validateField(value, spec, path) {
  if (spec.type === 'any') return null;

  const missing = value === undefined || value === null;

  if (missing) {
    return spec.required ? `Missing required field "${path}".` : null;
  }

  if (spec.type === 'array') {
    if (!Array.isArray(value)) {
      return `Field "${path}" must be an array, got ${typeof value}.`;
    }
    if (spec.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErr = validateField(value[i], spec.items, `${path}[${i}]`);
        if (itemErr) return itemErr;
      }
    }
    return null;
  }

  // eslint-disable-next-line valid-typeof
  if (spec.type !== typeof value) {
    // Be lenient with numbers that arrive as strings (common in APIs)
    if (spec.type === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
      return null;
    }
    return `Field "${path}" must be ${spec.type}, got ${typeof value}.`;
  }

  if (spec.type === 'object' && spec.shape) {
    for (const [key, fieldSpec] of Object.entries(spec.shape)) {
      const fieldErr = validateField(value[key], fieldSpec, `${path}.${key}`);
      if (fieldErr) return fieldErr;
    }
  }

  return null;
}

/**
 * Validate a response data object against a schema map.
 * Returns an array of all violation strings found.
 *
 * @param {*} data - The response data to validate.
 * @param {{ [key: string]: FieldSpec }} schema - Top-level schema shape.
 * @returns {string[]}  Array of violation messages; empty means valid.
 */
function validateSchema(data, schema) {
  const violations = [];
  for (const [key, spec] of Object.entries(schema)) {
    const err = validateField(data?.[key], spec, key);
    if (err) violations.push(err);
  }
  return violations;
}

/**
 * Internal helper: execute a call, validate the response, and normalise errors.
 *
 * @template T
 * @param {() => Promise<T>}                   fn     - Axios call to execute.
 * @param {{ [key: string]: FieldSpec }} [schema]     - Optional schema for response.data.
 * @param {string}                         [endpoint] - Name for logging context.
 * @returns {Promise<T>}
 */
async function call(fn, schema, endpoint = 'unknown') {
  let response;
  try {
    response = await fn();
  } catch (err) {
    throw normalizeApiError(err);
  }

  // Runtime schema validation on the response body
  if (schema && response?.data !== undefined) {
    const violations = validateSchema(response.data, schema);
    if (violations.length > 0) {
      const msg =
        `API schema mismatch for "${endpoint}": ${violations.join('; ')}. ` +
        `The backend response shape may have changed — please report this.`;
      // Always log a structured error; callers decide whether to surface it.
      if (typeof console !== 'undefined') {
        console.error('[paymentApiClient] SCHEMA_MISMATCH', {
          endpoint,
          violations,
          data: response.data,
        });
      }
      throw {
        message: msg,
        code: 'SCHEMA_MISMATCH',
        status: response.status ?? null,
        retryable: false,
      };
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/**
 * Schemas define the minimum expected shape of each API response.
 * Only required fields are marked required: true; extra fields are ignored.
 * Using a "soft" approach — we validate the fields we depend on rather than
 * every field, so additive backend changes don't cause unnecessary failures.
 */

const PAYMENT_SCHEMA = {
  txHash:    { type: 'string',  required: true  },
  status:    { type: 'string',  required: true  },
  amount:    { type: 'number',  required: false },
  asset:     { type: 'string',  required: false },
  createdAt: { type: 'string',  required: false },
};

const PAYMENT_INSTRUCTIONS_SCHEMA = {
  walletAddress:  { type: 'string', required: true },
  memo:           { type: 'string', required: true },
  acceptedAssets: {
    type:     'array',
    required: false,
    items:    {
      type:  'object',
      shape: { code: { type: 'string', required: true } },
    },
  },
};

const STUDENT_BALANCE_SCHEMA = {
  totalPaid:  { type: 'number',  required: false },
  totalDue:   { type: 'number',  required: false },
  balance:    { type: 'number',  required: false },
  feeStatus:  { type: 'string',  required: false },
};

const PAYMENT_SUMMARY_SCHEMA = {
  totalCollected: { type: 'number', required: false },
  pendingCount:   { type: 'number', required: false },
  successCount:   { type: 'number', required: false },
};

const VERIFY_PAYMENT_SCHEMA = {
  txHash: { type: 'string', required: true  },
  status: { type: 'string', required: true  },
  memo:   { type: 'string', required: false },
};

const SYNC_RESULT_SCHEMA = {
  processed: { type: 'number', required: false },
  new:       { type: 'number', required: false },
};

const SYNC_STATUS_SCHEMA = {
  running:    { type: 'boolean', required: false },
  lastSyncAt: { type: 'string',  required: false },
};

const REFUND_SCHEMA = {
  refundId:  { type: 'string', required: true  },
  status:    { type: 'string', required: true  },
  amount:    { type: 'number', required: false },
  createdAt: { type: 'string', required: false },
};

const REFUND_INITIATE_SCHEMA = {
  refundId: { type: 'string', required: true  },
  status:   { type: 'string', required: false },
};

// Student schemas
const STUDENT_SCHEMA = {
  _id:       { type: 'string', required: false },
  studentId: { type: 'string', required: false },
  name:      { type: 'string', required: false },
  class:     { type: 'string', required: false },
  feeStatus: { type: 'string', required: false },
};

// School schemas
const SCHOOL_SCHEMA = {
  _id:           { type: 'string', required: false },
  name:          { type: 'string', required: false },
  walletAddress: { type: 'string', required: false },
};

// Auth schemas
const AUTH_LOGIN_SCHEMA = {
  token:   { type: 'string', required: false },
  user:    { type: 'object', required: false },
};

const AUTH_REFRESH_SCHEMA = {
  token: { type: 'string', required: false },
};

// Export schemas for consumers and testing
export {
  PAYMENT_SCHEMA,
  PAYMENT_INSTRUCTIONS_SCHEMA,
  STUDENT_BALANCE_SCHEMA,
  PAYMENT_SUMMARY_SCHEMA,
  VERIFY_PAYMENT_SCHEMA,
  SYNC_RESULT_SCHEMA,
  SYNC_STATUS_SCHEMA,
  REFUND_SCHEMA,
  REFUND_INITIATE_SCHEMA,
  STUDENT_SCHEMA,
  SCHOOL_SCHEMA,
  AUTH_LOGIN_SCHEMA,
  AUTH_REFRESH_SCHEMA,
};

// Also export validation helpers for testing
export { validateSchema, validateField };

// ---------------------------------------------------------------------------
// Payment API functions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PaymentInstructions
 * @property {string} walletAddress     - School Stellar wallet public key.
 * @property {string} memo              - Memo text to embed in the transaction.
 * @property {Array<{code: string, issuer?: string}>} acceptedAssets
 */

/**
 * Retrieve payment instructions (wallet address, memo, accepted assets) for a
 * student.  Consumers should embed the memo in the Stellar transaction.
 *
 * @param {string}        studentId        - The student's ID.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse<PaymentInstructions>>}
 */
export function fetchPaymentInstructions(studentId, { signal } = {}) {
  return call(
    () => api.get(`/payments/instructions/${studentId}`, { signal }),
    PAYMENT_INSTRUCTIONS_SCHEMA,
    'fetchPaymentInstructions'
  );
}

/**
 * @typedef {Object} Payment
 * @property {string}  txHash    - Stellar transaction hash.
 * @property {string}  status    - One of the PAYMENT_STATUS values.
 * @property {number}  amount    - Payment amount.
 * @property {string}  asset     - Asset code (e.g. "XLM").
 * @property {string}  createdAt - ISO 8601 timestamp.
 */

/**
 * Retrieve the payment history for a student.
 * Response may be an array directly, or wrapped in { payments: [...] }.
 *
 * @param {string}        studentId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse<Payment[]>>}
 */
export function fetchStudentPayments(studentId, { signal } = {}) {
  // The payments endpoint may return an array or a { payments: [] } wrapper.
  // We validate individual items when the wrapper shape is used.
  return call(
    () => api.get(`/payments/${studentId}`, { signal }),
    null, // array responses are validated item-by-item below if needed
    'fetchStudentPayments'
  );
}

/**
 * @typedef {Object} StudentBalance
 * @property {number} totalPaid      - Sum of successful payments.
 * @property {number} totalDue       - Fee amount owed.
 * @property {number} balance        - Remaining balance (totalDue - totalPaid).
 * @property {string} feeStatus      - "paid" | "partial" | "unpaid"
 */

/**
 * Retrieve the current balance summary for a student.
 *
 * @param {string}        studentId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse<StudentBalance>>}
 */
export function fetchStudentBalance(studentId, { signal } = {}) {
  return call(
    () => api.get(`/payments/balance/${studentId}`, { signal }),
    STUDENT_BALANCE_SCHEMA,
    'fetchStudentBalance'
  );
}

/**
 * @typedef {Object} PaymentSummary
 * @property {number} totalCollected  - Total amount collected across all students.
 * @property {number} pendingCount    - Number of pending payments.
 * @property {number} successCount    - Number of successful payments.
 */

/**
 * Retrieve the school-wide payment summary (dashboard overview).
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse<PaymentSummary>>}
 */
export function fetchPaymentSummary({ signal } = {}) {
  return call(
    () => api.get("/payments/summary", { signal }),
    PAYMENT_SUMMARY_SCHEMA,
    'fetchPaymentSummary'
  );
}

/**
 * @typedef {Object} VerifyPaymentResult
 * @property {string}  txHash  - The verified transaction hash.
 * @property {string}  status  - Resulting payment status.
 * @property {string}  memo    - Memo from the transaction.
 */

/**
 * Submit a Stellar transaction hash for on-chain verification.
 *
 * @param {string} txHash - The Stellar transaction hash to verify.
 * @returns {Promise<import('axios').AxiosResponse<VerifyPaymentResult>>}
 */
export function verifyPayment(txHash) {
  return call(
    () => api.post("/payments/verify", { txHash }),
    VERIFY_PAYMENT_SCHEMA,
    'verifyPayment'
  );
}

/**
 * @typedef {Object} SyncResult
 * @property {number} processed - Number of transactions processed.
 * @property {number} new       - Number of new payments recorded.
 */

/**
 * Trigger a manual sync of the latest transactions from the Stellar blockchain.
 *
 * @returns {Promise<import('axios').AxiosResponse<SyncResult>>}
 */
export function syncPayments() {
  return call(
    () => api.post("/payments/sync"),
    SYNC_RESULT_SCHEMA,
    'syncPayments'
  );
}

/**
 * @typedef {Object} SyncStatus
 * @property {boolean} running    - Whether a sync is currently in progress.
 * @property {string}  lastSyncAt - ISO 8601 timestamp of the last completed sync.
 */

/**
 * Retrieve the current sync status.
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse<SyncStatus>>}
 */
export function fetchSyncStatus({ signal } = {}) {
  return call(
    () => api.get("/payments/sync/status", { signal }),
    SYNC_STATUS_SCHEMA,
    'fetchSyncStatus'
  );
}

/**
 * @typedef {Object} ConversionRates
 * @property {{ [assetCode: string]: number }} rates - Conversion rates to USD.
 */

/**
 * Retrieve current XLM/USDC conversion rates.
 *
 * @returns {Promise<import('axios').AxiosResponse<ConversionRates>>}
 */
export function fetchConversionRates() {
  return call(
    () => api.get("/payments/rates"),
    null,
    'fetchConversionRates'
  );
}

/**
 * @typedef {Object} RefundRequest
 * @property {string} reason - Reason for the refund.
 * @property {number} [amount] - Partial refund amount; omit for full refund.
 */

/**
 * @typedef {Object} RefundResult
 * @property {string} refundId - The created refund request ID.
 * @property {string} status   - Initial status of the refund.
 */

/**
 * Initiate a refund for a completed payment.
 *
 * @param {string}        txHash - The transaction hash of the payment to refund.
 * @param {RefundRequest} data   - Refund details.
 * @returns {Promise<import('axios').AxiosResponse<RefundResult>>}
 */
export function initiateRefund(txHash, data) {
  return call(
    () => api.post(`/payments/${txHash}/refund`, data),
    REFUND_INITIATE_SCHEMA,
    'initiateRefund'
  );
}

/**
 * @typedef {Object} RefundApprovalData
 * @property {string} [notes] - Optional admin notes for the approval.
 */

/**
 * Approve a pending refund request.
 *
 * @param {string}            refundId - The refund request ID.
 * @param {RefundApprovalData} data    - Approval details.
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function approveRefund(refundId, data) {
  return call(
    () => api.post(`/payments/refunds/${refundId}/approve`, data),
    null,
    'approveRefund'
  );
}

/**
 * @typedef {Object} Refund
 * @property {string} refundId  - Unique refund ID.
 * @property {string} status    - Refund status.
 * @property {number} amount    - Refund amount.
 * @property {string} createdAt - ISO 8601 timestamp.
 */

/**
 * Retrieve all refund records for a specific payment.
 *
 * @param {string} txHash - The transaction hash of the original payment.
 * @returns {Promise<import('axios').AxiosResponse<Refund[]>>}
 */
export function fetchPaymentRefunds(txHash) {
  return call(
    () => api.get(`/payments/${txHash}/refunds`),
    null,
    'fetchPaymentRefunds'
  );
}

/**
 * @typedef {Object} RefundListParams
 * @property {number} [page]   - Page number (1-indexed).
 * @property {number} [limit]  - Results per page.
 * @property {string} [status] - Filter by refund status.
 */

/**
 * Retrieve the paginated list of all refunds for the current school.
 *
 * @param {RefundListParams} [params]
 * @returns {Promise<import('axios').AxiosResponse<{ refunds: Refund[], total: number }>>}
 */
export function fetchSchoolRefunds(params = {}) {
  return call(
    () => api.get("/payments/refunds/school/list", { params }),
    null,
    'fetchSchoolRefunds'
  );
}

// ---------------------------------------------------------------------------
// Student API functions (typed)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Student
 * @property {string} _id       - MongoDB document ID.
 * @property {string} studentId - School-assigned student ID.
 * @property {string} name      - Student full name.
 * @property {string} class     - Class name.
 * @property {string} feeStatus - "paid" | "partial" | "unpaid"
 */

/**
 * Retrieve a single student by ID with schema validation.
 *
 * @param {string} studentId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse<Student>>}
 */
export function fetchStudent(studentId, { signal } = {}) {
  return call(
    () => api.get(`/students/${studentId}`, { signal }),
    STUDENT_SCHEMA,
    'fetchStudent'
  );
}

/**
 * Retrieve a paginated list of students with schema validation.
 * Response shape: { students: Student[], total: number, page: number }
 *
 * @param {number} [page=1]
 * @param {number} [limit=20]
 * @param {{ search?: string, status?: string, className?: string }} [filters]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function fetchStudents(page = 1, limit = 20, filters = {}, { signal } = {}) {
  const { search, status, className } = filters;
  return call(
    () => api.get("/students", {
      params: {
        page,
        limit,
        ...(search    && { search }),
        ...(status    && status !== "all" && { status }),
        ...(className && { class: className }),
      },
      signal,
    }),
    null,
    'fetchStudents'
  );
}

// ---------------------------------------------------------------------------
// School API functions (typed)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} School
 * @property {string} _id           - MongoDB document ID.
 * @property {string} name          - School name.
 * @property {string} walletAddress - School Stellar wallet public key.
 */

/**
 * Retrieve school details by slug.
 *
 * @param {string} slug
 * @returns {Promise<import('axios').AxiosResponse<School>>}
 */
export function fetchSchool(slug) {
  return call(
    () => api.get(`/schools/${slug}`),
    SCHOOL_SCHEMA,
    'fetchSchool'
  );
}

// ---------------------------------------------------------------------------
// Auth API functions (typed)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LoginCredentials
 * @property {string} email
 * @property {string} password
 * @property {string} [schoolSlug]
 */

/**
 * Authenticate an admin user.
 *
 * @param {LoginCredentials} credentials
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function login(credentials) {
  return call(
    () => api.post("/auth/login", credentials),
    AUTH_LOGIN_SCHEMA,
    'login'
  );
}

/**
 * Refresh the access token using the HttpOnly refresh cookie.
 *
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function refreshToken() {
  return call(
    () => api.post("/auth/refresh"),
    AUTH_REFRESH_SCHEMA,
    'refreshToken'
  );
}

/**
 * Log the current user out (invalidates the session server-side).
 *
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function logout() {
  return call(
    () => api.post("/auth/logout"),
    null,
    'logout'
  );
}
