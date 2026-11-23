# Error Codes Taxonomy

## Overview

StellarEduPay provides a structured, versioned error taxonomy across all API endpoints. Every error response includes a stable machine-readable code, HTTP status, categorization, safe user-facing message, and retryability semantics.

Clients should evaluate the `code` and `retryable` properties to determine programmatic error handling and recovery behavior.

---

## Canonical Error Response Envelope

```json
{
  "success": false,
  "error": {
    "code": "AMOUNT_TOO_LOW",
    "message": "The payment amount is below the minimum allowed threshold.",
    "category": "VALIDATION",
    "retryable": false,
    "details": null
  }
}
```

---

## Taxonomy Reference Table

### 1. Validation Errors (HTTP 400 / 404)

| Error Code | HTTP Status | Retryable | Message Template / Safe Message | Notes |
|---|---|---|---|---|
| `VALIDATION_ERROR` | 400 | No | The request payload or parameter failed validation. | Client payload schema validation error |
| `INVALID_AMOUNT` | 400 | No | The payment amount is invalid. | Must be a positive decimal number |
| `AMOUNT_TOO_LOW` | 400 | No | The payment amount is below the minimum allowed threshold. | Below minimum allowed amount |
| `AMOUNT_TOO_HIGH` | 400 | No | The payment amount exceeds the maximum allowed limit. | Exceeds single transaction limit |
| `INVALID_HASH_FORMAT` | 400 | No | The transaction hash format is invalid. | Must be 64-character hex |
| `MISSING_MEMO` | 400 | No | The transaction is missing a required student identification memo. | Memo required for routing |
| `INVALID_MEMO` | 400 | No | The transaction memo format is invalid or unsupported. | Memo format incorrect |
| `MISSING_XDR` | 400 | No | The transaction envelope XDR is required. | Missing Stellar XDR |
| `INVALID_DESTINATION` | 400 | No | The transaction destination account does not match the school wallet. | Destination mismatch |
| `UNSUPPORTED_ASSET` | 400 | No | The asset used in the transaction is not supported. | Asset code not supported |
| `ASSET_NOT_ACCEPTED` | 400 | No | The asset is not accepted by this school. | School does not accept this asset |
| `INVALID_FEE_CATEGORY`| 400 | No | The specified fee category was not found for this student. | Unknown fee category |
| `MISSING_SCHOOL_CONTEXT` | 400 | No | School tenant context header or identifier is required. | Tenant header missing |
| `MISSING_IDEMPOTENCY_KEY` | 400 | No | Idempotency-Key header is required for this operation. | Header missing on mutating endpoint |
| `UNDERPAID` | 400 | No | The payment amount is less than the required fee. | Partial fee underpayment |
| `INVALID_TRANSITION` | 400 | No | The requested payment status transition is invalid. | Illegal state machine transition |
| `STUDENT_NOT_FOUND` | 404 | No | The associated student could not be found. | Student record not found |
| `PAYMENT_NOT_FOUND` | 404 | No | The requested payment was not found. | Payment record not found |
| `INTENT_NOT_FOUND` | 404 | No | The requested payment intent was not found. | Payment intent not found |
| `NOT_FOUND` | 404 | No | The requested resource was not found. | General 404 |

### 2. Authorization Errors (HTTP 401 / 403)

| Error Code | HTTP Status | Retryable | Message Template / Safe Message | Notes |
|---|---|---|---|---|
| `UNAUTHORIZED` | 401 | No | Authentication credentials are required or invalid. | Missing or invalid auth header/cookie |
| `INVALID_TOKEN` | 401 | No | The authentication token provided is invalid or expired. | Malformed JWT or invalid signature |
| `TOKEN_EXPIRED` | 401 | No | The authentication token has expired. | Refresh access token |
| `FORBIDDEN` | 403 | No | You do not have permission to perform this payment action. | Role permissions insufficient |
| `INTENT_MISMATCH` | 403 | No | The payment intent does not belong to the authenticated school context. | Tenant boundary violation |
| `TENANT_ACCESS_DENIED` | 403 | No | Access to this school tenant is denied. | School tenant access revoked |

### 3. Conflict Errors (HTTP 409)

| Error Code | HTTP Status | Retryable | Message Template / Safe Message | Notes |
|---|---|---|---|---|
| `DUPLICATE_TX` | 409 | No | This transaction has already been recorded and processed. | Transaction hash collision |
| `DUPLICATE_PAYMENT_INTENT` | 409 | No | A payment intent with this memo already exists. | Intent memo collision |
| `DUPLICATE_IDEMPOTENCY_KEY` | 409 | No | A request with this Idempotency-Key is currently processing or had different parameters. | Concurrent in-flight or mismatched payload |
| `SYNC_IN_PROGRESS` | 409 | Yes (backoff) | A synchronization or verification operation is already in progress for this resource. | Lock contention; retry after delay |
| `STATE_CONFLICT` | 409 | No | The payment resource is in a state that conflicts with the requested action. | Conflicting resource state |

### 4. Upstream / Provider Errors (HTTP 502)

| Error Code | HTTP Status | Retryable | Message Template / Safe Message | Notes |
|---|---|---|---|---|
| `PROVIDER_UNAVAILABLE` | 502 | Yes (backoff) | The payment provider service is temporarily unreachable. | Horizon or RPC gateway offline |
| `PROVIDER_ERROR` | 502 | No | An error occurred while communicating with the payment provider. | Horizon rejected tx envelope |
| `TX_SUBMISSION_FAILED` | 502 | No | Transaction submission to the Stellar network failed. | Stellar transaction failed |
| `EXCHANGE_RATE_UNAVAILABLE` | 502 | Yes (backoff) | Unable to retrieve current currency exchange rates. | CoinGecko / oracle failure |

### 5. Transient & System Errors (HTTP 429 / 503 / 504)

| Error Code | HTTP Status | Retryable | Message Template / Safe Message | Notes |
|---|---|---|---|---|
| `RATE_LIMITED` | 429 | Yes (backoff) | Too many requests. Please slow down and try again later. | Rate limit quota exceeded |
| `SERVICE_UNAVAILABLE` | 503 | Yes (backoff) | Service is temporarily unavailable. Please try again shortly. | Server maintenance or overload |
| `QUEUE_UNAVAILABLE` | 503 | Yes (backoff) | The background processing queue is temporarily unavailable. | Redis / BullMQ unavailable |
| `GATEWAY_TIMEOUT` | 504 | Yes (backoff) | The upstream request timed out. | Upstream provider timeout |
| `INTERNAL_ERROR` | 500 | No | An unexpected error occurred. Please contact support. | Unhandled system exception |
