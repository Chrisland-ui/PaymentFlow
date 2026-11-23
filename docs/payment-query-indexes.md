# Payment Query Indexes

> Added by migration `030_add_payment_query_indexes` (Issue #39).

## Overview

Filtering, sorting, and date-range queries on the `payments`, `auditlogs`,
`students`, and `pendingverifications` collections can degrade as payment
volume grows. This document profiles the most common query patterns, lists the
compound indexes added to serve them, estimates write overhead, and documents
migration and rollback paths.

---

## Added Indexes

### `payments` collection

| Index | Target query | Replaces / extends |
|-------|-------------|-------------------|
| `{ schoolId:1, status:1, deletedAt:1 }` | `getAllPayments` filtered by status | New — extends the partial index `{ schoolId, status, confirmedAt }` to include `deletedAt` so the `deletedAt: null` filter is resolved within the index |
| `{ schoolId:1, feeValidationStatus:1, deletedAt:1 }` | `getOverpayments` | Extends the existing `{ schoolId, feeValidationStatus }` single-field index; removes the post-index `deletedAt` filter step |
| `{ schoolId:1, studentId:1, deletedAt:1, confirmedAt:-1 }` | `getStudentPayments` sorted by `confirmedAt`, excluding soft-deleted | Supersedes `{ schoolId, studentId, confirmedAt }` for queries that include `deletedAt: null` |

### `auditlogs` collection

| Index | Target query | Notes |
|-------|-------------|-------|
| `{ schoolId:1, result:1, createdAt:-1 }` | `getAuditLogs` filtered by `result` | Companion to the existing `action`, `performedBy`, and `targetType` compound indexes |

### `students` collection

| Index | Target query | Notes |
|-------|-------------|-------|
| `{ schoolId:1, deletedAt:1, createdAt:-1 }` | `getAllStudents` list (not deleted, sorted by `createdAt`) | Allows a single index scan instead of filtering `deletedAt` after a range scan |

### `pendingverifications` collection

| Index | Target query | Notes |
|-------|-------------|-------|
| `{ schoolId:1, status:1, createdAt:1 }` | Admin `getPendingPayments` endpoint sorted by `createdAt` | Complements the existing `{ schoolId, status, nextRetryAt }` (retry worker) index |

---

## Write Overhead Analysis

Each additional index adds approximately **1–5 ms write latency** per document
and roughly **100–500 bytes storage** per document, depending on field
cardinality.

| Index | Est. additional write latency | Storage per document |
|-------|------------------------------|----------------------|
| `payments: (schoolId, status, deletedAt)` | ~2 ms | ~150 bytes |
| `payments: (schoolId, feeValidationStatus, deletedAt)` | ~2 ms | ~150 bytes |
| `payments: (schoolId, studentId, deletedAt, confirmedAt)` | ~2 ms | ~200 bytes |
| `auditlogs: (schoolId, result, createdAt)` | ~1 ms | ~120 bytes |
| `students: (schoolId, deletedAt, createdAt)` | ~1 ms | ~120 bytes |
| `pendingverifications: (schoolId, status, createdAt)` | ~1 ms | ~120 bytes |

**Why overhead is low:**

- Payment writes are infrequent relative to reads (one record per on-chain
  transaction).
- All new indexes are non-unique — no uniqueness-check overhead per write.
- `deletedAt` is a sparse field (`null` for active records) with very low
  cardinality, so index entries stay compact.
- Audit log writes happen at most once per user action; the extra 1 ms is
  immaterial compared to the network round-trip.

---

## Migration

Run the migration runner from the project root:

```bash
node scripts/migrate.js
```

The runner is **idempotent** — it tracks applied migrations in the
`migrations` collection and skips any that have already run. It is safe to
execute repeatedly.

### Rollback

Each migration file exports a `down()` function that drops the indexes it
created. To roll back migration 030 manually:

```javascript
// From a Node.js REPL connected to your MongoDB instance:
const { down } = require('./backend/migrations/030_add_payment_query_indexes');
await down();
```

`dropIndex` errors with code `27` (index not found) or `26` (collection does
not exist) are treated as no-ops and will not abort the rollback.

---

## Verification with Explain Plans

To verify that a query uses the new index, run an explain plan in the MongoDB
shell. Example for `getStudentPayments`:

```javascript
db.payments.find({
  schoolId: 'SCH-001',
  studentId: 'STU001',
  deletedAt: null,
}).sort({ confirmedAt: -1 }).explain('executionStats');
```

Look for `winningPlan.inputStage.indexName` containing `schoolId_1_studentId_1_deletedAt_1_confirmedAt_-1`
and `executionStats.totalDocsExamined` being equal to (or close to)
`totalKeysExamined` — this indicates an efficient covered scan with no
collection-level document fetch beyond what is needed.
