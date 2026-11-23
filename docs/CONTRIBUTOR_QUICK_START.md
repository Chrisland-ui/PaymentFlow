# Contributor Quick Start

This is the shortest supported path from a fresh clone to a running PaymentFlow development environment. The application uses Node.js 20, MongoDB 7 as a single-node replica set, Redis 7, an Express backend, and a Next.js frontend.

## Prerequisites

- Git
- Node.js 20.11.0 (see `.nvmrc`) and npm
- Docker Engine with Docker Compose v2
- `curl` and `openssl`

Check the versions before starting:

```bash
node --version
npm --version
docker compose version
```

## Clone and Install

```bash
git clone https://github.com/onlyonee1/PaymentFlow.git
cd PaymentFlow

npm ci
(cd backend && npm ci)
(cd frontend && npm ci)
```

The root dependencies support the repository-wide tests. The backend and frontend installs support their package-local tests, linting, and development commands.

## Configure Local Environment

Create the three local environment files. They are ignored by Git and must not be committed.

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Edit the files and replace placeholder secrets with local-only values:

- `.env`: set `MONGO_ROOT_PASSWORD`, `JWT_SECRET`, and `ADMIN_PASSWORD`. `MONGO_ROOT_USERNAME=root` is suitable for local Docker.
- `backend/.env`: set `MONGO_URI=mongodb://localhost:27017/stellaredupay`, a generated `JWT_SECRET`, and `REDIS_HOST=localhost` if running the backend outside Docker.
- `frontend/.env.local`: keep `NEXT_PUBLIC_API_URL=/api` for the same-origin Next.js proxy and `NEXT_PUBLIC_STELLAR_NETWORK=testnet`.

Generate values without printing them to a log:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

The root `.env` is used by Docker Compose. The backend file is used by backend scripts and host-run processes; keep their secrets consistent when switching between modes. `SCHOOL_WALLET_ADDRESS` is optional for startup. A valid Stellar testnet address is required only for migration or seed flows that create a school; see [Stellar testnet setup](stellar-integration.md#testnet-setup-for-contributors).

## Start the Local Stack

Run the complete stack so MongoDB stays on its internal network and can provide the replica set required by MongoDB transactions:

```bash
docker compose up --build -d --wait
```

Verify the services:

```bash
docker compose ps
curl http://localhost:5000/health
curl -I http://localhost:3000
```

Open the frontend at <http://localhost:3000>. The backend API is available at <http://localhost:5000>, and development API documentation is at <http://localhost:5000/api/docs>.

The Compose backend runs pending migrations before starting. Do not start a second backend on port 5000 while the Compose backend is running.

To stop the stack while keeping database data:

```bash
docker compose down
```

To remove local database volumes and start over, use `docker compose down -v`; this deletes local MongoDB data.

## Tests and First Change

Run the fast repository checks before editing:

```bash
npm test
(cd backend && npm test)
(cd frontend && npm test -- --runInBand)
```

Create a branch, make one small change, and run the check that covers it. For backend changes, also run `npm run lint` from `backend`; for frontend changes, run `npm run build` from `frontend` when the change affects rendering or routing.

```bash
git switch -c docs/my-first-change
# edit a file

git diff --check
```

When the change affects the running app, rebuild the relevant service and repeat the health check:

```bash
docker compose up --build -d backend frontend
curl http://localhost:5000/health
```

## Troubleshooting

### Compose does not start

Check the rendered service state and the first failing service:

```bash
docker compose ps
docker compose logs --tail=100 mongo
docker compose logs --tail=100 backend
```

If Compose reports that `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD`, or another required variable is missing, check the root `.env`. Do not paste that file or its logs into an issue. If an old local volume has an incompatible MongoDB initialization, stop the stack and recreate local data with `docker compose down -v`.

### Backend is unhealthy

The backend requires `MONGO_URI` and `JWT_SECRET`. Confirm that MongoDB is healthy before inspecting the backend:

```bash
docker compose ps mongo
docker compose logs --tail=100 backend
curl http://localhost:5000/health/ready
```

The health response can be `degraded` when Stellar Horizon or Redis is unavailable; MongoDB connectivity is what determines whether the service is `unhealthy`. A backend started on the host must use the host URI in `backend/.env`; a backend in Compose must use the Compose-provided URI and must not be pointed at `localhost` inside the container.

### Frontend cannot reach the API

Keep `NEXT_PUBLIC_API_URL=/api` in `frontend/.env.local` and ensure the backend is listening on port 5000. The Next.js development proxy targets `http://localhost:5000` by default. After changing a `NEXT_PUBLIC_*` value, restart or rebuild the frontend because Next.js embeds these values during startup/build.

### Tests fail before running

Run `npm ci` in the directory whose test command failed. Use the root test command for repository tests, `backend/npm test` for backend package tests, and `frontend/npm test` for frontend package tests. Integration, end-to-end, and Docker health-check suites are opt-in; use the scripts in the root `package.json` only when you have the required services and test data.

### Seed data is missing

Seeding is optional and requires a host-reachable MongoDB plus a valid Stellar public address. The default Compose file does not publish MongoDB's port, so run this with a local MongoDB or a deliberate Compose override that publishes MongoDB only to `127.0.0.1`:

```bash
npm run seed
```

The script reads `backend/.env`, creates the default `SCH001` demo school, and is safe to rerun. Use only synthetic local data; never put real student, credential, wallet-secret, or personally identifiable information in fixtures or logs.

## Useful Commands

```bash
docker compose logs -f backend
docker compose restart backend
(cd backend && npm run migrate)
(cd backend && npm run dev)
(cd frontend && npm run dev)
```

Use the host-run `dev` commands only after stopping the corresponding Compose service. The host-run backend requires MongoDB and Redis to be reachable from the host; the default Compose file intentionally does not publish MongoDB's port.
