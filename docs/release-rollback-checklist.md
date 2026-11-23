# Release and Rollback Checklist

> **Purpose:** Provide a repeatable, auditable procedure for every deployment
> to PaymentFlow. All steps must be recorded with a timestamp and the operator
> who performed them. Irreversible steps are called out explicitly.
>
> **Evidence location:** All release artefacts (migration run log, pre-release
> database snapshot, post-release health-check output) must be stored in
> `releases/<YYYY-MM-DD>-<sha>/` in the release storage bucket (or the
> equivalent path defined by your team's release process).

---

## Table of Contents

1. [Prerequisites and Roles](#1-prerequisites-and-roles)
2. [Dry-Run Support](#2-dry-run-support)
3. [Phase 1 — Pre-Flight Checks](#3-phase-1--pre-flight-checks)
4. [Phase 2 — Migration Ordering](#4-phase-2--migration-ordering)
5. [Phase 3 — Rollout](#5-phase-3--rollout)
6. [Phase 4 — Rollout Monitoring](#6-phase-4--rollout-monitoring)
7. [Phase 5 — Post-Release Verification](#7-phase-5--post-release-verification)
8. [Phase 6 — Rollback](#8-phase-6--rollback)
9. [Irreversible Steps Reference](#9-irreversible-steps-reference)
10. [Release Evidence Checklist](#10-release-evidence-checklist)

---

## 1. Prerequisites and Roles

| Role | Responsibility |
|------|---------------|
| **Release Engineer** | Executes the checklist end-to-end; records every step |
| **Database Operator** | Reviews and approves migration plan; owns restore if needed |
| **API Operator** | Monitors health and metrics during rollout |
| **Incident Commander** | Paged if rollout triggers a SEV-2 or higher |

Before starting, confirm:

- [ ] CI is green on the release branch (all test suites pass).
- [ ] The PR has been reviewed and approved against the contribution guide (`CONTRIBUTING.md`).
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` for this release.
- [ ] You have write access to the target environment.
- [ ] A deployment freeze is not in effect (check `#deploys` Slack).

---

## 2. Dry-Run Support

Every phase in this checklist that modifies state has a dry-run path.
**Always perform the dry run before the real run** in production.

| Operation | Dry-Run Command |
|-----------|----------------|
| Database restore | `./scripts/restore.sh --dry-run` |
| Migration runner | `node scripts/migrate.js --dry-run` *(prints pending migrations without applying)* |
| Kubernetes apply | `kubectl apply -k <overlay> --dry-run=client` |
| Secret provisioning | The provisioning script uses `--dry-run=client` internally; verify its output before re-running without dry-run |
| Backup verification | `./scripts/verify-latest-backup.sh` *(read-only by default)* |

---

## 3. Phase 1 — Pre-Flight Checks

> **Owner:** Release Engineer

- [ ] **Record release start time** (ISO-8601 UTC) and the commit SHA being deployed.
- [ ] **Identify the target environment:** testnet or mainnet.
- [ ] **Check current system health:**
  ```sh
  curl -s https://<host>/health | jq .
  ```
  Abort the release if status is not `"ok"`.
- [ ] **Check error rate and latency** on Grafana / Prometheus — baseline must be normal before starting a release.
- [ ] **Confirm the retry queue is empty or draining** (no stuck payments in-flight):
  ```sh
  curl -s https://<host>/api/admin/retry-queue -H "Authorization: Bearer <token>" | jq .
  ```
- [ ] **Take a pre-release database backup:**
  ```sh
  ./scripts/backup.sh
  ```
  Record the backup filename and path as release evidence.
- [ ] **List pending migrations** (dry run):
  ```sh
  node scripts/migrate.js --dry-run
  ```
  If any migrations are pending, proceed to Phase 2. If none, skip Phase 2.
- [ ] **Review the migration plan** with the Database Operator — confirm ordering,
  estimated run time, and whether any migration is irreversible (see §9).
- [ ] **Confirm the image tag** to be deployed matches the reviewed PR:
  ```sh
  # Check the overlay's kustomization.yaml
  grep newTag deploy/k8s/overlays/<env>/kustomization.yaml
  ```
- [ ] **Announce the deployment** in `#deploys` with: environment, commit SHA, expected duration, and rollback plan.

---

## 4. Phase 2 — Migration Ordering

> **Owner:** Release Engineer + Database Operator

Migrations must always run **before** the new application code is started.
This is enforced automatically in Kubernetes via the migration initContainer
in `deploy/k8s/backend-deployment.yaml`. For non-Kubernetes environments,
follow the manual steps below.

### Ordering rules

1. **Always run migrations against the current (old) application version first.**
   The new code must be compatible with both the pre- and post-migration schema
   (backward-compatible migrations).
2. **Never run migrations after deploying new code** unless the new code is
   explicitly designed to handle the pre-migration schema.
3. **Each migration is identified by its prefix number** (e.g. `001_`, `029_`).
   The runner applies them in ascending numeric order. Never renumber existing
   migrations.

### Execution

- [ ] **Dry-run the migrations** (see §2).
- [ ] **Run migrations:**
  ```sh
  node scripts/migrate.js
  ```
  The runner is idempotent — already-applied migrations are skipped.
- [ ] **Record the output** of the migration run as release evidence.
- [ ] **Verify the `migrations` collection** reflects the newly applied migrations:
  ```sh
  # Via mongosh
  db.migrations.find({}, { name: 1, appliedAt: 1 }).sort({ appliedAt: -1 }).limit(5)
  ```

### Irreversible migrations

Some migrations cannot be rolled back automatically (see §9 for the full list).
If a migration in this release is irreversible, the Database Operator must
approve it explicitly before you proceed. Record their approval in the release
evidence.

---

## 5. Phase 3 — Rollout

> **Owner:** Release Engineer

### Kubernetes (recommended)

```sh
# Dry run first
kubectl apply -k deploy/k8s/overlays/<env> --dry-run=client

# Real apply
kubectl apply -k deploy/k8s/overlays/<env>
```

Monitor the rollout:

```sh
kubectl rollout status deployment/backend
kubectl rollout status deployment/frontend
```

### Canary deployment (for high-risk changes)

When deploying schema changes, payment-path changes, or any change flagged as
high-risk, use the canary procedure:

```sh
kubectl apply -k deploy/k8s/overlays/canary
```

Wait for the canary pod to reach `Running` and the readiness probe (`/health/ready`)
to pass before proceeding. See `docs/operator-runbooks.md § Canary Deployment Rollout`.

### Docker Compose (non-Kubernetes)

```sh
docker compose -f docker-compose.yml [-f docker-compose.monitoring.yml] pull
docker compose up -d --no-deps --build backend frontend
```

---

## 6. Phase 4 — Rollout Monitoring

> **Owner:** API Operator  
> **Duration:** Monitor for a minimum of 15 minutes after the rollout completes
> (30 minutes for a canary deployment before promoting to full rollout).

- [ ] **Watch pod/container readiness:**
  ```sh
  kubectl get pods -w
  # or
  docker ps
  ```
- [ ] **Confirm `/health` returns `ok` on every new pod:**
  ```sh
  curl -s https://<host>/health | jq .
  ```
- [ ] **Watch the Grafana dashboards** for any regression vs. the pre-release baseline:
  - API error rate (`ApiHigh5xxRateWarning` must not fire)
  - API p95 latency (`ApiLatencyP95High` must not fire)
  - MongoDB connection state (must remain 1)
  - Transaction queue depth (must not climb)
- [ ] **Submit a test payment** on the testnet path and confirm it progresses through polling and confirmation.
- [ ] **Check the retry queue** for any new failures:
  ```sh
  curl -s https://<host>/api/admin/retry-queue -H "Authorization: Bearer <token>" | jq .
  ```
- [ ] **Review application logs** for unexpected errors:
  ```sh
  kubectl logs deployment/backend --since=15m | grep '"level":"error"'
  # or
  docker logs <backend> --since=15m | grep '"level":"error"'
  ```
- [ ] **If the canary is healthy after 30 minutes,** proceed with the full rollout:
  ```sh
  kubectl set image deployment/backend backend=stellaredupay/backend:<new-tag>
  ```

---

## 7. Phase 5 — Post-Release Verification

> **Owner:** Release Engineer

- [ ] **Confirm the deployed image SHA** matches the intended release:
  ```sh
  kubectl get deployment backend -o jsonpath='{.spec.template.spec.containers[0].image}'
  ```
- [ ] **Run the data consistency check:**
  ```sh
  curl -s https://<host>/consistency -H "Authorization: Bearer <token>" | jq .
  ```
  Record the output as release evidence. Any `inconsistencies` must be resolved before the release is considered complete.
- [ ] **Verify Prometheus scraping** is working — confirm the `/metrics` endpoint returns fresh data and Grafana dashboards are populating.
- [ ] **Confirm the retry queue is draining** (not growing).
- [ ] **Update `CHANGELOG.md`:** move the `[Unreleased]` entry to the new version with a release date.
- [ ] **Tag the release** in git:
  ```sh
  git tag v<version>
  git push origin v<version>
  ```
- [ ] **Announce release complete** in `#deploys` with: version, SHA, environment, and a link to the Grafana dashboard.
- [ ] **Record the release close time** and duration.

---

## 8. Phase 6 — Rollback

> **Trigger:** Any of the following conditions during Phases 4–5:
> - `ApiHigh5xxRateCritical` fires after the rollout.
> - `/health` returns `unhealthy` on any pod.
> - Payment processing is degraded and not recovering within 10 minutes.
> - A data consistency check finds new inconsistencies introduced by this release.
>
> **Decision authority:** Incident Commander (or Release Engineer if no IC is assigned).

### Application rollback

⚠️ **Kubernetes rollback does NOT undo database migrations.** See §9 for which
migrations are irreversible before rolling back the application.

```sh
# Roll back the backend deployment to the previous ReplicaSet
kubectl rollout undo deployment/backend

# Roll back the frontend deployment
kubectl rollout undo deployment/frontend
```

Confirm the previous image is running:

```sh
kubectl rollout status deployment/backend
kubectl get deployment backend -o jsonpath='{.spec.template.spec.containers[0].image}'
```

### Database rollback

Most migrations are additive (new indexes, new fields) and the previous
application version tolerates the new schema. In these cases, a database rollback
is not required.

For migrations that remove or rename fields (see §9), coordinate with the
Database Operator:

1. Restore the pre-release backup:
   ```sh
   BACKUP_FILE=<pre-release-backup>.gz MONGO_URI=<uri> ./scripts/restore.sh --dry-run
   # Review, then apply:
   BACKUP_FILE=<pre-release-backup>.gz MONGO_URI=<uri> ./scripts/restore.sh
   ```
2. Record the restore as a new incident if it affects live payment data.

### Rollback verification

- [ ] `/health` returns `ok` on all pods.
- [ ] Error rate returns to pre-release baseline (check Grafana).
- [ ] Run the consistency check and confirm no new issues.
- [ ] Retry queue is draining normally.
- [ ] Record the rollback time, reason, and operator in the release evidence.

---

## 9. Irreversible Steps Reference

The following steps **cannot be automatically undone**. Each one requires
Database Operator approval before execution and must be explicitly noted in
the release evidence.

| Step | Why It Is Irreversible | Safe Rollback Path |
|------|----------------------|--------------------|
| **Applying a migration that drops a field or index** | Existing data in that field is lost on drop | Restore from pre-release backup (see §8) |
| **Applying migration `011_encrypt_payment_memos.js`** | Re-encrypts existing memo values; decryption with old key fails after rollback | Rotate `SIGNER_MASTER_KEY` back or restore from backup |
| **Applying migration `021_encrypt_webhook_secrets.js`** | Re-encrypts webhook secrets; old key cannot decrypt after rollback unless dual-key grace is maintained | Keep `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` set until confirmed stable |
| **Applying migration `029_encrypt_student_pii.js`** | Re-encrypts student PII; rollback requires key restoration | Restore from backup |
| **JWT secret rotation** (`scripts/rotate-jwt-secret.js --confirm`) | All live sessions are immediately invalidated; MFA enrollments are wiped | Inform all admins; MFA re-enrollment required |
| **Signer master key rotation** (`scripts/rotate-signer-master-key.js --apply`) | All school signing keys are re-encrypted; old key cannot decrypt them | Restore from backup and rotate back |
| **Removing a school record** (`DELETE /api/schools/:id`) | Deactivation is soft (isActive = false) but tenant data remains; permanent deletion is not provided by default | Reactivate via `PUT /api/schools/:id` |
| **Stellar wallet address change** | Existing payment instructions cached by parents or external systems reference the old address | Follow `docs/runbooks/wallet-rotation.md` |

---

## 10. Release Evidence Checklist

Store all evidence in `releases/<YYYY-MM-DD>-<sha>/`. At minimum, include:

| Artefact | How to Capture |
|----------|---------------|
| Release start time and commit SHA | Record in `release-log.txt` |
| Pre-release health check output | `curl -s https://<host>/health > pre-release-health.json` |
| Pre-release backup filename | Output of `./scripts/backup.sh` |
| Migration dry-run output | `node scripts/migrate.js --dry-run > migration-dry-run.txt` |
| Migration run output | `node scripts/migrate.js > migration-run.txt` |
| Database Operator approval for irreversible migrations | Email / Slack screenshot saved as `migration-approval.txt` |
| Post-release health check output | `curl -s https://<host>/health > post-release-health.json` |
| Consistency check output | `curl -s https://<host>/consistency ... > consistency.json` |
| Deployed image tag | `kubectl get deployment backend -o json > deployment.json` |
| Release close time | Append to `release-log.txt` |

---

*Last reviewed: 2026-09-27. Review this document before every major release and
after any incident caused by a deployment.*
