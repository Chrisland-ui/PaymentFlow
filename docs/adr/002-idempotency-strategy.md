# ADR-002: Idempotency Strategy for Payment Verification

**Status:** Accepted
**Date:** 2024-02-10
**Authors:** PaymentFlow Core Team

---

## Context

Payment verification in StellarEduPay follows an at-least-once delivery model: the transaction poller, the retry service, and the API endpoint `POST /api/payments/verify` can all trigger verification of the same `txHash` concurrently or repeatedly. Without explicit idempotency controls:

- The same Stellar transaction could be recorded as two separate `Payment` documents (double credit).
- A student could have their fee marked paid twice, corrupting their balance.
- Concurrent retries under load could race each other and produce inconsistent state.

These are financial correctness bugs — incorrect balances that erode trust and require manual correction.

### Requirements

1. Verifying the same `txHash` twice in any order must produce the same final state (exactly-once semantics for the student's balance).
2. The idempotency guarantee must survive backend restarts.
3. The guarantee must hold under concurrent requests (race condition safety).
4. The mechanism must not introduce unbounded storage growth.
5. The mechanism must compose with the payment retry queue (BullMQ / MongoDB retry backend).

### Alternatives Evaluated

| Approach | Atomicity | Persistence | Complexity | Verdict |
|----------|-----------|-------------|------------|---------|
| **Compound unique index `{ schoolId, txHash }`** | Database-enforced | Yes | Low | **Primary guard — chosen** |
| Application-level `if exists, skip` check | Race condition vulnerable | Yes | Low | Insufficient alone |
| Distributed lock (Redis `SET NX`)| Strong (during lock hold) | No (TTL) | Medium | Used as secondary guard for concurrent requests |
| Idempotency key collection with TTL | Yes, explicit | Yes (TTL) | Medium | **Secondary mechanism — chosen** |
| Event sourcing / CQRS | Yes | Yes | High | Over-engineered for current scale |

### Chosen Approach: Layered Idempotency

**Layer 1 — Database unique index:**
A compound unique index `{ schoolId: 1, txHash: 1 }` on the `payments` collection means MongoDB will reject any duplicate insertion at the storage level. This is the ground truth: even if application code has a bug, the database enforces exactly-once semantics.

**Layer 2 — Idempotency key with TTL:**
Before processing any transaction, the verification pipeline checks the `idempotencyKeys` collection for a record keyed by `txHash`. If found, the request is a duplicate and returns the previously recorded result immediately (without re-running the verification logic). Each key has a TTL index (`expiresAt`, default 24h) to prevent unbounded growth. See `backend/src/models/idempotencyKeyModel.js`.

**Layer 3 — Distributed lock (Redis `SET NX`):**
For concurrent requests against the same `txHash`, a Redis lock (`SET txHash:lock 1 NX EX 30`) serializes them. The second requester waits and then hits Layer 1 or Layer 2 on release. If Redis is unavailable, the lock is skipped and MongoDB's unique index provides the safety net. See `backend/src/services/distributedLock.js`.

## Decision

Implement a **three-layer idempotency strategy**:

1. MongoDB compound unique index `{ schoolId, txHash }` as the persistence-level guard.
2. `idempotencyKeys` collection with TTL as the application-level deduplication cache.
3. Redis distributed lock as the concurrency-level serializer.

The MongoDB index is the only strictly required layer. The other two layers are performance optimizations that prevent unnecessary re-processing and reduce lock contention at the database level.

## Consequences

**Positive:**
- Double-payment is structurally impossible — the database will reject the second insert even if application code is buggy.
- Retries are safe; the queue can safely re-process any job without fear of double-crediting.
- Partial failures (server crash after writing to payments but before updating student balance) are detected on retry by the unique-index rejection, and the student balance update is re-applied idempotently.

**Negative:**
- Idempotency keys must be explicitly managed. If the TTL is too short, a delayed legitimate retry may be incorrectly rejected as a duplicate. Current TTL is 24h — sufficient for the retry window (`RETRY_MAX_ATTEMPTS` × `RETRY_INTERVAL_MS`).
- Distributed lock requires Redis. If Redis is unavailable, serialization is lost (but database-level safety is maintained).
- Migration 003 (`add_idempotency_key_ttl_index.js`) must be applied before deploying. Production deployments without it will accumulate stale keys indefinitely.

**Constraints imposed on callers:**
- Every call to `verifyPayment()` must supply a `txHash` — this is the idempotency key.
- Callers must not generate a synthetic `txHash` for non-blockchain events.

---

## References

- Idempotency key model: [`backend/src/models/idempotencyKeyModel.js`](../../backend/src/models/idempotencyKeyModel.js)
- Distributed lock service: [`backend/src/services/distributedLock.js`](../../backend/src/services/distributedLock.js)
- Idempotency TTL migration: [`backend/migrations/003_add_idempotency_key_ttl_index.js`](../../backend/migrations/003_add_idempotency_key_ttl_index.js)
- Design doc: [`docs/idempotency-payment-verification.md`](../idempotency-payment-verification.md)
