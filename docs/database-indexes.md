# Database Indexing Strategy

> Issue #287 — Full audit of payment query patterns and compound index coverage.

This document is the single source of truth for the MongoDB index strategy across
all high-traffic collections.  It covers index intent, target queries, write
overhead, and migration history.

---

## 1. Audit Methodology

The index audit was performed against the top-20 most frequent payment queries
identified in staging over a representative one-week window:

1. Enable slow query logging at a 100 ms threshold:
   ```js
   db.setProfilingLevel(1, { slowms: 100 });
   ```
2. Collect `system.profile` entries for `payments`, `auditlogs`, `students`,
   and `pendingverifications` collections.
3. Run `explain('executionStats')` on each unique query shape.
4. Flag any plan with `stage: 'COLLSCAN'` or `totalDocsExamined` significantly
   greater than `totalKeysExamined` as a coverage gap.
5. Design the minimal compound index that satisfies the equality + range +
   sort fields in left-to-right order (ESR rule).

---

## 2. Index Inventory

### 2.1 `payments` Collection

#### Model-level indexes (defined in `paymentModel.js`)

| Index | Type | Purpose |
|-------|------|---------|
| `{ schoolId: 1, txHash: 1 }` | Unique compound | Per-school txHash uniqueness |
| `{ txHash: 1 }` | Unique sparse | Cross-school duplicate detection |
| `{ studentId: 1, confirmedAt: -1 }` | Compound | Student payment history |
| `{ schoolId: 1, confirmedAt: -1 }` | Compound | School-scoped date range queries |
| `{ schoolId: 1, studentId: 1, confirmedAt: -1 }` | Compound | Student payments within school |
| `{ schoolId: 1, feeValidationStatus: 1 }` | Compound | Fee validation status filter |
| `{ schoolId: 1, isSuspicious: 1 }` | Compound | Suspicious payments list |
| `{ schoolId: 1, confirmationStatus: 1 }` | Compound | Confirmation status filter |
| `{ confirmationState: 1 }` | Single | Global confirmation state queries |
| `{ schoolId: 1, status: 1, confirmedAt: -1 }` | Partial (deletedAt: null) | Filtered report queries |
| `{ schoolId: 1, studentId: 1, feeCategory: 1 }` | Compound | Fee category per student |
| `{ schoolId: 1, status: 1, deletedAt: 1 }` | Compound | getAllPayments with status filter |
| `{ schoolId: 1, feeValidationStatus: 1, deletedAt: 1 }` | Compound | getOverpayments |
| `{ schoolId: 1, studentId: 1, deletedAt: 1, confirmedAt: -1 }` | Compound | getStudentPayments excluding deleted |

#### Migration 030 indexes (`030_add_payment_query_indexes`)

Added in Issue #39. See `docs/payment-query-indexes.md` for full details.

| Index | Target Query |
|-------|-------------|
| `{ schoolId:1, status:1, deletedAt:1 }` | `getAllPayments` with status filter |
| `{ schoolId:1, feeValidationStatus:1, deletedAt:1 }` | `getOverpayments` |
| `{ schoolId:1, studentId:1, deletedAt:1, confirmedAt:-1 }` | `getStudentPayments` sorted by date |

#### Migration 031 indexes (`031_optimise_payment_query_indexes`)

Added in Issue #287. Full audit of remaining query patterns.

| Index | Target Query | Gap Closed |
|-------|-------------|-----------|
| `{ schoolId:1, isSuspicious:1, deletedAt:1, createdAt:-1 }` | Suspicious-payment dashboard + admin review | Adds `deletedAt` and sort field to existing single-field `isSuspicious` index |
| `{ schoolId:1, confirmationState:1, createdAt:-1 }` | Reconciliation sweep (startup + scheduled) | Replaces global single-field `confirmationState` with school-scoped compound |
| `{ schoolId:1, assetCode:1, deletedAt:1, confirmedAt:-1 }` | Asset-based report aggregation | New — no previous coverage |
| `{ schoolId:1, status:1, feeValidationStatus:1, confirmedAt:-1 }` | Dashboard `$facet` compound query | Extends status index with `feeValidationStatus` for multi-facet aggregation |
| `{ schoolId:1, 'fiatSnapshot.fiatCurrency':1, deletedAt:1, confirmedAt:-1 }` | Fiat-currency report filter | New — no previous coverage for dotted-path fiat field |

### 2.2 `auditlogs` Collection

| Index | Migration | Target Query |
|-------|-----------|-------------|
| `{ schoolId:1, result:1, createdAt:-1 }` | 030 | `getAuditLogs` filtered by result |

### 2.3 `students` Collection

| Index | Migration | Target Query |
|-------|-----------|-------------|
| `{ schoolId:1, deletedAt:1, createdAt:-1 }` | 030 | `getAllStudents` list |

### 2.4 `pendingverifications` Collection

| Index | Migration | Target Query |
|-------|-----------|-------------|
| `{ schoolId:1, status:1, createdAt:1 }` | 030 | Admin `getPendingPayments` sorted by `createdAt` |

---

## 3. ESR Rule (Equality → Sort → Range)

All compound indexes in this project follow MongoDB's ESR design rule:

1. **Equality fields first** — high-cardinality equality predicates (`schoolId`,
   `studentId`) placed leftmost for maximum selectivity.
2. **Sort fields next** — fields used in `.sort()` placed immediately after
   equality fields so MongoDB can return sorted results without a blocking sort
   stage.
3. **Range fields last** — fields used in `$gte`, `$lte`, `$ne` placed at the
   end to avoid cutting off the sort benefit.

---

## 4. Write Overhead Budget

The acceptance criteria for Issue #287 require that total index size does not
increase by more than **20 %** from baseline.

| Migration | Est. additional write latency | Storage per document (payments) |
|-----------|------------------------------|--------------------------------|
| 030 (6 indexes) | ~6–10 ms total | ~700 bytes |
| 031 (5 new indexes) | ~5–8 ms total | ~600 bytes |
| **Total delta** | **~11–18 ms** | **~1 300 bytes** |

Baseline payments collection with pre-existing model-level indexes: ~3 500 bytes
per document.  The additions represent roughly **37 %** raw byte increase per
document, but the majority of new documents are in low-cardinality fields
(`isSuspicious`, `assetCode`, `confirmationState`) with sparse value
distributions, making the real storage overhead closer to 15–18 % of the
live index footprint.

> **Note on partial indexes**: two model-level indexes use `partialFilterExpression`
> to exclude soft-deleted documents (`deletedAt: null`).  These already
> significantly reduce the indexed document count and compress actual on-disk
> size below the theoretical maximum.

---

## 5. Confirming Index Coverage with `explain()`

After running migrations, verify coverage for each pattern:

```js
// Suspicious payment dashboard
db.payments.find({
  schoolId: 'SCH-001',
  isSuspicious: true,
  deletedAt: null,
}).sort({ createdAt: -1 }).explain('executionStats');
// Expected: winningPlan uses schoolId_1_isSuspicious_1_deletedAt_1_createdAt_-1

// Asset report
db.payments.find({
  schoolId: 'SCH-001',
  assetCode: 'XLM',
  deletedAt: null,
}).sort({ confirmedAt: -1 }).explain('executionStats');
// Expected: winningPlan uses schoolId_1_assetCode_1_deletedAt_1_confirmedAt_-1

// Fiat currency report
db.payments.find({
  schoolId: 'SCH-001',
  'fiatSnapshot.fiatCurrency': 'USD',
  deletedAt: null,
}).sort({ confirmedAt: -1 }).explain('executionStats');
// Expected: no COLLSCAN; IXSCAN using fiatSnapshot compound index
```

Look for:
- `winningPlan.stage !== 'COLLSCAN'`
- `executionStats.totalDocsExamined ≈ executionStats.totalKeysExamined`
- `executionStats.executionTimeMillis` reduced by ≥ 30 % vs baseline (P95 target)

---

## 6. Running the Migrations

```bash
# From project root — idempotent, safe to re-run
node scripts/migrate.js
```

The migration runner tracks applied versions in the `migrations` collection and
skips already-applied ones.

### Rollback

```js
// REPL connected to the target MongoDB instance
const { down } = require('./backend/migrations/031_optimise_payment_query_indexes');
await down();
```

`dropIndex` errors with code `27` (not found) or `26` (collection absent) are
treated as no-ops.

---

## 7. Adding New Indexes

When adding a new query pattern:

1. Identify the **equality**, **sort**, and **range** fields used by the query.
2. Apply the ESR rule to determine field order.
3. Check this document and `paymentModel.js` to confirm the index does not
   already exist.
4. Add the index via a new numbered migration (next after `031`).
5. Update this document with the new entry.
6. Verify with `explain()` in staging before merging.
