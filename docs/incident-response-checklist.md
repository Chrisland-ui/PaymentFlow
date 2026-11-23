# Incident Response Checklist

> **Purpose:** Provide a repeatable, auditable procedure for handling production
> incidents in PaymentFlow. Every step below must be recorded with a timestamp
> and the operator who performed it. No step may be skipped without an explicit
> documented reason.

---

## Table of Contents

1. [Roles and Escalation Channels](#1-roles-and-escalation-channels)
2. [Severity Classification](#2-severity-classification)
3. [Phase 1 — Detection and Triage](#3-phase-1--detection-and-triage)
4. [Phase 2 — Containment](#4-phase-2--containment)
5. [Phase 3 — Evidence Preservation](#5-phase-3--evidence-preservation)
6. [Phase 4 — Communication](#6-phase-4--communication)
7. [Phase 5 — Recovery](#7-phase-5--recovery)
8. [Phase 6 — Post-Incident Review](#8-phase-6--post-incident-review)
9. [Scenario: Credential Exposure](#9-scenario-credential-exposure)
10. [Scenario: Payment Integrity Breach](#10-scenario-payment-integrity-breach)
11. [Auditability Requirements](#11-auditability-requirements)

---

## 1. Roles and Escalation Channels

| Role | Responsibility | Primary Channel |
|------|---------------|-----------------|
| **Incident Commander (IC)** | Owns the incident end-to-end; makes go/no-go decisions for each phase | `#incidents` Slack channel (pin the thread) |
| **API Operator** | Monitors backend health, logs, Prometheus/Grafana, and applies hotfixes | `#backend-on-call` |
| **Database Operator** | Handles MongoDB replica-set health, backups, and restore procedures | `#db-on-call` |
| **Blockchain Operator** | Monitors Stellar Horizon connectivity, transaction queue, and finality | `#blockchain-on-call` |
| **Communications Owner** | Drafts and sends external status updates; manages the status page | `#comms-on-call` |
| **Security Lead** | Engaged whenever credential exposure or data breach is suspected | `#security-incidents` (private) |

**Escalation path:**
1. On-call engineer detects or is paged about an incident.
2. If the incident cannot be resolved within 15 minutes, the on-call engineer
   assigns or self-nominates as Incident Commander and pages the relevant
   operators.
3. For SEV-1 or any credential-exposure scenario, the Security Lead is paged
   immediately regardless of time of day.
4. For payment integrity issues, the Incident Commander also notifies the
   product owner.

---

## 2. Severity Classification

| Severity | Criteria | Target Time-to-Acknowledge | Target Time-to-Mitigate |
|----------|----------|---------------------------|------------------------|
| **SEV-1** | Payment processing down for all tenants; data breach suspected; credential exposure confirmed | 5 minutes | 30 minutes |
| **SEV-2** | Payment processing degraded for ≥1 tenant; sync lag > 15 minutes; queue depth > 200 | 15 minutes | 2 hours |
| **SEV-3** | Single non-critical feature degraded; sync lag 5–15 minutes; queue depth 50–200 | 30 minutes | Next business day |
| **SEV-4** | Informational; no customer impact; fix can wait for the next sprint | 4 hours | Next sprint |

---

## 3. Phase 1 — Detection and Triage

> **Owner:** First responder → Incident Commander

- [ ] **Record incident open time** (ISO-8601 UTC) and initial alert source (Grafana alert / user report / automated health check).
- [ ] **Create an incident record** in the incident tracker with: time, environment (testnet / mainnet), reporter, and initial description.
- [ ] **Assign severity** using the table in §2.
- [ ] **Assign roles** — at minimum Incident Commander and API Operator.
- [ ] **Open a dedicated incident thread** in `#incidents` Slack. Pin the thread URL in the incident record.
- [ ] **Freeze non-essential deployments** — post in `#deploys` that a deployment freeze is in effect.
- [ ] **Check the health endpoint:**
  ```sh
  curl -s https://<host>/health | jq .
  ```
  Record the full response (status, subsystem details, log level, version).
- [ ] **Check Prometheus/Grafana** — note which dashboards are alerting:
  - API Errors (`monitoring/alerts/api_errors.yml`)
  - API Latency (`monitoring/alerts/api_latency.yml`)
  - MongoDB (`monitoring/alerts/mongodb.yml`)
  - Transaction Queue (`monitoring/alerts/transaction_queue.yml`)
  - Horizon Poll (`monitoring/alerts/horizon_poll.yml`)
  - Queue Backpressure (`monitoring/alerts/queue_backpressure.yml`)
- [ ] **Triage the payment pipeline:** Are payments being accepted? Are they being confirmed on-chain? Is the retry queue growing?
- [ ] **Record findings** in the incident thread before moving to Phase 2.

---

## 4. Phase 2 — Containment

> **Owner:** Incident Commander + API Operator

- [ ] **Assess blast radius** — how many tenants / students are affected?
- [ ] **Decide operating mode:**
  - *Full recovery:* system remains online; operators work to restore service.
  - *Read-only mode:* disable payment creation while preserving reads. Enable by setting `MAINTENANCE_MODE=true` and redeploying.
  - *Maintenance mode:* full maintenance page for all tenants.
- [ ] **Stop workers if they are making things worse** (e.g. hammering a degraded Horizon endpoint or writing corrupt state):
  ```sh
  # Scale down workers without taking down the API
  kubectl scale deployment backend --replicas=0 -l role=worker
  ```
  Record the replica count before scaling down.
- [ ] **Isolate the affected tenant(s)** if the issue is tenant-specific — disable their school record and communicate separately.
- [ ] **If Stellar Horizon is unreachable:** stop new transaction submissions (do not mark unknown payments as failed until ledger status is confirmed). See runbook: `docs/operator-runbooks.md § Horizon Or Stellar Network Down`.
- [ ] **If MongoDB is unreachable:** stop all workers before they perform external writes that cannot be persisted. See runbook: `docs/operator-runbooks.md § Mongo Or Database Down`.
- [ ] **If Redis / BullMQ is down:** put payment creation into read-only mode. Confirm that no jobs are lost before restarting. See runbook: `docs/operator-runbooks.md § Redis Or Queue Down`.
- [ ] **Document every containment action** (what was done, why, and by whom) in the incident thread.

---

## 5. Phase 3 — Evidence Preservation

> **Owner:** Database Operator + API Operator  
> **Critical:** Evidence must be preserved **before** any remediation that could overwrite it.

- [ ] **Snapshot the database** immediately:
  ```sh
  ./scripts/backup.sh
  ```
  Record the backup filename and storage location in the incident record.
- [ ] **Capture a log bundle** — collect structured JSON logs from the affected time window:
  ```sh
  # Docker / local
  docker logs <backend-container> --since=<ISO-time> > incident-<date>-backend.log

  # Kubernetes
  kubectl logs deployment/backend --since=<duration> > incident-<date>-backend.log
  ```
- [ ] **Export Prometheus metrics snapshot** (scrape `/metrics` or use the Grafana export panel) for the incident time range.
- [ ] **Record the deployment SHA** currently running:
  ```sh
  kubectl get deployment backend -o jsonpath='{.spec.template.spec.containers[0].image}'
  ```
- [ ] **Capture queue state** (BullMQ job counts: waiting / active / failed / delayed):
  ```sh
  curl -s https://<host>/api/admin/retry-queue -H "Authorization: Bearer <token>" | jq .
  ```
- [ ] **Do not delete or rotate any credentials or logs** until the Security Lead has approved it, even if the logs contain sensitive-looking data. Log entries are evidence.
- [ ] **Confirm that no PII or secrets have leaked** into public channels, screenshots, or issue comments. If they have, revoke the credentials immediately and involve the Security Lead.

---

## 6. Phase 4 — Communication

> **Owner:** Communications Owner, guided by Incident Commander

- [ ] **Internal update within 15 minutes of SEV-1/SEV-2 declaration:** post in `#incidents` with: severity, systems affected, current status, and next update time.
- [ ] **External status page update** (if customer-visible impact): use templated language; no technical details that reveal vulnerabilities.
- [ ] **Notify affected school administrators** via the platform's reminder/notification channel — keep messaging factual, avoid blame, and do not speculate on root cause.
- [ ] **Regular cadence updates:** every 30 minutes for SEV-1, every 1 hour for SEV-2, until the incident is resolved.
- [ ] **All-clear communication** once service is fully restored, including:
  - What was the impact?
  - When was the issue detected, mitigated, and resolved?
  - What should affected users do (e.g. re-verify a payment, check their dashboard)?

---

## 7. Phase 5 — Recovery

> **Owner:** Incident Commander + all operators

- [ ] **Identify root cause** before applying any fix that could obscure evidence.
- [ ] **Apply the smallest possible fix** — prefer a targeted patch over a full redeployment where possible.
- [ ] **Restore from backup if needed** — follow the procedure in `docs/operator-runbooks.md § Restore Procedure`. Always do a dry run first:
  ```sh
  BACKUP_FILE=./backups/<filename>.gz MONGO_URI=<uri> ./scripts/restore.sh --dry-run
  ```
- [ ] **Re-run database migrations** after any restore:
  ```sh
  node scripts/migrate.js
  ```
- [ ] **Run the consistency check** to confirm no orphaned or inconsistent records:
  ```sh
  curl -s https://<host>/consistency -H "Authorization: Bearer <token>" | jq .
  ```
- [ ] **Process stuck payments:**
  - Query Stellar/Horizon directly for any payment with an unknown state.
  - If confirmed on-chain, update the payment record with an audit reason.
  - If failed, mark as failed with the failure reason.
  - Do not retry automatically if state is ambiguous — mark as `manual-review`.
- [ ] **Restore worker replicas** to their pre-incident count.
- [ ] **Lift deployment freeze** only after health checks pass and payment processing is confirmed end-to-end.
- [ ] **Verify the retry queue is draining:**
  ```sh
  curl -s https://<host>/api/admin/retry-queue -H "Authorization: Bearer <token>" | jq .
  ```
- [ ] **Confirm `/health` returns `{"status":"ok"}`** across all pods.
- [ ] **Record the incident close time** (ISO-8601 UTC) and recovery duration.

---

## 8. Phase 6 — Post-Incident Review

> **Owner:** Incident Commander  
> **Deadline:** Within 5 business days of incident close for SEV-1/SEV-2; within 2 weeks for SEV-3.

- [ ] **Write a post-incident review (PIR) document** covering:
  - Timeline (detection → containment → resolution)
  - Root cause (technical and process)
  - Impact (tenants affected, payments impacted, duration)
  - What went well
  - What went wrong
  - Action items with owners and due dates
- [ ] **Share the PIR** in `#incidents` and with affected school administrators if appropriate.
- [ ] **Update this checklist and relevant runbooks** if any step was unclear or missing.
- [ ] **File issues** for all identified action items. Label them `incident-followup` and link to the PIR.
- [ ] **Conduct a 30-day check-in** to verify that action items are on track.
- [ ] **Archive the incident record, log bundle, and backup snapshot** in the designated storage for at least 90 days.

---

## 9. Scenario: Credential Exposure

> Triggered when: a secret (JWT_SECRET, SIGNER_MASTER_KEY, WEBHOOK_SECRET_ENCRYPTION_KEY,
> database credentials, or any API key) may have been exposed via logs, a public
> repository, a screenshot, or an access by an unauthorized party.

**Immediate actions (within 10 minutes):**

- [ ] Page the Security Lead immediately via `#security-incidents`.
- [ ] Confirm what was exposed (which secret, to which channel, at what time).
- [ ] **Do not rotate the secret yet** — the Security Lead must first assess whether the incident log needs to capture the current state.
- [ ] Ensure that the exposed secret has not already been used to authenticate (check audit logs).

**Containment:**

- [ ] **Revoke / rotate the exposed credential** using the appropriate script:
  - JWT secret: `node scripts/rotate-jwt-secret.js --confirm` (invalidates all active sessions)
  - Stellar signer key: `node scripts/rotate-signer-master-key.js --apply`
  - Webhook encryption key: `node scripts/rotate-webhook-encryption-key.js --apply`
  - Database / queue credentials: follow the general rotation order in `docs/operator-runbooks.md § Key Rotation`.
- [ ] After rotation, redeploy the backend so the new secret is loaded.
- [ ] Verify that the old credential is no longer accepted (test a request signed with the old key — it must fail).
- [ ] **Remove the exposed value from any public location** (git history, issue comments, Slack messages). Use `git filter-repo` or GitHub Support for history removal.
- [ ] For JWT rotation: inform all school administrators that they must re-login; enrolled MFA users must re-enrol.

**Evidence and reporting:**

- [ ] Document the scope: which credentials, which systems, suspected access window, any evidence of misuse.
- [ ] Determine if the exposure constitutes a reportable data breach under applicable regulations.
- [ ] The Security Lead approves the post-incident communication.

---

## 10. Scenario: Payment Integrity Breach

> Triggered when: payments may be duplicated, missing, have incorrect amounts,
> or on-chain records do not match the database.

**Immediate actions:**

- [ ] Stop the transaction polling service and BullMQ workers immediately to prevent further state corruption.
- [ ] Take a database snapshot (§5 above).
- [ ] **Do not mark any payment as failed or complete** until the on-chain state is confirmed via Horizon.

**Investigation:**

- [ ] For every affected payment: query Stellar Horizon directly using the transaction hash.
  ```sh
  curl "https://horizon-testnet.stellar.org/transactions/<txHash>"
  ```
- [ ] Cross-reference the `memo` field with the student record to confirm correct attribution.
- [ ] Check for duplicate `idempotency_key` records (idempotency violations).
- [ ] Check the audit log for any manual status overrides that may have caused divergence.
- [ ] Run the consistency check endpoint:
  ```sh
  curl -s https://<host>/consistency -H "Authorization: Bearer <token>" | jq .
  ```

**Remediation:**

- [ ] For each payment with a confirmed on-chain hash:
  - If the database record is missing → create it with an audit note: `"Restored during incident <ID>"`.
  - If the status is wrong → correct it with an audit note.
  - If the amount is wrong → flag for manual review; do not auto-correct until the root cause is known.
- [ ] For payments with no on-chain hash and no funds transferred → safe to cancel with audit note.
- [ ] For payments with no on-chain hash but funds confirmed received → escalate to the blockchain operator; funds may have been received off-memo.
- [ ] Notify affected schools and parents through the platform's official channel.
- [ ] All corrections must be logged in the audit trail with: operator, reason, incident ID, and timestamp.

---

## 11. Auditability Requirements

All incident actions must satisfy the following to be considered auditable:

| Requirement | Detail |
|------------|--------|
| **Timestamped** | Every action records its UTC timestamp in ISO-8601 format |
| **Attributed** | Every action records the operator who performed it (name + role) |
| **Linked** | Every action references the incident record ID |
| **Immutable** | The incident record and audit log entries must not be edited after the fact — append corrections rather than overwriting |
| **Retained** | All incident artefacts (logs, backups, PIR) retained for ≥ 90 days |
| **No secrets in records** | Credential values must never appear in the incident record, Slack, or PIR — reference them by name only (e.g. `JWT_SECRET`) |
| **No PII in records** | Student names, payment amounts associated with identifiable individuals, and school-specific financial data must not appear in public channels or shared PIR documents |

---

*Last reviewed: 2026-09-27. Review this document after every SEV-1 incident and at least every 6 months.*
