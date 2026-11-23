# Production Resource Requests and Limits

> Issue #119 — sizing rationale for CPU/memory requests and limits across all
> PaymentFlow workloads.

## Background

Resource requests tell the Kubernetes scheduler how much CPU and memory to
reserve on a node for a pod. Limits cap how much a pod can consume before it is
throttled (CPU) or OOM-killed (memory). Under-specifying requests causes noisy
workloads to starve payment-critical pods; over-specifying wastes cluster
capacity.

Values below are derived from:

1. Representative load profiling documented in `docs/load-simulation.md`.
2. Observed Docker Compose tuning values in `docker-compose.yml`
   (`BACKEND_MEM_LIMIT=512m`, `FRONTEND_MEM_LIMIT=256m`, `REDIS_MEM_LIMIT=128m`,
   `MONGO_MEM_LIMIT=1g`).
3. Node.js heap sizing: the default V8 heap for a 64-bit process is ~1.5 GB but
   the backend rarely exceeds 200 MB at steady state; a 512 Mi limit leaves a
   comfortable buffer for spikes.

---

## Workload Sizing

### Backend API (Node.js / Express)

| Metric | Request | Limit | Rationale |
|--------|---------|-------|-----------|
| CPU | 250m | 1000m | Steady-state ~200m; spikes to ~800m on end-of-term batch |
| Memory | 256Mi | 512Mi | Node.js heap steady-state ~150 Mi; 512 Mi matches Docker Compose |

The HPA (`backend-hpa.yaml`) scales between 2–10 replicas at 70% average CPU,
so a burst above 1000m per pod should trigger a scale-out rather than CPU
throttling of a single pod.

### Frontend (Next.js)

| Metric | Request | Limit | Rationale |
|--------|---------|-------|-----------|
| CPU | 100m | 500m | Next.js SSR pages are lightweight; 500m handles concurrent renders |
| Memory | 192Mi | 384Mi | Next.js SSR steady-state ~120 Mi; reduced from Docker Compose 256m |

### Redis (BullMQ queue, rate-limit counters)

| Metric | Request | Limit | Rationale |
|--------|---------|-------|-----------|
| CPU | 100m | 500m | Redis is single-threaded; 500m is the ceiling for a single command |
| Memory | 128Mi | 256Mi | Queue + rate-limit data fits well under 128 Mi; 256 Mi matches Docker Compose |

### MongoDB (StatefulSet, 3 replicas)

| Metric | Request | Limit | Rationale |
|--------|---------|-------|-----------|
| CPU | 250m | 1000m | Aggregation queries on payment history can spike briefly |
| Memory | 512Mi | 1Gi | WiredTiger cache default = RAM/2; 1 Gi limit matches Docker Compose |

### Migration init-container (backend)

| Metric | Request | Limit | Rationale |
|--------|---------|-------|-----------|
| CPU | 100m | 500m | Short-lived; runs one migration sweep then exits |
| Memory | 128Mi | 256Mi | Minimal Node.js process loading Mongoose + running migrations |

---

## OOM and Throttling Behaviour

**CPU throttling**: When a pod exceeds its CPU limit Kubernetes applies CFS
throttling (not a kill). Payment-path endpoints may respond slower but the pod
stays alive. The HPA will scale out before sustained throttling affects p99
latency.

**OOM kill**: When memory exceeds the limit, the kernel OOM-kills the container
and Kubernetes restarts it (CrashLoopBackOff if it happens repeatedly).
Monitor `container_memory_working_set_bytes` and alert at 80% of the limit
so engineers can investigate before an OOM event occurs.

**Recommended alert thresholds** (add to `monitoring/alerts/`):

| Workload | Warning (memory) | Critical (memory) |
|----------|-----------------|------------------|
| backend | > 410 Mi (80%) | > 460 Mi (90%) |
| frontend | > 307 Mi (80%) | > 345 Mi (90%) |
| redis | > 204 Mi (80%) | > 230 Mi (90%) |
| mongodb | > 819 Mi (80%) | > 921 Mi (90%) |

---

## Schedulability

A standard 3-node cluster with 2 vCPU / 4 GiB nodes can accommodate:

- 2 backend replicas × 250m + 256Mi
- 2 frontend replicas × 100m + 192Mi
- 1 redis × 100m + 128Mi
- 3 mongodb × 250m + 512Mi

Total request: ~1700m CPU / ~2.5 GiB — fits within a 3 × 2 vCPU cluster
(6000m available minus OS/system overhead ~1200m ≈ 4800m usable).

If the HPA scales backend to 10 replicas, additional node capacity is required
(10 × 250m = 2500m CPU + 2560Mi memory for backend pods alone). Plan cluster
autoscaling accordingly.

---

## Tuning Process

When load patterns change:

1. Collect `container_cpu_usage_seconds_total` and
   `container_memory_working_set_bytes` from Prometheus over a representative
   peak (e.g. end-of-term fee collection).
2. Set `requests` to p95 observed usage; set `limits` to 2× request (CPU) or
   1.5× request (memory).
3. Validate that the cluster can schedule the target replica count with the new
   values before deploying to production.
4. Update this document with the new values and the date of the measurement.
