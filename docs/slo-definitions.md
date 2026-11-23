# SLO Definitions — PaymentFlow

**Issue:** #122  
**Owner:** Platform / Payments team  
**Review cadence:** Quarterly or after any SLO breach  

---

## Overview

Service Level Objectives define the reliability targets that PaymentFlow commits to for its users (school admins and parents). Each SLO is expressed as a ratio measured over a rolling window, with an error budget that allows teams to prioritise reliability work. Alerts fire on fast-burn and slow-burn patterns so that breaches are caught both immediately (acute outages) and gradually (quiet erosion).

All SLOs use **30-day rolling windows** unless stated otherwise.

---

## SLO Catalogue

### SLO-1 — API Availability

| Field | Value |
|-------|-------|
| **What** | Fraction of HTTP requests that return a non-5xx response |
| **Target** | ≥ 99.5 % |
| **Error budget** | 0.5 % → ~3.6 hours/month of fully-down equivalent |
| **Window** | 30-day rolling |
| **Owner** | Platform |
| **Metric** | `http_request_duration_seconds_count{status!~"5.."}` / `http_request_duration_seconds_count` |

**Alert policy**

| Alert name | Burn rate | Window | Severity | Action |
|------------|-----------|--------|----------|--------|
| `SLOApiAvailabilityFastBurn` | > 14× | 5 m | critical | Page on-call immediately |
| `SLOApiAvailabilitySlowBurn` | > 6× | 30 m | warning | Investigate within 30 min |

Runbook: [`docs/runbooks/slo-api-availability.md`](runbooks/slo-api-availability.md)

---

### SLO-2 — Payment Confirmation Latency

| Field | Value |
|-------|-------|
| **What** | Fraction of payments confirmed within 60 seconds of blockchain detection |
| **Target** | ≥ 95 % |
| **Error budget** | 5 % of payments may exceed 60 s |
| **Window** | 30-day rolling |
| **Owner** | Payments |
| **Metric** | `payment_processing_duration_seconds_bucket{le="60"}` / `payment_processing_duration_seconds_count` |

**Alert policy**

| Alert name | Condition | Severity | Action |
|------------|-----------|----------|--------|
| `SLOPaymentLatencyFastBurn` | p95 > 30 s for 5 m | critical | Page on-call |
| `SLOPaymentLatencySlowBurn` | p95 > 10 s for 30 m | warning | Investigate |

Runbook: [`docs/runbooks/slo-payment-latency.md`](runbooks/slo-payment-latency.md)

---

### SLO-3 — Webhook Delivery Success

| Field | Value |
|-------|-------|
| **What** | Fraction of webhook delivery attempts that succeed (HTTP 2xx from recipient) |
| **Target** | ≥ 99 % |
| **Error budget** | 1 % — roughly 1 in 100 webhook events may fail after all retries |
| **Window** | 30-day rolling |
| **Owner** | Payments / Integrations |
| **Metric** | `webhook_delivery_total{outcome="success"}` / `webhook_delivery_total` |

**Alert policy**

| Alert name | Burn rate | Window | Severity | Action |
|------------|-----------|--------|----------|--------|
| `SLOWebhookSuccessFastBurn` | > 14× | 5 m | critical | Page on-call |
| `SLOWebhookSuccessSlowBurn` | > 3× | 1 h | warning | Investigate within 1 h |

Runbook: [`docs/runbooks/slo-webhook-delivery.md`](runbooks/slo-webhook-delivery.md)

---

### SLO-4 — Blockchain Reconciliation Lag

| Field | Value |
|-------|-------|
| **What** | Maximum age of the most-recently-polled Horizon transaction per school |
| **Target** | 95 % of schools reconciled within 5 minutes at all times |
| **Error budget** | Up to 5 % of schools may lag > 5 min at any given moment |
| **Window** | Continuous (point-in-time) |
| **Owner** | Payments / Infrastructure |
| **Metric** | `horizon_poll_max_deferral_cycles` (proxy: deferral_cycles × poll_interval ≈ lag) |

**Alert policy**

| Alert name | Condition | Severity | Action |
|------------|-----------|----------|--------|
| `SLOReconciliationLagWarning` | `horizon_poll_max_deferral_cycles > 3` for 10 m | warning | Check Horizon budget |
| `SLOReconciliationLagCritical` | `horizon_poll_max_deferral_cycles > 9` for 5 m | critical | Page on-call |

Runbook: [`docs/runbooks/slo-reconciliation-lag.md`](runbooks/slo-reconciliation-lag.md)

---

### SLO-5 — Retry Queue Age (Error Budget)

| Field | Value |
|-------|-------|
| **What** | Depth of the pending-verification backlog (payments awaiting retry) |
| **Target** | `pending_verification_backlog{status="pending"}` < 100 at all times |
| **Error budget** | Queue should drain to < 10 within 30 min of a spike |
| **Window** | Continuous |
| **Owner** | Payments |
| **Metric** | `pending_verification_backlog{status="pending"}` |

**Alert policy**

| Alert name | Condition | Severity | Action |
|------------|-----------|----------|--------|
| `SLORetryQueueDepthWarning` | depth > 50 for 5 m | warning | Investigate backlog |
| `SLORetryQueueDepthCritical` | depth > 200 for 5 m | critical | Page on-call |
| `SLODeadLetterGrowing` | `pending_verification_backlog{status="dead_letter"} > 0` for 10 m | critical | Manual intervention |

Runbook: [`docs/runbooks/slo-retry-queue.md`](runbooks/slo-retry-queue.md)

---

## Error Budget Policy

1. **> 50 % budget consumed** in the first two weeks: schedule a reliability sprint for the following iteration.
2. **> 75 % budget consumed**: freeze non-essential feature work; reliability improvements take priority.
3. **Budget exhausted (100 %)**: all non-critical feature releases are blocked until the budget recovers, unless explicitly waived by the engineering lead.
4. **SLO breach in production**: a blameless post-mortem is required within 5 business days.

---

## Measurement Notes

- All ratios use 5-minute `rate()` windows inside the Prometheus recording rules.
- Burn rates are multiples of the baseline error rate consistent with Google SRE workbook formulas.
- Planned maintenance windows are excluded via Alertmanager inhibition rules when `maintenance_mode` label is present.
- SLO targets reflect the **testnet** baseline; production targets should be reviewed after 90 days of data.
