# API Pagination and Filtering Guide

> **x-pagination-guide**: This document is the narrative companion to the OpenAPI spec.
> See `GET /api/docs.json` for the machine-readable spec. The spec links here via the
> `x-pagination-guide` extension on relevant operations.

This guide explains how to use PaymentFlow's pagination and filtering capabilities
together, what the performance implications are, and how to avoid common mistakes
that cause missed or duplicated records.

---

## Table of Contents

- [Overview](#overview)
- [Cursor Pagination Explained](#cursor-pagination-explained)
  - [How cursors work](#how-cursors-work)
  - [Worked example — paginating payments](#worked-example--paginating-payments)
- [Supported Endpoints](#supported-endpoints)
- [Filter Parameters Reference](#filter-parameters-reference)
  - [Payment filters](#payment-filters)
  - [Student filters](#student-filters)
  - [Audit log filters](#audit-log-filters)
- [Combining Filters with Pagination](#combining-filters-with-pagination)
- [Sorting Options](#sorting-options)
- [Performance Notes](#performance-notes)
- [Code Examples](#code-examples)
  - [JavaScript (fetch)](#javascript-fetch)
  - [Python (requests)](#python-requests)
- [Anti-Patterns](#anti-patterns)

---

## Overview

PaymentFlow uses **cursor-based pagination** on all list endpoints. Cursors are
opaque tokens derived from a stable field value (usually `_id` or `confirmedAt`)
that mark your position in the result set. Unlike page-number pagination, cursors
remain correct even when records are inserted or deleted between requests.

Key properties:

- Responses include a `nextCursor` token when more results exist.
- Pass `cursor=<token>` on the next request to continue from where you left off.
- Filters are applied **before** cursor positioning — the cursor always reflects
  the filtered set, not the full collection.
- Default page size is **50 records**. Maximum is **200**.

---

## Cursor Pagination Explained

### How cursors work

A cursor encodes the `_id` (and optionally a secondary sort field) of the last
document returned. The next page query becomes:

```
SELECT * FROM payments
WHERE  <your filters>
  AND  _id > <cursor_id>       -- "after this document"
ORDER BY _id ASC
LIMIT  pageSize
```

This is equivalent to a keyset query and uses the database index directly —
it does **not** skip rows, so performance is consistent regardless of how
deep into the result set you are.

### Worked example — paginating payments

**Goal:** Retrieve all confirmed payments for student `STU001`, 20 at a time.

**Request 1 — first page:**

```
GET /api/payments/STU001?limit=20&status=confirmed
```

**Response 1:**

```json
{
  "data": [
    { "_id": "64a1...", "amount": 250, "status": "confirmed", "confirmedAt": "2026-01-10T09:00:00Z" },
    { "_id": "64a2...", "amount": 250, "status": "confirmed", "confirmedAt": "2026-01-11T10:15:00Z" },
    "... 18 more ..."
  ],
  "pagination": {
    "total": 47,
    "limit": 20,
    "nextCursor": "eyJfaWQiOiI2NGEyLi4uIn0="
  }
}
```

`nextCursor` is a base64-encoded JSON object. You do not need to decode it —
treat it as an opaque string.

**Request 2 — second page:**

```
GET /api/payments/STU001?limit=20&status=confirmed&cursor=eyJfaWQiOiI2NGEyLi4uIn0=
```

**Response 2:**

```json
{
  "data": [ "... 20 more records ..." ],
  "pagination": {
    "total": 47,
    "limit": 20,
    "nextCursor": "eyJfaWQiOiI2NGEzLi4uIn0="
  }
}
```

**Request 3 — final page:**

```
GET /api/payments/STU001?limit=20&status=confirmed&cursor=eyJfaWQiOiI2NGEzLi4uIn0=
```

**Response 3:**

```json
{
  "data": [ "... 7 remaining records ..." ],
  "pagination": {
    "total": 47,
    "limit": 20,
    "nextCursor": null
  }
}
```

`nextCursor: null` means you have retrieved all records matching the filter.

---

## Supported Endpoints

| Endpoint | Cursor pagination | Filters |
|----------|:-----------------:|---------|
| `GET /api/payments/:studentId` | ✓ | `status`, `from`, `to`, `asset`, `limit`, `cursor` |
| `GET /api/payments/pending` | ✓ | `from`, `to`, `limit`, `cursor` |
| `GET /api/payments/overpayments` | ✓ | `from`, `to`, `limit`, `cursor` |
| `GET /api/students` | ✓ | `class`, `search`, `includeDeleted`, `limit`, `cursor` |
| `GET /api/audit` | ✓ | `from`, `to`, `actor`, `action`, `limit`, `cursor` |
| `GET /api/disputes` | ✓ | `status`, `from`, `to`, `limit`, `cursor` |
| `GET /api/reminders` | ✓ | `from`, `to`, `limit`, `cursor` |

---

## Filter Parameters Reference

### Payment filters

| Parameter | Type | Range / Values | Example | Notes |
|-----------|------|----------------|---------|-------|
| `status` | string | `pending` \| `confirmed` \| `failed` \| `overpaid` \| `underpaid` | `status=confirmed` | Single value only |
| `from` | ISO 8601 date-time | Any valid UTC datetime | `from=2026-01-01T00:00:00Z` | Inclusive lower bound on `confirmedAt` |
| `to` | ISO 8601 date-time | Any valid UTC datetime | `to=2026-03-31T23:59:59Z` | Inclusive upper bound on `confirmedAt` |
| `asset` | string | `XLM` \| `USDC` \| any accepted asset code | `asset=USDC` | Case-sensitive |
| `limit` | integer | 1–200, default 50 | `limit=100` | Exceeding 200 returns a 400 |
| `cursor` | string (opaque) | Token from previous `nextCursor` | `cursor=eyJ...` | Do not construct manually |

### Student filters

| Parameter | Type | Range / Values | Example | Notes |
|-----------|------|----------------|---------|-------|
| `class` | string | Any class name | `class=Grade+5` | URL-encode spaces |
| `search` | string | Free text | `search=john` | Matches `name` and `studentId`; case-insensitive prefix |
| `includeDeleted` | boolean | `true` \| `false`, default `false` | `includeDeleted=true` | Admin only |
| `limit` | integer | 1–200, default 50 | `limit=25` | |
| `cursor` | string (opaque) | Token from previous response | `cursor=eyJ...` | |

### Audit log filters

| Parameter | Type | Range / Values | Example | Notes |
|-----------|------|----------------|---------|-------|
| `from` | ISO 8601 date-time | Any valid UTC datetime | `from=2026-01-01T00:00:00Z` | Inclusive lower bound on `createdAt` |
| `to` | ISO 8601 date-time | Any valid UTC datetime | `to=2026-01-31T23:59:59Z` | Inclusive upper bound on `createdAt` |
| `actor` | string | Admin user ID or email | `actor=admin@school.org` | Exact match |
| `action` | string | Event type string | `action=PAYMENT_CONFIRMED` | Exact match; see audit log docs for all event types |
| `limit` | integer | 1–200, default 50 | `limit=50` | |
| `cursor` | string (opaque) | Token from previous response | `cursor=eyJ...` | |

**Date filtering semantics:** `from` and `to` are applied to `confirmedAt` for
payments and `createdAt` for audit log entries. Both bounds are inclusive. If
you supply only `from`, results extend to the present. If you supply only `to`,
results start from the beginning of the collection.

---

## Combining Filters with Pagination

Filters are part of the cursor's context. The cursor returned on page 1 already
encodes which filters were active. **Always pass the same filter parameters on
every page of a paginated request.** Changing filters mid-pagination produces
undefined behaviour and may skip or duplicate records.

Example — correct multi-page iteration with filters:

```
Page 1: GET /api/audit?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z&action=PAYMENT_CONFIRMED&limit=50
Page 2: GET /api/audit?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z&action=PAYMENT_CONFIRMED&limit=50&cursor=<token>
Page 3: GET /api/audit?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z&action=PAYMENT_CONFIRMED&limit=50&cursor=<token>
```

---

## Sorting Options

Most list endpoints default to ascending `_id` order (effectively insertion
order). Endpoints that support explicit sort parameters document them in the
OpenAPI spec.

| Endpoint | Default sort | Sort options |
|----------|-------------|--------------|
| `GET /api/payments/:studentId` | `confirmedAt ASC` | `sort=confirmedAt&order=desc` |
| `GET /api/audit` | `createdAt DESC` | Not configurable |
| `GET /api/students` | `_id ASC` | `sort=name&order=asc` |
| `GET /api/payments/overpayments` | `confirmedAt DESC` | Not configurable |

When sorting by a non-unique field (e.g. `confirmedAt`), the cursor also encodes
`_id` as a tiebreaker to ensure stable pagination even when multiple records
share the same sort value.

---

## Performance Notes

1. **Always filter before paginating.** Unfiltered pagination over large
   collections (`GET /api/audit?limit=200` with no date filter) performs a full
   collection scan. Apply a `from`/`to` date range whenever possible —
   these fields are indexed and will use an index range scan.

2. **Avoid deep pagination without filters.** Fetching page 500 of an unfiltered
   result set is expensive even with cursors. If you need to process the full
   collection, use a narrow date range window per batch (e.g. one day at a time).

3. **Use the `total` field for display only, not logic.** `total` is an
   approximate count on large collections. Do not use it to predict when
   `nextCursor` will be null — always loop until `nextCursor` is null.

4. **Limit size vs. latency trade-off.** A `limit=200` request transfers more
   data per round-trip but reduces the number of requests. For real-time UIs,
   `limit=50` provides a good balance. For bulk export scripts, `limit=200` is
   preferred.

5. **Date-range indexes.** The compound indexes on `(schoolId, confirmedAt)` and
   `(schoolId, createdAt)` are used by `from`/`to` filters. Queries without a
   `from`/`to` range do a full schoolId scan. See
   [`docs/payment-query-indexes.md`](payment-query-indexes.md) for index details.

---

## Code Examples

### JavaScript (fetch)

```javascript
/**
 * Fetch all confirmed payments for a student within a date range.
 * Uses cursor pagination to handle arbitrarily large result sets.
 */
async function fetchAllConfirmedPayments(studentId, from, to, token) {
  const baseUrl = `https://api.example.com/api/payments/${studentId}`;
  const params = new URLSearchParams({
    status: 'confirmed',
    from,
    to,
    limit: '100',
  });

  const allPayments = [];
  let cursor = null;

  do {
    if (cursor) {
      params.set('cursor', cursor);
    } else {
      params.delete('cursor');
    }

    const response = await fetch(`${baseUrl}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`);
    }

    const { data, pagination } = await response.json();
    allPayments.push(...data);
    cursor = pagination.nextCursor;

  } while (cursor !== null);

  return allPayments;
}

// Usage:
const payments = await fetchAllConfirmedPayments(
  'STU001',
  '2026-01-01T00:00:00Z',
  '2026-12-31T23:59:59Z',
  myJwtToken
);
console.log(`Fetched ${payments.length} confirmed payments`);
```

```javascript
/**
 * Iterate audit log entries one page at a time (streaming pattern).
 * Useful when the full result set is too large to hold in memory.
 */
async function* streamAuditLog(from, to, action, token) {
  const baseUrl = 'https://api.example.com/api/audit';
  let cursor = null;

  do {
    const params = new URLSearchParams({ from, to, action, limit: '100' });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(`${baseUrl}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { data, pagination } = await response.json();

    for (const entry of data) {
      yield entry;
    }

    cursor = pagination.nextCursor;
  } while (cursor !== null);
}

// Usage:
for await (const entry of streamAuditLog(
  '2026-01-01T00:00:00Z',
  '2026-01-31T23:59:59Z',
  'PAYMENT_CONFIRMED',
  myJwtToken
)) {
  console.log(entry.actor, entry.createdAt);
}
```

### Python (requests)

```python
import requests
from typing import Generator, Any

def fetch_all_payments(
    student_id: str,
    from_date: str,
    to_date: str,
    status: str,
    token: str,
    base_url: str = "https://api.example.com",
) -> list[dict]:
    """
    Fetch all payments for a student within a date range.
    Handles cursor pagination automatically.
    """
    url = f"{base_url}/api/payments/{student_id}"
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "status": status,
        "from": from_date,
        "to": to_date,
        "limit": 100,
    }

    all_payments = []
    cursor = None

    while True:
        if cursor:
            params["cursor"] = cursor
        elif "cursor" in params:
            del params["cursor"]

        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()

        body = response.json()
        all_payments.extend(body["data"])

        cursor = body["pagination"].get("nextCursor")
        if not cursor:
            break

    return all_payments


def stream_audit_log(
    from_date: str,
    to_date: str,
    action: str,
    token: str,
    base_url: str = "https://api.example.com",
) -> Generator[dict[str, Any], None, None]:
    """
    Generator that yields audit log entries one at a time.
    Memory-efficient for large result sets.
    """
    url = f"{base_url}/api/audit"
    headers = {"Authorization": f"Bearer {token}"}
    params = {"from": from_date, "to": to_date, "action": action, "limit": 100}
    cursor = None

    while True:
        if cursor:
            params["cursor"] = cursor
        elif "cursor" in params:
            del params["cursor"]

        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        body = response.json()

        for entry in body["data"]:
            yield entry

        cursor = body["pagination"].get("nextCursor")
        if not cursor:
            break


# Usage example:
payments = fetch_all_payments(
    student_id="STU001",
    from_date="2026-01-01T00:00:00Z",
    to_date="2026-12-31T23:59:59Z",
    status="confirmed",
    token=MY_JWT_TOKEN,
)
print(f"Fetched {len(payments)} confirmed payments")
```

---

## Anti-Patterns

### 1. Fetching all records without a filter

**Wrong:**

```javascript
// Fetches every payment in the system — expensive full-collection scan
async function getAllPayments(token) {
  const all = [];
  let cursor = null;
  do {
    const params = cursor ? `?cursor=${cursor}` : '';
    const { data, pagination } = await fetch(`/api/payments/all${params}`, { ... }).then(r => r.json());
    all.push(...data);
    cursor = pagination.nextCursor;
  } while (cursor);
  return all;
}
```

**Why it's a problem:** No date filter means a full index scan across all school
records. On a school with thousands of transactions, this will be slow and
puts unnecessary load on the database.

**Right:** Always apply at least a date range:

```javascript
// Narrow the window — one month at a time
const params = new URLSearchParams({
  from: '2026-01-01T00:00:00Z',
  to: '2026-01-31T23:59:59Z',
  limit: '100',
});
```

---

### 2. Changing filter parameters between pages

**Wrong:**

```javascript
// Page 1: status=confirmed
const page1 = await fetch('/api/payments/STU001?status=confirmed&limit=20');
const { pagination } = await page1.json();

// Page 2: status changed to pending — now uses the confirmed cursor with a pending filter
const page2 = await fetch(`/api/payments/STU001?status=pending&limit=20&cursor=${pagination.nextCursor}`);
```

**Why it's a problem:** The cursor was generated for the `confirmed` filter.
Applying it with a different filter skips records or returns unexpected results.

**Right:** Keep all filter parameters identical across pages.

---

### 3. Using `total` to detect the last page

**Wrong:**

```javascript
let page = 1;
let fetched = 0;
while (fetched < total) {  // ❌ total is approximate and changes as records are added
  const result = await fetchPage(page++);
  fetched += result.data.length;
  total = result.pagination.total;
}
```

**Why it's a problem:** `total` is an estimate on large collections (MongoDB's
`estimatedDocumentCount` is used when no filter is present). New records can be
added between pages, making `total` stale. The loop condition can become
incorrect.

**Right:** Use `nextCursor` as the termination condition:

```javascript
let cursor = null;
do {
  const { data, pagination } = await fetchPage(cursor);
  processBatch(data);
  cursor = pagination.nextCursor;
} while (cursor !== null);  // ✓ definitive — null means no more records
```

---

### 4. Re-fetching from page 1 to detect new records

**Wrong:**

```javascript
// Polling loop that always restarts from the beginning
setInterval(async () => {
  const all = await fetchAllFromStart();  // ❌ re-scans the whole collection
  updateUI(all);
}, 5000);
```

**Why it's a problem:** Restarting from page 1 on every poll performs a full
scan and returns duplicates that you must de-duplicate client-side.

**Right:** Use the Server-Sent Events endpoint for real-time updates:

```javascript
const es = new EventSource('/api/payments/stream', {
  headers: { Authorization: `Bearer ${token}` },
});
es.onmessage = (event) => {
  const payment = JSON.parse(event.data);
  appendToUI(payment);  // ✓ push-based, no polling overhead
};
```

See [`docs/stellar-integration.md`](stellar-integration.md) for SSE details.

---

### 5. Constructing cursor tokens manually

**Wrong:**

```javascript
// Manually encoding a MongoDB ObjectId as a cursor
const cursor = btoa(JSON.stringify({ _id: lastId }));  // ❌ format may change
```

**Why it's a problem:** The cursor format is internal and may change between
API versions without notice. Manually constructed cursors may stop working or
return incorrect results after an API update.

**Right:** Only use cursor tokens returned in `pagination.nextCursor`. Treat
them as opaque blobs — do not decode, inspect, or construct them.

---

*For the complete parameter list with JSON Schema types, see the OpenAPI spec
at `GET /api/docs.json`. The spec includes the `x-pagination-guide` extension
on pagination-enabled operations linking back to this document.*
