# Runbook: Stuck Payments

**Audience:** Support and operations engineers  
**Severity:** P2 (no funds lost; user-visible payment status is incorrect)  
**Escalation path:** On-call backend engineer → Payment platform team → Stellar integration team

---

## Table of contents

1. [What is a stuck payment?](#1-what-is-a-stuck-payment)
2. [Required permissions](#2-required-permissions)
3. [Investigation: gather facts first](#3-investigation-gather-facts-first)
4. [Decision tree](#4-decision-tree)
5. [Safe remediation actions](#5-safe-remediation-actions)
6. [Escalation criteria](#6-escalation-criteria)
7. [Prohibited manual edits](#7-prohibited-manual-edits)
8. [Audit requirements](#8-audit-requirements)
9. [Post-incident checklist](#9-post-incident-checklist)

---

## 1. What is a stuck payment?

A payment is **stuck** when its status in MongoDB has not progressed for an
unexpectedly long time. The most common cases are:

| Symptom | Likely cause |
|---------|-------------|
| Status `pending` for > 15 minutes | Stellar Horizon unreachable; retry worker backlogged |
| Status `pending_verification` for > 30 minutes | Retry exhausted; landed in dead-letter backlog |
| Status `submitted` for > 10 minutes | Stellar transaction not confirmed or failed |
| Status `manual_review` | Previous automated decision was ambiguous; requires human review |
| Status `failed` but Horizon shows confirmed | Status not updated after successful retry |
| Status `confirmed` but student balance not updated | Post-confirmation hook failure |

The retry schedule for failed verifications is:
- Attempt 1: 1 minute after failure
- Attempt 2: 5 minutes after attempt 1
- Attempt 3: 15 minutes after attempt 2
- After 3 attempts: moved to dead-letter queue (status: `dead_letter`)

For the BullMQ backend (Redis): up to `MAX_RETRY_ATTEMPTS` (default 10) with exponential backoff + jitter.

---

## 2. Required permissions

| Action | Minimum role |
|--------|-------------|
| Read payment records, Prometheus metrics | `support` |
| Query MongoDB directly (read-only) | `db-reader` |
| Trigger a payment sync (`POST /api/payments/sync`) | `admin` JWT |
| Re-drive a dead-letter job | `admin` JWT |
| Update payment status via admin API | `admin` JWT |
| Direct MongoDB write | **Backend platform team only** — see §7 |
| Stellar Horizon queries | No credentials required (public API) |

Do not use elevated permissions for initial triage. Read-only queries first.

---

## 3. Investigation: gather facts first

> **Rule:** Never modify any record until you have confirmed the Stellar network
> state. An incorrect update cannot be undone without a backup restore.

### 3.1 Identify the affected payment

Collect the following before taking any action:

- **Payment ID** (MongoDB `_id`)
- **Transaction hash** (`txHash`) — the Stellar transaction hash
- **School ID** (`schoolId`) and **Student ID** (`studentId`)
- **Current status** in MongoDB
- **Amount** and **asset** (`assetCode`)
- **`createdAt`** and **`updatedAt`** timestamps
- **Last error** (from retry record or dead-letter entry)

Query via the admin API (requires `admin` JWT):

```bash
# List payments in pending or manual_review status
GET /api/payments/pending

# List payments with specific status for debugging
# Use the Grafana dashboard → Payments → Filter by status
```

Or from MongoDB (read-only, `db-reader` role):

```js
// Find payments stuck in pending for > 30 min
db.payments.find({
  status: { $in: ['pending', 'pending_verification', 'submitted'] },
  updatedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) }
}).sort({ updatedAt: 1 }).limit(20)

// Find dead-lettered verification jobs
db.pendingverifications.find({ status: 'dead_letter' }).sort({ updatedAt: -1 }).limit(20)

// Find a specific payment by txHash
db.payments.findOne({ txHash: '<hash>' })
```

### 3.2 Check Stellar Horizon directly

**This is the authoritative source of truth.** Always check Horizon before any remediation.

```bash
# Testnet
curl "https://horizon-testnet.stellar.org/transactions/<txHash>"

# Mainnet
curl "https://horizon.stellar.org/transactions/<txHash>"
```

Fields to check in the response:

| Field | What to look for |
|-------|-----------------|
| `successful` | `true` = transaction confirmed; `false` = transaction failed |
| `created_at` | When the transaction was ledger-confirmed |
| `memo` | Should contain the student ID for automatic matching |
| `operations` (via `/transactions/<hash>/operations`) | Payment amount, asset, source, destination |

**If Horizon returns 404:** the transaction hash does not exist on the network.
Do not mark the payment as confirmed. See §4.

**If Horizon is timing out or returning 5xx:** the network may be degraded.
Do not take any irreversible action until Horizon responds. See §6 (escalation).

### 3.3 Check retry queue depth

```bash
# Admin API — retry queue status
GET /api/admin/retry-queue
Authorization: Bearer <admin-jwt>

# Prometheus metric (Grafana dashboard or direct query)
queue_depth{queue="transaction-processing"}
queue_failed{queue="transaction-dead-letter-queue"}
pending_verification_backlog{status="pending"}
pending_verification_backlog{status="dead_letter"}
```

A large backlog usually indicates a Horizon outage or Redis connectivity issue
rather than a single stuck payment. Check the health endpoint and system alerts.

```bash
GET /health
```

### 3.4 Check application logs

```bash
# Docker Compose
docker compose logs --since=1h backend | grep '<txHash>'

# Kubernetes
kubectl logs -l app=backend --since=1h | grep '<txHash>'
```

Look for:
- `Stellar network error` — Horizon connectivity issue
- `DUPLICATE_TX` — payment already recorded; status may be stale
- `MISSING_MEMO` — transaction memo did not match any student
- `INVALID_DESTINATION` — payment went to wrong wallet
- `AMOUNT_TOO_LOW` / `AMOUNT_TOO_HIGH` — fee validation failure
- `webhook retry exhausted` — downstream notification failed (not a payment issue)

---

## 4. Decision tree

Work through this tree in order. Do not skip steps.

```
Is Horizon returning the transaction?
│
├── NO (404)
│   ├── Was money actually sent? (confirm with the payer)
│   │   ├── YES → Transaction may be pending in mempool; wait 10 min and re-query
│   │   └── NO  → Mark payment as FAILED; document reason in audit log
│   └── Was it a testnet transaction submitted to mainnet (or vice versa)?
│       └── YES → Mark FAILED, notify user of network mismatch
│
├── YES, transaction is confirmed on Horizon (successful: true)
│   ├── MongoDB status = confirmed?
│   │   └── YES → No action needed; check if downstream systems (webhook, email) are the issue
│   ├── MongoDB status = pending / pending_verification / submitted?
│   │   └── Trigger a payment sync (see §5.1) — safe, idempotent
│   ├── MongoDB status = failed?
│   │   └── Status is incorrect — escalate to backend team for API-level correction (see §5.3)
│   └── MongoDB status = manual_review?
│       └── Verify amount matches expected fee, then clear to confirmed (see §5.2)
│
└── YES, transaction is on Horizon but NOT successful (successful: false)
    ├── MongoDB status = failed? → Correct; no action needed
    └── MongoDB status = anything else? → Trigger sync (§5.1); verify it transitions to failed
```

---

## 5. Safe remediation actions

### 5.1 Trigger a payment sync (safe — read from Stellar, no destructive writes)

This re-polls the Stellar Horizon API for the school's wallet and processes any
unrecorded transactions. It is **idempotent** — it will not double-record a
payment already in MongoDB.

**Requires:** `admin` JWT

```bash
POST /api/payments/sync
Authorization: Bearer <admin-jwt>
Content-Type: application/json
{}
```

After the sync completes, re-query the payment status. If it has not changed,
the transaction may not yet be confirmed on Stellar, or the memo may not match.

### 5.2 Re-drive a dead-letter verification job

If a payment verification job exhausted all retries and landed in the dead-letter
queue, an admin can re-trigger it once the underlying issue (e.g. Horizon outage)
is resolved.

**Requires:** `admin` JWT

```bash
# List dead-letter entries
GET /api/admin/retry-queue
Authorization: Bearer <admin-jwt>

# Re-drive a specific dead-letter job
POST /api/admin/retry-queue/<jobId>/retry
Authorization: Bearer <admin-jwt>
```

For the MongoDB retry backend, equivalent:

```js
// Read-only query first — confirm the record exists
db.pendingverifications.findOne({ txHash: '<hash>', status: 'dead_letter' })

// Escalate to backend team to reset status to 'pending' via admin API
```

### 5.3 Request an admin status correction

If a payment's MongoDB status is demonstrably wrong (e.g. `failed` when Horizon
confirms `successful: true`) and the sync in §5.1 did not resolve it, escalate
to the backend platform team.

Provide:
1. The payment `_id` and `txHash`
2. Evidence from Horizon (URL + response JSON, with no PII)
3. Current MongoDB status
4. Expected status and why

The backend team will update via an authenticated admin API call, not a direct
database write (see §7).

### 5.4 Acknowledge a manual-review payment

Payments in `manual_review` status were flagged by the fraud-detection or
fee-validation layer. Before clearing them:

1. Confirm the Horizon transaction is `successful: true` (§3.2).
2. Confirm the amount matches the student's expected fee (within configured tolerance).
3. Confirm the `memo` matches the student ID in the payment record.
4. Confirm no dispute has been opened for this payment.

If all checks pass, the backend team can clear the payment to `confirmed` via
the admin API. Document the approval in the audit log (§8).

---

## 6. Escalation criteria

Escalate to the backend platform team if:

- A single payment has been stuck for > 2 hours and a sync did not resolve it.
- More than 5 payments from the same school are stuck simultaneously.
- Horizon is returning `successful: true` but the status remains `failed` after a sync.
- The dead-letter queue depth is growing faster than 10 jobs/hour.
- Any payment record shows inconsistent data (e.g. `txHash` in MongoDB does not match Horizon).
- You are being asked to write directly to MongoDB (§7).

Escalate to the Stellar integration team if:

- Horizon itself is unavailable for > 30 minutes (check https://status.stellar.org).
- Horizon returns `successful: true` but the transaction memo cannot be decoded.
- Payments to the correct wallet are not appearing on Horizon.

When escalating, include:

- The incident record number
- A list of affected payment IDs, school IDs, and transaction hashes (no PII)
- Timeline of events with log excerpts
- What was already attempted

---

## 7. Prohibited manual edits

The following actions **must not be taken** without explicit authorisation from
the backend platform team and a documented change request:

| Prohibited action | Why |
|-------------------|-----|
| Direct `db.payments.updateOne(...)` or `db.payments.findOneAndUpdate(...)` | Bypasses audit log, status machine validation, and webhook notifications |
| Manually setting `status: 'confirmed'` without Horizon confirmation | Could result in unearned fee credit |
| Deleting a payment record | Destroys audit trail; may create orphaned student balance |
| Modifying `txHash` | Breaks idempotency checks; may allow double-payment |
| Resetting `attemptCount` to 0 without investigating the root failure | May re-trigger the same error in a loop |
| Modifying `studentId` or `schoolId` on an existing payment | Violates tenant isolation; may misattribute fees |
| Running `mongorestore --drop` against the production database during a live incident | Irreversible; destroys all records written since the backup |

If you believe a prohibited action is necessary, stop and escalate. The platform
team will assess whether an API-level correction is possible, or whether a
controlled maintenance window is required.

---

## 8. Audit requirements

Every remediation action must be recorded. For each action taken:

1. **Open an audit entry** via the admin audit log endpoint before making changes:
   ```bash
   # All state changes made via the admin API are automatically audit-logged.
   # For manual investigation steps, create an incident record externally.
   ```

2. **Record the following** in the incident management system:
   - Incident ID and time opened
   - Operator name and role
   - Affected payment IDs (no PII — omit student names, parent contact info)
   - Horizon evidence (URL queried, `successful` field value, `created_at`)
   - Action taken and API endpoint called
   - Before and after payment status
   - Time action completed and operator who verified it

3. **For any payment moved to `confirmed`:** retain the Horizon response as an
   attachment in the incident record. This is required for financial audit purposes.

4. **Automated audit log:** all changes made via the admin API are written to
   the `auditlogs` collection automatically. Verify the entry was created:
   ```js
   // Read-only check — db-reader role
   db.auditlogs.findOne({ resourceId: '<paymentId>' }, { _id: 1, action: 1, actor: 1, ts: 1 })
   ```

---

## 9. Post-incident checklist

After the stuck payment is resolved:

- [ ] Payment status in MongoDB matches Horizon (`successful` field)
- [ ] Student fee balance is updated correctly
- [ ] Webhook delivery was triggered (check delivery history: `GET /api/webhook-deliveries`)
- [ ] Email receipt was sent (check `emaildeliveries` collection or admin email log)
- [ ] Dispute, if any, was resolved or still correctly open
- [ ] Audit log entry created for each action taken
- [ ] Retry queue depth has returned to baseline (Prometheus `queue_depth` alert cleared)
- [ ] Root cause documented in the incident record
- [ ] If the root cause was a Horizon outage: confirm Horizon status page shows all systems operational before closing
- [ ] If the root cause was a Redis/queue issue: confirm `GET /health` returns `{ "status": "ok" }` for all subsystems
- [ ] Alert thresholds reviewed — if the alert fired too late, update Prometheus alert rules

---

## Related documentation

- [`docs/operator-runbooks.md`](../operator-runbooks.md) — general incident steps, Redis/queue runbook, Horizon outage runbook
- [`docs/retry-backends.md`](../retry-backends.md) — BullMQ vs MongoDB backend guarantee matrix
- [`docs/architecture.md`](../architecture.md) — payment pipeline data flow
- [`docs/stellar-integration.md`](../stellar-integration.md) — Horizon API details, memo field, asset types
- Prometheus alert rules: `monitoring/alerts/queue_backpressure.yml`, `monitoring/alerts/transaction_queue.yml`
