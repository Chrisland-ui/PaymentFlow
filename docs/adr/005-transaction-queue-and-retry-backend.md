# ADR-005: Transaction Queue and Retry Backend Selection

**Status:** Accepted
**Date:** 2024-05-08
**Authors:** PaymentFlow Core Team

---

## Context

When a Stellar transaction is detected by the polling service, it must be handed off to a durable processing queue. The queue must:

1. Guarantee at-least-once delivery (no payment is silently dropped on backend restart or crash).
2. Support exponential backoff retries — a transient Horizon API error should not permanently fail a valid payment.
3. Support concurrency limits — multiple workers processing different transactions in parallel, without duplicate processing.
4. Be operable in resource-constrained environments (single-node Docker Compose on a $20/month VPS, as well as Kubernetes clusters).

Additionally, the queue subsystem should not be a hard dependency that blocks startup if the backing service is unavailable: if a school is running StellarEduPay on a small server without Redis, the system should degrade gracefully rather than fail to start.

### Queue System Alternatives Evaluated

| Option | Durability | Backoff | Concurrency | External dependency | Verdict |
|--------|-----------|---------|-------------|---------------------|---------|
| **BullMQ + Redis** | Yes (Redis AOF/RDB) | Yes (built-in) | Yes (worker concurrency config) | Redis 7 | **Primary — chosen** |
| In-memory queue (Node.js EventEmitter) | No (lost on restart) | Manual | Single-process only | None | Insufficient |
| RabbitMQ | Yes | Yes (dead-letter queues) | Yes | RabbitMQ server | Too heavy; harder to operate than Redis |
| Apache Kafka | Yes | Manual | Yes | Kafka cluster | Overkill for current message volume |
| AWS SQS | Yes | Yes | Yes | AWS account | Vendor lock-in; offline dev requires mocks |
| MongoDB-based retry collection | Yes | Manual | Per-document locking | MongoDB (already required) | Good fallback; no extra dependency |

### Fallback Strategy

Since Redis is an additional operational dependency, a **MongoDB-based fallback retry backend** was built as a parallel implementation. The system detects at startup whether Redis is available and selects the appropriate backend via `retryServiceSelector.js`. Both backends implement the same `retryContract.js` interface, so the calling code is unaffected by which backend is active.

This allows:
- Development/small deployments: run without Redis, use MongoDB retry backend.
- Production: use BullMQ + Redis for better performance and visibility.

### BullMQ vs Bull (v3)

BullMQ is the modern successor to Bull. Key differences that drove the choice:

- BullMQ uses Redis Streams internally (better performance and ordering guarantees than Bull's RPOPLPUSH pattern).
- BullMQ has first-class TypeScript support and active maintenance.
- BullMQ supports job grouping and rate limiting natively (used in `horizonPollBudget.js`).

## Decision

Use **BullMQ + Redis 7** as the primary transaction processing queue, with a **MongoDB-based retry backend** as an automatic fallback when Redis is unavailable.

The selection logic lives in `backend/src/services/retryServiceSelector.js` and is transparent to callers.

### Queue Configuration

| Parameter | Default | Environment Variable |
|-----------|---------|---------------------|
| Redis host | — | `REDIS_HOST` |
| Redis port | 6379 | `REDIS_PORT` |
| Max retry attempts | 10 | `RETRY_MAX_ATTEMPTS` |
| Retry interval | 60000 ms | `RETRY_INTERVAL_MS` |
| Transaction queue concurrency | 5 | (hardcoded in queue config) |

When `REDIS_HOST` is not set, the MongoDB retry backend activates automatically. A startup log line identifies which backend is in use:
```
info: Using BullMQ retry backend (Redis connected)
info: Using MongoDB retry backend (Redis not configured)
```

## Consequences

**Positive:**
- Payments are durable — a backend restart during processing re-processes the queued job rather than losing it.
- Exponential backoff prevents hammering the Horizon API during transient outages.
- The fallback strategy removes Redis as a hard deployment requirement.
- BullMQ's dashboard (Bull Board) can be added for queue visibility without code changes.

**Negative:**
- Rate-limit counters are in-process only when Redis is absent — they reset on restart. This means per-IP rate limiting is weaker without Redis.
- Two retry backend implementations must be kept in sync with the `retryContract.js` interface. A contract test (`backend/tests/retryBackendContract.test.js`) enforces this.
- BullMQ 5.x has breaking changes from BullMQ 4.x — upgrades require testing the queue serialization format.

**Operational notes:**
- Redis AOF persistence (`appendonly yes`) is strongly recommended in production to prevent queue loss on Redis restart.
- The Docker Compose Redis service uses default config (no AOF). Enable it by mounting a custom `redis.conf` for production deployments.
- Monitor `bullmq_queue_waiting_total` Prometheus metric. Alert threshold: > 50 (warn), > 200 (crit) — see `monitoring/alerts/queue_backpressure.yml`.

---

## References

- Retry service selector: [`backend/src/services/retryServiceSelector.js`](../../backend/src/services/retryServiceSelector.js)
- BullMQ retry service: [`backend/src/services/bullMQRetryService.js`](../../backend/src/services/bullMQRetryService.js)
- MongoDB retry service: [`backend/src/services/retryService.js`](../../backend/src/services/retryService.js)
- Retry contract interface: [`backend/src/services/retryContract.js`](../../backend/src/services/retryContract.js)
- Transaction queue: [`backend/src/queue/transactionQueue.js`](../../backend/src/queue/transactionQueue.js)
- Retry backends doc: [`docs/retry-backends.md`](../retry-backends.md)
- Redis dependency doc: [`docs/redis-dependency.md`](../redis-dependency.md)
