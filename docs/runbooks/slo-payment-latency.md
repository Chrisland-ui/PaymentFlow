# Runbook: SLO-2 — Payment Confirmation Latency

**Alert names:** `SLOPaymentLatencyFastBurn` · `SLOPaymentLatencySlowBurn`  
**SLO target:** p95 ≤ 60 seconds for ≥ 95 % of payments (30-day rolling)  
**Severity:** critical (fast burn) / warning (slow burn)  
**Component:** Payment processing pipeline (pollingService → concurrentPaymentProcessor → paymentConfirmationStateMachine)  

---

## Overview

This SLO measures how quickly payments progress from blockchain detection (when the Horizon poller sees the transaction) to confirmed status (stored in MongoDB with `status: CONFIRMED`).

The full pipeline is:
1. **Transaction polled** from Stellar Horizon API
2. **Queued** in the concurrent payment processor
3. **Validated** against fee structures and student records
4. **State-machined** through SUBMITTED → PROCESSING → CONFIRMED
5. **Recorded** in MongoDB and webhook fired

Latency spikes indicate a bottleneck at one of these stages.

---

## Alert Conditions

| Alert | Condition | Severity |
|-------|-----------|----------|
| `SLOPaymentLatencyFastBurn` | `slo:payment_processing_p95:rate5m > 30 s` for 5 m | critical |
| `SLOPaymentLatencySlowBurn` | `slo:payment_processing_p95:rate30m > 10 s` for 30 m | warning |

---

## Diagnosis Steps

### 1. Confirm the latency spike

```promql
slo:payment_processing_p95:rate5m
histogram_quantile(0.99, sum(rate(payment_processing_duration_seconds_bucket[5m])) by (le))
```

Check if this is a recent regression or a gradual rise:

```promql
slo:payment_processing_p95:rate30m
```

### 2. Check payment processor queue depth

```promql
payment_processor_queue_depth
payment_processor_queue_backpressure_high_water
```

If `queue_depth >= backpressure_high_water`, the processor is throttling — payments are waiting in queue. This is expected under load but should self-recover. If depth is near `payment_processor_queue_max_depth`, payments are being rejected entirely.

### 3. Check transaction retry queue

```promql
queue_depth{queue="transaction-retry"}
queue_failed{queue="transaction-retry"}
```

A large retry queue means many payments are failing on first attempt and being re-queued. Check the failure reason:

```bash
docker logs stellaredupay-backend --tail 500 | grep '"level":"error"' | grep -i payment
```

### 4. Check Horizon polling throughput

```promql
horizon_poll_max_deferral_cycles
horizon_poll_budget_remaining
```

If schools are being deferred, newly-detected transactions sit unprocessed. Slow polling means the measurement clock for latency starts late.

### 5. Check MongoDB write latency

The confirmation step writes to MongoDB. Slow writes directly inflate `payment_processing_duration_seconds`.

```promql
mongodb_connection_state
rate(mongodb_connection_errors_total[5m])
```

Check MongoDB slow query logs:

```bash
docker logs stellaredupay-mongodb --tail 200 | grep "slowQuery"
```

### 6. Check Horizon request latency

```promql
histogram_quantile(0.95, sum(rate(horizon_request_duration_seconds_bucket[5m])) by (le, operation))
```

If Horizon responses are slow, the full pipeline latency grows proportionally for `transactions` and `loadAccount` operations.

### 7. Check for stuck payments

```promql
stuck_payments
```

A growing stuck-payment count means payments are stuck in `SUBMITTED` state and will never confirm without intervention. Restart the reconciliation job or manually re-queue via the admin API.

---

## Mitigation Actions

| Cause | Action |
|-------|--------|
| Queue backpressure | Check if it will self-drain; if not, raise `QUEUE_BACKPRESSURE_HIGH_WATER` |
| Queue full | Raise `MAX_QUEUE_DEPTH` or reduce concurrent load |
| MongoDB slow writes | Check Atlas/replica-set health, indexes, disk I/O |
| Horizon slow | Check Horizon endpoint health; consider switching to backup |
| Retry queue growing | Investigate retry failures; fix root cause (Horizon/Mongo) |
| Stuck payments | Call `POST /api/payments/sync` or investigate via admin API |

---

## Recovery Verification

```promql
slo:payment_processing_p95:rate5m
slo:payment_within_slo:ratio_rate5m
```

`slo:payment_within_slo:ratio_rate5m` should be ≥ 0.95 (95 %) for the SLO to be met.

---

## Escalation

- **P1 (fast-burn / p95 > 30 s):** Page on-call. Check queue and database first.
- **P2 (slow-burn / p95 > 10 s for 30 min):** Notify on-call; investigate within 30 minutes.
- **Post-incident:** Document root cause and update capacity plan if a load-related issue.
