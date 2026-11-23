# Payment Error Taxonomy

## Overview

The StellarEduPay payment system provides a stable, categorized error taxonomy for all payment operations. API consumers can inspect the returned `code` and `category` fields to programmatically determine appropriate handling, fallback, or retry behavior without parsing free-text error messages.

Internal details (database connection errors, internal stack traces, private keys, third-party provider payloads) are never exposed to public consumers in error responses, while complete diagnostic context is preserved in server-side logs.

---

## Error Categories

| Category | HTTP Status | Description | Client Action |
|---|---|---|---|
| `VALIDATION` | 400, 404 | Malformed request body, invalid payment parameters, or missing resources. | Fix request parameters before resubmitting. Do not retry without changes. |
| `AUTHORIZATION` | 401, 403 | Missing or invalid auth credentials, or attempting cross-tenant access. | Re-authenticate or request required tenant permissions. |
| `CONFLICT` | 409 | Duplicate submissions, idempotency conflicts, or concurrent sync operations. | Check existing payment status or wait for in-progress operation to finish. |
| `PROVIDER` | 502, 400 | Stellar network, Horizon, or currency provider errors. | Inspect failure reason. Transient provider errors may be retried. |
| `TRANSIENT` | 503, 504, 429 | Temporary downstream or queue unavailability, or rate limiting. | Safe to retry after backoff interval. |
| `INTERNAL` | 500 | Unhandled server exception. | Report error to support; do not retry immediately. |

---

## Response Structure

Public payment error responses follow a consistent JSON format:

```json
{
  "success": false,
  "error": {
    "code": "AMOUNT_TOO_LOW",
    "message": "The payment amount is below the minimum allowed threshold.",
    "category": "VALIDATION",
    "details": null
  }
}
```

### Fields:
- `success`: Always `false` on error responses.
- `error.code`: A stable, uppercase string identifying the precise error type.
- `error.message`: A safe, human-readable description appropriate for display.
- `error.category`: One of `VALIDATION`, `AUTHORIZATION`, `CONFLICT`, `PROVIDER`, `TRANSIENT`, `INTERNAL`.
- `error.details`: (Optional) Field-level validation issues or supplementary safe metadata.

---

## Error Taxonomy Reference Table

### 1. Validation Errors (400 / 404)

| Error Code | HTTP Status | Safe Message | Retryable |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | The request payload or parameter failed validation. | No |
| `INVALID_AMOUNT` | 400 | The payment amount is invalid. | No |
| `AMOUNT_TOO_LOW` | 400 | The payment amount is below the minimum allowed threshold. | No |
| `AMOUNT_TOO_HIGH` | 400 | The payment amount exceeds the maximum allowed limit. | No |
| `INVALID_HASH_FORMAT` | 400 | The transaction hash format is invalid. | No |
| `MISSING_MEMO` | 400 | The transaction is missing a required student identification memo. | No |
| `INVALID_MEMO` | 400 | The transaction memo format is invalid or unsupported. | No |
| `MISSING_XDR` | 400 | The transaction envelope XDR is required. | No |
| `INVALID_DESTINATION` | 400 | The transaction destination account does not match the school wallet. | No |
| `UNSUPPORTED_ASSET` | 400 | The asset used in the transaction is not supported. | No |
| `ASSET_NOT_ACCEPTED` | 400 | The asset is not accepted by this school. | No |
| `INVALID_FEE_CATEGORY`| 400 | The specified fee category was not found for this student. | No |
| `MISSING_SCHOOL_CONTEXT` | 400 | School tenant context header or identifier is required. | No |
| `MISSING_IDEMPOTENCY_KEY` | 400 | Idempotency-Key header is required for this operation. | No |
| `UNDERPAID` | 400 | The payment amount is less than the required fee. | No |
| `INVALID_TRANSITION` | 400 | The requested payment status transition is invalid. | No |
| `STUDENT_NOT_FOUND` | 404 | The associated student could not be found. | No |
| `PAYMENT_NOT_FOUND` | 404 | The requested payment was not found. | No |
| `INTENT_NOT_FOUND` | 404 | The requested payment intent was not found. | No |
| `NOT_FOUND` | 404 | The requested resource was not found. | No |

### 2. Authorization Errors (401 / 403)

| Error Code | HTTP Status | Safe Message | Retryable |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | Authentication credentials are required or invalid. | No |
| `INVALID_TOKEN` | 401 | The authentication token provided is invalid or expired. | No |
| `TOKEN_EXPIRED` | 401 | The authentication token has expired. | No |
| `FORBIDDEN` | 403 | You do not have permission to perform this payment action. | No |
| `INTENT_MISMATCH` | 403 | The payment intent does not belong to the authenticated school context. | No |
| `TENANT_ACCESS_DENIED` | 403 | Access to this school tenant is denied. | No |

### 3. Conflict Errors (409)

| Error Code | HTTP Status | Safe Message | Retryable |
|---|---|---|---|
| `DUPLICATE_TX` | 409 | This transaction has already been recorded and processed. | No |
| `DUPLICATE_PAYMENT_INTENT` | 409 | A payment intent with this memo already exists. | No |
| `DUPLICATE_IDEMPOTENCY_KEY` | 409 | A request with this Idempotency-Key is currently processing or had different parameters. | No |
| `SYNC_IN_PROGRESS` | 409 | A synchronization or verification operation is already in progress for this resource. | Yes (backoff) |
| `STATE_CONFLICT` | 409 | The payment resource is in a state that conflicts with the requested action. | No |

### 4. Provider Errors (502 / 400)

| Error Code | HTTP Status | Safe Message | Retryable |
|---|---|---|---|
| `PROVIDER_ERROR` | 502 | The upstream payment provider encountered an unexpected failure. | Yes |
| `STELLAR_NETWORK_ERROR` | 502 | Communication with the Stellar network failed. | Yes |
| `HORIZON_ERROR` | 502 | The Stellar Horizon endpoint returned an error. | Yes |
| `TX_SUBMISSION_FAILED` | 502 | Failed to submit transaction to the Stellar network. | Yes |
| `TX_FAILED` | 400 | The transaction was processed on-chain but resulted in failure. | No |
| `ONCHAIN_FAILURE` | 502 | Transaction execution failed on the ledger. | No |

### 5. Transient Errors (503 / 504 / 429)

| Error Code | HTTP Status | Safe Message | Retryable |
|---|---|---|---|
| `TRANSIENT_FAILURE` | 503 | A transient error occurred. Please retry your request shortly. | Yes |
| `SERVICE_UNAVAILABLE` | 503 | The payment service is temporarily unavailable. Please retry shortly. | Yes |
| `HORIZON_UNAVAILABLE` | 503 | Stellar Horizon is temporarily unreachable. Please retry shortly. | Yes |
| `QUEUE_UNAVAILABLE` | 503 | Async payment processing queue is temporarily unavailable. Please retry shortly. | Yes |
| `REQUEST_TIMEOUT` | 504 | The request timed out waiting for downstream dependencies. | Yes |
| `RATE_LIMITED` | 429 | Too many payment requests. Please throttle your requests. | Yes (after reset) |

---

## Client Handling Recommendations

When integrating with PaymentFlow:
1. **Branch on `error.category`** first:
   - `VALIDATION`: Display validation errors to the user.
   - `AUTHORIZATION`: Prompt the user to re-authenticate.
   - `CONFLICT`: Check if payment is already recorded or retry after a short delay for `SYNC_IN_PROGRESS`.
   - `TRANSIENT`: Implement exponential backoff with jitter.
   - `PROVIDER`: For 502 errors, queue for background polling or retry.
2. **Key on `error.code`** for fine-grained UX (e.g. `AMOUNT_TOO_LOW` vs `MISSING_MEMO`).
3. **Never parse `error.message`** strings, as messages may be localized or improved in future releases.
