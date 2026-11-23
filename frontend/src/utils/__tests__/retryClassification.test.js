/**
 * Tests for retryClassification.js
 *
 * Covers:
 *  - isRetryable() for network errors, 5xx, 429, 4xx, abort
 *  - Known retryable and non-retryable error codes
 *  - getErrorCode() extraction
 */

import {
  isRetryable,
  getErrorCode,
  RETRYABLE_CODES,
  NON_RETRYABLE_CODES,
} from "../../utils/retryClassification";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build an Axios-style error with a response. */
function axiosErr(status, code = "", errorMsg = "") {
  return {
    name: "AxiosError",
    message: errorMsg || `Request failed with status code ${status}`,
    response: { status, data: { code, error: errorMsg } },
  };
}

/** Build an error with no response (pure network failure). */
function networkErr(message = "Network Error") {
  return { name: "AxiosError", message, response: undefined };
}

/** Build an AbortController cancellation error. */
function canceledErr() {
  return { name: "CanceledError", code: "ERR_CANCELED", message: "canceled" };
}

// ─── isRetryable — network / abort ────────────────────────────────────────────

describe("isRetryable — network-level failures", () => {
  it("returns true when there is no response (network error)", () => {
    expect(isRetryable(networkErr())).toBe(true);
  });

  it("returns true for a timeout error with no response", () => {
    expect(isRetryable({ name: "AxiosError", code: "ECONNABORTED", message: "timeout", response: undefined })).toBe(true);
  });

  it("returns false for a CanceledError (abort)", () => {
    expect(isRetryable(canceledErr())).toBe(false);
  });

  it("returns false for an error named CanceledError even without ERR_CANCELED code", () => {
    expect(isRetryable({ name: "CanceledError", message: "canceled" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRetryable(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRetryable(undefined)).toBe(false);
  });
});

// ─── isRetryable — HTTP status codes ─────────────────────────────────────────

describe("isRetryable — HTTP status heuristic", () => {
  it("returns true for HTTP 500", () => {
    expect(isRetryable(axiosErr(500))).toBe(true);
  });

  it("returns true for HTTP 502", () => {
    expect(isRetryable(axiosErr(502))).toBe(true);
  });

  it("returns true for HTTP 503", () => {
    expect(isRetryable(axiosErr(503))).toBe(true);
  });

  it("returns true for HTTP 504", () => {
    expect(isRetryable(axiosErr(504))).toBe(true);
  });

  it("returns true for HTTP 429 (rate limit)", () => {
    expect(isRetryable(axiosErr(429))).toBe(true);
  });

  it("returns false for HTTP 400", () => {
    expect(isRetryable(axiosErr(400, "VALIDATION_ERROR"))).toBe(false);
  });

  it("returns false for HTTP 401", () => {
    expect(isRetryable(axiosErr(401, "INVALID_AUTH_TOKEN"))).toBe(false);
  });

  it("returns false for HTTP 403", () => {
    expect(isRetryable(axiosErr(403, "INSUFFICIENT_ROLE"))).toBe(false);
  });

  it("returns false for HTTP 404", () => {
    expect(isRetryable(axiosErr(404, "NOT_FOUND"))).toBe(false);
  });

  it("returns false for HTTP 409 (conflict / duplicate)", () => {
    expect(isRetryable(axiosErr(409, "DUPLICATE_STUDENT"))).toBe(false);
  });

  it("returns false for HTTP 422", () => {
    expect(isRetryable(axiosErr(422, "VALIDATION_ERROR"))).toBe(false);
  });
});

// ─── isRetryable — error code overrides ──────────────────────────────────────

describe("isRetryable — retryable error codes take precedence over status", () => {
  const retryableCodes = [
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
  ];

  retryableCodes.forEach((code) => {
    it(`RETRYABLE_CODES includes ${code}`, () => {
      expect(RETRYABLE_CODES.has(code)).toBe(true);
    });

    it(`isRetryable returns true for ${code} on a 503 response`, () => {
      expect(isRetryable(axiosErr(503, code))).toBe(true);
    });
  });

  it("isRetryable returns true for STELLAR_NETWORK_ERROR even on a 200 (edge case)", () => {
    // Simulate a backend that returns 200 but with a retryable code body (unlikely
    // but the code-based check runs before the status check).
    const weirdErr = axiosErr(200, "STELLAR_NETWORK_ERROR");
    expect(isRetryable(weirdErr)).toBe(true);
  });
});

describe("isRetryable — non-retryable error codes", () => {
  const nonRetryableCodes = [
    "DUPLICATE_STUDENT",
    "STUDENT_PREVIOUSLY_DELETED",
    "DUPLICATE_TX",
    "MISSING_MEMO",
    "INVALID_DESTINATION",
    "INVALID_CREDENTIALS",
    "DISPUTE_ALREADY_EXISTS",
    "VALIDATION_ERROR",
  ];

  nonRetryableCodes.forEach((code) => {
    it(`NON_RETRYABLE_CODES includes ${code}`, () => {
      expect(NON_RETRYABLE_CODES.has(code)).toBe(true);
    });

    it(`isRetryable returns false for ${code} on a 409 response`, () => {
      expect(isRetryable(axiosErr(409, code))).toBe(false);
    });
  });
});

// ─── getErrorCode ─────────────────────────────────────────────────────────────

describe("getErrorCode", () => {
  it("extracts code from response.data.code", () => {
    expect(getErrorCode(axiosErr(503, "SERVICE_UNAVAILABLE"))).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns empty string when response is absent", () => {
    expect(getErrorCode(networkErr())).toBe("");
  });

  it("returns empty string when data.code is absent", () => {
    const err = { response: { status: 500, data: { error: "Something broke" } } };
    expect(getErrorCode(err)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(getErrorCode(null)).toBe("");
  });
});

// ─── RETRYABLE_CODES / NON_RETRYABLE_CODES sets are disjoint ─────────────────

describe("RETRYABLE_CODES and NON_RETRYABLE_CODES are disjoint", () => {
  it("no code appears in both sets", () => {
    const overlap = [...RETRYABLE_CODES].filter(c => NON_RETRYABLE_CODES.has(c));
    expect(overlap).toEqual([]);
  });
});
