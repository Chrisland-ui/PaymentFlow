# Runbook: Redis Degradation

**Severity:** P2 — Service Degraded  
**Owner:** Platform / Backend On-Call  
**Related docs:** [`docs/redis-dependency.md`](../redis-dependency.md)

---

## 1. Detection

A Redis degradation event is signalled by one or more of the following:

| Signal | Where |
|--------|-------|
| `/health` returns `"status": "degraded"` with `checks.redis.status !== "ok"` | Prometheus / uptime monitor |
| `rate(cache_outages_total[5m]) > 0.05` alert fires | Grafana |
| `redis_connected` gauge drops to `0` | Grafana |
| Application logs: `[RedisClient] Redis unavailable` at WARN level | Log aggregator |
| BullMQ retry queue switches to MongoDB backend (log: `[RetrySelector] switching to mongodb`) | Log aggregator |

### Health endpoint check

```bash
curl -s https://<host>/health | jq '.checks.redis, .status'
```

Expected healthy:
```json
{ "configured": true, "status": "ok", "required": false, "latency_ms": 1 }
```

Degraded:
```json
{ "configured": true, "status": "unreachable", "required": false, "error": "..." }
```

---

## 2. Immediate Triage

### 2.1 Is Redis reachable from the app pod?

```bash
# From inside the application container
redis-cli -h $REDIS_HOST -p $REDIS_PORT ping
# Expected: PONG
```

If `PONG` is returned but the app still reports `unreachable`, the app may be
in the middle of a reconnection window — wait 30–60 seconds for auto-reconnect.

### 2.2 Check Redis server status

```bash
# Docker Compose
docker compose ps redis
docker compose logs redis --tail 50

# Kubernetes
kubectl get pods -l app=redis
kubectl logs -l app=redis --tail 50
```

### 2.3 Check Redis memory

```bash
redis-cli -h $REDIS_HOST info memory | grep used_memory_human
redis-cli -h $REDIS_HOST info memory | grep maxmemory_human
```

If `used_memory` ≈ `maxmemory`, Redis has hit its memory limit and is evicting
keys or refusing writes.

### 2.4 Check connection count

```bash
redis-cli -h $REDIS_HOST info clients | grep connected_clients
```

Unusually high connection count (> 500 for a single-instance setup) may
indicate a connection leak.

---

## 3. Degraded-Mode Behavior by Component

Refer to the classification table in [`docs/redis-dependency.md §8`](../redis-dependency.md#8-degradation-classification-issue-286).

| User-visible impact | Root cause | Notes |
|---------------------|-----------|-------|
| Rate limits not enforced cluster-wide | In-process fallback activated | Burst attacks are less restricted |
| Real-time payment notifications delayed | SSE pub/sub lost | Clients refresh on next poll interval |
| Report job returns HTTP 503 | BullMQ queue unavailable | Advise user to retry after Redis recovers |
| Occasional duplicate retry job execution | Distributed lock unavailable | Idempotency keys in MongoDB prevent double-payment |
| Auth IP blocking not cluster-wide | In-process IP block cache | Brute-force protection weakened across replicas |

---

## 4. Recovery Procedure

### 4.1 Redis process crashed / OOM

```bash
# Restart Redis (Docker Compose)
docker compose restart redis

# Kubernetes
kubectl rollout restart deployment/redis
```

After restart, the application will auto-reconnect within `REDIS_RECONNECT_MAX_DELAY_MS`
(default 30 s).  Watch the logs:

```bash
# Expected reconnection log
[RedisClient] connected
[RetrySelector] Redis available — switching back to bullmq backend
```

### 4.2 Redis memory exhausted

1. Increase `REDIS_MEM_LIMIT` in `docker-compose.yml` (or Kubernetes resource limits).
2. Flush the least-important keyspace if needed:
   ```bash
   # WARNING: this clears all rate-limit counters — do only if memory is critical
   redis-cli -h $REDIS_HOST flushdb
   ```
3. Restart the application to re-initialize BullMQ queues.

### 4.3 Network partition between app and Redis

1. Check firewall rules / security groups.
2. Check Redis `bind` configuration — confirm it listens on the correct interface.
3. Check DNS resolution from inside the app container.

---

## 5. Verifying Recovery

Once Redis is accessible again:

```bash
# Health check should return healthy
curl -s https://<host>/health | jq '.status, .checks.redis.status'
# Expected: "healthy", "ok"

# Verify rate-limit metrics back to Redis (look for absence of fallback logs)
# In log aggregator: search for "[RateLimiter] Redis op failed" — should stop appearing
```

---

## 6. Post-Incident Checklist

- [ ] Root cause identified and documented in incident report
- [ ] Redis memory limits reviewed — increase if OOM was the cause
- [ ] `REDIS_REQUIRED` setting reviewed — should production require Redis for startup?
- [ ] Alert threshold reviewed — was the alert timely?
- [ ] Any payments stuck in retry queue? Check `/api/admin/retry-queue/stats`
- [ ] Any report jobs that returned 503 — communicate to affected schools
- [ ] Review `cache_outages_total` spike in Grafana for affected time window
- [ ] If rate limits were weakened during outage — review auth logs for anomalous traffic

---

## 7. Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | unset | Redis hostname. Unset = Redis disabled |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | unset | Redis AUTH password |
| `REDIS_REQUIRED` | `false` | `true` = Redis must be up for readiness probe to pass |
| `REDIS_CHECK_TIMEOUT_MS` | `2000` | Timeout for health-check PING |
| `REDIS_STARTUP_TIMEOUT_MS` | `30000` | Total startup retry budget |
| `REDIS_RECONNECT_MAX_ATTEMPTS` | `8` | Max ioredis reconnection attempts |
| `REDIS_RECONNECT_MAX_DELAY_MS` | `30000` | Max ioredis reconnection delay |
