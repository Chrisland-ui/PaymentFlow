# Pagination and Filtering Reference

This document is the authoritative reference for query parameters and response
metadata on the two primary list endpoints:

- **Audit log** — `GET /api/audit`
- **Payment list** — `GET /api/payments`

It also covers the variant payment list endpoints that share the same pagination
envelope (`GET /api/payments/overpayments`, `/pending`, `/suspicious`) and the
student-scoped payment list (`GET /api/payments/:studentId`), which uses a
slightly different response shape.

All information is derived from the source code in
`backend/src/controllers/auditController.js`,
`backend/src/services/auditService.js`, and
`backend/src/controllers/paymentQueryController.js`, verified against the test
suite in `tests/`.

---

## Table of Contents

1. [Audit Log List](#1-audit-log-list)
   - [Query parameters](#11-query-parameters)
   - [Response envelope](#12-response-envelope)
   - [Sorting](#13-sorting)
   - [Pagination mechanics](#14-pagination-mechanics)
   - [Date filtering semantics](#15-date-filtering-semantics)
   - [Known limitation — page and cursor](#16-known-limitation--page-and-cursor)
   - [Examples](#17-examples)
2. [Payment List](#2-payment-list)
   - [Query parameters](#21-query-parameters)
   - [Response envelope](#22-response-envelope)
   - [Sorting](#23-sorting)
   - [Pagination mechanics](#24-pagination-mechanics)
   - [Date filtering semantics](#25-date-filtering-semantics)
   - [Amount filtering](#26-amount-filtering)
   - [Examples](#27-examples)
3. [Variant Payment Endpoints](#3-variant-payment-endpoints)
4. [Student Payment List](#4-student-payment-list)
5. [Common Error Responses](#5-common-error-responses)
6. [Client Walk-through: Following Next-Page Links](#6-client-walk-through-following-next-page-links)

---

## 1. Audit Log List

```
GET /api/audit
Authorization: Bearer <admin-token>
```

Requires admin authentication. All results are scoped to the school derived from
the request context.

### 1.1 Query Parameters

| Parameter     | Type    | Default | Constraints          | Description |
|---------------|---------|---------|----------------------|-------------|
| `action`      | string  | —       | exact match          | Filter by action type (e.g. `student_create`, `payment_sync`). |
| `targetType`  | string  | —       | `student` \| `payment` \| `fee` \| `school` | Filter by the kind of object the action targeted. |
| `performedBy` | string  | —       | exact match          | Filter by the actor who performed the action (admin identifier). |
| `result`      | string  | —       | `success` \| `failure` | Filter by outcome. |
| `search`      | string  | —       | free-text            | Full-text search over the `details` field. Changes sort order to relevance (see [Sorting](#13-sorting)). |
| `startDate`   | string  | —       | ISO 8601             | Include entries with `createdAt >= startDate`. The time component is taken as-is from the parsed value (see [Date filtering semantics](#15-date-filtering-semantics)). |
| `endDate`     | string  | —       | ISO 8601             | Include entries with `createdAt <= endDate`. Unlike the payment list, **no end-of-day adjustment is applied by the API**. |
| `cursor`      | string  | —       | opaque base64 token  | Cursor-based pagination. Pass the `nextCursor` value from a prior response. Accepted by the API but not yet fully wired — see [Known limitation](#16-known-limitation--page-and-cursor). |
| `page`        | integer | `1`     | ≥ 1                  | Offset-based page number. Accepted and validated but not yet fully wired — see [Known limitation](#16-known-limitation--page-and-cursor). |
| `limit`       | integer | `50`    | 1–200                | Results per page. Values above 200 are clamped to 200. |

### 1.2 Response Envelope

```jsonc
{
  "logs": [
    {
      "_id": "665f1a2b3c4d5e6f7a8b9c0d",
      "schoolId": "SCH001",
      "action": "student_create",
      "performedBy": "admin@example.com",
      "targetId": "STU042",
      "targetType": "student",
      "details": { "name": "Jordan Lee", "class": "6A" },
      "result": "success",
      "errorMessage": null,
      "ipAddress": "203.0.113.10",
      "userAgent": "Mozilla/5.0 ...",
      "prevHash": "e3b0c44298fc1c149afb...",
      "entryHash": "a591a6d40bf420404a01...",
      "archived": false,
      "createdAt": "2026-09-01T08:30:00.000Z",
      "updatedAt": "2026-09-01T08:30:00.000Z"
    }
    // …
  ],
  "total": 347,
  "page": 1,           // see Known limitation §1.6
  "limit": 50,
  "pages": 7,          // ceil(total / limit), minimum 1
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA5LTAxVDA4OjMwOjAwLjAwMFoiLCJfaWQiOiI2NjVmMWEyYjNjNGQ1ZTZmN2E4YjljMGQifQ=="
}
```

Field semantics:

| Field        | Type            | Description |
|--------------|-----------------|-------------|
| `logs`       | array           | Page of matching audit entries, sorted newest first. |
| `total`      | integer         | Total matching records across all pages. |
| `page`       | integer \| undefined | Requested page number. Currently `undefined` in the response due to a known bug — do not rely on this field. |
| `limit`      | integer         | Effective page size after clamping. |
| `pages`      | integer         | Total page count: `ceil(total / limit)`. Minimum value is `1` even when `total` is 0. |
| `nextCursor` | string \| null  | Opaque pagination cursor. `null` when the current page is the last page or the result set is empty. |

### 1.3 Sorting

| Condition             | Sort order |
|-----------------------|------------|
| No `search` parameter | `createdAt DESC` (newest first). Fixed — cannot be overridden. |
| `search` is set       | MongoDB `textScore DESC` (most relevant first). `createdAt` ordering within equal scores is not guaranteed. |

### 1.4 Pagination Mechanics

The API exposes two pagination mechanisms. Due to a known bug (see §1.6),
offset-based pagination via `page` does not currently function. Cursor-based
pagination via `nextCursor` is the stable method.

**Cursor-based (recommended)**

1. Make the first request without a `cursor` parameter.
2. Read `nextCursor` from the response.
3. If `nextCursor` is non-null, include `cursor=<nextCursor>` in the next request
   (keeping all other filters unchanged).
4. Stop when `nextCursor` is `null`.

The cursor is an opaque base64-encoded token. Clients must not parse or
construct it — treat it as an opaque string.

**Page-based (currently non-functional)**

The `page` parameter is accepted and validated but does not advance the query
window. All requests currently return the first page of results. This will be
corrected in a future release. Track issue for the fix alongside the
`_decodeCursor`/`_encodeCursor` implementation in `auditService.js`.

### 1.5 Date Filtering Semantics

Both `startDate` and `endDate` are parsed with `new Date(value)` in the service.
The API does **not** adjust `endDate` to the end of the day — the timestamp is
used exactly as supplied.

| Scenario | Recommended practice |
|---|---|
| Filter a specific calendar day | Send `startDate=2026-09-01T00:00:00.000Z` and `endDate=2026-09-01T23:59:59.999Z`. |
| Filter from midnight UTC | Send `startDate=2026-09-01T00:00:00.000Z`. |
| Filter up to (and including) a day | Send `endDate=2026-09-01T23:59:59.999Z`. |

The frontend (`frontend/src/pages/audit-logs.jsx`) automatically applies
local-time start-of-day for `startDate` and local-time end-of-day (23:59:59.999
in the browser's timezone) for `endDate` before sending the request. If you
call the API directly, perform the same adjustment.

### 1.6 Known Limitation — `page` and Cursor

The `getAuditLogs` service function references `skip` and `actualPage` variables
that are never assigned. As a result:

- `.skip(undefined)` is passed to MongoDB, which treats it as `.skip(0)`.
  Every request returns the first page regardless of the `page` query parameter.
- The `page` field in the response is always `undefined`.

The `_decodeCursor` and `_encodeCursor` helpers exist in the file but are not
called from `getAuditLogs`. The `nextCursor` field is populated correctly for
the page of results that is returned (always the first page), so clients can use
cursor-based traversal to iterate forward through the full result set.

**Safe client strategy until the bug is fixed:** ignore the `page` response
field; use `nextCursor` to advance through pages.

### 1.7 Examples

**Baseline request — first page, default limit**

```http
GET /api/audit HTTP/1.1
Authorization: Bearer <token>
```

```jsonc
// Response 200
{
  "logs": [ /* up to 50 entries */ ],
  "total": 200,
  "page": undefined,   // known bug — always undefined
  "limit": 50,
  "pages": 4,
  "nextCursor": "eyJjcmVh..."
}
```

---

**Filter by action and result**

```http
GET /api/audit?action=student_create&result=failure HTTP/1.1
Authorization: Bearer <token>
```

```jsonc
// Response 200
{
  "logs": [ /* entries where action=student_create AND result=failure */ ],
  "total": 3,
  "limit": 50,
  "pages": 1,
  "nextCursor": null
}
```

---

**Date range — one specific calendar day (UTC)**

```http
GET /api/audit?startDate=2026-09-01T00%3A00%3A00.000Z&endDate=2026-09-01T23%3A59%3A59.999Z HTTP/1.1
Authorization: Bearer <token>
```

The percent-encoded values decode to:
- `startDate` → `2026-09-01T00:00:00.000Z`
- `endDate`   → `2026-09-01T23:59:59.999Z`

The service applies `createdAt >= startDate` and `createdAt <= endDate` with no
further adjustment.

---

**Boundary date — midnight exactly**

Sending `startDate=2026-09-01` (date-only) is parsed by `new Date()` in the
service as `2026-09-01T00:00:00.000Z` in UTC environments. To be unambiguous
across timezones, always include a time and `Z` suffix.

```http
GET /api/audit?startDate=2026-09-01T00%3A00%3A00.000Z HTTP/1.1
```

---

**Invalid `startDate`**

The service calls `new Date(value)` without validation. An invalid string
produces `Invalid Date` (NaN internally) which silently matches nothing rather
than returning an error. Send a well-formed ISO 8601 string to avoid empty
results.

```http
GET /api/audit?startDate=not-a-date HTTP/1.1
// Response 200 — logs: [], total: 0 (no 400 is returned at service level)
```

---

**Invalid `page` parameter**

```http
GET /api/audit?page=abc HTTP/1.1
// Response 400
{
  "error": "page must be a positive integer",
  "code": "VALIDATION_ERROR"
}
```

```http
GET /api/audit?page=0 HTTP/1.1
// Response 400
{
  "error": "page must be a positive integer",
  "code": "VALIDATION_ERROR"
}
```

---

**Invalid `limit` parameter**

```http
GET /api/audit?limit=0 HTTP/1.1
// Response 400
{
  "error": "limit must be a positive integer",
  "code": "VALIDATION_ERROR"
}
```

---

**Limit above maximum is silently clamped to 200**

```http
GET /api/audit?limit=9999 HTTP/1.1
// Response 200 — limit in envelope is 200, not 9999
{
  "limit": 200,
  ...
}
```

---

**Following a cursor**

```http
// Request 1 — first page
GET /api/audit?limit=10 HTTP/1.1

// Response
{
  "logs": [ /* 10 entries */ ],
  "total": 25,
  "limit": 10,
  "pages": 3,
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2..."
}

// Request 2 — next page
GET /api/audit?limit=10&cursor=eyJjcmVhdGVkQXQiOiIyMDI2... HTTP/1.1

// Request 3 — final page (nextCursor is null)
GET /api/audit?limit=10&cursor=<cursor-from-response-2> HTTP/1.1

// Response
{
  "logs": [ /* 5 entries */ ],
  "total": 25,
  "limit": 10,
  "pages": 3,
  "nextCursor": null   // ← stop here
}
```

---

**Empty result set**

When no entries match the filters:

```jsonc
{
  "logs": [],
  "total": 0,
  "limit": 50,
  "pages": 1,    // minimum 1, even when total is 0
  "nextCursor": null
}
```

---

**Full-text search**

```http
GET /api/audit?search=payment+sync+failed HTTP/1.1
```

Sort order switches to relevance (MongoDB `textScore`). The `nextCursor` field
is still returned and usable for traversal.

---

## 2. Payment List

```
GET /api/payments
Authorization: Bearer <school-auth-token>
```

Returns all non-deleted payments for the authenticated school.

### 2.1 Query Parameters

| Parameter     | Type    | Default | Constraints         | Description |
|---------------|---------|---------|---------------------|-------------|
| `page`        | integer | `1`     | ≥ 1 (floor at 1)   | Page number. |
| `limit`       | integer | `50`    | 1–100               | Results per page. Values above 100 are clamped to 100; values below 1 are clamped to 1. |
| `startDate`   | string  | —       | ISO 8601            | Include payments with `confirmedAt >= startDate`. Rejected with 400 if not a valid date string. |
| `endDate`     | string  | —       | ISO 8601            | Include payments with `confirmedAt <= endDate` (adjusted to end of UTC day). Rejected with 400 if not a valid date string. |
| `minAmount`   | number  | —       | finite number       | Include payments with `amount >= minAmount`. |
| `maxAmount`   | number  | —       | finite number       | Include payments with `amount <= maxAmount`. |
| `status`      | string  | —       | any; uppercased     | Filter by payment status. The value is uppercased before querying (e.g., `confirmed` → `CONFIRMED`). |
| `studentId`   | string  | —       | exact match         | Filter to payments for a specific student. |
| `isSuspicious`| string  | —       | `"true"` \| `"false"` | Filter suspicious payments. The value is compared as a string: only the literal string `"true"` sets the flag to `true`. |

### 2.2 Response Envelope

```jsonc
{
  "payments": [
    {
      "_id": "665f1a2b3c4d5e6f7a8b9c0e",
      "schoolId": "SCH001",
      "studentId": "STU042",
      "transactionHash": "abc123def456...",
      "amount": 250.0,
      "asset": "XLM",
      "status": "SUCCESS",
      "confirmedAt": "2026-09-01T10:15:00.000Z",
      "feeValidationStatus": "paid",
      "isSuspicious": false,
      // … other payment fields …
      "stellarExplorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123def456...",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123def456..."
    }
    // …
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 312,
    "totalPages": 7,
    "hasNext": true,
    "hasPrev": false
  }
}
```

Field semantics:

| Field                   | Type    | Description |
|-------------------------|---------|-------------|
| `payments`              | array   | Page of matching payments sorted by `confirmedAt` descending. |
| `pagination.page`       | integer | Current page number (≥ 1). |
| `pagination.limit`      | integer | Effective page size after clamping. |
| `pagination.total`      | integer | Total matching records across all pages. |
| `pagination.totalPages` | integer | `ceil(total / limit)`. |
| `pagination.hasNext`    | boolean | `true` when `page < totalPages`. |
| `pagination.hasPrev`    | boolean | `true` when `page > 1`. |

`stellarExplorerUrl` and `explorerUrl` are always the same value. Both are
`null` when the payment has no `transactionHash` or `txHash`.

Soft-deleted payments (`deletedAt != null`) and payments for deleted students
(`studentDeleted: true`) are always excluded and do not appear in `total`.

### 2.3 Sorting

Always `confirmedAt DESC` (most recently confirmed first). Fixed — cannot be
overridden.

### 2.4 Pagination Mechanics

Standard offset-based pagination. No cursor field is present in the response.

```
skip = (page - 1) * limit
```

To advance:

1. Check `pagination.hasNext`. If `true`, increment `page` by 1 and repeat the
   request with the same filters.
2. Stop when `pagination.hasNext` is `false`.

Alternatively, check `pagination.page < pagination.totalPages`.

### 2.5 Date Filtering Semantics

Both `startDate` and `endDate` are validated with `Date.parse()`. If the value
is not a valid date string, the API returns **400 VALIDATION_ERROR** — unlike
the audit endpoint which silently returns an empty result.

`endDate` is automatically extended to the end of the UTC day:

```
endDate → new Date(endDate).setUTCHours(23, 59, 59, 999)
```

This means that `endDate=2026-09-01` matches all payments confirmed on
2026-09-01 from `00:00:00.000Z` through `23:59:59.999Z`, regardless of whether
you include a time component.

`startDate` is **not** adjusted — the time component is taken as-is. Sending
`startDate=2026-09-01` parses as `2026-09-01T00:00:00.000Z` (midnight UTC), so
a date-only value works correctly for start boundaries.

| Intent                         | Recommended value       | API applies             |
|-------------------------------|--------------------------|-------------------------|
| All of September 2026          | `startDate=2026-09-01`  | `>= 2026-09-01T00:00:00.000Z` |
|                                | `endDate=2026-09-30`    | `<= 2026-09-30T23:59:59.999Z` |
| Single day 2026-09-15          | `startDate=2026-09-15`  | `>= 2026-09-15T00:00:00.000Z` |
|                                | `endDate=2026-09-15`    | `<= 2026-09-15T23:59:59.999Z` |
| Same start and end date        | both set to `2026-09-15`| Inclusive of the whole day |

### 2.6 Amount Filtering

`minAmount` and `maxAmount` are parsed with `Number()`. The API returns
**400 VALIDATION_ERROR** if the value is not a finite number (`Infinity`,
`-Infinity`, and `NaN` are all rejected).

The filters are applied to the stored `amount` field (in the payment's native
asset unit — XLM or USDC).

### 2.7 Examples

**Baseline request — first page**

```http
GET /api/payments HTTP/1.1
Authorization: Bearer <token>
```

```jsonc
// Response 200
{
  "payments": [ /* up to 50 payments */ ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 312,
    "totalPages": 7,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

**Date range — single calendar day**

```http
GET /api/payments?startDate=2026-09-15&endDate=2026-09-15 HTTP/1.1
```

The API expands `endDate` to `2026-09-15T23:59:59.999Z`, so all payments
confirmed on that UTC day are included.

---

**Boundary date — last day of month**

```http
GET /api/payments?startDate=2026-09-01&endDate=2026-09-30 HTTP/1.1
```

Matches `confirmedAt >= 2026-09-01T00:00:00.000Z`
and `confirmedAt <= 2026-09-30T23:59:59.999Z`.

---

**Invalid `startDate`**

```http
GET /api/payments?startDate=01-09-2026 HTTP/1.1

// Response 400
{
  "error": "Invalid startDate",
  "code": "VALIDATION_ERROR"
}
```

---

**Invalid `endDate`**

```http
GET /api/payments?endDate=not-a-date HTTP/1.1

// Response 400
{
  "error": "Invalid endDate",
  "code": "VALIDATION_ERROR"
}
```

---

**Amount filter**

```http
GET /api/payments?minAmount=100&maxAmount=500 HTTP/1.1
// Payments where 100 <= amount <= 500
```

---

**Invalid `minAmount`**

```http
GET /api/payments?minAmount=abc HTTP/1.1

// Response 400
{
  "error": "Invalid minAmount",
  "code": "VALIDATION_ERROR"
}
```

```http
GET /api/payments?minAmount=Infinity HTTP/1.1

// Response 400
{
  "error": "Invalid minAmount",
  "code": "VALIDATION_ERROR"
}
```

---

**Status filter**

```http
GET /api/payments?status=success HTTP/1.1
// Equivalent to querying status=SUCCESS (value is uppercased)
```

---

**`isSuspicious` filter**

```http
GET /api/payments?isSuspicious=true HTTP/1.1   // suspicious only
GET /api/payments?isSuspicious=false HTTP/1.1  // non-suspicious only
GET /api/payments?isSuspicious=1 HTTP/1.1      // treated as false — only "true" matches
GET /api/payments HTTP/1.1                      // both, filter omitted
```

Only the exact string `"true"` sets the filter to `true`. Any other value
(including `"1"`, `"yes"`, `"True"`) is treated as `false`.

---

**Advancing through pages**

```http
// Page 1
GET /api/payments?limit=20 HTTP/1.1
// pagination.hasNext: true, pagination.page: 1

// Page 2
GET /api/payments?limit=20&page=2 HTTP/1.1
// pagination.hasNext: true, pagination.page: 2

// Last page
GET /api/payments?limit=20&page=16 HTTP/1.1
// pagination.hasNext: false — stop here
```

---

**Page beyond last page**

When `page` exceeds `totalPages`, the API returns an empty `payments` array
with the correct `total`.

```jsonc
// GET /api/payments?page=9999
{
  "payments": [],
  "pagination": {
    "page": 9999,
    "limit": 50,
    "total": 312,
    "totalPages": 7,
    "hasNext": false,
    "hasPrev": true
  }
}
```

---

**Empty result set**

```jsonc
{
  "payments": [],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 0,
    "totalPages": 0,
    "hasNext": false,
    "hasPrev": false
  }
}
```

Note: when the result set is empty, `totalPages` is `0` (unlike the audit
endpoint where `pages` is always at least `1`).

---

**Combined filters**

```http
GET /api/payments?status=SUCCESS&startDate=2026-01-01&endDate=2026-03-31&minAmount=50&page=2&limit=25 HTTP/1.1
```

All filters are ANDed together.

---

## 3. Variant Payment Endpoints

The following endpoints share the same pagination mechanics and response
envelope as `GET /api/payments`. The only difference is the implicit filter
applied by each endpoint.

| Endpoint                        | Implicit filter                                      |
|---------------------------------|------------------------------------------------------|
| `GET /api/payments/overpayments`| `feeValidationStatus: "overpaid"`                    |
| `GET /api/payments/pending`     | `confirmationStatus: "pending_confirmation"`         |
| `GET /api/payments/suspicious`  | `isSuspicious: true`                                 |

All three accept `page` and `limit` with the same defaults and clamping
(1–100). None accept additional query filters (date, amount, status, etc.).

Response shape (same `pagination` object as `GET /api/payments`, plus an
endpoint-specific top-level field):

**Overpayments**

```jsonc
{
  "count": 3,             // length of the current page (not total)
  "totalExcess": 47.5,    // sum of excessAmount for this page only
  "overpayments": [ /* payments */ ],
  "pagination": { "page": 1, "limit": 50, "total": 3, "totalPages": 1 }
}
```

**Pending**

```jsonc
{
  "count": 12,
  "pending": [ /* payments */ ],
  "pagination": { "page": 1, "limit": 50, "total": 12, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

**Suspicious**

```jsonc
{
  "count": 5,
  "suspicious": [ /* payments */ ],
  "pagination": { "page": 1, "limit": 50, "total": 5, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

---

## 4. Student Payment List

```
GET /api/payments/:studentId
Authorization: Bearer <school-auth-token>
```

Returns payment history for a specific student. Uses a **different response
shape** from `GET /api/payments` — there is no nested `pagination` object.

**Query parameters:** `page` (default 1) and `limit` (default 50, max 200).

**Response shape:**

```jsonc
{
  "payments": [ /* payment objects */ ],
  "total": 8,
  "page": 1,
  "pages": 1    // ceil(total / limit), no hasNext / hasPrev
}
```

There is no `hasNext` or `hasPrev`. Clients can compute these:

```
hasNext = page < pages
hasPrev = page > 1
```

---

## 5. Common Error Responses

All error responses use the shape `{ "error": "...", "code": "..." }`.

| Scenario | Status | Code | Notes |
|---|---|---|---|
| `page` is non-integer or < 1 | 400 | `VALIDATION_ERROR` | Audit endpoint only; payment endpoint clamps silently. |
| `limit` is non-integer or < 1 | 400 | `VALIDATION_ERROR` | Audit endpoint only; payment endpoint clamps silently. |
| `startDate` is not a valid date | 400 | `VALIDATION_ERROR` | Payment endpoint only; audit endpoint silently matches nothing. |
| `endDate` is not a valid date | 400 | `VALIDATION_ERROR` | Payment endpoint only; audit endpoint silently matches nothing. |
| `minAmount` is non-finite | 400 | `VALIDATION_ERROR` | Payment endpoint only. |
| `maxAmount` is non-finite | 400 | `VALIDATION_ERROR` | Payment endpoint only. |
| No auth token | 401 | `UNAUTHORIZED` | Both endpoints. |
| Valid token but wrong role | 403 | `FORBIDDEN` | Both endpoints. |

### Date validation asymmetry

The two endpoints behave differently for malformed dates:

| Endpoint | Invalid date string | Behaviour |
|---|---|---|
| `GET /api/audit` | `startDate=bad` | `new Date("bad")` → Invalid Date; query matches nothing; 200 with empty `logs`. |
| `GET /api/payments` | `startDate=bad` | `Date.parse("bad")` → NaN; 400 `VALIDATION_ERROR` returned. |

Always send well-formed ISO 8601 strings to both endpoints.

---

## 6. Client Walk-through: Following Next-Page Links

### Payment list (offset pagination)

```javascript
async function fetchAllPayments(filters = {}) {
  const results = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `/api/payments?${new URLSearchParams({ ...filters, page, limit: 100 })}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await response.json();

    results.push(...body.payments);

    if (!body.pagination.hasNext) break;
    page += 1;
  }

  return results;
}
```

### Audit log (cursor pagination)

Because offset-based pagination on the audit endpoint is currently non-functional
(see §1.6), use cursor-based traversal:

```javascript
async function fetchAllAuditLogs(filters = {}) {
  const results = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ ...filters, limit: 200 });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(`/api/audit?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json();

    results.push(...body.logs);
    cursor = body.nextCursor;
  } while (cursor !== null);

  return results;
}
```

Key points:

- Pass all filter parameters on every request — they are not encoded in the cursor.
- Do not modify `nextCursor` before passing it back.
- A `null` `nextCursor` is the only reliable stop signal for the audit endpoint.
  Do not rely on `page` or `pages` for this endpoint until the pagination bug
  is resolved.
