# Local Docker Troubleshooting Guide

This guide helps contributors diagnose and fix the most common failure modes
when running PaymentFlow locally with Docker Compose. Commands are written for
Docker Compose v2 (`docker compose`) but also work with v1 (`docker-compose`).

> **Data safety note:** Several procedures below are marked ⚠️ **DESTRUCTIVE**.
> These steps delete volumes, databases, or containers permanently.
> Confirm you do not need local data before running them.

## Table of Contents

- [Prerequisites Check](#prerequisites-check)
- [Start Commands](#start-commands)
- [Top Startup Failures](#top-startup-failures)
  - [1. MongoDB fails to become healthy](#1-mongodb-fails-to-become-healthy)
  - [2. Backend exits before becoming healthy](#2-backend-exits-before-becoming-healthy)
  - [3. Migration fails on startup](#3-migration-fails-on-startup)
  - [4. Port already in use](#4-port-already-in-use)
  - [5. Missing required environment variables](#5-missing-required-environment-variables)
  - [6. Redis fails to start or connect](#6-redis-fails-to-start-or-connect)
  - [7. Frontend fails to build or start](#7-frontend-fails-to-start-or-connect)
- [Health Inspection Commands](#health-inspection-commands)
- [Log Inspection](#log-inspection)
- [Reset Procedures](#reset-procedures)
- [Monitoring Stack Issues](#monitoring-stack-issues)
- [Safe Data Handling During Troubleshooting](#safe-data-handling-during-troubleshooting)

---

## Prerequisites Check

Before running `docker compose up`, verify:

```bash
# Docker Engine ≥ 24 and Compose v2 (shows "Docker Compose version v2.x.x")
docker --version
docker compose version

# .env file exists in the repo root (copy from the example if not)
ls .env || cp .env.example .env
```

Minimum required values in `.env`:

```bash
MONGO_ROOT_USERNAME=root         # any value — must be set
MONGO_ROOT_PASSWORD=<your-pw>    # any value — must be set
SCHOOL_WALLET_ADDRESS=G...       # Stellar public key (G... format)
JWT_SECRET=<32+ char string>     # openssl rand -hex 32
```

The compose file uses `${VAR:?error message}` for `MONGO_ROOT_USERNAME` and
`MONGO_ROOT_PASSWORD` — Docker Compose will refuse to start with a clear error
if either is unset.

---

## Start Commands

```bash
# Recommended: start and wait until all health checks pass
docker compose up --wait

# Detached mode (check health manually with docker compose ps)
docker compose up -d

# Rebuild images after code changes
docker compose up --build --wait

# Full stack including Prometheus + Grafana
export GRAFANA_PASSWORD=$(openssl rand -hex 24)
export METRICS_TOKEN=$(openssl rand -hex 32)
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up --wait
```

---

## Top Startup Failures

### 1. MongoDB fails to become healthy

**Symptom:** `docker compose ps` shows `mongo` in `(unhealthy)` or `starting`
indefinitely. The backend never starts.

**Diagnose:**

```bash
# Check the mongo container's exit code and health check log
docker compose ps mongo
docker inspect --format='{{json .State.Health}}' paymentflow-mongo-1 | jq

# Tail logs directly
docker compose logs --tail=50 mongo
```

**Common causes and fixes:**

| Cause | Fix |
|-------|-----|
| Replica set not initialised on first run | Run `docker compose down -v` and try again — a clean start runs `rs.initiate()` automatically. |
| Data directory corruption from a previous unclean shutdown | ⚠️ **DESTRUCTIVE:** `docker compose down -v` removes the named volume and all data. |
| `mongosh` binary missing in the image (older Mongo images) | Ensure `image: mongo:7` in `docker-compose.yml`. |
| Another `mongod` process using port 27017 | Run `lsof -i :27017` and stop the conflicting process. |

**Quick test after fix:**

```bash
docker compose exec mongo mongosh --quiet --eval 'rs.status().ok'
# Expected output: 1
```

---

### 2. Backend exits before becoming healthy

**Symptom:** The backend container restarts in a loop or shows `(unhealthy)`.
`docker compose logs backend` shows a crash.

**Diagnose:**

```bash
docker compose logs --tail=100 backend
docker inspect --format='{{json .State.Health}}' paymentflow-backend-1 | jq
```

**Common causes and fixes:**

| Cause | Symptom in logs | Fix |
|-------|-----------------|-----|
| MongoDB not yet ready | `MongoServerSelectionError` or `connection refused` | Add a delay or use `--wait` — `depends_on: condition: service_healthy` should prevent this, but a slow host may need a larger `start_period`. |
| `MONGO_URI` not set or malformed | `MONGO_URI is not set` | Set `MONGO_ROOT_USERNAME` and `MONGO_ROOT_PASSWORD` in `.env`. |
| Missing `JWT_SECRET` | `JWT_SECRET must be at least 32 characters` | Add `JWT_SECRET=<32+ char string>` to `.env`. |
| Missing `SCHOOL_WALLET_ADDRESS` | Config validation error at startup | Add `SCHOOL_WALLET_ADDRESS=G...` to `.env`. |
| `NODE_OPTIONS` out-of-memory | `JavaScript heap out of memory` | Increase `BACKEND_MEM_LIMIT` in `.env` (default `512m`). |

**Quick test after fix:**

```bash
curl http://localhost:5000/health
# Expected: {"status":"ok"} or {"status":"degraded"} — NOT 503
```

---

### 3. Migration fails on startup

**Symptom:** `docker compose logs backend` shows a migration error and the
container exits non-zero. The backend never reaches `Server running on port 5000`.

The backend start command is:
```
sh -c "npm run migrate && npm start"
```
A non-zero exit from `npm run migrate` prevents `npm start` from running.

**Diagnose:**

```bash
docker compose logs backend | grep -i "migration\|migrate\|error" | head -40
```

**Common causes and fixes:**

| Cause | Log message | Fix |
|-------|-------------|-----|
| Migration directory missing from image | `Migrations directory not found` | Rebuild the image: `docker compose build --no-cache backend`. |
| Stale lock document (previous crash) | Migration skipped, but expected output missing | See [Stale migration lock](#stale-migration-lock) below. |
| Required env var missing for a migration | `STUDENT_PII_ENCRYPTION_KEY must be set` | Add the required env var to `.env` or `docker-compose.yml`. |
| Duplicate or out-of-order migration numbering | `Duplicate migration number` | Run `node scripts/validate-migrations.js` locally and fix the numbering. |
| MongoDB connection lost mid-migration | `MongoNetworkError` | Restart: `docker compose restart backend`. The runner will skip already-applied migrations. |

#### Stale migration lock

A migration that crashed after inserting its lock document but before writing
`appliedAt` will be skipped on every subsequent run. To diagnose and clear:

```bash
# List all migration records
docker compose exec mongo mongosh stellaredupay --quiet \
  --eval 'db.migrations.find({}, {version:1, appliedAt:1, lockedAt:1}).sort({version:1}).pretty()'

# A locked-only record looks like:
# { version: "NNN_name", lockedAt: ISODate("...") }   <-- no appliedAt

# Remove the stale lock so the runner retries the migration:
docker compose exec mongo mongosh stellaredupay --quiet \
  --eval 'db.migrations.deleteOne({ version: "NNN_name", appliedAt: { $exists: false } })'
```

Then restart the backend: `docker compose restart backend`.

---

### 4. Port already in use

**Symptom:** `bind: address already in use` when starting a container.

**Diagnose:**

```bash
# Find what is using port 5000, 3000, or 27017
lsof -i :5000
lsof -i :3000
lsof -i :27017
```

**Fix:** Stop the conflicting process, or change the host port in `.env`:

```bash
# Override the host-side port (container port stays the same)
PORT=5001 docker compose up -d   # backend on 5001
```

---

### 5. Missing required environment variables

**Symptom:** Docker Compose exits immediately with:
```
MONGO_ROOT_USERNAME: Error: MONGO_ROOT_USERNAME environment variable must be set.
```
or the backend logs show a config validation error.

**Fix:**

```bash
# Check which vars are unset
grep -E '^\s*-\s+[A-Z_]+=\$\{[A-Z_]+:\?' docker-compose.yml

# Copy the example and fill in the required values
cp .env.example .env
# Then edit .env and set at minimum:
#   MONGO_ROOT_USERNAME, MONGO_ROOT_PASSWORD, SCHOOL_WALLET_ADDRESS, JWT_SECRET
```

---

### 6. Redis fails to start or connect

**Symptom:** `docker compose logs redis` shows an error, or the backend logs
show `Redis connection refused` / `ECONNREFUSED 6379`.

**Diagnose:**

```bash
docker compose ps redis
docker compose logs --tail=50 redis
docker compose exec redis redis-cli ping
# Expected: PONG
```

**Fixes:**

| Cause | Fix |
|-------|-----|
| Port 6379 in use | `lsof -i :6379`, stop conflicting process. |
| Memory limit too low | Increase `REDIS_MEM_LIMIT` in `.env` (default `128m`). |
| Redis not critical | The backend degrades gracefully without Redis (BullMQ falls back to MongoDB retry backend, rate-limit counters become in-process). Check `GET /health` — status `degraded` with a Redis detail is expected and the app keeps running. |

---

### 7. Frontend fails to start or connect

**Symptom:** `docker compose ps frontend` shows `(unhealthy)` or the browser
shows a connection refused on port 3000.

**Diagnose:**

```bash
docker compose logs --tail=100 frontend
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Backend not healthy yet | Frontend `depends_on: condition: service_healthy` waits. If the backend is still starting, wait or run `docker compose up --wait`. |
| `NEXT_PUBLIC_API_URL` not set | Add `NEXT_PUBLIC_API_URL=http://localhost:5000/api` to `.env`. This var is baked in at **build time** — rebuild if you change it: `docker compose up --build frontend`. |
| Build failure (TypeScript / ESLint errors) | `docker compose logs frontend` will show the Next.js build output. Fix the error and rebuild. |

---

## Health Inspection Commands

```bash
# Overview of all container states and health
docker compose ps

# Detailed health check history for a specific container
docker inspect --format='{{json .State.Health}}' paymentflow-backend-1 | jq
docker inspect --format='{{json .State.Health}}' paymentflow-mongo-1   | jq

# Manual health check probes
# MongoDB:
docker compose exec mongo mongosh --quiet --eval 'db.runCommand({ ping: 1 })'

# Backend HTTP health:
curl -s http://localhost:5000/health | jq

# Backend health via container (avoids needing curl on the host):
docker compose exec backend wget -qO- http://localhost:5000/health

# Redis:
docker compose exec redis redis-cli ping
```

The backend `/health` endpoint returns a three-tier status:

| HTTP status | `status` field | Meaning |
|-------------|----------------|---------|
| 200 | `"ok"` | All systems healthy |
| 200 | `"degraded"` | App running; a non-critical subsystem (Horizon, Redis, retry queue) is impaired |
| 503 | `"unhealthy"` | MongoDB disconnected — app cannot serve requests |

A `degraded` response is **not** a startup failure. The app keeps running
with reduced functionality. Only `503 unhealthy` indicates a hard failure.

---

## Log Inspection

```bash
# All services (follow)
docker compose logs -f

# Single service
docker compose logs -f backend
docker compose logs -f mongo

# Last N lines
docker compose logs --tail=200 backend

# Filter for errors only
docker compose logs backend 2>&1 | grep -i '"level":"error"'

# Pretty-print structured JSON logs
docker compose logs backend 2>&1 | grep '^{' | jq '.'

# Show migration log lines
docker compose logs backend 2>&1 | grep -i 'migration\|migrate'
```

---

## Reset Procedures

### Soft reset — restart containers without losing data

```bash
docker compose restart
# or restart a single service:
docker compose restart backend
```

### Medium reset — recreate containers (keep volumes / data)

```bash
docker compose down
docker compose up --wait
```

### ⚠️ DESTRUCTIVE: Hard reset — remove containers and volumes

This **permanently deletes** the local MongoDB data, Redis data, and backup
volume. Use only when you need a completely fresh state.

```bash
# Stop and remove containers, networks, AND named volumes
docker compose down -v

# Rebuild images from scratch (no Docker layer cache)
docker compose build --no-cache

# Start fresh
docker compose up --wait
```

### ⚠️ DESTRUCTIVE: Remove all Docker artefacts

Removes all stopped containers, unused networks, dangling images, and build
cache. This affects **all Docker projects on your machine**, not just
PaymentFlow.

```bash
docker system prune -a --volumes
```

Only run this if you need to free disk space and are certain no other Docker
projects are important on this machine.

---

## Monitoring Stack Issues

The monitoring stack (`docker-compose.monitoring.yml`) requires two additional
environment variables that have **no default** — Docker Compose exits if
either is absent:

| Variable | Purpose | How to generate |
|----------|---------|-----------------|
| `GRAFANA_PASSWORD` | Grafana admin password | `openssl rand -hex 24` |
| `METRICS_TOKEN` | Bearer token for `/metrics` endpoint | `openssl rand -hex 32` |

```bash
export GRAFANA_PASSWORD=$(openssl rand -hex 24)
export METRICS_TOKEN=$(openssl rand -hex 32)
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up --wait
```

After setting `METRICS_TOKEN`, update `monitoring/prometheus.yml` to use
it as the `authorization.credentials` value before starting.

**Access:**
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (login: `admin` / value of `GRAFANA_PASSWORD`)
- Metrics: `http://localhost:5000/metrics` (requires `Authorization: Bearer <METRICS_TOKEN>`)

---

## Safe Data Handling During Troubleshooting

- **Do not paste Docker logs containing real credentials** into issue trackers
  or Slack. The logs may include env var names (never values, because
  `MONGO_URI` is redacted at the logger level), but check before sharing.
- **Do not share `.env` files.** They contain real secrets. Share
  `.env.example` instead.
- If you use `docker inspect` to examine environment variables, be aware the
  output includes raw env var values. Treat the output as sensitive and do not
  share it. Relevant command:
  ```bash
  # CAUTION: output contains plaintext secrets
  docker inspect paymentflow-backend-1 | jq '.[0].Config.Env'
  ```
- When reporting a migration issue, share the migration **version string**
  (e.g. `"029_encrypt_student_pii"`) and the error message — not raw database
  documents that may contain PII.
- Backup archives in `./backups/` may contain encrypted student PII. Do not
  share them externally. Delete with `rm -rf ./backups/` when no longer needed.
