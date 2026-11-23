# Frontend Analytics Event Schema

## Overview

The PaymentFlow frontend uses a centralized, type-safe analytics catalog (`frontend/src/services/analyticsEvents.js` and `frontend/src/services/analyticsEvents.d.ts`). Every instrumented interaction is strictly typed, validated against an allowlist of properties, and protected by an automated PII stripping layer.

All event payloads automatically attach `schemaVersion: "1.0.0"` for forward and backward compatibility across analytics ingest pipelines.

---

## Privacy by Design (PII Stripping)

Sensitive fields are unconditionally scrubbed from payloads before dispatching to any third-party adapter (e.g. PostHog, Segment):
- `txHash` / `transactionHash`
- `walletAddress`
- `secretKey`
- `parentEmail`
- `parentPhone`
- `memoValue`

---

## Event Catalog Reference

| Event Name | Allowed Properties | Description |
|---|---|---|
| `PAYMENT_INSTRUCTIONS_VIEWED` | `className`, `paymentStatus`, `assetType`, `studentIdPrefix` | Parent opened the payment instructions panel. |
| `PAYMENT_VERIFY_SUBMITTED` | `assetType` | User submitted a transaction hash for verification. |
| `PAYMENT_VERIFY_SUCCESS` | `assetType`, `validationStatus` | Payment verification succeeded. |
| `PAYMENT_VERIFY_FAILED` | `errorCode`, `assetType` | Payment verification failed. |
| `DISPUTE_SUBMIT_SUCCESS` | `disputeType` | Dispute form submitted successfully. |
| `DISPUTE_SUBMIT_FAILED` | `errorCode` | Dispute form submission encountered an error. |
| `PAGINATION_PAGE_CHANGED` | `listName`, `pageNumber`, `pageSize` | User navigated to a page in a paginated list. |
| `SYNC_TRIGGERED` | `source` | Admin initiated a manual blockchain sync. |

---

## Usage Example

```typescript
import { track, EVENTS } from '../services/analyticsEvents';

track(EVENTS.PAYMENT_VERIFY_SUCCESS, {
  assetType: 'XLM',
  validationStatus: 'valid',
});
```
