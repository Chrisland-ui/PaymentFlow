# Redis Dependency Health and Degradation Policy

This document defines the health check contracts, probe timeouts, degradation policies, readiness semantics, and Prometheus metrics for Redis-dependent components in PaymentFlow.

---

## 1. Overview & Architectural Guiding Principles

PaymentFlow uses Redis for distributed caching and asynchronous queue processing (e.g., BullMQ transaction verification retry and report generation). However, external cache/queue outages should result in controlled, safe degradation rather than unexpected request failures or silent data loss.

### Core Policies:
1. **Readiness Reflects Required Dependencies**: When Redis is marked as required via `REDIS_REQUIRED=true`, the readiness probe (`/health/ready`) and health check (`/health`) will mark the service as unready/unhealthy (HTTP 503) if Redis is unavailable or failing probes. When Redis is optional (`REDIS_REQUIRED=false`), Redis outages degrade the service gracefully without failing Kubernetes readiness probes.
2. **Safe Cache Degradation**: Read and write paths to the cache degrade to local in-memory storage (`NodeCache`) when Redis is unreachable or times out, preventing user-facing HTTP 500 errors.
3. **Actionable Errors on Queue Mutations**: If an asynchronous mutation requires Redis/BullMQ (e.g. async report generation) and the queue is unavailable, the API returns a structured, actionable error (HTTP 503 with code `QUEUE_UNAVAILABLE` and retry recommendations).
4. **Metrics Distinguish Outage from Miss**: Prometheus metrics explicitly separate normal cache misses (when a key simply does not exist) from dependency outages (when Redis is down, unreachable, or times out).

---

## 2. Configuration & Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `REDIS_HOST` | *(unset)* | Redis server hostname. If unset, Redis is disabled. |
| `REDIS_PORT` | `6379` | Redis server port. |
| `REDIS_REQUIRED` | `false` | When set to `'true'`, Redis is treated as a mandatory readiness dependency. |
| `REDIS_CHECK_TIMEOUT_MS`| `2000` | Timeout in milliseconds for Redis `PING` health probes. |
| `REDIS_CACHE_TIMEOUT_MS`| `1000` | Bounded read timeout for Redis cache gets before degrading to memory. |

---

## 3. Health Checks and Readiness Semantics

### `/health/ready` (Kubernetes Readiness Probe)
The readiness probe ensures traffic is routed to a pod only when its required dependencies are operational:
- **Database** (`database.healthCheck()`): Must be healthy.
- **Stellar Horizon** (`checkStellar()`): Must be ok.
- **Shutdown Manager**: Must not be in shutting-down state.
- **Redis Dependency**:
  - If `REDIS_REQUIRED=true`: Evaluates `checkRedis()`. If Redis is disabled, unreachable, or times out, returns HTTP 503:
    ```json
    {
      "status": "not_ready",
      "reason": "required_dependency_unhealthy",
      "unhealthyDependency": "redis",
      "checks": {
        "database": { "status": "healthy" },
        "stellar": { "status": "ok" },
        "redis": {
          "configured": true,
          "status": "unreachable",
          "required": true,
          "error": "Redis did not respond to PING within 2000ms"
        }
      }
    }
    ```
  - If `REDIS_REQUIRED=false` (or unset): Redis outages do not block readiness; returns HTTP 200 with Redis status reported as `unreachable` or `disabled`.

### `/health` (Detailed Health Endpoint)
Includes diagnostic status for on-call engineers:
- When `REDIS_REQUIRED=true` and Redis is down: Returns HTTP 503 (`status: 'unhealthy'`).
- When `REDIS_REQUIRED=false` and Redis is down (but configured): Returns HTTP 200 (`status: 'degraded'`).
- Surfaces `checks.redis` containing `configured`, `status`, `required`, `latency_ms`, and optional error details.

---

## 4. Cache Multi-Tier & Degradation Policy

The cache layer (`backend/src/cache.js`) implements a two-tier strategy:
1. **Tier 1 (Redis)**: Distributed shared cache across application instances.
2. **Tier 2 (NodeCache)**: In-memory local fallback.

### Behavior on Outage:
- **`asyncGet(key, options)`**:
  - Attempts Redis read with bounded timeout (`REDIS_CACHE_TIMEOUT_MS`).
  - If Redis responds with data: records hit (`cache_hits_total`), returns parsed object.
  - If Redis reports key not found: continues to local cache.
  - If Redis times out, errors, or is disconnected: logs a warning, records an outage degradation (`cache_outages_total`), and falls back to local cache. Caller requests never throw.
- **`asyncSet(key, value, ttl, options)` / `set(key, value, ttl)`**:
  - Always writes immediately to local in-memory cache.
  - Asynchronously propagates to Redis.
  - Redis connection failure is caught, logged, and incremented as an outage metric (`cache_outages_total`).
- **`getSafe(key, fallbackLoader, options)`**:
  - Combines `asyncGet` with an automatic fallback loader.
  - On miss or degradation, calls `fallbackLoader()`, writes the result to cache, and returns it.

---

## 5. Queue-Dependent Mutations

Mutations that require an asynchronous job queue (e.g., async export/report jobs via `enqueueReportJob`):
- If Redis / queue worker is down, the request fails fast with HTTP 503 instead of hanging or returning an unhandled 500 error.
- Returns a standardized actionable response:
  ```json
  {
    "error": "Async report queue is temporarily unavailable. Please retry synchronously or try again later.",
    "code": "QUEUE_UNAVAILABLE",
    "actionable": true,
    "retryAfterSeconds": 30,
    "details": "Queue dependency outage detected; async report mutation cannot be queued at this time."
  }
  ```

---

## 6. Prometheus Metrics

The metrics registry exports the following counters and gauges to distinguish normal operational misses from infrastructure outages:

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `cache_operations_total` | Counter | `cache`, `result` (`hit`, `miss`, `outage`) | Total cache operations categorized by result. |
| `cache_hits_total` | Counter | `cache` | Number of successful cache hits. |
| `cache_misses_total` | Counter | `cache` | Normal cache misses (key was looked up but did not exist). |
| `cache_outages_total` | Counter | `cache` | Outage events where Redis timed out or errored during cache read/write. |
| `redis_connected` | Gauge | *none* | 1 if Redis client is currently connected and ready, 0 otherwise. |

### Alerting Rule Example:
```promql
# High cache outage rate indicates Redis connection or latency degradation
rate(cache_outages_total[5m]) > 0.05
```

---

## 7. Startup Retry Policy (Issue #286)

When `REDIS_HOST` is configured, the application can wait for Redis to become
available before deciding whether to start in degraded mode or abort.

### `waitForRedis(timeoutMs, retryIntervalMs)`

Located in `backend/src/config/redisClient.js`, this function performs bounded
startup probing with exponential backoff:

| Parameter | Default | Source |
|-----------|---------|--------|
| `timeoutMs` | `30 000` ms | `REDIS_STARTUP_TIMEOUT_MS` env var |
| `retryIntervalMs` (initial) | `500` ms | hardcoded constant |
| Max interval | `5 000` ms | hardcoded constant |

**Retry schedule:**

| Attempt | Wait before attempt |
|---------|-------------------|
| 1 | immediate |
| 2 | 500 ms |
| 3 | 1 000 ms |
| 4 | 2 000 ms |
| 5+ | 5 000 ms (capped) |

If the budget expires:
- `REDIS_REQUIRED=false` — application continues in **degraded mode**: rate
  limiting falls back to in-process counters, BullMQ falls back to MongoDB
  retry backend, other components degrade per the classification table below.
- `REDIS_REQUIRED=true` — the caller (app startup) should not accept traffic
  (readiness probe returns 503) until Redis becomes available.

Returns `{ connected: boolean, attempts: number, reason?: string }`.

---

## 8. Degradation Classification (Issue #286)

Every Redis-dependent component in PaymentFlow is classified by its criticality
so on-call engineers know what degrades during a Redis outage.

| Component | File | Criticality | Degraded Behavior |
|-----------|------|-------------|-------------------|
| BullMQ transaction retry queue | `src/queue/transactionRetryQueue.js` | **CRITICAL** | Automatically falls back to MongoDB-backed retry service (`retryServiceSelector.js`) |
| BullMQ report generation queue | `src/queue/reportQueue.js` | **CRITICAL** | Returns HTTP 503 `QUEUE_UNAVAILABLE` — report jobs cannot be enqueued until Redis is restored |
| Rate limiting | `src/middleware/rateLimiter.js` | **DEGRADABLE** | Falls back to in-process sliding-window counter per replica; limits are not coordinated across replicas |
| Auth IP-block tracking | `src/middleware/auth.js` | **DEGRADABLE** | Falls back to in-process `NodeCache`; blocks are not coordinated across replicas |
| Distributed lock | `src/services/distributedLock.js` | **DEGRADABLE** | Operations proceed without distributed lock; concurrent execution risk for lock-guarded jobs |
| Idempotency key store | `src/services/idempotencyStore.js` | **DEGRADABLE** | Falls back to MongoDB-backed idempotency store |
| Session / read-through cache | `src/cache.js` | **DEGRADABLE** | Falls back to `NodeCache` in-process store; cache is not shared across replicas |
| Leader election | `src/services/leaderElection.js` | **DEGRADABLE** | All replicas act as leader; background jobs may run on multiple instances |
| SSE pub/sub | `src/services/sseService.js` | **OPTIONAL** | SSE events are only delivered to the local replica's connected clients |

**Impact summary during a Redis outage:**

- Users can still log in and make payments (MongoDB is the authoritative store).
- Rate limiting becomes per-replica only — burst protection is weakened.
- Failed payment retries switch to MongoDB backend automatically.
- Real-time SSE notifications may be missed if the client is connected to a
  different replica.
- Report generation is temporarily unavailable (returns HTTP 503).
