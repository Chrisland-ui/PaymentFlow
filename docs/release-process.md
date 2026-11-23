# Release Process

This document defines the formal release process for StellarEduPay. Every production release **must** follow this checklist in order. The goal is to eliminate preventable production incidents caused by skipped migrations, untested deploys, or missing rollback plans.

---

## Table of Contents

- [Release Types](#release-types)
- [Pre-Release Checklist](#pre-release-checklist)
- [Deployment Steps](#deployment-steps)
- [Post-Deploy Smoke Tests](#post-deploy-smoke-tests)
- [Monitoring Watch Period](#monitoring-watch-period)
- [Rollback Decision Criteria](#rollback-decision-criteria)
- [Rollback Procedures](#rollback-procedures)
  - [Code-Only Rollback](#code-only-rollback)
  - [Rollback with Reversible Migration](#rollback-with-reversible-migration)
  - [Rollback with Irreversible Migration (Forward-Fix)](#rollback-with-irreversible-migration-forward-fix)
- [Post-Incident Review](#post-incident-review)

---

## Release Types

| Type | Description | Migration Risk | Rollback Complexity |
|------|-------------|---------------|-------------------|
| Patch | Bug fixes, dependency updates, config changes | None | Low — code-only rollback |
| Minor | New features, new endpoints, non-breaking schema changes | Possible (additive) | Medium — reversible migration rollback |
| Major | Breaking API changes, destructive schema changes, architecture changes | Likely | High — may require forward-fix |

---

## Pre-Release Checklist

Complete every item **before** merging a release PR. The release PR template (`.github/PULL_REQUEST_TEMPLATE/release.md`) includes this checklist.

### Code Quality
- [ ] All CI checks pass (linting, tests, security audit, secret scan, migration validation)
- [ ] No new high or critical severity dependency vulnerabilities (`npm audit`)
- [ ] CHANGELOG.md updated with an `[Unreleased]` entry describing the change

### Migrations
- [ ] List all new migrations in this release: _(fill in migration numbers)_
- [ ] Migrations have been tested against a staging database
- [ ] Migrations are idempotent — safe to re-run without side effects
- [ ] If any migration is **irreversible**, it is documented here: _(describe)_
- [ ] Migration rollback strategy is defined (see [Rollback Procedures](#rollback-procedures))

### Stellar / Blockchain
- [ ] Any changes to payment processing logic have been tested on **testnet** first
- [ ] No changes require Stellar secret key access (backend must remain read-only)
- [ ] Fee validation changes have been tested with both exact-match and edge-case amounts

### Environment & Configuration
- [ ] All new environment variables are documented in `README.md` and `.env.example`
- [ ] Kubernetes manifests updated if new env vars or resource limits changed
- [ ] No secrets committed to the repository (secret scan CI check must pass)

### Observability
- [ ] New features have corresponding metrics or log statements
- [ ] Any new alert rules have been added with `runbook_url` annotations
- [ ] `docs/observability.md` updated if new alerts or dashboards were added

### Rollback Plan
- [ ] Rollback procedure has been identified: code-only / reversible migration / forward-fix
- [ ] The on-call engineer has been notified of the release window
- [ ] A database snapshot has been taken immediately before deploy

---

## Deployment Steps

### Docker Compose (staging / self-hosted production)

```bash
# 1. Pull the new image
docker compose pull backend

# 2. Take a database snapshot before any migrations
./scripts/backup.sh

# 3. Run database migrations (idempotent — safe to run first)
docker compose run --rm backend node scripts/migrate.js

# 4. Deploy the new backend
docker compose up -d backend

# 5. Tail logs to confirm healthy startup
docker compose logs -f backend | head -50
```

Expected healthy startup output:
```
MongoDB connected
Server running on port 5000
Background polling started
Retry worker started
```

### Kubernetes

```bash
# 1. Take a database snapshot
./scripts/backup.sh

# 2. Run migrations via an init container or Job
kubectl apply -f deploy/k8s/migration-job.yaml
kubectl wait --for=condition=complete job/migration --timeout=120s

# 3. Update the image tag in the overlay kustomization
# overlays/mainnet/kustomization.yaml: newTag: sha-<commit>

# 4. Apply the deployment
kubectl apply -k deploy/k8s/overlays/mainnet

# 5. Monitor the rollout
kubectl rollout status deployment/backend --timeout=5m

# 6. Verify health check
kubectl exec deployment/backend -- curl -s http://localhost:5000/health | jq .status
```

### Canary Deploys (recommended for major/minor releases)

For changes that touch the payment processing path:

```bash
# 1. Deploy canary (single pod)
kubectl apply -k deploy/k8s/overlays/canary

# 2. Monitor canary for 15 minutes before full rollout
kubectl logs -f deployment/backend -l environment=canary

# 3. If canary is healthy, promote to full rollout
kubectl set image deployment/backend backend=stellaredupay/backend:<tag>

# 4. If canary fails, remove it
kubectl delete deployment backend -l environment=canary
```

See [docs/operator-runbooks.md](operator-runbooks.md#canary-deployment-rollout) for the full canary procedure.

---

## Post-Deploy Smoke Tests

Run these checks **immediately** after every deployment, before the monitoring watch period begins.

### Health Check
```bash
curl -s http://localhost:5000/health | jq .
# Expected: { "status": "ok" } or { "status": "degraded", "details": {...} }
# NOT acceptable: { "status": "unhealthy" } or HTTP 503
```

### Metrics Endpoint
```bash
curl -s http://localhost:5000/metrics | grep -E "^(nodejs_heap|http_request)"
# Expected: prometheus metrics with numeric values
```

### Authentication
```bash
curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"wrong"}' | jq .error
# Expected: "Invalid credentials" (not a 500 error)
```

### Payment Instructions (read-only path)
```bash
curl -s "http://localhost:5000/api/payments/instructions/STU001?schoolId=SCH-DEFAULT" | jq .
# Expected: walletAddress + acceptedAssets (or 404 if student not seeded)
# NOT acceptable: 500 error
```

### Database Migration Verification
```bash
# Verify migrations applied successfully (from backend logs or direct DB check)
docker compose logs backend | grep -i "migration"
# Expected: "All migrations up to date" or "Applied migration NNN"
```

### Grafana Dashboards
- Open `http://localhost:3001` and confirm the Payments dashboard loads without errors
- Check that `mongodb_connection_state` shows `1` (connected)
- Check that `nodejs_heap_used_ratio` is below `0.50`

---

## Monitoring Watch Period

After smoke tests pass, the on-call engineer **must** actively monitor the system for a minimum of **30 minutes** before declaring the release stable.

### Watch Period Checklist

During the 30-minute window, check every 5 minutes:

- [ ] `GET /health` returns `200 ok` (not degraded or unhealthy)
- [ ] No new `critical` alerts firing in Prometheus/Alertmanager
- [ ] HTTP 5xx rate stays below 1 % (check Grafana API Errors panel)
- [ ] Payment funnel metrics are advancing (not stuck)
- [ ] No unexpected error spikes in backend logs

### When to End the Watch Period

The watch period ends when all of the following are true:
1. At least 30 minutes have elapsed since deployment
2. No new critical or warning alerts have fired
3. At least one payment has been successfully processed (or the system is confirmed healthy with no active payments)
4. The on-call engineer has signed off in the release record

If any condition is not met within **60 minutes**, initiate rollback and open an incident.

---

## Rollback Decision Criteria

Initiate rollback **immediately** if any of the following occur during or after deployment:

| Signal | Action |
|--------|--------|
| `GET /health` returns 503 | Rollback immediately |
| HTTP 5xx rate > 20 % for > 2 minutes | Rollback immediately |
| `MongoDBDisconnected` or `HorizonAllEndpointsUnavailable` alert fires | Investigate first; rollback if caused by the deploy |
| Payment confirmation rate drops to zero | Rollback immediately |
| Data corruption detected | Stop writes immediately; do NOT rollback; escalate to engineering lead |
| Any `critical` alert fires and is linked to the new deploy | Rollback after 5 minutes if no fix is available |

Do not wait for the full 30-minute watch period if a clear regression is observed. **Rollback first, investigate second.**

---

## Rollback Procedures

### Code-Only Rollback

Use this when the release contains **no database migrations**, or all migrations are additive and forward-compatible.

**Docker Compose:**
```bash
# Roll back to the previous image tag
docker compose up -d --no-deps backend <previous-image-tag>

# Or if using tagged images:
docker compose pull backend:<previous-tag>
IMAGE_TAG=<previous-tag> docker compose up -d backend

# Verify health
curl -s http://localhost:5000/health | jq .status
```

**Kubernetes:**
```bash
# Roll back to the previous ReplicaSet (restores the previous immutable image tag)
kubectl rollout undo deployment/backend

# Monitor rollback progress
kubectl rollout status deployment/backend

# Verify health
kubectl exec deployment/backend -- curl -s http://localhost:5000/health | jq .status
```

**Expected outcome:** Application returns to healthy state within 2 minutes. The rolled-back version is fully functional because no irreversible data changes were made.

---

### Rollback with Reversible Migration

Use this when the release includes a migration that **can be reversed** (e.g., adding an index, adding an optional field with a default).

A migration is reversible if:
- It only adds new indexes, collections, or fields
- It does not drop or rename fields or collections
- It does not modify existing records in a way that the old code cannot handle

**Steps:**

1. Roll back the application code first (see [Code-Only Rollback](#code-only-rollback))
2. Verify the old version is running and healthy
3. Decide whether to roll back the migration:
   - **If the migration is forward-compatible** (old code works fine with the new schema): leave the migration applied. No data rollback needed.
   - **If the migration breaks old code** (e.g., a new required field confuses the old version): run the migration rollback script if one exists, or manually revert via `mongosh`.

```bash
# Example: drop an index added by the migration
mongosh "$MONGO_URI" --eval "db.payments.dropIndex('myNewIndex_1')"

# Example: remove a field added by the migration (if required by old schema)
mongosh "$MONGO_URI" --eval "db.students.updateMany({}, { \$unset: { newField: '' } })"
```

4. Document the rollback action in the incident log.

**Expected outcome:** System is stable on the previous application version. The migration is re-applied when the fixed version is deployed.

---

### Rollback with Irreversible Migration (Forward-Fix)

Use this when a migration **cannot be reversed** without data loss or manual intervention. Examples:
- Dropping a collection or field
- Encrypting/transforming existing records
- Renaming a field used by the old code
- Data backfill that the old code cannot undo

**In this case, do NOT attempt to roll back the database. Instead, apply a forward fix.**

**Steps:**

1. **Do not roll back the application code yet** — assess the impact first.
2. Open an incident record immediately.
3. Determine whether the issue is in the **application code** or the **migration**:
   - If the application code has a bug that is fixable quickly (< 30 minutes), deploy a hotfix.
   - If the migration itself caused data corruption, escalate to the engineering lead.

4. **Deploy the hotfix forward:**
   ```bash
   # Create a hotfix branch from main
   git checkout -b hotfix/description main

   # Apply the fix
   # ... make changes ...

   # Fast-track PR: bypass normal review if P1 incident (requires second engineer approval)
   git push origin hotfix/description

   # After merge, deploy immediately following the deployment steps above
   ```

5. **If data corruption occurred and a hotfix is not viable:**
   ```bash
   # Step 1: Stop all writes immediately (enable maintenance mode)
   curl -X POST http://localhost:5000/api/admin/maintenance \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"enabled": true}'

   # Step 2: Take a forensic snapshot of the current database state
   ./scripts/backup.sh

   # Step 3: Restore from pre-deploy backup to staging
   MONGO_URI=<staging-uri> BACKUP_FILE=./backups/<pre-deploy-backup>.gz \
     ./scripts/restore.sh --drop

   # Step 4: Compare restored data with production to assess scope
   # Step 5: Escalate to engineering lead for production restore decision
   ```

6. Communicate RPO impact to stakeholders **before** any production restore.
7. Resume workers only after database and queue state are verified consistent.

**Expected outcome:** A hotfix is deployed within the same release window. If that is not possible, maintenance mode is enabled and the engineering lead is engaged. Data integrity is prioritized over uptime.

---

## Post-Incident Review

After any rollback, complete a blameless post-incident review within 48 hours:

1. **Timeline:** What was deployed, when, and what signal indicated the problem?
2. **Root cause:** What caused the regression? Migration bug? Code bug? Missing test coverage?
3. **Impact:** Which schools/payments were affected? Was any data corrupted?
4. **Detection time:** How long between deployment and detection?
5. **Response time:** How long between detection and rollback?
6. **Action items:** What changes to the release process, tests, or code will prevent recurrence?

Record the review in the project's incident log and link it to the release PR.

---

## Document Stability

This document is considered stable once it has been followed for **at least one production release** without requiring emergency amendments. The release engineer should annotate that release PR with: `"First release following docs/release-process.md — no amendments required."` or list any deviations and open follow-up issues to address them.
