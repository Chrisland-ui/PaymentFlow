# Backup and Restore Verification

This document describes what the backup contains, how retention and integrity work,
how to perform a restore in a fresh environment, and what to verify afterwards.
It also states the RPO/RTO assumptions and escalation paths for failures.

---

## Table of contents

1. [Recovery objectives (RPO / RTO)](#1-recovery-objectives-rpo--rto)
2. [What the backup contains](#2-what-the-backup-contains)
3. [Encryption and secrets](#3-encryption-and-secrets)
4. [Backup schedule and retention](#4-backup-schedule-and-retention)
5. [Running a manual backup](#5-running-a-manual-backup)
6. [Restore procedure (fresh environment)](#6-restore-procedure-fresh-environment)
7. [Validation checks after restore](#7-validation-checks-after-restore)
8. [Weekly restore drill](#8-weekly-restore-drill)
9. [Failure escalation paths](#9-failure-escalation-paths)
10. [Cleanup after a drill](#10-cleanup-after-a-drill)

---

## 1. Recovery objectives (RPO / RTO)

| Metric | Target | Basis |
|--------|--------|-------|
| **RPO** (Recovery Point Objective) | ≤ 24 hours | Nightly backup cadence; at most one day of data may be lost |
| **RTO** (Recovery Time Objective) | ≤ 4 hours | Time to provision a fresh MongoDB instance, restore the archive, run migrations, and pass validation checks |

**Important caveats:**

- RPO assumes the nightly backup ran successfully and the integrity check passed.
  If the most recent backup is corrupt, RPO extends to the previous known-good backup.
  Monitor the `backup_last_success_timestamp_seconds` Prometheus metric.
- RTO assumes the backup archive is accessible (not corrupted, not expired).
  Archive retrieval from remote storage adds to the RTO estimate.
- Stellar blockchain transactions are immutable and always recoverable from the
  public Horizon API regardless of MongoDB state. Payments that occurred after the
  last backup can be re-synced via `POST /api/payments/sync` after restore.

---

## 2. What the backup contains

The backup is a gzip-compressed `mongodump` archive of the entire `stellaredupay`
MongoDB database. It includes:

| Collection | Contents |
|------------|----------|
| `payments` | All payment records (status, txHash, amounts, feeValidationStatus) |
| `students` | Student records (PII encrypted at rest — see §3) |
| `schools` | School configuration, wallet addresses, webhook settings |
| `pendingverifications` | Retry queue for failed Stellar verifications |
| `auditlogs` | Immutable audit trail |
| `users` | Admin user accounts (hashed passwords only) |
| `feestructures` | Per-class fee configuration |
| `disputes` | Dispute records and resolution history |
| `webhookdeliveries` | Delivery logs (retained per TTL, default 90 days) |
| `migrations` | Migration run history (needed to avoid re-running migrations) |
| All other collections | Full snapshot of all application collections |

**What the backup does NOT contain:**

- Redis state (BullMQ queues, rate-limit counters, webhook replay nonces)
- Application logs (written to disk / log aggregator separately)
- Stellar private keys (never stored in MongoDB — see §3)

After a restore, in-flight BullMQ jobs that were in Redis at the time of the
backup will be lost. Unprocessed payments should be re-synced from Horizon
after restore (§7).

---

## 3. Encryption and secrets

| Data | Protection |
|------|------------|
| Student PII (names, parent contacts) | Encrypted at rest in MongoDB using `SIGNER_MASTER_KEY` derivative; migration 029 |
| Webhook secrets | Encrypted at rest using `WEBHOOK_SECRET_ENCRYPTION_KEY`; migration 021 |
| Payment memos | Encrypted at rest; migration 011 |
| Admin passwords | Bcrypt-hashed; never stored as plaintext |
| Stellar wallet private keys | **Never stored in MongoDB** — held by the school admin in their own wallet |
| JWT secrets | Environment variable only; not in MongoDB |

The backup archive itself is **not encrypted at the file level**. Encrypted fields
inside the archive remain encrypted (as stored in MongoDB), but the archive should
be treated as sensitive and access-controlled accordingly:

- Store backups in a location accessible only to operations personnel.
- Do not commit backup archives to version control.
- In production, consider encrypting the archive at rest using your infrastructure's
  key management (e.g. AWS SSE-S3, GCS CMEK, or `gpg --symmetric` before upload).

---

## 4. Backup schedule and retention

| Setting | Default | Environment variable |
|---------|---------|---------------------|
| Schedule | Nightly (Docker Compose `backup` service) | Cron in the container |
| Retention | 7 days | `RETAIN_DAYS` |
| Backup directory | `./backups` | `BACKUP_DIR` |
| Minimum archive size | 1024 bytes | `MIN_BACKUP_SIZE` |

Archives are named by UTC timestamp: `YYYYMMDDTHHMMSSZ.gz`
(example: `20260924T020000Z.gz`).

The backup script automatically prunes archives older than `RETAIN_DAYS` after
each successful run. Verify retention with:

```bash
ls -lh ./backups/*.gz
```

**Monitoring:** the backup container sends a heartbeat to
`/api/internal/backup-heartbeat` after each successful run. The backend records
this as `backup_last_success_timestamp_seconds` in Prometheus. An alert fires if
this metric is stale for more than 26 hours — see
`monitoring/alerts/backup.yml`.

---

## 5. Running a manual backup

```bash
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_DIR=./backups \
RETAIN_DAYS=7 \
  ./scripts/backup.sh
```

The script:
1. Runs `mongodump --archive --gzip` to create the archive.
2. Verifies the archive is non-empty and meets `MIN_BACKUP_SIZE`.
3. Runs `mongorestore --dryRun` on the archive to check structural integrity (exit-code-based).
4. Sends a heartbeat to the backend to update the Prometheus metric.
5. Prunes archives older than `RETAIN_DAYS`.

If any step fails, the script exits non-zero and (if `WEBHOOK_URL` is set) sends
an alert. The failed archive is deleted to avoid restoring from a corrupt file.

---

## 6. Restore procedure (fresh environment)

Follow these steps to restore to a fresh MongoDB instance. The same procedure
applies to a disaster recovery event and to a restore drill.

### Prerequisites

- `mongorestore` installed and on PATH (MongoDB Database Tools)
- `mongosh` installed (for validation queries)
- A MongoDB instance (replica set) accessible via `MONGO_URI`
- The backup archive file (`*.gz`)
- Application environment variables available (needed for step 6)

### Step 1 — Stop all application writes

If restoring to an existing (degraded) environment, stop the backend and
workers first to prevent writes during restore:

```bash
# Docker Compose
docker compose stop backend

# Kubernetes
kubectl scale deployment backend --replicas=0
```

If restoring to a **fresh** environment, there is nothing to stop — proceed
to step 2.

### Step 2 — Verify the archive before restoring

```bash
# Check the archive is readable and structurally valid
mongorestore --archive=./backups/20260924T020000Z.gz --gzip --dryRun
```

A zero exit code means the archive is structurally sound.
Non-zero means the archive is corrupt — use the next most-recent archive.

```bash
ls -lt ./backups/*.gz | head -5   # most recent first
```

### Step 3 — Dry-run: confirm target URI and archive

Always run dry-run first to verify you are targeting the correct instance:

```bash
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260924T020000Z.gz \
  ./scripts/restore.sh --dry-run
```

Expected output:
```
[restore] DRY-RUN mode — no data will be written.
[restore] Target database URI : mongodb://localhost:27017/stellaredupay
[restore] Backup archive      : ./backups/20260924T020000Z.gz
[restore] DROP collections    : false
[restore] Dry-run complete — no changes made.
```

Confirm the URI and archive path are correct before proceeding.

### Step 4 — Restore

**Option A — Merge restore (safe default, no data loss risk)**

Merges the backup into the existing database. Documents already present are
preserved; the backup fills in anything missing. Use this when restoring to an
existing environment that still has some good data.

```bash
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260924T020000Z.gz \
  ./scripts/restore.sh
```

**Option B — Drop-and-replace restore (destructive)**

Drops all existing collections before restoring. Use this for a fresh instance
or when you want a clean slate from the backup. Requires explicit confirmation.

```bash
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260924T020000Z.gz \
DROP=true \
  ./scripts/restore.sh
```

The script will prompt:
```
WARNING: You are about to DROP existing collections on mongodb://...
Are you sure? [y/N]
```

Type `y` to proceed. Any other input aborts.

For automated pipelines (e.g. CI restore drill), add `--yes` to skip the prompt:

```bash
MONGO_URI=... BACKUP_FILE=... DROP=true ./scripts/restore.sh --yes
```

### Step 5 — Run database migrations

Migrations are idempotent. Running them after a restore ensures any migrations
applied after the backup date are re-applied:

```bash
node scripts/migrate.js
```

Migrations that already ran (tracked in the `migrations` collection, which was
restored from backup) will be skipped.

### Step 6 — Re-sync payments from Stellar (optional but recommended)

The backup captures a point-in-time snapshot. Payments that occurred between
the backup and the restore are not in MongoDB but are on the Stellar blockchain.
Re-sync to recover them:

```bash
# Start the backend with the restored database
docker compose up -d backend

# Trigger a sync
curl -X POST http://localhost:5000/api/payments/sync \
  -H "Authorization: Bearer <admin-jwt>"
```

The sync is idempotent — it will not duplicate payments already in MongoDB.

### Step 7 — Resume application traffic

```bash
# Docker Compose
docker compose up -d

# Kubernetes
kubectl scale deployment backend --replicas=2
```

---

## 7. Validation checks after restore

Run these checks after every restore (drill or production recovery) before
declaring the restore complete.

### Check 1 — Document count

Compare document count against a known baseline (Grafana dashboard, or a
pre-restore count):

```js
// mongosh
db.getSiblingDB('stellaredupay')
  .getCollectionNames()
  .reduce((n, c) => n + db.getSiblingDB('stellaredupay').getCollection(c).countDocuments(), 0)
```

### Check 2 — Critical collections are non-empty

```js
db.payments.countDocuments()
db.students.countDocuments()
db.schools.countDocuments()
db.auditlogs.countDocuments()
```

All should be > 0 for any non-empty deployment. A zero count for `payments` or
`students` on a production restore is a red flag.

### Check 3 — Indexes are present

```js
db.payments.getIndexes()
db.pendingverifications.getIndexes()
db.students.getIndexes()
```

The compound index `{ schoolId: 1, txHash: 1 }` on `payments` must be present.
Missing indexes will cause severe performance degradation.

### Check 4 — Application health check

```bash
curl http://localhost:5000/health
```

Expected: `{ "status": "ok" }`. A `degraded` or `unhealthy` response indicates
a subsystem (MongoDB connection, Horizon reachability) is not working.

### Check 5 — Verify a known payment

Pick a recent payment from before the backup timestamp and confirm its record
is present and correct:

```js
db.payments.findOne({ txHash: '<known-hash>' })
// Verify: status, amount, studentId, schoolId, confirmedAt
```

### Check 6 — Cross-check with Stellar Horizon

For the most critical payments (largest amounts, most recent), query Horizon
directly and confirm the on-chain state matches MongoDB:

```bash
curl "https://horizon.stellar.org/transactions/<txHash>"
# Compare: successful, created_at, memo
```

---

## 8. Weekly restore drill

`scripts/verify-latest-backup.sh` automates the restore drill against a
**temporary** MongoDB instance (never production). It:

1. Finds the most recent archive in `BACKUP_DIR`.
2. Restores it into `TEMP_MONGO_URI` with `--drop`.
3. Counts total documents in both the production database and the restored copy.
4. Fails if the counts differ.
5. Sends a heartbeat to update the `last_backup_verification_age_seconds` metric.

```bash
BACKUP_DIR=./backups \
PROD_MONGO_URI=mongodb://prod-host:27017/stellaredupay \
TEMP_MONGO_URI=mongodb://temp-host:27017/stellaredupay \
  ./scripts/verify-latest-backup.sh
```

**Run this weekly.** A backup that is never tested is not a backup — it is a
hypothesis. The drill should be automated in CI or a scheduled job.
`monitoring/alerts/backup.yml` includes an alert for
`last_backup_verification_age_seconds` going stale (> 8 days).

For a deeper verification (document counts + index manifest + field-level content
fingerprint), run the full smoke test:

```bash
MONGO_URI=mongodb://localhost:27017/stellaredupay \
  ./scripts/test-backup-recovery.sh
```

This script performs a full round-trip (backup → restore → compare) on a
running instance and verifies:
- Total document count matches before vs after.
- Every index (name + key spec) is present after restore.
- A SHA-256 fingerprint of all document field values matches before vs after.

---

## 9. Failure escalation paths

| Failure | Immediate action | Escalation |
|---------|-----------------|------------|
| Backup script exits non-zero | Check `[backup] ALERT:` lines in logs; re-run manually | Page on-call if failure persists > 2 hours |
| `mongorestore --dryRun` fails on archive | Archive is corrupt; restore from previous archive | If all recent archives fail: escalate to platform team |
| Restored document count < production count | Data loss — do not promote to production | Escalate immediately; retrieve offsite archive |
| Restored document count > production count | Unexpected; investigate before promoting | Escalate to platform team |
| Missing indexes after restore | Run `node scripts/migrate.js` to recreate | If migrations fail: escalate to platform team |
| `POST /api/payments/sync` returns errors | Stellar Horizon may be unavailable | Wait and retry; check https://status.stellar.org |
| `backup_last_success_timestamp_seconds` stale > 26 h | Check backup container logs | Page on-call; investigate cron job health |
| `last_backup_verification_age_seconds` stale > 8 days | Weekly drill has not run | Investigate CI/cron job; run drill manually |
| No archives in `BACKUP_DIR` | Backup container not running or misconfigured | Page on-call immediately |

If a restore is needed in production and all archives in `BACKUP_DIR` are
corrupt or missing, contact the platform team immediately. Stellar blockchain
data can be re-synced from Horizon for payments, but student and school
configuration data cannot be recovered without a valid backup.

---

## 10. Cleanup after a drill

After a successful restore drill, clean up the temporary database to avoid
confusion and reduce storage usage:

```bash
# Drop the temporary database used for the drill
mongosh "${TEMP_MONGO_URI}" --eval "db.getSiblingDB('stellaredupay').dropDatabase()"

# Remove the drill's backup archive (if created separately from production backups)
rm ./drill-backups/*.gz
```

Do **not** clean up production backup archives. Let retention pruning handle
expiry automatically via the `RETAIN_DAYS` setting.

---

## Related documentation

- [`docs/operator-runbooks.md`](./operator-runbooks.md) — restore procedure in the context of an incident
- [`scripts/backup.sh`](../scripts/backup.sh) — backup script source
- [`scripts/restore.sh`](../scripts/restore.sh) — restore script source
- [`scripts/verify-latest-backup.sh`](../scripts/verify-latest-backup.sh) — weekly drill script
- [`scripts/test-backup-recovery.sh`](../scripts/test-backup-recovery.sh) — full round-trip smoke test
- [`monitoring/alerts/backup.yml`](../monitoring/alerts/backup.yml) — Prometheus alert rules
