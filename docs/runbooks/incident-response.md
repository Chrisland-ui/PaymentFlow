# Incident Response Runbook

> **Audience:** On-call engineers, incident commanders, and communications owners.
> This runbook defines severity levels, response SLAs, escalation paths,
> first-30-minutes procedures, and school communication templates for PaymentFlow.
>
> Keep this document open during an incident. Record every action with a timestamp
> and the name of the person who took it.

---

## Table of Contents

- [Severity Framework](#severity-framework)
  - [P1 — Platform Down](#p1--platform-down)
  - [P2 — Major Feature Broken](#p2--major-feature-broken)
  - [P3 — Minor Degradation](#p3--minor-degradation)
- [Escalation Contacts](#escalation-contacts)
- [First 30 Minutes — Any Incident](#first-30-minutes--any-incident)
- [P1 Response Procedure](#p1-response-procedure)
- [P2 Response Procedure](#p2-response-procedure)
- [P3 Response Procedure](#p3-response-procedure)
- [Diagnostic Quick Reference](#diagnostic-quick-reference)
- [Post-Incident Review Template](#post-incident-review-template)
- [School Communication Templates](#school-communication-templates)
  - [P1 Initial Notification](#p1-initial-notification)
  - [P1 Resolution Notice](#p1-resolution-notice)
  - [P2 Initial Notification](#p2-initial-notification)
  - [P2 Resolution Notice](#p2-resolution-notice)

---

## Severity Framework

### P1 — Platform Down

**Definition:** The platform is entirely unavailable or payment processing is
completely broken. No school can accept or verify payments. Data integrity may
be at risk.

**Examples for PaymentFlow:**
- `GET /health` returns `503 unhealthy` for ≥ 2 consecutive checks
- MongoDB replica set primary is unavailable
- All payment verification (`POST /api/payments/verify`) requests return 5xx
- Transaction polling has stopped syncing for > 30 minutes
- A security breach is confirmed or strongly suspected (credential exposure, PII leak)
- Stellar Horizon is unreachable and the retry queue is growing unboundedly

**Response SLA:**
- Acknowledge (on-call engineer responds): **within 5 minutes of alert**
- Incident Commander assigned: **within 10 minutes**
- First status update to affected schools: **within 30 minutes**
- Subsequent updates: **every 30 minutes** until resolution
- Target time-to-resolution: **2 hours**

---

### P2 — Major Feature Broken

**Definition:** A significant feature is degraded or unavailable, but the platform
is partially operational. Some schools can still accept payments.

**Examples for PaymentFlow:**
- Payment verification is slow (p95 > 30 s) but still succeeding
- A single school's webhook delivery is failing consistently
- The admin dashboard is inaccessible but the payment API is working
- BullMQ / Redis is down and the system has fallen back to MongoDB retries
- Bulk CSV student import is failing for all schools
- Dispute creation or management is unavailable
- Reports cannot be generated

**Response SLA:**
- Acknowledge: **within 15 minutes of alert**
- Incident Commander assigned: **within 30 minutes** (may be the on-call engineer)
- First status update to affected schools: **within 1 hour** (only if schools are directly affected)
- Subsequent updates: **every hour** until resolution
- Target time-to-resolution: **4 hours**

---

### P3 — Minor Degradation

**Definition:** A non-critical feature is degraded or a minor bug is causing
inconvenience, but payments and core operations are working correctly.

**Examples for PaymentFlow:**
- A non-critical log error is occurring at elevated rate
- Prometheus metrics scraping is failing (monitoring blind spot, not a service failure)
- Email reminders are not sending but payment operations are unaffected
- Swagger UI (`/api/docs`) is unreachable in a development environment
- A single student's record is incorrectly soft-deleted

**Response SLA:**
- Acknowledge: **within 2 hours** (during business hours); **next business day** (outside hours)
- No school communication required unless the school specifically requests an update
- Target time-to-resolution: **next business day**

---

## Escalation Contacts

> **Important:** Replace the placeholder values below with real contact
> information before publishing this runbook. Store sensitive contact details
> (personal mobile numbers) in your secret manager, not in this file.

| Role | Primary Contact | Backup Contact | Channel |
|------|----------------|----------------|---------|
| **On-Call Engineer (primary)** | `[PRIMARY_ONCALL_NAME]` — `[PRIMARY_ONCALL_PHONE]` | `[BACKUP_ONCALL_NAME]` — `[BACKUP_ONCALL_PHONE]` | PagerDuty / `#incidents` |
| **Incident Commander pool** | `[IC_1_NAME]` | `[IC_2_NAME]` | `#incidents` Slack |
| **Database Operator** | `[DB_OPERATOR_NAME]` — `[DB_OPERATOR_PHONE]` | `[DB_BACKUP_NAME]` | `#db-on-call` |
| **Blockchain Operator** | `[BLOCKCHAIN_OPERATOR_NAME]` — `[BLOCKCHAIN_OPERATOR_PHONE]` | `[BLOCKCHAIN_BACKUP_NAME]` | `#blockchain-on-call` |
| **Security Lead** | `[SECURITY_LEAD_NAME]` — `[SECURITY_LEAD_PHONE]` | `[SECURITY_BACKUP_NAME]` | `#security-incidents` (private) |
| **Communications Owner** | `[COMMS_NAME]` — `[COMMS_PHONE]` | `[COMMS_BACKUP_NAME]` | `#comms-on-call` |
| **Engineering Manager** | `[EM_NAME]` — `[EM_PHONE]` | — | Direct call for P1 only |
| **Product Owner** | `[PO_NAME]` | — | `#product` for P1/P2 payment integrity |

**Escalation trigger conditions:**

| Condition | Who to page |
|-----------|------------|
| P1 declared | Incident Commander + Database Operator + Blockchain Operator |
| Any credential exposure suspected | Security Lead immediately (day or night) |
| P1 not resolved in 1 hour | Engineering Manager |
| Payment integrity breach confirmed | Product Owner + Engineering Manager |
| School threatening legal action | Engineering Manager + Communications Owner |

---

## First 30 Minutes — Any Incident

Work through these steps in order. Record each step in the incident thread with
a timestamp.

```
[ ] 00:00 — DETECT
        Receive alert or report. Note exact time and alert source.
        Command: curl -s https://[PRODUCTION_URL]/health | jq

[ ] 00:02 — ASSESS SEVERITY
        Determine P1 / P2 / P3 using the criteria above.
        If unsure, treat as P1 until proven otherwise.

[ ] 00:05 — OPEN INCIDENT THREAD
        Post in #incidents:
        "🚨 INCIDENT OPENED [P1/P2/P3] — [one-line description]
         Time: [HH:MM UTC]
         IC: @[your name]
         Status: Investigating"

[ ] 00:05 — PAGE RESPONDERS (P1/P2 only)
        Page roles per the escalation table above.

[ ] 00:10 — GATHER INITIAL DIAGNOSTICS
        See Diagnostic Quick Reference below.
        Copy relevant log lines and metrics into the incident thread.

[ ] 00:15 — FORM HYPOTHESIS
        State in the incident thread: "Best current hypothesis: [X]"
        Assign one engineer to investigate; others stand by.

[ ] 00:20 — DECIDE: MITIGATE OR FIX
        Can you apply a safe mitigation (restart, rollback, feature flag)?
        If yes, apply it now and observe.
        If no, continue investigation and move to the P1/P2 procedure.

[ ] 00:25 — DRAFT SCHOOL COMMUNICATION (P1/P2 only)
        Communications Owner begins drafting from the template below.
        Do not send until IC approves.

[ ] 00:30 — FIRST STATUS UPDATE
        IC posts update in #incidents:
        "Status update [HH:MM UTC]: [what we know / what we're doing next]"
        Communications Owner sends school notification (P1) if approved.
```

---

## P1 Response Procedure

### 1. Stabilise

Attempt mitigation in this order. Stop when the service recovers.

```bash
# 1a. Check health endpoint
curl -s https://[PRODUCTION_URL]/health | jq

# 1b. Check all container health (Docker / Kubernetes)
docker compose ps            # Docker Compose
kubectl get pods -n paymentflow   # Kubernetes

# 1c. Restart the backend (stateless — safe to restart)
docker compose restart backend
# or: kubectl rollout restart deployment/backend -n paymentflow

# 1d. Check MongoDB replica set status
docker compose exec mongo mongosh --quiet --eval 'rs.status()'
# Look for: members[n].stateStr === "PRIMARY"
# If no primary: see docs/runbooks/stuck-payments.md for replica set recovery

# 1e. Check Stellar Horizon connectivity
curl -s https://horizon-testnet.stellar.org/  # or mainnet
# If unreachable: the app will degrade gracefully; payments queue up for retry

# 1f. If a bad deploy caused the outage, roll back:
git log --oneline -5    # identify last known-good commit
git checkout <commit>   # on a hotfix branch; deploy via standard process
```

### 2. Communicate

- Send P1 initial notification within 30 minutes (see template below).
- Update `#incidents` every 30 minutes.
- Do not speculate about cause in school-facing communications.

### 3. Preserve evidence

Before any destructive action (container restart, volume wipe):

```bash
# Capture logs
docker compose logs --no-color > /tmp/incident-$(date +%Y%m%dT%H%M%S)-backend.log
# Upload to incident channel immediately
```

### 4. Resolve and close

Once the platform is confirmed healthy:

```bash
curl -s https://[PRODUCTION_URL]/health | jq
# Expect: {"status":"ok"}
```

- Post resolution in `#incidents`.
- Send P1 resolution notice to schools.
- Schedule post-incident review within **48 hours**.

---

## P2 Response Procedure

1. Confirm impact scope: which schools or features are affected?
2. Check whether a recent deployment is correlated with the degradation.
3. Apply mitigation if safe (restart affected service, disable feature flag).
4. Monitor recovery for 15 minutes before declaring resolved.
5. Send P2 school communication only if schools are directly affected.
6. Schedule post-incident review within **1 week**.

---

## P3 Response Procedure

1. Create a GitHub issue with the `bug` label and link the alert.
2. Triage priority: is it blocking any user action? If yes, treat as P2.
3. Fix during normal working hours.
4. No school communication required.

---

## Diagnostic Quick Reference

```bash
# ── Application health ──────────────────────────────────────────────────────
curl -s https://[PRODUCTION_URL]/health | jq
# ok = all healthy | degraded = non-critical subsystem down | unhealthy = critical failure

# ── Backend logs (last 200 lines, errors only) ──────────────────────────────
docker compose logs --tail=200 backend | grep '"level":"error"'

# ── MongoDB replica set ──────────────────────────────────────────────────────
docker compose exec mongo mongosh --quiet --eval 'rs.status().members.map(m => ({name:m.name, state:m.stateStr}))'

# ── Redis / BullMQ queue depth ───────────────────────────────────────────────
docker compose exec redis redis-cli info keyspace
# Or via admin API:
curl -s -H "Authorization: Bearer $JWT" https://[PRODUCTION_URL]/api/admin/retry-queue | jq

# ── Transaction polling lag ─────────────────────────────────────────────────
# Check lastSyncAt in health response
curl -s https://[PRODUCTION_URL]/health | jq '.details.stellar'
# Warning if > 5 min old, critical if > 15 min old

# ── Prometheus metrics ───────────────────────────────────────────────────────
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://[PRODUCTION_URL]/metrics | grep payment_

# ── Stellar Horizon connectivity ─────────────────────────────────────────────
curl -s https://horizon.stellar.org/      # mainnet
curl -s https://horizon-testnet.stellar.org/   # testnet

# ── Check for stuck payments ─────────────────────────────────────────────────
# See docs/runbooks/stuck-payments.md for full procedure
```

**Key Prometheus metrics to check during a P1:**

| Metric | Alert threshold | Meaning |
|--------|----------------|---------|
| `payment_processing_duration_seconds` (p95) | > 30s | Payments are very slow |
| `transaction_queue_depth` | > 200 | Retry queue backing up |
| `horizon_poll_lag_seconds` | > 900 | Polling stopped for 15 min |
| `http_requests_total{status="5xx"}` | > 10/min | Backend throwing errors |
| `mongodb_connection_pool_size` | near 0 | DB connection exhaustion |

---

## Post-Incident Review Template

Schedule the review within 48 hours for P1 and 1 week for P2.
Use this template as the agenda. Publish the completed document in
`docs/post-incident-reviews/YYYY-MM-DD-[short-title].md`.

```markdown
# Post-Incident Review — [Short Title]

**Date of incident:** [YYYY-MM-DD]
**Severity:** [P1 / P2]
**Duration:** [HH:MM] (from first alert to resolution)
**Incident Commander:** [Name]
**Review date:** [YYYY-MM-DD]
**Attendees:** [Names]

---

## Timeline

| Time (UTC) | Event |
|------------|-------|
| HH:MM      | First alert / user report |
| HH:MM      | IC assigned |
| HH:MM      | Root cause identified |
| HH:MM      | Mitigation applied |
| HH:MM      | Service restored |
| HH:MM      | Incident closed |

---

## Impact

- **Schools affected:** [N schools / all schools / specific school names]
- **Duration of impact:** [HH:MM]
- **Payments affected:** [N payments queued / failed / delayed]
- **Data integrity:** [None / Potential / Confirmed — describe if applicable]

---

## Root Cause

[Describe the technical root cause in 2–4 sentences. Include what failed and why.]

---

## Contributing Factors

[List systemic issues that made this incident more likely or harder to detect.]

- [ ] Missing monitoring / alerting
- [ ] Lack of runbook coverage
- [ ] Deployment process gap
- [ ] Third-party dependency (Stellar Horizon, MongoDB Atlas, etc.)
- [ ] Other: ___

---

## What Went Well

[List things that helped contain or resolve the incident quickly.]

---

## What Could Be Improved

[Honest assessment of gaps. No blame — focus on systems and processes.]

---

## Action Items

| Action | Owner | Due date | GitHub issue |
|--------|-------|----------|-------------|
| [Description] | @[handle] | YYYY-MM-DD | #[n] |

---

## Detection

- How was the incident first detected? [Alert / User report / Monitoring]
- Was the alert timely? If not, what threshold change would help?

---

## Communication

- Was the school notification sent within SLA? [Yes / No]
- Were the updates clear and accurate?
- Any feedback from schools?
```

---

## School Communication Templates

All school-facing communications should be sent from the official support email
address and posted to the status page. Replace all `[PLACEHOLDER]` values before
sending. Have the Incident Commander approve the message before it goes out.

### P1 Initial Notification

> **Subject:** [ACTION REQUIRED] PaymentFlow Service Disruption — [DATE]

```
Dear [SCHOOL_NAME] Administrator,

We are writing to inform you that PaymentFlow is currently experiencing a
service disruption affecting [BRIEFLY DESCRIBE IMPACT — e.g. "payment
verification" or "the entire platform"].

Incident details:
  Started:  [HH:MM UTC, DATE]
  Status:   Investigating / Identified / Monitoring
  Impact:   [One sentence description of what is not working]

What this means for your school:
  [Describe in plain language what schools cannot do right now and whether
  any in-flight payments are at risk.]

What we are doing:
  Our engineering team is actively working to resolve this issue.
  We will send an update every 30 minutes until the service is restored.

What you should do:
  [Specific guidance, e.g. "Please ask parents to hold off on initiating new
  payments until we confirm the service is restored." OR "No action is
  needed — all in-flight payments will be processed automatically once
  the service recovers."]

We sincerely apologise for the disruption. Your students' payment records
are safe and no data has been lost.

Incident updates: [STATUS_PAGE_URL]
Support: [SUPPORT_EMAIL] | [SUPPORT_PHONE]

— PaymentFlow Engineering Team
```

### P1 Resolution Notice

> **Subject:** RESOLVED — PaymentFlow Service Restored — [DATE]

```
Dear [SCHOOL_NAME] Administrator,

We are pleased to confirm that the PaymentFlow service disruption has been
fully resolved.

Incident summary:
  Started:  [HH:MM UTC, DATE]
  Resolved: [HH:MM UTC, DATE]
  Duration: [HH:MM]
  Root cause: [Brief, non-technical explanation, e.g. "A database
    configuration issue caused payment verification requests to fail."]

Impact on your school:
  [Describe what was affected and, crucially, confirm data integrity:
  e.g. "All payments initiated during the outage were queued and have now
  been processed. No payments were lost."]

Next steps:
  [Any action needed from schools, e.g. "No action is required. Payments
  made during the outage are now reflected in your dashboard."]

We will conduct an internal review of this incident and implement measures
to prevent recurrence. We will share a summary of our findings within
[N] business days.

We apologise for the disruption and thank you for your patience.

Support: [SUPPORT_EMAIL] | [SUPPORT_PHONE]

— PaymentFlow Engineering Team
```

### P2 Initial Notification

> **Subject:** PaymentFlow — Service Degradation Notice — [DATE]

```
Dear [SCHOOL_NAME] Administrator,

We want to let you know that PaymentFlow is currently experiencing
degraded performance affecting [BRIEFLY DESCRIBE IMPACT — e.g.
"webhook delivery notifications" or "report generation"].

Incident details:
  Started:  [HH:MM UTC, DATE]
  Status:   Investigating
  Impact:   [One sentence description]

Core payment processing [IS / IS NOT] affected.

Our engineering team is actively investigating. We will update you
once the issue is resolved or if the impact changes.

Incident updates: [STATUS_PAGE_URL]
Support: [SUPPORT_EMAIL]

— PaymentFlow Engineering Team
```

### P2 Resolution Notice

> **Subject:** RESOLVED — PaymentFlow Service Restored — [DATE]

```
Dear [SCHOOL_NAME] Administrator,

The degraded service issue affecting [FEATURE] has been resolved.

  Started:  [HH:MM UTC, DATE]
  Resolved: [HH:MM UTC, DATE]
  Duration: [HH:MM]

[One sentence describing what was fixed.]

No data was lost. [Any follow-up action needed, or "No action is required."]

Thank you for your patience.

Support: [SUPPORT_EMAIL]

— PaymentFlow Engineering Team
```

---

*Related runbooks:*
- [`docs/runbooks/stuck-payments.md`](stuck-payments.md) — recovering stuck payment processing
- [`docs/runbooks/wallet-rotation.md`](wallet-rotation.md) — Stellar wallet key rotation
- [`docs/runbooks/secret-rotation-rollback.md`](secret-rotation-rollback.md) — rolling back a secret rotation
- [`docs/incident-response-checklist.md`](../incident-response-checklist.md) — detailed phase-by-phase checklist
