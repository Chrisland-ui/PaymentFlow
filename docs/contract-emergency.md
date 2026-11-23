# Contract Emergency Playbook

This document is for on-call engineers responding to a production incident that
requires invoking the emergency pause or upgrade controls for the PaymentFlow
payment-processing "contract" (the backend service that validates and records
Stellar payments).

**Keep this document bookmarked and accessible offline.** During an incident you
may not be able to reach internal wikis.

---

## Table of Contents

1. [Severity Framework](#1-severity-framework)
2. [Who Can Act](#2-who-can-act)
3. [Emergency Pause](#3-emergency-pause)
4. [Emergency Unpause](#4-emergency-unpause)
5. [Emergency Upgrade](#5-emergency-upgrade)
6. [Multisig Quorum Rules](#6-multisig-quorum-rules)
7. [API Quick Reference](#7-api-quick-reference)
8. [Post-Incident Checklist](#8-post-incident-checklist)
9. [Common Failure Modes](#9-common-failure-modes)
10. [Contacts](#10-contacts)

---

## 1. Severity Framework

| Severity | Description | Response SLO | Action |
|----------|-------------|-------------|--------|
| **SEV-1** | Active exploit; funds at risk; double-spend detected | 5 min | **Pause immediately**, then diagnose |
| **SEV-2** | Oracle failure; corrupt payment matching; data integrity at risk | 15 min | Pause, assess scope, decide on upgrade |
| **SEV-3** | Elevated error rate (< 5 % of payments); no confirmed financial loss | 30 min | Monitor; consider pause |
| **SEV-4** | Degraded performance; no functional impact | 60 min | Diagnose; no pause needed |

---

## 2. Who Can Act

The pause, unpause, and upgrade operations require **two-of-three** approvals
from the configured signer list before they execute.

### Authorised Signers

Set via the `MULTISIG_SIGNERS` environment variable (comma-separated admin
identities matching the `sub` or `email` field in admin JWTs):

```
MULTISIG_SIGNERS=alice@example.com,bob@example.com,carol@example.com
```

Any two of the three must approve before the operation executes. The proposer's
vote counts as the first approval. A second signer must call the approve
endpoint to reach quorum.

### Break-Glass

If `MULTISIG_SIGNERS` is **unset**, the service falls back to permissive mode:
any authenticated super-admin can propose and immediately execute with a single
approval. This is for development only. **Production deployments MUST set
`MULTISIG_SIGNERS`.**

If fewer than two signers are reachable, the infrastructure on-call lead can
temporarily add a signer via the secrets manager and restart backend pods. See
[Contacts](#10-contacts).

---

## 3. Emergency Pause

### When to Pause

Pause when:
- An exploit is actively draining funds or corrupting payment records
- The Stellar oracle is returning incorrect exchange rates and payments are
  being credited at wrong amounts
- A consistency check (`GET /api/consistency`) reports widespread orphaned or
  double-counted payments
- The incident commander declares SEV-1 or authorises a precautionary pause

**Do NOT pause** for transient network blips, elevated latency without data
corruption, or before routine deployments (use the maintenance-mode flag
instead).

### Pause Procedure

```
Step 1 — Signer A proposes the pause
Step 2 — Signer B approves → contract is immediately paused
```

**Step 1 — Propose (Signer A):**

```bash
curl -s -X POST https://api.example.com/api/admin/emergency/pause/propose \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"reason": "SEV-1: suspected double-spend in payment verify endpoint"}'
```

Response (HTTP 202):

```json
{
  "message": "Pause proposal created. A second authorised signer must approve...",
  "approvalId": "6731a4c1b2e...",
  "status": "pending",
  "approvals": 1,
  "required": 2,
  "expiresAt": "2026-10-23T09:18:00.000Z"
}
```

Share the `approvalId` with Signer B immediately via the incident channel.

**Step 2 — Approve (Signer B):**

```bash
curl -s -X POST https://api.example.com/api/admin/emergency/pause/approve/<APPROVAL_ID> \
  -H "Authorization: Bearer $SIGNER_B_JWT" \
  -H "Content-Type: application/json"
```

Response (HTTP 200 with `"executed": true`) confirms the contract is paused.

**Confirm the pause is active:**

```bash
curl -s https://api.example.com/api/admin/emergency/status \
  -H "Authorization: Bearer $ADMIN_JWT"
# → "contractPaused": true
```

Verify a state-changing request now returns `CONTRACT_PAUSED`:

```bash
curl -s -X POST https://api.example.com/api/payments/verify \
  -H "Content-Type: application/json" \
  -d '{"txHash": "test"}'
# → HTTP 503, {"error":"...","code":"CONTRACT_PAUSED"}
```

### What Pausing Blocks vs. Allows

**Pausing BLOCKS (returns HTTP 503 `CONTRACT_PAUSED`):**
- `POST /api/payments/verify` — new payment verification
- `POST /api/payments/intent` — payment intent creation
- `POST /api/payments/submit` — transaction submission
- `POST /api/payments/sync` — manual blockchain sync trigger
- `POST /api/payments/finalize` — payment finalisation
- `PATCH /api/payments/:txHash/status` — manual status updates
- `PATCH /api/payments/bulk/status` — bulk status updates
- `POST /api/payments/:txHash/refund` — refund initiation
- `POST /api/students` — student registration
- `PUT/DELETE /api/students/:id` — student record mutations
- `POST/PUT/DELETE /api/fees` — fee structure mutations

**Pausing does NOT block:**
- All `GET` read-only routes (operators can still inspect the system)
- `/health` and `/metrics` (monitoring must continue working)
- `/api/auth` (admins must be able to log in)
- `/api/admin/emergency` (the pause controls must remain reachable)

> **Background polling note:** The `transactionPollingService` runs as a
> background timer inside the Node.js process — it is not guarded by the HTTP
> middleware. If the polling service is the source of the incident, stop it by
> setting `POLL_INTERVAL_MS=0` and cycling pods, or scale replicas to zero.

---

## 4. Emergency Unpause

Only unpause after:
1. The root cause has been identified and confirmed resolved (or the issue was a
   false alarm)
2. A post-mortem ticket has been created
3. The incident commander explicitly signs off

**Never rush the unpause.** A 30-minute pause costs far less than a second
exploit.

```bash
# Step 1 — Signer A proposes
curl -s -X POST https://api.example.com/api/admin/emergency/unpause/propose \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Root cause fixed (PR #1234 deployed). Safe to resume."}'

# Step 2 — Signer B approves
curl -s -X POST https://api.example.com/api/admin/emergency/unpause/approve/<APPROVAL_ID> \
  -H "Authorization: Bearer $SIGNER_B_JWT" \
  -H "Content-Type: application/json"
```

After unpausing, run the consistency check:

```bash
curl -s https://api.example.com/api/consistency \
  -H "Authorization: Bearer $ADMIN_JWT"
```

---

## 5. Emergency Upgrade

### When to Upgrade

Upgrade when a security patch must be deployed immediately and the fix requires
a new version of the running backend — i.e. a pause alone is insufficient
because the corrective behaviour must be live before the system can safely
resume.

The upgrade workflow authorises a specific deployment artefact before it goes
live, preventing an untested or rogue build from being deployed under pressure.

### Upgrade Procedure

```
Step 1 — Build and tag the patched image, obtain its digest
Step 2 — Signer A proposes the upgrade with newVersionHash
Step 3 — Signer B approves → deployment is authorised
Step 4 — CI/CD or on-call engineer deploys and verifies
```

**Step 1 — Build:**

```bash
docker build -t paymentflow-backend:hotfix-<TICKET> .
docker push registry.example.com/paymentflow-backend:hotfix-<TICKET>

# Obtain the SHA-256 image digest
docker inspect registry.example.com/paymentflow-backend:hotfix-<TICKET> \
  --format='{{index .RepoDigests 0}}'
# → sha256:abc123def456...  ← this is your newVersionHash
```

**Step 2 — Propose (Signer A):**

`newVersionHash` is the SHA-256 digest of the new container image (or the git
commit SHA). This is the direct analogue of Soroban's `new_wasm_hash` parameter
in `update_current_contract_wasm`.

```bash
curl -s -X POST https://api.example.com/api/admin/emergency/upgrade/propose \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "newVersionHash": "abc123def456...",
    "reason": "Security patch for double-spend in verifyPayment (CVE-2026-XXXX)"
  }'
```

**Step 3 — Approve (Signer B):**

```bash
curl -s -X POST https://api.example.com/api/admin/emergency/upgrade/approve/<APPROVAL_ID> \
  -H "Authorization: Bearer $SIGNER_B_JWT" \
  -H "Content-Type: application/json"
```

Response includes `"executed": true` and the authorised `newVersionHash`.

**Step 4 — Deploy and verify:**

The CI/CD pipeline must verify the image digest matches the approved hash before
deploying:

```bash
# In pipeline
APPROVED_HASH=$(curl -s https://api.example.com/api/admin/emergency/approvals \
  -H "Authorization: Bearer $CI_ADMIN_JWT" \
  | jq -r '.approvals[]
      | select(.operationType == "upgrade" and .status == "executed")
      | .payload.newVersionHash' \
  | head -1)

if [ "$APPROVED_HASH" != "$DEPLOY_HASH" ]; then
  echo "ERROR: deploy hash does not match approved hash — aborting"
  exit 1
fi

kubectl set image deployment/backend \
  backend=registry.example.com/paymentflow-backend@sha256:${DEPLOY_HASH}
```

### How This Maps to Soroban

In Soroban, `update_current_contract_wasm(new_wasm_hash)` atomically replaces
the running WASM binary. The PaymentFlow equivalent preserves the same
properties:

| Soroban concept | PaymentFlow equivalent |
|-----------------|----------------------|
| WASM binary | Docker image / git commit |
| `new_wasm_hash` | `newVersionHash` (image SHA-256 or commit SHA) |
| `update_current_contract_wasm` tx | `kubectl set image` / CI/CD deploy |
| Ledger-level atomicity | Approval document locked before deploy; pipeline verifies hash before applying |
| Two-of-N authorisation | `MULTISIG_REQUIRED_SIGNERS` threshold enforced by `PendingApproval` model |

The key property preserved: **no deployment may proceed without a recorded,
multi-party authorisation of the specific artefact being deployed.**

---

## 6. Multisig Quorum Rules

| Rule | Default | Override via env |
|------|---------|-----------------|
| Required approvals | 2 | `MULTISIG_REQUIRED_SIGNERS` |
| Approval TTL | 24 hours | `MULTISIG_APPROVAL_TTL_HOURS` |
| Authorised signers | (see env) | `MULTISIG_SIGNERS` |

- A signer may not vote twice on the same proposal.
- Any single rejection immediately closes the proposal (no majority needed to
  block). To retry after a rejection, re-propose.
- Only one `pending` proposal per operation type may exist at a time.
- Expired documents are automatically purged from MongoDB after 7 days.

---

## 7. API Quick Reference

All endpoints require `Authorization: Bearer <super-admin JWT>`.

```
# Status
GET    /api/admin/emergency/status
GET    /api/admin/emergency/approvals
GET    /api/admin/emergency/approvals/:id

# Pause
POST   /api/admin/emergency/pause/propose        body: { reason }
POST   /api/admin/emergency/pause/approve/:id    body: {}
POST   /api/admin/emergency/pause/reject/:id     body: { reason }

# Unpause
POST   /api/admin/emergency/unpause/propose      body: { reason }
POST   /api/admin/emergency/unpause/approve/:id  body: {}
POST   /api/admin/emergency/unpause/reject/:id   body: { reason }

# Upgrade
POST   /api/admin/emergency/upgrade/propose      body: { newVersionHash, reason }
POST   /api/admin/emergency/upgrade/approve/:id  body: {}
POST   /api/admin/emergency/upgrade/reject/:id   body: { reason }
```

**Error codes:**

| Code | HTTP | Meaning |
|------|------|---------|
| `SIGNER_NOT_AUTHORISED` | 403 | Your identity is not in `MULTISIG_SIGNERS` |
| `DUPLICATE_PROPOSAL` | 409 | An open proposal of this type already exists |
| `NOT_FOUND` | 404 | The approval ID does not exist |
| `INVALID_STATE` | 409 | The proposal is not in `pending` state |
| `ALREADY_VOTED` | 409 | You have already voted on this proposal |
| `APPROVAL_EXPIRED` | 410 | The TTL elapsed before quorum was reached |
| `CONTRACT_PAUSED` | 503 | State-changing request rejected — contract is paused |

---

## 8. Post-Incident Checklist

Complete within 24 hours of resolving the incident:

- [ ] Confirm the contract is unpaused (`GET /api/admin/emergency/status`)
- [ ] Run consistency check and confirm no anomalies (`GET /api/consistency`)
- [ ] Review audit logs:
  ```
  GET /api/audit?action=contract_pause
  GET /api/audit?action=contract_unpause
  GET /api/audit?action=contract_upgrade_authorised
  ```
- [ ] Confirm all `PendingApproval` docs are in `executed` or `rejected` state
- [ ] Open a post-mortem ticket and link the audit log entries
- [ ] Identify whether this runbook needs updating and open a PR
- [ ] Notify affected schools with a status update within 48 hours
- [ ] Assess whether the `MULTISIG_SIGNERS` list needs rotation

---

## 9. Common Failure Modes

### "SIGNER_NOT_AUTHORISED"

Your admin JWT identity is not in `MULTISIG_SIGNERS`. Ask another authorised
signer to propose, or have infrastructure update the secret and cycle pods.

### "DUPLICATE_PROPOSAL"

A previous proposal is still open. Check:

```bash
curl https://api.example.com/api/admin/emergency/approvals \
  -H "Authorization: Bearer $ADMIN_JWT"
```

If the existing proposal is still valid, proceed to approve it. To cancel,
reject it first, then re-propose.

### Quorum not reached before expiry

The 24-hour TTL elapsed. The proposal transitions to `expired`. Re-propose.

### Background polling continues while paused

The `contractPaused` HTTP middleware only guards HTTP routes. The background
`transactionPollingService` runs on a process timer and is not intercepted. To
stop it:

1. **Preferred:** Set `POLL_INTERVAL_MS=0` and roll pods
2. **Nuclear:** Scale down all backend pods:
   `kubectl scale deployment/backend --replicas=0`

### Emergency endpoints are unreachable (full API down)

Connect directly to MongoDB:

```js
// mongosh
db.systemconfigs.updateOne(
  { key: 'contractPaused' },
  { $set: { value: true } },
  { upsert: true }
)
```

The backend reads this on the next request (cache TTL ≤ 100 ms). Document the
break-glass action in a manual audit log entry.

---

## 10. Contacts

| Role | Contact | Availability |
|------|---------|-------------|
| Platform on-call | PagerDuty rotation | 24/7 |
| Platform engineering lead | (see internal directory) | Business hours; SEV-1 after hours |
| Infrastructure / secrets | (see internal directory) | For `MULTISIG_SIGNERS` changes |
| Security team | (see internal directory) | CVE / exploit response |

For Stellar-specific emergencies (Horizon outage, network halt) see the
[Stellar status page](https://status.stellar.org/) and
[docs/stellar-integration.md](./stellar-integration.md).

---

*Document owner: Platform Engineering*  
*Last updated: 2026-10-22*  
*Review cadence: Quarterly and after every SEV-1/SEV-2 incident*
