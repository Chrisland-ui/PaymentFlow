# Runbook: SLO-4 — Blockchain Reconciliation Lag

**Alert names:** `SLOReconciliationLagWarning` · `SLOReconciliationLagCritical`  
**SLO target:** 95 % of schools reconciled (latest Horizon transaction polled) within 5 minutes  
**Severity:** warning (> 3 deferral cycles ≈ 1.5 min) / critical (> 9 cycles ≈ 5 min SLO breach)  
**Component:** `transactionPollingService.js` — Horizon poll budget system  

---

## Overview

PaymentFlow polls the Stellar Horizon API on a configurable interval (default: 30 s) to discover new transactions for each school wallet. When multiple schools are registered, a per-cycle request budget (`HORIZON_RATE_LIMIT_PER_HOUR`) governs how many Horizon requests can be issued. Low-priority schools can be **deferred** to a later cycle when the budget is exhausted.

The metric `horizon_poll_max_deferral_cycles` tracks the worst-case school — the school that has been deferred the most consecutive cycles without a poll. Each deferred cycle adds approximately `POLL_INTERVAL_MS / 60000` minutes of lag.

With the default 30 s interval:
- 3 cycles deferred ≈ 1.5 min lag (warning)
- 10 cycles deferred ≈ 5 min lag (SLO breach)

---

## Alert Conditions

| Alert | Condition | Severity |
|-------|-----------|----------|
| `SLOReconciliationLagWarning` | `horizon_poll_max_deferral_cycles > 3` for 10 m | warning |
| `SLOReconciliationLagCritical` | `horizon_poll_max_deferral_cycles > 9` for 5 m | critical |

---

## Diagnosis Steps

### 1. Confirm deferral state

```promql
horizon_poll_max_deferral_cycles
horizon_poll_deferred_schools
horizon_poll_budget_remaining
horizon_poll_budget_ceiling
```

Check if the budget ceiling has collapsed (adaptive AIMD response to 429s):

```promql
horizon_poll_budget_ceiling
```

A ceiling ≤ 4 means Horizon is aggressively throttling — see `HorizonPollBudgetCollapsed` alert.

### 2. Check Horizon rate-limit responses

```promql
rate(horizon_rate_limited_total[15m])
```

Any non-zero rate means Horizon is returning 429s. This triggers AIMD to halve the budget ceiling. The configured `HORIZON_RATE_LIMIT_PER_HOUR` may exceed the real allowance, or `HORIZON_POLL_REPLICA_COUNT` may be wrong (each replica spends a full budget).

### 3. Count registered active schools

If the number of active schools has grown recently, the fixed budget may be insufficient:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/schools | jq '.total'
```

Each school requires at least 1 Horizon request per poll cycle. If `active schools > budget_ceiling`, some will always be deferred.

### 4. Check polling cycle duration

```promql
histogram_quantile(0.95, rate(polling_cycle_duration_seconds_bucket[5m]))
```

A slow cycle means each school's turn takes longer, compounding lag.

### 5. Check Horizon request latency

```promql
histogram_quantile(0.95, sum(rate(horizon_request_duration_seconds_bucket[5m])) by (le, operation))
```

Slow Horizon responses (`payments`, `transactions` operations) directly slow poll cycles.

### 6. Check the Horizon failover state

```promql
horizon_circuit_breaker_state
min(horizon_circuit_breaker_state)
```

Open circuit breakers reduce the available endpoints, concentrating load on fewer (or no) healthy endpoints.

---

## Mitigation Actions

| Cause | Action |
|-------|--------|
| Budget ceiling collapsed | Check `HORIZON_RATE_LIMIT_PER_HOUR` vs actual Horizon allowance; reduce or request higher limit |
| `HORIZON_POLL_REPLICA_COUNT` wrong | Set to actual running replica count (each replica uses a full budget) |
| Too many schools for budget | Raise rate limit, lengthen `POLL_INTERVAL_MS`, or shard schools across replicas |
| Horizon slow/throttling | Switch to dedicated Horizon instance or reduce poll frequency |
| Circuit breaker open | Wait for half-open recovery or manually clear; check Horizon endpoint health |

### Adjusting rate limit

Update `HORIZON_RATE_LIMIT_PER_HOUR` in the backend `.env`:

```bash
# Example: raise from default 100 to 500 requests per hour
HORIZON_RATE_LIMIT_PER_HOUR=500
```

Then redeploy. The new ceiling takes effect at the next poll cycle.

### Lengthening poll interval

```bash
POLL_INTERVAL_MS=60000  # 60 seconds instead of 30
```

This halves the request rate per school at the cost of doubling worst-case lag.

---

## Capacity Guidance

From `docs/horizon-rate-limits.md`:

```
max_delay ≈ (max_deferral_cycles + 1) × poll_interval
```

To support N schools within the 5-minute SLO with a 30 s interval:
- Require: `HORIZON_RATE_LIMIT_PER_HOUR / 120 ≥ N` (120 cycles/hour at 30 s)

---

## Recovery Verification

```promql
horizon_poll_max_deferral_cycles
horizon_poll_deferred_schools
```

Both should return to 0. Confirm payments are being confirmed by checking:

```promql
rate(payment_processing_duration_seconds_count[5m])
```

---

## Escalation

- **P1 (critical — SLO breach):** Page on-call; review budget configuration immediately.
- **P2 (warning — lag growing):** Notify on-call; review horizon-rate-limits.md and plan capacity before the breach threshold is hit.
- **Post-incident:** Update the capacity plan with the current school count and Horizon rate limit.
