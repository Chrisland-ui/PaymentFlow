# ADR-002: Timeout and Retry Semantics for Payment Verification

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2024-03-01 |
| **Review date** | 2027-03-01 |
| **Authors** | Payment Platform Team |
| **Code references** | `backend/src/services/retryService.js`, `backend/src/queue/transactionRetryQueue.js`, `backend/src/services/retryServiceSelector.js`, `backend/src/services/retryContract.js`, `docs/retry-backends.md` |

---

## Context

After a payment is detected on the Stellar blockchain, the backend must verify
it: check the amount, validate the memo against a student, record the result,
and fire webhooks. The verification calls Horizon and performs database writes.

Several failure modes can interrupt this:

- **Transient Horizon errors** — 429 rate-limit, 503 unavailable, network timeout
- **Transient database errors** — temporary MongoDB write failures
- **Application errors** — bugs introduced by deployment; should not permanently
  fail valid payments
- **Permanent errors** — `DUPLICATE_TX` (already recorded), `MISSING_MEMO`
  (transaction cannot be matched) — retrying cannot change the outcome

The system must:
1. Not lose a payment that could eventually be verified.
2. Not double-record a payment that was already verified.
3. Not retry permanently-failed verifications indefinitely.
4. Scale retry coordination across multiple backend replicas without double-processing.

---

## Decision

**Use two retry backends with a shared error classification contract:**

1. **BullMQ (Redis-backed)** when `REDIS_HOST` is configured — required for
   multi-replica deployments.
2. **MongoDB-backed `retryService`** when `REDIS_HOST` is unset — single-replica
   development/staging fallback only.

**Retry schedule (BullMQ):** exponential backoff with ±20% jitter, starting at
60 seconds, capped at 60 minutes, up to 10 attempts.

**Retry schedule (MongoDB backend / webhook retries):** fixed delays of
1 minute → 5 minutes → 15 minutes (3 attempts).

**Error classification** (`retryContract.js`):
- `PERMANENT_ERROR_CODES` (e.g. `DUPLICATE_TX`, `MISSING_MEMO`) → never retry,
  route directly to dead-letter.
- `TRANSIENT_ERROR_CODES` + transient message patterns (network errors, 5xx,
  429) → retry with backoff.
- Unknown errors → retry until max attempts, then dead-letter.

---

## Alternatives considered

### 1. No retry — fail permanently on first error

**Rejected.** Transient Horizon outages (which occur) would permanently lose
payments. The Stellar blockchain is the source of truth; a payment that is
on-chain must eventually be recorded in MongoDB.

### 2. Unlimited retries with no dead-letter queue

**Rejected.** Permanently-failed jobs (e.g. `MISSING_MEMO` where the student
doesn't exist) would retry forever, consuming resources and masking operational
problems. A dead-letter queue provides visibility and a controlled path for
manual intervention.

### 3. Single retry backend (BullMQ only, require Redis)

**Rejected.** Requiring Redis in development creates environment friction.
The MongoDB fallback enables local development and single-instance staging
without a Redis dependency. The trade-off (no cross-replica coordination) is
documented and enforced with a startup warning.

### 4. Single retry backend (MongoDB only)

**Rejected.** MongoDB polling cannot safely coordinate across replicas without
distributed locking overhead. BullMQ provides atomic job claiming via Redis,
which is the correct primitive for multi-replica queue processing.

### 5. Synchronous retry (in-request retry loop)

**Rejected.** Blocking the HTTP response until Horizon recovers would cause
request timeouts and degrade the API. Durable out-of-process retry is required.

---

## Consequences

**Positive:**
- Transient failures (Horizon outages, network blips) are recovered automatically
  without operator intervention.
- Permanent failures are isolated in the dead-letter queue, visible at
  `GET /api/admin/retry-queue`, and can be re-driven after root-cause fix.
- Jitter prevents thundering-herd re-verification after a bulk outage.
- The shared `retryContract.js` means error classification is identical across
  both backends, so a job classified as transient in development (MongoDB) is
  also transient in production (BullMQ).

**Negative:**
- At-least-once delivery: a payment may be processed more than once if a
  BullMQ job is acknowledged before the database write completes. Idempotency
  keys (`idempotencyKeyModel.js`) prevent double-recording.
- Redis is a required production dependency. Redis unavailability degrades the
  retry backend to MongoDB (if configured), or halts retries entirely.
- Dead-letter jobs require manual operator intervention
  (see `docs/runbooks/stuck-payments.md`).

**Configuration reference:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `REDIS_HOST` | — | Enables BullMQ backend when set |
| `MAX_RETRY_ATTEMPTS` | `10` | Max BullMQ retry attempts |
| `INITIAL_RETRY_DELAY_MS` | `60000` | Base backoff (1 min) |
| `MAX_RETRY_DELAY_MS` | `3600000` | Backoff cap (60 min) |
| `RETRY_BACKOFF_MULTIPLIER` | `2` | Exponential multiplier |
| `RETRY_JITTER_RATIO` | `0.2` | ±20% jitter |
| `RETRY_MAX_ATTEMPTS` | `10` | MongoDB backend max attempts |
| `RETRY_INTERVAL_MS` | `60000` | MongoDB backend poll interval |

---

## Review criteria

Revisit this ADR if:
- The dead-letter queue consistently exceeds 200 jobs (alert threshold in
  `monitoring/alerts/queue_backpressure.yml`).
- A new failure mode is identified that is not covered by the current
  `PERMANENT_ERROR_CODES` / `TRANSIENT_ERROR_CODES` classification.
- BullMQ is deprecated or a significantly better queue library emerges.
- Redis is replaced as the caching/queue layer (would require a new backend).
