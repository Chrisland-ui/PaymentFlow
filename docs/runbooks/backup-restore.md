# Runbook: Backup and Restore Procedures

**Component:** `scripts/backup.sh`, `scripts/restore.sh`, `scripts/test-backup-recovery.sh`, Docker Compose `backup` service
**Severity:** critical — this runbook is the authoritative guide for recovering data after a storage failure or corruption event.
**Closes:** [#320](https://github.com/onlyonee1/PaymentFlow/issues/320)

---

## Overview

StellarEduPay stores all payment, student, and school data in MongoDB. While every payment is also permanently recorded on the Stellar blockchain (providing an immutable external source of truth), MongoDB holds the operational state that drives the application: student balances, fee structures, disputes, and audit logs. Losing this data means re-deriving it from the blockchain — a time-intensive manual process.

This runbook documents:
- How and where backups are created
- Recovery Time Objective (RTO) and Recovery Point Objective (RPO)
- Step-by-step restore procedure
- Restore verification checklist
- Quarterly drill procedure

---

## RTO and RPO Targets

| Objective | Target | Rationale |
|-----------|--------|-----------|
| **RPO** (max data loss) | **24 hours** | Nightly automated backups; accepted gap for the cost of real-time replication |
| **RTO** (max downtime) | **4 hours** | Time to provision a replacement instance, restore, run migrations, and verify |

> For disaster scenarios where RPO < 24h is critical, enable MongoDB replica set oplog continuous backup (e.g. MongoDB Atlas continuous backup or a self-managed oplog archiver). The current tooling does not support point-in-time recovery.

---

## Backup Schedule and Storage

### Automated Docker Compose Backup

The `backup` service in `docker-compose.yml` runs `scripts/backup.sh` on a **24-hour schedule** (midnight UTC by default). Archives are stored as gzip-compressed mongodump archives.

```yaml
# From docker-compose.yml — backup service
BACKUP_DIR: /backups          # Inside the container; mounted to host
RETAIN_DAYS: 7                # Days of backups retained
```

**Host storage location:** Configured via the `BACKUP_DIR` environment variable, default `./backups/`.

**Archive naming convention:** `backups/<YYYYMMDDTHHMMSSZ>.gz`

Example: `backups/20261021T000000Z.gz`

### CI Weekly Verification

The GitHub Actions workflow `.github/workflows/backup-restore-test.yml` runs the full backup → restore → verification cycle every Monday at 03:00 UTC. It uses `scripts/test-backup-recovery.sh` to verify document count, index integrity, and field-level content fingerprint.

### Manual Backup

To create an on-demand backup outside the scheduled window:

```bash
# From the project root
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_DIR=./backups \
RETAIN_DAYS=7 \
./scripts/backup.sh
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | *required* | MongoDB connection string |
| `BACKUP_DIR` | `./backups` | Directory for archive output |
| `RETAIN_DAYS` | `7` | Days of backups to keep |
| `WEBHOOK_URL` | — | Optional Slack/webhook URL for failure alerts |
| `MIN_BACKUP_SIZE` | `1024` | Minimum archive size in bytes; smaller archives are rejected |
| `BACKUP_NOTIFY_TOKEN` | — | Bearer token for backend heartbeat notification |
| `BACKEND_INTERNAL_URL` | `http://backend:5000` | Backend URL for the heartbeat |

The script will:
1. Run `mongodump --archive --gzip`
2. Verify the archive is non-empty and meets minimum size
3. Run `mongorestore --dryRun` on the archive to verify integrity
4. Prune backups older than `RETAIN_DAYS`
5. Send a heartbeat to the backend to update the `backup_last_success_timestamp_seconds` Prometheus metric

---

## Backup Verification

Verification happens at two levels:

### 1. Automated Integrity Check (every backup)

`backup.sh` runs `mongorestore --dryRun` on every archive immediately after creation. If this fails, the archive is deleted and an alert is sent to `WEBHOOK_URL`.

### 2. Full Round-Trip Verification (weekly CI + quarterly drill)

`scripts/test-backup-recovery.sh` verifies:

- **Document count** — total documents before and after restore must match
- **Index manifest** — every index (name + key spec) present before backup must exist after restore
- **Field-level content fingerprint** — SHA-256 hash of every document's full canonical JSON must match

This catches corrupt backups even when document counts are identical (e.g. a field was silently dropped or garbled).

---

## Restore Procedure

> **Before restoring to production, always test in a staging environment first.** See "Test Restore on Staging" below.

### Prerequisites

- `mongodump` / `mongorestore` / `mongosh` installed (`mongodb-database-tools` package)
- `MONGO_URI` for the target instance
- Path to the backup archive (`.gz` file)
- Application downtime window arranged (users should not write data during restore)

### Step 1: Take the application offline

```bash
# Stop the backend to prevent writes during restore
docker compose stop backend

# Confirm no active connections (optional)
mongosh "$MONGO_URI" --eval "db.adminCommand({ currentOp: 1 }).inprog.length"
```

### Step 2: List available backups

```bash
ls -lh ./backups/*.gz | sort -k6
```

Choose the most recent backup (or a specific point-in-time archive for targeted recovery).

### Step 3: Dry-run the restore

Always run a dry-run first to verify the archive is readable and the target URI is correct:

```bash
MONGO_URI="mongodb://localhost:27017/stellaredupay" \
BACKUP_FILE="./backups/<YYYYMMDDTHHMMSSZ>.gz" \
./scripts/restore.sh --dry-run
```

Expected output:
```
[restore] DRY-RUN mode — no data will be written.
[restore] Target database URI : mongodb://localhost:27017/stellaredupay
[restore] Backup archive      : ./backups/20261021T000000Z.gz
[restore] DROP collections    : false
```

### Step 4: Restore the database

**Option A — Additive restore (does not drop existing data):**

```bash
MONGO_URI="mongodb://localhost:27017/stellaredupay" \
BACKUP_FILE="./backups/<YYYYMMDDTHHMMSSZ>.gz" \
./scripts/restore.sh
```

Use this when restoring to add missing documents (e.g. a corrupted subset of records). Existing documents are left in place; newer documents from the backup are upserted.

**Option B — Full replace (drops existing collections first):**

```bash
MONGO_URI="mongodb://localhost:27017/stellaredupay" \
BACKUP_FILE="./backups/<YYYYMMDDTHHMMSSZ>.gz" \
DROP=true \
./scripts/restore.sh
```

> ⚠️ `DROP=true` permanently deletes all data in the target database before restoring. You will be prompted to confirm interactively unless you also pass `--yes`.

Use this for disaster recovery where you want a clean slate.

```bash
# Non-interactive (automation/CI)
MONGO_URI="..." BACKUP_FILE="..." DROP=true ./scripts/restore.sh --yes
```

### Step 5: Run database migrations

After restore, ensure all migrations are applied to bring the schema to the current version:

```bash
node scripts/migrate.js
```

Migrations are idempotent and safe to re-run.

### Step 6: Restart the application

```bash
docker compose start backend
```

### Step 7: Verify the restore

Run the verification checklist in the next section.

---

## Restore Verification Checklist

After every restore, verify the following before declaring recovery complete:

- [ ] **Health check passes**
  ```bash
  curl -s https://<api-host>/health | jq .
  # Expected: { "status": "ok" }
  ```

- [ ] **Document counts match the backup manifest**
  ```bash
  mongosh "$MONGO_URI" --eval "
    db.getCollectionNames().forEach(c =>
      print(c + ': ' + db.getCollection(c).countDocuments())
    )
  "
  ```
  Compare against the pre-restore counts logged by `test-backup-recovery.sh`.

- [ ] **Indexes are intact**
  ```bash
  mongosh "$MONGO_URI" --eval "
    db.getCollectionNames().forEach(c =>
      db.getCollection(c).getIndexes().forEach(i => print(c + '|' + i.name))
    )
  "
  ```

- [ ] **Migrations applied**
  ```bash
  mongosh "$MONGO_URI" --eval "db.migrations.find().sort({ createdAt: 1 }).toArray()"
  # Should list all expected migrations as applied
  ```

- [ ] **Login and authentication work**
  ```bash
  curl -X POST https://<api-host>/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{ "email": "<admin-email>", "password": "<admin-password>" }'
  ```

- [ ] **Recent payment records are present**
  ```bash
  mongosh "$MONGO_URI" --eval "
    db.payments.find().sort({ createdAt: -1 }).limit(5).toArray()
  "
  ```

- [ ] **Cross-reference a known payment against the Stellar blockchain**
  Pick any `SUCCESS` payment from the last 24h and verify its `txHash` resolves on Horizon:
  ```bash
  curl -s "https://horizon.stellar.org/transactions/<TX_HASH>" | jq .successful
  # Expected: true
  ```

- [ ] **Prometheus backup staleness metric is updating**
  ```bash
  curl -s https://<api-host>/metrics | grep backup_last_success
  ```

---

## Test Restore on Staging

Before applying a restore to production, always test on a staging instance:

```bash
# Set MONGO_URI to staging database
export MONGO_URI="mongodb://staging-host:27017/stellaredupay?replicaSet=rs0"
export BACKUP_FILE="./backups/<YYYYMMDDTHHMMSSZ>.gz"

# Full round-trip test
./scripts/test-backup-recovery.sh
```

Expected final output: `✅ PASS — document count, indexes, and field-level content all match.`

---

## Quarterly Backup Restore Drill

**Schedule:** First Monday of each quarter (January, April, July, October).

**Procedure:**

1. Pick the most recent weekly backup archive.
2. Provision a temporary MongoDB instance (Docker is sufficient):
   ```bash
   docker run -d --name drill-mongo -p 27018:27017 mongo:7
   mongosh "mongodb://localhost:27018" --eval "rs.initiate()"
   ```
3. Run the full verification:
   ```bash
   MONGO_URI="mongodb://localhost:27018/stellaredupay" \
   BACKUP_FILE="./backups/<LATEST>.gz" \
   ./scripts/test-backup-recovery.sh
   ```
4. Record the result in the Drill Log table below.
5. Clean up:
   ```bash
   docker rm -f drill-mongo
   ```

### Drill Log

| Date | Backup Used | Outcome | RTO Measured | Conducted By |
|------|-------------|---------|--------------|--------------|
| *First drill to be conducted before production go-live* | | | | |

---

## Alert: Backup Staleness

The Prometheus rule in `monitoring/alerts/backup.yml` fires a `BackupStaleness` alert when no successful backup has been recorded for longer than 26 hours. If this alert fires:

1. Check if the backup container is running:
   ```bash
   docker compose ps backup
   ```
2. Check backup container logs:
   ```bash
   docker compose logs backup
   ```
3. Run a manual backup (see above).
4. If the issue persists, check `MONGO_URI` connectivity from the backup container and `BACKUP_DIR` disk space.

---

## Related Documents

- Backup script: [`scripts/backup.sh`](../../scripts/backup.sh)
- Restore script: [`scripts/restore.sh`](../../scripts/restore.sh)
- Round-trip test script: [`scripts/test-backup-recovery.sh`](../../scripts/test-backup-recovery.sh)
- CI verification workflow: [`.github/workflows/backup-restore-test.yml`](../../.github/workflows/backup-restore-test.yml)
- Backup staleness alerts: [`monitoring/alerts/backup.yml`](../../monitoring/alerts/backup.yml)
- Database migrations: [`docs/migrations.md`](../migrations.md)
- Docker quick start: [`docs/QUICK_START_DOCKER.md`](../QUICK_START_DOCKER.md)
