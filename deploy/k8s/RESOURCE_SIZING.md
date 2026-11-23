# Kubernetes Resource Sizing — PaymentFlow Backend

This document records the profiling data and rationale behind the CPU and memory
requests/limits set in `deploy/k8s/backend-deployment.yaml` and the HPA thresholds
in `deploy/k8s/backend-hpa.yaml`.

---

## Methodology

Resources were profiled by running `scripts/loadsim/horizonPollLoadModel.js` against
a staging cluster with a representative workload:

- **Baseline**: 10 concurrent users, steady-state (no active payment bursts)
- **Typical load (P50)**: 50 concurrent users, mixed payment verification + polling
- **Peak load (P99)**: 150 concurrent users, batch sync + report generation

Metrics were collected via the Prometheus endpoint (`/metrics`) and the Node.js
`process.memoryUsage()` via the heap monitoring utility (`src/utils/heapMonitoring.js`).

---

## API Server (`backend` Deployment)

| Metric      | Baseline | P50 (typical) | P99 (peak) | Limit (P99 + 20%) |
|-------------|----------|--------------|------------|-------------------|
| CPU         | ~80 m    | ~250 m       | ~650 m     | **1 000 m (1 vCPU)** |
| Memory (RSS)| ~130 Mi  | ~230 Mi      | ~380 Mi    | **512 Mi**        |

**Requests** (scheduler hint — set at P50):
- CPU: `250m`
- Memory: `256Mi`

**Limits** (hard ceiling — set at P99 + ~20 % buffer):
- CPU: `1000m`
- Memory: `512Mi`

### Notes
- Node.js single-threaded CPU is capped at ~1 vCPU per process. The 1 000 m limit
  matches this ceiling; exceeding it throttles rather than OOM-kills.
- Memory limit is set conservatively. The heap monitoring alert fires at 80 % of the
  512 Mi limit (~410 Mi) to give on-call time to react before OOM eviction.
- The HPA scales out at 70 % CPU utilisation (~700 m) and 80 % memory utilisation
  (~410 Mi), both within the limit, so new pods are provisioned before existing ones
  are throttled or evicted.

---

## Init Container (`migrate`)

The migration init container runs once per pod start, executes database migrations,
and exits. Its resource profile is much lower than the long-running API server.

| Metric   | Observed peak | Limit |
|----------|--------------|-------|
| CPU      | ~80 m        | **500m** |
| Memory   | ~100 Mi      | **256Mi** |

**Requests**:
- CPU: `100m`
- Memory: `128Mi`

**Limits**:
- CPU: `500m`
- Memory: `256Mi`

### Notes
- Migration 029 (`encrypt_student_pii`) performs a full collection scan and is the
  most resource-intensive migration. The 500 m CPU limit prevents it from starving
  other pods on the node during cluster upgrades.
- Once migrations are complete, the init container exits and releases its resources.

---

## BullMQ Worker (embedded in the API server process)

The BullMQ transaction queue worker runs inside the same Node.js process as the
Express API server. Its CPU contribution is already included in the API server
numbers above.

If workers are extracted into a dedicated `Deployment` in future, the following
baseline profile applies:

| Metric   | Idle  | Active (processing 10 jobs/s) |
|----------|-------|-------------------------------|
| CPU      | ~40 m | ~300 m                        |
| Memory   | ~90 Mi| ~200 Mi                       |

Recommended starting point for a dedicated worker deployment:
- Requests: `cpu: 100m`, `memory: 128Mi`
- Limits: `cpu: 500m`, `memory: 256Mi`

---

## Redis (`redis` Deployment)

| Metric   | Observed | Limit  |
|----------|---------|--------|
| CPU      | ~20 m   | **500m** |
| Memory   | ~50 Mi  | **256Mi** |

Limits are already set in `deploy/k8s/redis.yaml`.

---

## PodDisruptionBudget

`backend-pdb.yaml` sets `minAvailable: 1` against the `backend` selector.

With `replicas: 2` (the HPA minimum), this allows exactly one pod to be voluntarily
evicted at a time — sufficient to maintain availability during rolling upgrades and
node drains while still permitting maintenance operations to proceed without hanging.

---

## HorizontalPodAutoscaler

`backend-hpa.yaml` scales the `backend` Deployment between **2 and 10 replicas**
based on:

| Metric | Scale-out threshold | Rationale |
|--------|---------------------|-----------|
| CPU    | 70 % average utilisation | Keeps 30 % headroom for request spikes |
| Memory | 80 % average utilisation | Triggers before OOM-kill at the 512 Mi limit |

Scale-down uses a 300 s stabilisation window to prevent flapping under bursty traffic
(e.g., post-school-event payment syncs followed by a quiet period).

Scale-up adds up to 2 pods per 30 s with no stabilisation delay to absorb sudden
demand spikes quickly.

---

## Re-profiling Guidance

Re-run profiling whenever:
- A new background service is added to the API process
- Migration count grows past 40 (heap pressure from model loading increases)
- The Stellar SDK is upgraded (SDK v12→v13 may change memory footprint)

Use `docker stats` locally or query Prometheus for `container_cpu_usage_seconds_total`
and `container_memory_working_set_bytes` in staging.
