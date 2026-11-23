# Runbook: SLO-1 — API Availability

**Alert names:** `SLOApiAvailabilityFastBurn` · `SLOApiAvailabilitySlowBurn`  
**SLO target:** ≥ 99.5 % of HTTP requests return a non-5xx response (30-day rolling)  
**Error budget:** ~3.6 hours/month of fully-down equivalent  
**Severity:** critical (fast burn) / warning (slow burn)  
**Component:** Express.js API backend  

---

## Overview

This SLO measures the fraction of all HTTP requests that return a non-5xx response code. A 5xx response indicates the server failed to process a request, which directly impacts parents submitting payments and school admins managing records.

Alert thresholds use multi-window burn rates:
- **Fast burn (critical):** 14× the monthly error rate sustained for 2 minutes — the monthly budget would be exhausted in ~2 hours.
- **Slow burn (warning):** 6× the monthly error rate sustained for 15 minutes — the budget would be exhausted in ~5 hours.

---

## Alert Conditions

| Alert | Condition | Severity |
|-------|-----------|----------|
| `SLOApiAvailabilityFastBurn` | `slo:api_error_ratio:rate5m > 7 %` for 2 m | critical |
| `SLOApiAvailabilitySlowBurn` | `slo:api_error_ratio:rate30m > 3 %` for 15 m | warning |

---

## Diagnosis Steps

### 1. Check overall error rate

Open the **SLO Dashboard** → SLO-1 row, or run:

```promql
slo:api_error_ratio:rate5m
```

Look at which HTTP status codes are spiking:

```promql
sum by (status) (rate(http_request_duration_seconds_count{status=~"5.."}[5m]))
```

### 2. Identify affected routes

```promql
sum by (route, status) (rate(http_request_duration_seconds_count{status=~"5.."}[5m]))
```

High counts on `/api/payments/verify` or `/api/payments/sync` indicate the payment-processing path. High counts on `/health` would be unusual — check MongoDB connectivity first.

### 3. Check MongoDB connection

```promql
mongodb_connection_state
```

Value `!= 1` (not connected) → follow the **MongoDB runbook** (operator-runbooks.md). This is the most common cause of widespread 5xx.

```bash
# Application logs
docker logs stellaredupay-backend --tail 200 | grep '"level":"error"'
```

### 4. Check Horizon circuit breaker

```promql
horizon_circuit_breaker_state
```

Any `== 1` (open) → Stellar Horizon is unreachable. Payment sync and verification endpoints will return 5xx or degrade. Follow the **Horizon Failover runbook**.

### 5. Check queue backpressure

```promql
payment_processor_queue_depth
payment_processor_queue_max_depth
```

If `queue_depth >= max_depth`, payments are being rejected with `QUEUE_FULL` (503). Consider raising `MAX_QUEUE_DEPTH` or investigating why the queue is not draining.

### 6. Check Node.js heap

```promql
nodejs_heap_used_ratio
```

> 0.9 means the process is under memory pressure. Check for memory leaks or increase the container's memory limit.

### 7. Check recent deployments

A sudden spike after a deployment indicates a bad release. Roll back:

```bash
kubectl rollout undo deployment/backend
# or Docker Compose:
docker compose up --build  # with previous image tag
```

---

## Mitigation Actions

| Cause | Action |
|-------|--------|
| MongoDB disconnected | Restore MongoDB; no manual code change needed |
| Horizon circuit open | Wait for recovery or switch to backup Horizon endpoint |
| Queue full | Raise `MAX_QUEUE_DEPTH` env var + redeploy |
| Bad deployment | Roll back with `kubectl rollout undo deployment/backend` |
| Memory pressure | Scale up memory limit or restart container |

---

## Recovery Verification

After applying a fix, confirm the error rate drops:

```promql
slo:api_error_ratio:rate5m
```

Confirm the alert has resolved in Alertmanager. Check `/health`:

```bash
curl -s http://localhost:5000/health | jq .
```

Expected: `{ "status": "ok" }`.

---

## Error Budget Impact

| Burn rate | Budget consumed per hour | Time to exhaustion |
|-----------|--------------------------|--------------------|
| 1× (baseline) | ~0.07 % | 30 days |
| 6× (slow burn alert) | ~0.42 % | ~5 hours |
| 14× (fast burn alert) | ~0.97 % | ~2 hours |
| 100× (complete outage) | ~6.9 % | ~14 min |

---

## Escalation

- **P1 (fast-burn firing):** Page on-call engineer immediately.
- **P2 (slow-burn firing):** Notify on-call, investigate within 30 minutes.
- **Post-incident:** Blameless post-mortem required within 5 business days of any SLO breach.
