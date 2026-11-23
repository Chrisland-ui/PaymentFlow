# Runbook: SLO-5 — Retry Queue Age / Error Budget

**Alert names:** `SLORetryQueueDepthWarning` · `SLORetryQueueDepthCritical` · `SLODeadLetterGrowing`  
**SLO target:** `pending_verification_backlog{status="pending"}` < 100 at all times  
**Severity:** warning (> 50) / critical (> 200 or dead-letter > 0 for 10 m)  
**Component:** `retryService.js` / `retryServiceSelector.js` — pending-verification retry backend  

---

## Overview

When a transaction is detected by the Horizon poller but cannot be immediately verified and confirmed (e.g., due to a transient Horizon error, MongoDB write failure, or fee structure inconsistency), it is placed in the **pending-verification backlog** with `status: pending`.

The retry service periodically re-processes these records with exponential backoff. Once all retry attempts are exhausted, the record transitions to `dead_letter`, requiring manual operator action.

A growing backlog means payments are stuck — parents see payment submission but no confirmation, and school records are inconsistent.

---

## Alert Conditions

| Alert | Condition | Severity |
|-------|-----------|----------|
| `SLORetryQueueDepthWarning` | `pending_verification_backlog{status="pending"} > 50` for 5 m | warning |
| `SLORetryQueueDepthCritical` | `pending_verification_backlog{status="pending"} > 200` for 5 m | critical |
| `SLODeadLetterGrowing` | `pending_verification_backlog{status="dead_letter"} > 0` for 10 m | critical |

---

## Diagnosis Steps

### 1. Check backlog depth

```promql
pending_verification_backlog
```

Breakdown by status:
- `pending` — waiting to be retried
- `processing` — currently being processed
- `resolved` — successfully confirmed
- `dead_letter` — exhausted all retries; needs manual action

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/admin/retry-queue | jq .
```

### 2. Check if the retry worker is alive

```bash
curl -s http://localhost:5000/health | jq .workers
```

Look for `workers.retryWorker`. If `status != "healthy"`, the retry service has crashed or is not processing.

Check logs:

```bash
docker logs stellaredupay-backend --tail 500 | grep -E "(retry|pending.verification)" | grep error
```

### 3. Identify the failure reason

Check why verifications are failing:

```bash
docker logs stellaredupay-backend --tail 1000 | \
  grep '"level":"error"' | \
  grep -E "(stellar|horizon|verification)" | \
  head -50
```

Common causes:
- **Horizon errors** — `STELLAR_NETWORK_ERROR` in log → check Horizon availability
- **MongoDB write failures** — `mongodb_connection_state != 1` → check DB
- **Fee structure missing** — payment received but no active fee for the student's class
- **Memo mismatch** — student ID not matching any registered student

### 4. Check Horizon availability

```promql
horizon_circuit_breaker_state
horizon_unreachable_since_seconds
```

If Horizon is unreachable, all verification attempts will fail and backlog will grow until Horizon recovers.

### 5. Check MongoDB health

```promql
mongodb_connection_state
rate(mongodb_connection_errors_total[5m])
```

### 6. Inspect dead-letter entries

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/admin/retry-queue?status=dead_letter&limit=20" | jq .
```

For each entry, look up the transaction hash on the Stellar blockchain to determine the true payment state:

```
https://stellarchain.io/transactions/{txHash}
# or Horizon directly:
https://horizon.stellar.org/transactions/{txHash}
```

---

## Mitigation Actions

| Cause | Action |
|-------|--------|
| Retry worker crashed | Restart backend container; monitor health check |
| Horizon unreachable | Wait for recovery; backlog will drain automatically |
| MongoDB errors | Restore MongoDB; backlog drains after reconnection |
| Fee structure missing | Create/restore the fee structure; then re-queue affected verifications |
| Dead-letter accumulation | Manually resolve each entry (see below) |

### Manually re-queuing a pending verification

```bash
# Re-queue a specific verification record
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/admin/retry-queue/RECORD_ID/requeue"
```

### Manually resolving a dead-lettered verification

Once you have confirmed the transaction status on-chain:

**If the payment was confirmed on-chain:**

```bash
# Mark as resolved with the on-chain status
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/payments/verify" \
  -H "Content-Type: application/json" \
  -d '{"txHash": "TRANSACTION_HASH", "schoolId": "SCHOOL_ID"}'
```

**If the payment failed on-chain:**

```bash
# Mark as failed
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/admin/retry-queue/RECORD_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "failed", "reason": "On-chain transaction failed — manually resolved"}'
```

---

## Recovery Verification

```promql
slo:retry_queue_pending:current
slo:retry_queue_dead_letter:current
```

Both should return to 0 or near-0. Confirm payments are processing:

```promql
rate(payments_total[5m])
```

---

## Escalation

- **P1 (critical — depth > 200 or dead-letter growing):** Page on-call; identify root cause (Horizon vs MongoDB vs worker).
- **P2 (warning — depth > 50):** Notify on-call; monitor for 30 minutes to see if it self-drains.
- **Dead-letter entries:** Always require manual inspection and either re-queue or mark resolved/failed with an audit reason. Do not bulk-delete without on-chain verification.
- **Post-incident:** Document how many payments were affected, whether any required manual resolution, and whether school/parent communication was needed.
