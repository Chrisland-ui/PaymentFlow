/**
 * retryClassification.js
 *
 * Single source of truth for deciding whether a given API error is transient
 * (retryable) or permanent (non-retryable).
 *
 * Design rules:
 * - Network-level failures (no response at all, timeout, abort) are always retryable.
 * - HTTP 5xx responses are retryable — the server may recover.
 * - HTTP 429 (rate limit) is retryable — backing off is sufficient.
 * - HTTP 4xx responses are NOT retryable — they indicate a client or data problem
 *   that a retry won't fix (e.g. INVALID_CREDENTIALS, DUPLICATE_STUDENT).
 * - Specific backend error codes that are known transient overrides are listed in
 *   RETRYABLE_CODES so they take precedence over the HTTP-status heuristic.
 *
 * Usage:
 *   import { isRetryable } from "../utils/retryClassification";
 *   const canRetry = isRetryable(err);
 */

/**
 * Backend error codes that are definitively transient and should be offered a
 * retry even when the HTTP status alone would not suggest it (e.g. a 503 body
 * may carry STELLAR_NETWORK_ERROR).  Any code in this set gets a retry offer.
 *
 * @type {Set<string>}
 */
export const RETRYABLE_CODES = new Set([
  "STELLAR_NETWORK_ERROR",
  "HORIZON_UNREACHABLE",
  "HORIZON_UNAVAILABLE",
  "RATE_LIMIT_EXCEEDED",
  "SERVICE_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "QUEUE_FULL",
  "NETWORK_ERROR",
  "INTERNAL_ERROR",
  "SYNC_IN_PROGRESS",
  "PROCESSING_ERROR",
  "MAX_RETRIES_EXCEEDED",
  "tx_insufficient_fee",
]);

/**
 * Backend error codes that are definitively permanent — retrying is pointless
 * and the UI should show a clear non-retryable message.  This explicit list
 * prevents accidental upgrades when a new code appears in a 5xx response.
 *
 * Not exhaustive: any code *not* in RETRYABLE_CODES is treated as non-retryable
 * by the default heuristic.  This set is used only by tests and documentation.
 *
 * @type {Set<string>}
 */
export const NON_RETRYABLE_CODES = new Set([
  "DUPLICATE_STUDENT",
  "STUDENT_PREVIOUSLY_DELETED",
  "DUPLICATE_TX",
  "MISSING_MEMO",
  "INVALID_DESTINATION",
  "UNSUPPORTED_ASSET",
  "INVALID_CREDENTIALS",
  "INVALID_TOKEN",
  "INVALID_AUTH_TOKEN",
  "INSUFFICIENT_ROLE",
  "DISPUTE_ALREADY_EXISTS",
  "INVALID_TRANSITION",
  "VALIDATION_ERROR",
  "DUPLICATE_SCHOOL",
  "DUPLICATE_FEE_STRUCTURE",
  "DUPLICATE_RULE",
  "NOT_FOUND",
  "FORBIDDEN",
]);

/**
 * Returns true when the Axios error (or plain Error) represents a transient
 * failure that is worth retrying.
 *
 * Decision order:
 *  1. No response at all (network error / timeout / abort) → retryable.
 *  2. Response body carries a known retryable error code → retryable.
 *  3. HTTP 429 or 5xx status → retryable.
 *  4. Everything else (4xx, unknown) → not retryable.
 *
 * @param {Error|null|undefined} err - The error from a failed API call.
 * @returns {boolean}
 */
export function isRetryable(err) {
  if (!err) return false;

  // Aborted requests (AbortController) are not retryable — they were cancelled
  // intentionally (e.g. component unmounted or filter changed).
  if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
    return false;
  }

  // No HTTP response → pure network failure (offline, DNS, timeout).
  if (!err.response) {
    return true;
  }

  const status = err.response?.status;
  const code   = err.response?.data?.code || "";

  // Explicit code match takes precedence over status heuristic.
  if (code && RETRYABLE_CODES.has(code)) return true;

  // HTTP 429 (Too Many Requests) or any 5xx → retryable.
  if (status === 429) return true;
  if (status >= 500)  return true;

  // 4xx (other than 429) → permanent client/data error.
  return false;
}

/**
 * Extracts the backend error code from an Axios error, or returns an empty
 * string if the response carries no code.
 *
 * @param {Error} err
 * @returns {string}
 */
export function getErrorCode(err) {
  return err?.response?.data?.code || "";
}
