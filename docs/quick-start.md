# Contributor Quick-Start Guide

> Get from `git clone` to a fully running local environment in under 15 minutes.  
> Commands are tested on **macOS**, **Linux**, and the **GitHub Codespace / devcontainer** included in this repo.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [1. Clone & Install](#1-clone--install)
- [2. Generate a Stellar Wallet](#2-generate-a-stellar-wallet)
- [3. Environment Setup](#3-environment-setup)
  - [Backend environment variables](#backend-environment-variables)
  - [Frontend environment variables](#frontend-environment-variables)
- [4. Database & Redis](#4-database--redis)
- [5. Start the Backend](#5-start-the-backend)
- [6. Start the Frontend](#6-start-the-frontend)
- [7. Run Tests](#7-run-tests)
- [8. Common Issues](#8-common-issues)
- [First PR Checklist](#first-pr-checklist)

---

## Prerequisites

Install all of the following before continuing.

| Tool | Required version | Install |
|------|-----------------|---------|
| **Node.js** | ≥ 20.0.0 | [nodejs.org](https://nodejs.org/) or `nvm use` (see below) |
| **npm** | comes with Node.js | — |
| **MongoDB** | 7.x (replica set) | [mongodb.com](https://www.mongodb.com/try/download/community) or Docker |
| **Redis** | 7.x | [redis.io](https://redis.io/docs/getting-started/) or Docker |
| **Git** | any modern version | [git-scm.com](https://git-scm.com/) |
| **Docker + Docker Compose v2** | optional, simplest path | [docs.docker.com](https://docs.docker.com/get-docker/) |

> **Recommended:** Use Docker Compose — it spins up MongoDB (replica set), Redis, backend, and frontend in one command.  See [docs/QUICK_START_DOCKER.md](QUICK_START_DOCKER.md) for the Docker path.  The rest of this guide covers the manual path.

### Node.js version

The repo ships a `.nvmrc` file.  If you use [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install   # installs the version pinned in .nvmrc
nvm use       # switches to it
```

Verify:

```bash
node --version   # should print v20.x.x or higher
```

### MongoDB as a replica set

StellarEduPay uses multi-document MongoDB transactions.  A **standalone** `mongod` will not work.

```bash
# macOS / Linux — start a single-node replica set
mongod --replSet rs0 --dbpath ~/data/db --port 27017 &

# Once, in a separate terminal — initialise the replica set
mongosh --eval "rs.initiate()"
```

Then use the connection string:

```
MONGO_URI=mongodb://localhost:27017/stellaredupay?replicaSet=rs0
```

---

## 1. Clone & Install

```bash
git clone https://github.com/onlyonee1/PaymentFlow.git
cd PaymentFlow

# Install root-level dev tools
npm install

# Install backend dependencies
cd backend && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..
```

---

## 2. Generate a Stellar Wallet

PaymentFlow needs a school wallet on the Stellar testnet to receive payments.

```bash
cd backend
npm run create-wallet
```

Expected output:

```
Public Key:  GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Secret Key:  SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Copy the **Public Key** — you'll need it in step 3.

> **Never commit the Secret Key.**  The `.gitignore` excludes `backend/.env`, but always double-check.

You can also use [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test) and click **Fund account with Friendbot** to create and activate a testnet wallet in the browser.

---

## 3. Environment Setup

### Backend environment variables

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`.  The **minimum required** values are:

| Variable | Description | Example value |
|----------|-------------|---------------|
| `MONGO_URI` | MongoDB connection string. Must include replica set. | `mongodb://localhost:27017/stellaredupay?replicaSet=rs0` |
| `SCHOOL_WALLET_ADDRESS` | School's Stellar public key from step 2 | `GXXXXX...` |
| `STELLAR_NETWORK` | Stellar network to connect to | `testnet` |
| `JWT_SECRET` | Random secret for signing JWTs (min 32 chars) | `openssl rand -hex 32` |

Generate a strong JWT secret:

```bash
openssl rand -hex 32
```

All other variables have safe defaults for local development.  Key optional variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `REDIS_HOST` | *(unset)* | Set to `localhost` to enable BullMQ and distributed rate limiting.  Leave unset if Redis is not running — the app falls back gracefully. |
| `PORT` | `5000` | Backend HTTP port |
| `LOG_LEVEL` | `info` | Set to `debug` for verbose output |
| `SIGNER_MASTER_KEY` | *(unset)* | Required only for contract signer key operations.  Generate with: `openssl rand -hex 32` |
| `APPROVAL_SECRET` | *(unset)* | Required for signer key rotation dual-approval.  Generate with: `openssl rand -hex 32` |

For the complete variable reference see the [Environment Variables](../README.md#environment-variables) section of the README.

### Frontend environment variables

```bash
cp frontend/.env.local.example frontend/.env.local
```

The default value of `NEXT_PUBLIC_API_URL=/api` works out of the box with the Next.js proxy in `frontend/next.config.js`.  No further edits are needed for local development.

---

## 4. Database & Redis

### Database migrations

Run migrations to create indexes and seed the default school:

```bash
node scripts/migrate.js
```

Migrations are idempotent — safe to run multiple times.

### Seed sample data (optional)

```bash
node scripts/seed-test-data.js          # upsert (safe to re-run)
node scripts/seed-test-data.js --clean  # drop and recreate
```

### Redis

Redis is **optional** for local development but recommended.  Without it:

- Rate-limit counters reset on restart
- BullMQ retry queue is not available (falls back to MongoDB retry)
- Distributed locks use in-process storage only

Start Redis locally:

```bash
# macOS with Homebrew
brew install redis && brew services start redis

# Linux
sudo systemctl start redis

# Docker (no install needed)
docker run -d -p 6379:6379 redis:7-alpine
```

Then set `REDIS_HOST=localhost` in `backend/.env`.

---

## 5. Start the Backend

```bash
cd backend && npm run dev
```

Expected output:

```
MongoDB connected
Server running on port 5000
Background polling started
Retry worker started
```

Verify it's healthy:

```bash
curl http://localhost:5000/health
# { "status": "ok" }
```

The Swagger UI is available at [http://localhost:5000/api/docs](http://localhost:5000/api/docs) in development.

---

## 6. Start the Frontend

In a **new terminal**:

```bash
cd frontend && npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

---

## 7. Run Tests

```bash
# All tests (root, backend, and frontend)
npm test

# Backend tests only
cd backend && npm test

# Specific test file
npm test tests/stellar.test.js

# Root-level integration tests (no live network needed — mocked)
npm test -- --testPathPattern=tests/

# Watch mode (re-runs on file change)
cd backend && npm test -- --watch
```

Tests mock both the Stellar SDK and MongoDB — **no real network or database required**.

---

## 8. Common Issues

### `MongoServerError: not primary` or `Transaction numbers are only allowed on a replica set`

MongoDB is running as a standalone instance, not a replica set.  Start it with `--replSet rs0` and run `rs.initiate()` once.  See [Prerequisites → MongoDB as a replica set](#mongodb-as-a-replica-set).

### `Error: connect ECONNREFUSED 127.0.0.1:27017`

MongoDB is not running.  Start it, or use Docker Compose (`docker compose up`).

### `tx_insufficient_balance` when testing payments

Your testnet wallet has 0 XLM.  Fund it via [Friendbot](https://laboratory.stellar.org/#account-creator?network=test).

### `Error: JWT_SECRET must be at least 32 characters`

Generate a proper secret:

```bash
openssl rand -hex 32
```

Paste the output into `JWT_SECRET=` in `backend/.env`.

### Frontend shows `Failed to fetch` or CORS errors

Check that the backend is running on port 5000 and that `frontend/.env.local` has `NEXT_PUBLIC_API_URL=/api`.  The Next.js proxy in `next.config.js` forwards `/api/*` requests to `http://localhost:5000`.

---

## First PR Checklist

Before opening a pull request:

- [ ] **Branch name** follows `feature/my-feature`, `fix/issue-NNN`, or `docs/topic` conventions.
- [ ] **Tests added** for any new behaviour.  Run `npm test` and confirm all tests pass.
- [ ] **No secrets committed** — run `node scripts/scan-repo-secrets.js` before pushing.
- [ ] **`CHANGELOG.md` updated** — add a line under `[Unreleased]` describing what changed.
- [ ] **ESLint passes** — run `cd backend && npm run lint` and `cd frontend && npm run lint`.
- [ ] **Self-reviewed** — read your own diff in the GitHub PR preview before requesting review.
- [ ] **PR description** includes:
  - What the change does
  - How it was tested
  - The issue it closes (e.g. `Closes #NNN`)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution guide, coding standards, and PR review process.
