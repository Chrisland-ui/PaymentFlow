# Runbook: SLO-3 — Webhook Delivery Success

**Alert names:** `SLOWebhookSuccessFastBurn` · `SLOWebhookSuccessSlowBurn`  
**SLO target:** ≥ 99 % of webhook delivery attempts succeed (30-day rolling)  
**Error budget:** 1 % — roughly 1 in 100 webhook events may fail after all retries  
**Severity:** critical (fast burn) / warning (slow burn)  
**Component:** `webhookService.js` — outbound HMAC-signed webhook deliveries  

---

## Overview

PaymentFlow fires HMAC-signed webhook events to registered school endpoints on payment status changes (CONFIRMED, FAILED, etc.). Each delivery is attempted with exponential-backoff retries. A delivery enters the dead-letter queue when all retry attempts fail.

This SLO measures the fraction of delivery attempts that complete with an HTTP 2xx response from the recipient.

**Important:** A failure means the school's integration did not receive a payment event. This can cause integration breakdowns (e.g., school's ERP not updating, parent not receiving email from school system).

---

## Alert Conditions

| Alert | Condition | Severity |
|-------|-----------|----------|
| `SLOWebhookSuccessFastBurn` | error ratio > 14 % for 2 m | critical |
| `SLOWebhookSuccessSlowBurn` | error ratio > 3 % for 30 m | warning |

---

## Diagnosis Steps

### 1. Check overall delivery rate

```promql
slo:webhook_success:ratio_rate5m
slo:webhook_error_ratio:rate5m
```

Check per-outcome breakdown:

```promql
sum by (outcome) (rate(webhook_delivery_total[5m]))
```

### 2. Identify failing schools

```promql
topk(10, sum by (schoolId) (increase(webhook_dead_letter_total[1h])))
```

A spike for one school often indicates that school's endpoint is down. A spike across all schools may indicate a network issue on the sender side or a bad payload.

### 3. Check dead-letter accumulation

```promql
webhook_dead_letter_total
```

Dead-letter entries require manual replay. List them via the admin API:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/webhook-deliveries?status=dead_letter&limit=50"
```

### 4. Check webhook delivery latency

```promql
histogram_quantile(0.95, rate(webhook_delivery_duration_ms_bucket[5m]))
```

Latency > 10,000 ms (10 s) means deliveries are timing out at the recipient. This inflates the failure count. The recipient endpoint may be slow or unreachable.

### 5. Verify HMAC signature validity

If a school's endpoint is rejecting with 4xx (not 5xx or timeout), it may be an HMAC mismatch after a secret rotation. Check:

```bash
docker logs stellaredupay-backend --tail 200 | grep -i webhook | grep -E "(hmac|signature|secret)"
```

If a webhook secret was recently rotated (`scripts/rotate-webhook-encryption-key.js`), verify the new secret is deployed.

### 6. Check outbound network connectivity

```bash
# From the backend container
docker exec stellaredupay-backend curl -I https://recipient-endpoint.example.com
```

### 7. Check for SSRF protection blocking the endpoint

The webhook service has SSRF protection. If a school registered a private IP endpoint after a network topology change, deliveries will be blocked:

```bash
docker logs stellaredupay-backend --tail 200 | grep -i "ssrf\|blocked\|private"
```

---

## Mitigation Actions

| Cause | Action |
|-------|--------|
| Recipient endpoint down | Contact school admin; deliveries will retry automatically |
| HMAC mismatch | Verify webhook secret and redeploy; replay dead-lettered events |
| Timeout at recipient | Check recipient load; reduce payload size if possible |
| SSRF block (new private IP) | Update school's webhook URL to a valid public endpoint |
| Network issue (sender side) | Check container networking and DNS resolution |
| Large DLQ backlog | Replay via `POST /api/webhook-deliveries/:id/replay` per school |

---

## Replaying Dead-Lettered Webhooks

Once the underlying issue is resolved, replay failed deliveries:

```bash
# Replay all dead-lettered webhooks for a school
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/webhook-deliveries/replay-dead-letter" \
  -H "Content-Type: application/json" \
  -d '{"schoolId": "SCHOOL_ID"}'
```

Or replay individual events:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/webhook-deliveries/DELIVERY_ID/replay"
```

---

## Recovery Verification

```promql
slo:webhook_success:ratio_rate5m
slo:webhook_error_ratio:rate5m
webhook_dead_letter_total
```

Confirm `slo:webhook_success:ratio_rate5m ≥ 0.99` and dead-letter count is not growing.

---

## Escalation

- **P1 (fast-burn):** Page on-call; identify failing school(s) immediately and notify them.
- **P2 (slow-burn):** Notify on-call; investigate within 1 hour.
- **Post-incident:** Document which schools were impacted and whether any events require replay. Confirm with schools that their integration state is consistent.
