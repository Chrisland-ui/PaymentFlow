# Observability Guide

This document is the single source of truth for monitoring StellarEduPay in production. It covers the Grafana dashboards, the full alert catalog, runbook links, metrics retention policy, and the on-call rotation schedule.

---

## Table of Contents

- [Monitoring Stack](#monitoring-stack)
- [Grafana Dashboards](#grafana-dashboards)
- [Alert Catalog](#alert-catalog)
  - [API Errors](#api-errors)
  - [API Latency](#api-latency)
  - [MongoDB](#mongodb)
  - [Horizon Poll](#horizon-poll)
  - [Horizon Failover](#horizon-failover)
  - [Payment Processing Latency](#payment-processing-latency)
  - [Payment Queue Backpressure](#payment-queue-backpressure)
  - [Transaction Queue](#transaction-queue)
  - [Payment Limits](#payment-limits)
  - [Receipts](#receipts)
  - [Webhooks](#webhooks)
  - [Backup](#backup)
  - [Node.js Heap](#nodejs-heap)
  - [Leader Election](#leader-election)
  - [Price Feed](#price-feed)
  - [Admin Alerts](#admin-alerts)
- [Key Metrics Reference](#key-metrics-reference)
- [Metrics Retention Policy](#metrics-retention-policy)
- [On-Call Rotation](#on-call-rotation)
- [Adding a New Alert](#adding-a-new-alert)

---

## Monitoring Stack

| Component | URL | Purpose |
|-----------|-----|---------|
| Prometheus | `http://localhost:9090` | Metrics scraping and alerting |
| Grafana | `http://localhost:3001` | Dashboards and visualization |
| Metrics endpoint | `http://localhost:5000/metrics` | Live Prometheus metrics from backend |
| Health endpoint | `http://localhost:5000/health` | System health check |

Start the full monitoring stack with:

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up
```

---

## Grafana Dashboards

All dashboards are auto-provisioned from `monitoring/grafana/dashboards/`. They are available immediately after `docker compose up`.

| Dashboard | File | URL | Purpose |
|-----------|------|-----|---------|
| Payments | `payments.json` | `http://localhost:3001/d/stellaredupay-payments` | Payment funnel, confirmation rates, verification latency, overpayment counts |
| Webhooks | `webhooks.json` | `http://localhost:3001/d/stellaredupay-webhooks` | Webhook delivery rates, failure rates, dead-letter queue depth, latency |
| Infrastructure | `infrastructure.json` | `http://localhost:3001/d/stellaredupay-infra` | Node.js heap, event loop lag, HTTP request rates, MongoDB connection state, Redis memory |
| Transaction Queue | `transaction_queue.json` | `http://localhost:3001/d/stellaredupay-queue` | BullMQ queue depth, worker liveness, job throughput, dead-letter count |
| Price Feed | `price_feed.json` | `http://localhost:3001/d/stellaredupay-price-feed` | Price feed staleness per provider, last success timestamps, fiat conversion availability |

> **Note:** Dashboard URLs above assume the default Grafana anonymous access configuration used by Docker Compose. In a production environment, replace `localhost:3001` with your Grafana hostname and authenticate as required.

### Verifying Dashboard Links

Run the monitoring stack and confirm each dashboard loads before releasing changes to alert annotations. Dashboard UIDs are hardcoded in the JSON files and must match the `dashboard_url` annotations in alert rules.

---

## Alert Catalog

Each alert is listed with: severity, trigger condition, typical cause, response steps, and owner by role.

Alert definitions live in `monitoring/alerts/`. All alerts route through Prometheus Alertmanager and page the on-call engineer for `critical` severity.

---

### API Errors

**File:** `monitoring/alerts/api_errors.yml`

#### ApiHigh5xxRateWarning

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | 5xx response rate > 5 % sustained for 10 minutes |
| Runbook | [docs/runbooks/api-errors.md](runbooks/api-errors.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Transient MongoDB blip, a bad deploy, or a dependency (Horizon, Redis) degrading.

**Response steps:**
1. Check `mongodb_connection_state` and `horizon_circuit_breaker_state` in Grafana Infrastructure dashboard.
2. Review application error logs: `docker logs backend | grep '"level":"error"'`.
3. If caused by a bad deploy, initiate rollback (see [Release Process](release-process.md)).
4. If MongoDB is the cause, follow the MongoDB Runbook in [docs/operator-runbooks.md](operator-runbooks.md).
5. Escalate to critical if rate crosses 20 % (ApiHigh5xxRateCritical will fire).

---

#### ApiHigh5xxRateCritical

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | 5xx response rate > 20 % sustained for 5 minutes |
| Runbook | [docs/runbooks/api-errors.md](runbooks/api-errors.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Active outage — bad deploy, MongoDB down, Horizon fully unreachable.

**Response steps:**
1. Page secondary on-call if not already on the incident.
2. Immediately check `GET /health` — if `503`, an upstream dependency is down.
3. Review the Payments dashboard for payment funnel drop.
4. If a recent deploy is the cause, roll back immediately (see [Release Process](release-process.md#rollback-procedures)).
5. Open an incident record with time, environment, and affected tenants.

---

### API Latency

**File:** `monitoring/alerts/api_latency.yml`

#### ApiLatencyP95High

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | HTTP p95 latency > 1 second for 10 minutes |
| Runbook | [docs/runbooks/api-latency.md](runbooks/api-latency.md) |
| Owner | Backend on-call engineer |

**Typical cause:** MongoDB slow queries, Horizon API latency, or high concurrent request load.

**Response steps:**
1. Check `mongodb_connection_state` and MongoDB query times in logs.
2. Check Horizon request latency on the Infrastructure dashboard.
3. Review `payment_processor_queue_depth` — high queue depth can slow payment routes.
4. If load is the cause, verify HPA scaling in Kubernetes (`kubectl get hpa`).

---

#### ApiLatencyP99Critical

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | HTTP p99 latency > 2.5 seconds for 10 minutes |
| Runbook | [docs/runbooks/api-latency.md](runbooks/api-latency.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Payment confirmation routes timing out due to Horizon or MongoDB degradation.

**Response steps:**
1. Page on-call immediately.
2. Check if parents are reporting failed payment confirmations.
3. If MongoDB is degraded, follow the MongoDB Down runbook in [docs/operator-runbooks.md](operator-runbooks.md).
4. Consider enabling maintenance mode to prevent new payment submissions while fixing the root cause.

---

### MongoDB

**File:** `monitoring/alerts/mongodb.yml`

#### MongoDBDisconnected

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `mongodb_connection_state != 1` for 1 minute |
| Runbook | [docs/operator-runbooks.md#mongo-or-database-down](operator-runbooks.md#mongo-or-database-down) |
| Owner | Database on-call engineer |

**Typical cause:** MongoDB replica set election, network partition, or container crash.

**Response steps:**
1. Page on-call immediately — all payment reads and writes are failing.
2. Check MongoDB container/pod health: `docker ps` or `kubectl get pods`.
3. Verify replica set status: `mongosh --eval "rs.status()"`.
4. Follow the [Mongo Or Database Down runbook](operator-runbooks.md#mongo-or-database-down).
5. Do not resume workers until database and queue state are consistent.

---

#### MongoDBConnectionErrorsElevated

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `rate(mongodb_connection_errors_total[5m]) > 0` for 5 minutes |
| Runbook | [docs/operator-runbooks.md#mongo-or-database-down](operator-runbooks.md#mongo-or-database-down) |
| Owner | Database on-call engineer |

**Typical cause:** Unstable connection pool; the driver is retrying transparently.

**Response steps:**
1. Review logs for `[MongoDB] Connection error` entries.
2. Check MongoDB Atlas or replica-set health dashboard.
3. Monitor `mongodb_connection_state` — if it drops below 1, treat as MongoDBDisconnected.

---

### Horizon Poll

**File:** `monitoring/alerts/horizon_poll.yml`

#### HorizonPollSchoolFallingBehind

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `horizon_poll_max_deferral_cycles > 5` for 15 minutes |
| Runbook | [docs/horizon-rate-limits.md](horizon-rate-limits.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Fleet has outgrown the Horizon allowance; one or more schools are being repeatedly deferred.

**Response steps:**
1. Check `horizon_poll_deferred_schools` metric.
2. Review [docs/horizon-rate-limits.md](horizon-rate-limits.md) operational guidance section.
3. Consider raising `HORIZON_RATE_LIMIT_PER_HOUR` or adding a dedicated Horizon instance.

---

#### HorizonRateLimitedDespiteBudget

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `rate(horizon_rate_limited_total[15m]) > 0` for 15 minutes |
| Runbook | [docs/horizon-rate-limits.md](horizon-rate-limits.md) |
| Owner | Backend on-call engineer |

**Typical cause:** `HORIZON_RATE_LIMIT_PER_HOUR` exceeds actual Horizon allowance, or `HORIZON_POLL_REPLICA_COUNT` is wrong.

**Response steps:**
1. Verify `HORIZON_POLL_REPLICA_COUNT` matches the running replica count.
2. Cross-check the configured limit against the actual Horizon API rate limit.
3. Reduce `HORIZON_RATE_LIMIT_PER_HOUR` and redeploy if overconfigured.

---

#### HorizonPollBudgetCollapsed

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `horizon_poll_budget_ceiling <= 4` for 30 minutes |
| Runbook | [docs/horizon-rate-limits.md](horizon-rate-limits.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Sustained rate limiting has caused AIMD to reduce the budget to its floor.

**Response steps:**
1. Page on-call — payment sync is at a fraction of nominal throughput.
2. Investigate root cause of rate limiting (see HorizonRateLimitedDespiteBudget steps).
3. After fixing the root cause, the ceiling will recover automatically via AIMD additive increase.

---

#### HorizonPollBudgetSaturated

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `horizon_poll_deferred_schools > 0` for 1 hour |
| Runbook | [docs/horizon-rate-limits.md](horizon-rate-limits.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Number of active schools has exceeded the polling capacity for the configured Horizon allowance.

**Response steps:**
1. Assess the deferred school count vs. total active schools.
2. Consider sharding schools across replicas or raising the Horizon allowance.
3. Check `POLL_INTERVAL_MS` — lengthening it reduces per-school poll frequency.

---

### Horizon Failover

**File:** `monitoring/alerts/horizon_failover.yml`

#### HorizonFailoverEventsOccurring

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `sum(rate(horizon_failover_total[15m])) > 0` for 15 minutes |
| Runbook | [docs/operator-runbooks.md#horizon-or-stellar-network-down](operator-runbooks.md#horizon-or-stellar-network-down) |
| Owner | Backend on-call engineer |

**Typical cause:** Primary Horizon endpoint is degraded; client is failing over to a backup.

**Response steps:**
1. Check `horizon_circuit_breaker_state` per endpoint in Grafana.
2. Test the primary Horizon URL directly: `curl https://horizon-testnet.stellar.org/`.
3. Follow [Horizon Or Stellar Network Down runbook](operator-runbooks.md#horizon-or-stellar-network-down).

---

#### HorizonCircuitBreakerOpen

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `horizon_circuit_breaker_state == 1` for 5 minutes |
| Runbook | [docs/operator-runbooks.md#horizon-or-stellar-network-down](operator-runbooks.md#horizon-or-stellar-network-down) |
| Owner | Backend on-call engineer |

**Typical cause:** An individual Horizon endpoint is returning sustained 5xx/429/network errors.

**Response steps:**
1. Identify the affected endpoint from `$labels.url`.
2. Check Stellar network status at `https://status.stellar.org`.
3. If all endpoints are affected, see HorizonAllEndpointsUnavailable.

---

#### HorizonAllEndpointsUnavailable

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `min(horizon_circuit_breaker_state) == 1` for 2 minutes |
| Runbook | [docs/operator-runbooks.md#horizon-or-stellar-network-down](operator-runbooks.md#horizon-or-stellar-network-down) |
| Owner | Backend on-call engineer |

**Typical cause:** Complete Stellar network outage, or all configured Horizon URLs are down.

**Response steps:**
1. Page on-call immediately — no new payments are being confirmed.
2. Check `https://status.stellar.org` for a network-wide incident.
3. Stop new payment submissions to prevent user-facing errors.
4. Do not mark payments as failed until ledger status is confirmed.

---

### Payment Processing Latency

**File:** `monitoring/alerts/payment_processing_latency.yml`

#### PaymentProcessingLatencyHigh

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | Payment processing p95 > 10 seconds for 5 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Horizon polling latency or transaction retry queue backlog.

**Response steps:**
1. Check `horizon_request_duration_seconds` histogram in Grafana.
2. Check `transaction_queue_depth` on the Transaction Queue dashboard.
3. If the retry queue is backed up, review `GET /api/admin/retry-queue/stats`.

---

### Payment Queue Backpressure

**File:** `monitoring/alerts/queue_backpressure.yml`

#### PaymentQueueBackpressureHighWater

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `payment_processor_queue_depth >= payment_processor_queue_backpressure_high_water` for 5 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Horizon or MongoDB latency causing the payment processor to drain slowly.

**Response steps:**
1. Check `horizon_request_duration_seconds` and `mongodb_connection_state`.
2. Review payment processing logs for slow confirms.
3. The poller automatically reduces its batch size at this threshold — this is expected behavior. Investigate if it persists.

---

#### PaymentQueueNearCapacity

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `payment_processor_queue_depth >= payment_processor_queue_max_depth` for 2 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Processor queue is completely full; new payments are being rejected with QUEUE_FULL.

**Response steps:**
1. Page on-call immediately — payments are actively being rejected.
2. Consider raising `MAX_QUEUE_DEPTH` as an immediate mitigation.
3. Investigate the underlying drain issue (Horizon/MongoDB latency).

---

### Transaction Queue

**File:** `monitoring/alerts/transaction_queue.yml`

#### TransactionQueueBacklogSustained

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `transaction_queue_depth >= transaction_queue_depth_alert_threshold` for 5 minutes |
| Runbook | [docs/operator-runbooks.md#redis-or-queue-down](operator-runbooks.md#redis-or-queue-down) |
| Owner | Backend on-call engineer |

**Typical cause:** BullMQ worker is not keeping up with intake; Horizon or MongoDB latency.

**Response steps:**
1. Check worker liveness via `GET /health` — `workers.transactionQueueWorker` must be `true`.
2. Review Transaction Queue dashboard for job throughput.
3. Follow [Redis Or Queue Down runbook](operator-runbooks.md#redis-or-queue-down) if the worker is down.

---

### Payment Limits

**File:** `monitoring/alerts/payment_limits.yml`

#### PaymentLimitTriggeredFrequently

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `sum(rate(payment_limit_triggered_total[15m])) by (school_id, asset, code) > 0.01` for 15 minutes |
| Runbook | [docs/payment-limits.md](payment-limits.md) |
| Owner | Backend on-call engineer / School administrator |

**Typical cause:** Configured limits no longer match the school's fee structure, or probing with out-of-range amounts.

**Response steps:**
1. Identify the school and code from `$labels.school_id` and `$labels.code`.
2. Review effective limits: `GET /api/admin/payment-limits?schoolId=<school_id>`.
3. Adjust limits without a redeploy: `PUT /api/admin/payment-limits`.

---

#### PaymentLimitBlockingMostPayments

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | Payment limit rejections > 50 % of received payments for 15 minutes |
| Runbook | [docs/payment-limits.md](payment-limits.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Limit configured in the wrong asset's value range — parents cannot pay.

**Response steps:**
1. Page on-call immediately.
2. Check `GET /api/admin/payment-limits?schoolId=<school_id>` — inspect the `source` field.
3. Update the limit via `PUT /api/admin/payment-limits` to unblock payments.

---

### Receipts

**File:** `monitoring/alerts/receipts.yml`

#### ReceiptGenerationFailures

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `sum(rate(receipt_generation_failures_total[10m])) by (source) > 0` for 10 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Receipt template error, receipt model/DB fault, or downstream dependency issue.

**Response steps:**
1. Search logs: `docker logs backend | grep "receipt generation failed"`.
2. Payments are still confirmed on-chain; only receipts are affected.
3. Identify failing `txHash` values from logs and backfill receipts after fixing root cause.

---

#### ReceiptGenerationSystemicFailure

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | Receipt failure rate > 50 % of confirmed payments for 15 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Receipt pipeline systemically broken — template engine, DB connection, or dependency outage.

**Response steps:**
1. Page on-call immediately.
2. Payments are unaffected (on-chain and recorded), but receipts need backfilling.
3. Fix root cause, then batch-generate missing receipts for affected payments.

---

### Webhooks

**File:** `monitoring/alerts/webhook_alerts.yml`

#### WebhookHighFailureRate

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | Webhook failure rate > 20 % for 5 minutes |
| Runbook | [docs/WEBHOOK_INTEGRATION.md](WEBHOOK_INTEGRATION.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Downstream webhook endpoints are returning non-2xx responses.

**Response steps:**
1. Check the Webhooks dashboard for failing endpoint URLs.
2. Review dead-letter queue: `GET /api/admin/webhooks/dlq`.
3. Contact school admins whose endpoints are failing if external.

---

#### WebhookDeadLetterGrowing

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `webhook_dead_letter_total > 50` for any school |
| Runbook | [docs/WEBHOOK_INTEGRATION.md](WEBHOOK_INTEGRATION.md) |
| Owner | Backend on-call engineer |

**Typical cause:** School's webhook endpoint has been consistently unavailable.

**Response steps:**
1. Identify the school from `$labels.schoolId`.
2. Replay or discard dead-letter entries: `POST /api/admin/webhooks/dlq/:id/retry`.
3. Investigate the school's endpoint health.

---

#### WebhookHighLatency

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | Webhook delivery p95 latency > 5 seconds for 5 minutes |
| Runbook | [docs/WEBHOOK_INTEGRATION.md](WEBHOOK_INTEGRATION.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Slow downstream webhook endpoints approaching the 10-second timeout.

**Response steps:**
1. Check which school endpoints are slow on the Webhooks dashboard.
2. Alert school administrators to optimize their webhook handler response times.

---

### Backup

**File:** `monitoring/alerts/backup.yml`

#### BackupStale

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | Last successful backup > 26 hours ago |
| Runbook | [docs/runbooks/backup-staleness.md](runbooks/backup-staleness.md) |
| Owner | Infrastructure on-call engineer |

**Typical cause:** Backup container failed silently; `BACKUP_NOTIFY_TOKEN` misconfigured.

**Response steps:**
1. Check: `docker logs <backup-container>`.
2. Verify `BACKUP_NOTIFY_TOKEN` is set in both backup and backend containers.
3. Run a manual backup: `./scripts/backup.sh`.

---

#### BackupCriticallyStale

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | Last successful backup > 48 hours ago |
| Runbook | [docs/runbooks/backup-staleness.md](runbooks/backup-staleness.md) |
| Owner | Infrastructure on-call engineer |

**Typical cause:** Backup has been failing for 2+ consecutive scheduled runs.

**Response steps:**
1. Page on-call immediately — financial and student data is at risk.
2. Run a manual backup immediately: `./scripts/backup.sh`.
3. Investigate and fix the backup schedule before the next window.

---

#### BackupNotRun

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `backup_last_success_timestamp_seconds == 0` for 26 hours |
| Runbook | [docs/runbooks/backup-staleness.md](runbooks/backup-staleness.md) |
| Owner | Infrastructure on-call engineer |

**Typical cause:** Backend just restarted and has not yet received a successful backup heartbeat, or `BACKUP_NOTIFY_TOKEN` is misconfigured.

**Response steps:**
1. Verify `BACKUP_NOTIFY_TOKEN` is correctly set.
2. Check that the backup container can reach the backend on `BACKEND_INTERNAL_URL`.

---

#### BackupRestoreTestStale

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `last_backup_restore_test_age_seconds > 691200` (8 days) |
| Runbook | [docs/runbooks/backup-staleness.md](runbooks/backup-staleness.md) |
| Owner | Infrastructure on-call engineer |

**Typical cause:** Weekly backup-restore-test CI workflow has failed silently.

**Response steps:**
1. Check GitHub Actions workflow run history for `backup-restore-test`.
2. Investigate and re-run the failed workflow.

---

#### BackupVerificationStale

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `last_backup_verification_age_seconds > 691200` (8 days) |
| Runbook | [docs/runbooks/backup-staleness.md](runbooks/backup-staleness.md) |
| Owner | Infrastructure on-call engineer |

**Typical cause:** Weekly backup-verify job failed silently.

**Response steps:**
1. Check: `docker logs <backup-verify-container>`.
2. Run `./scripts/verify-latest-backup.sh` manually to diagnose.

---

### Node.js Heap

**File:** `monitoring/alerts/heap_usage.yml`

#### NodeHeapUsageHigh

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `nodejs_heap_used_ratio > 0.85` for 10 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Memory leak in the backend process; out-of-memory crash is imminent.

**Response steps:**
1. Page on-call — OOM crash is imminent.
2. Capture a heap snapshot before restarting: attach Node.js inspector if available.
3. Restart the backend container/pod as an immediate mitigation.
4. Investigate the root cause (memory leak) in a non-production environment.

---

### Leader Election

**File:** `monitoring/alerts/leader_election.yml`

#### LeaderElectionSplitBrain

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `sum(leader_election_is_leader) > 1` for 1 minute |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Redis network partition leaving two replicas believing they hold the leader lock.

**Response steps:**
1. Page on-call — singleton schedulers are running twice (duplicate reminders, audit events, race conditions).
2. Check Redis reachability from every replica.
3. Restart the extra leader replica to release the stale lock.

---

#### LeaderElectionNoLeader

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `sum(leader_election_is_leader) == 0` for 5 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** All replicas lost Redis connectivity and cannot acquire the leader lock.

**Response steps:**
1. Check Redis health: `docker logs redis` or `kubectl logs <redis-pod>`.
2. Verify at least one backend replica is running.
3. Once Redis is restored, leadership will be re-acquired automatically.

---

#### LeaderElectionChurning

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `max(leader_election_tenure_seconds) < 300` for 15 minutes |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Redis latency or saturated event loop causing the leader lock to expire before renewal.

**Response steps:**
1. Check Redis latency metrics.
2. Review `LEADER_LOCK_TTL_MS` vs. `LEADER_RENEW_INTERVAL_MS` configuration.
3. Increase `LEADER_LOCK_TTL_MS` if Redis latency is elevated.

---

### Price Feed

**File:** `monitoring/alerts/price_feed.yml`

#### PriceFeedStalenessWarning

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | `price_feed_staleness_seconds > 300` for 2 minutes |
| Runbook | [docs/runbooks/price-feed-staleness.md](runbooks/price-feed-staleness.md) |
| Dashboard | `http://localhost:3001/d/stellaredupay-price-feed/stellaredupay-price-feed-health` |
| Owner | Backend on-call engineer |

**Typical cause:** CoinGecko or Coinbase API is temporarily unavailable.

**Response steps:**
1. Check provider status pages (CoinGecko, Coinbase).
2. Review Price Feed dashboard for staleness trend.
3. Fiat display may be serving cached values — acceptable for brief outages.

---

#### PriceFeedStale

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `price_feed_stale == 1` for 15 minutes |
| Runbook | [docs/runbooks/price-feed-staleness.md](runbooks/price-feed-staleness.md) |
| Dashboard | `http://localhost:3001/d/stellaredupay-price-feed/stellaredupay-price-feed-health` |
| Owner | Backend on-call engineer |

**Typical cause:** Stale-while-revalidate window exhausted; fiat amounts show "rate unavailable."

**Response steps:**
1. Page on-call — fiat currency conversions are fully degraded.
2. Follow the [Price Feed Staleness runbook](runbooks/price-feed-staleness.md).
3. Investigate connectivity to price feed providers.

---

#### PriceFeedNoRecentSuccess

| Field | Value |
|-------|-------|
| Severity | `warning` |
| Trigger | No successful price feed fetch for 10 minutes |
| Runbook | [docs/runbooks/price-feed-staleness.md](runbooks/price-feed-staleness.md) |
| Dashboard | `http://localhost:3001/d/stellaredupay-price-feed/stellaredupay-price-feed-health` |
| Owner | Backend on-call engineer |

**Typical cause:** Process restart wiped in-memory counter; no successful fetch since restart.

**Response steps:**
1. Check price feed service logs for fetch errors.
2. Verify network connectivity to price providers from the backend container.

---

### Admin Alerts

**File:** `monitoring/alerts/admin-alerts.yml`

#### AdminAlertFired

| Field | Value |
|-------|-------|
| Severity | `critical` |
| Trigger | `increase(send_admin_alert_total[5m]) > 0` for 1 minute |
| Runbook | [docs/operator-runbooks.md](operator-runbooks.md) |
| Owner | Backend on-call engineer |

**Typical cause:** Internal `alertService` was called — typically a data consistency issue or critical internal error.

**Response steps:**
1. Search application logs for the alert context: `docker logs backend | grep "admin alert"`.
2. Identify the root cause from log context and follow the relevant runbook.

---

## Key Metrics Reference

| Metric | Type | Description |
|--------|------|-------------|
| `http_request_duration_seconds` | Histogram | HTTP request latency by method, route, status |
| `mongodb_connection_state` | Gauge | Mongoose connection state (1=connected) |
| `mongodb_connection_errors_total` | Counter | MongoDB driver connection errors |
| `horizon_circuit_breaker_state` | Gauge | Per-endpoint circuit breaker (0=closed, 1=open, 2=half_open) |
| `horizon_failover_total` | Counter | Horizon endpoint failover events |
| `horizon_rate_limited_total` | Counter | Horizon 429 responses |
| `horizon_poll_max_deferral_cycles` | Gauge | Max consecutive deferral cycles for any school |
| `horizon_poll_budget_ceiling` | Gauge | AIMD adaptive poll budget ceiling |
| `horizon_poll_deferred_schools` | Gauge | Schools deferred in the current cycle |
| `payment_processor_queue_depth` | Gauge | Current in-flight payment count |
| `payment_processor_queue_backpressure_high_water` | Gauge | Configured backpressure threshold |
| `payment_processor_queue_max_depth` | Gauge | Configured maximum queue depth |
| `payment_processing_duration_seconds` | Histogram | Time from detection to confirmation |
| `transaction_queue_depth` | Gauge | BullMQ transaction queue depth |
| `transaction_queue_depth_alert_threshold` | Gauge | Configured alert threshold |
| `payment_limit_triggered_total` | Counter | Payment limit rejections by school/asset/code |
| `payment_funnel_total` | Counter | Payments by funnel stage |
| `receipt_generation_failures_total` | Counter | Receipt generation failures by source |
| `webhook_deliveries_total` | Counter | Webhook delivery attempts by outcome |
| `webhook_dead_letter_total` | Gauge | Webhook dead-letter count by school |
| `webhook_delivery_duration_ms` | Histogram | Webhook delivery latency |
| `backup_last_success_timestamp_seconds` | Gauge | Unix timestamp of last successful backup |
| `last_backup_restore_test_age_seconds` | Gauge | Age of last successful restore test |
| `last_backup_verification_age_seconds` | Gauge | Age of last successful backup verification |
| `nodejs_heap_used_ratio` | Gauge | Node.js used heap / total heap |
| `leader_election_is_leader` | Gauge | 1 if this replica holds leader lock |
| `leader_election_tenure_seconds` | Gauge | Seconds current leader has held the lock |
| `price_feed_staleness_seconds` | Gauge | Seconds since last successful price fetch per provider |
| `price_feed_stale` | Gauge | 1 when stale-while-revalidate window exhausted |
| `send_admin_alert_total` | Counter | Internal admin alert invocations |

---

## Metrics Retention Policy

Prometheus retains scraped metrics for **15 days** by default (configured in `monitoring/prometheus.yml`). This is sufficient for:

- Incident post-mortems (most incidents resolve within hours)
- Weekly trend analysis
- Alert rule development and tuning

For longer-term retention (90+ days), use remote write to a long-term storage backend such as Thanos, VictoriaMetrics, or Grafana Cloud. Configure `remote_write` in `monitoring/prometheus.yml`.

| Tier | Retention | Use Case |
|------|-----------|----------|
| Hot (Prometheus local) | 15 days | Live alerting, dashboards, post-mortems |
| Warm (remote write) | 90 days | Trend analysis, capacity planning |
| Cold (object storage) | 1+ years | Compliance, annual capacity review |

Grafana dashboard retention follows Prometheus — panels will show "No data" for time ranges beyond the configured retention window.

---

## On-Call Rotation

Alert ownership is defined by **role**, not individual, to remain resilient through team changes.

| Role | Responsibilities |
|------|-----------------|
| Backend on-call engineer | API errors, latency, payment processing, Horizon connectivity, queue health, receipts, webhooks, heap usage, leader election, price feed |
| Database on-call engineer | MongoDB disconnection, connection errors, data integrity |
| Infrastructure on-call engineer | Backup staleness, restore test failures, Kubernetes pod health, Redis availability |

### Escalation Path

1. **P1 / Critical alerts:** Page primary on-call immediately via PagerDuty (or configured alerting channel). Secondary on-call is paged if no acknowledgment within 15 minutes.
2. **P2 / Warning alerts:** Create a ticket and assign to the on-call engineer for investigation within the same business day.
3. **Incident commander:** Assigned by the primary on-call engineer for P1 incidents. Responsible for coordination and communication.

### On-Call Handoff Checklist

At the start of each on-call shift, the incoming engineer should:

- [ ] Review open alerts and active incidents
- [ ] Check Grafana dashboards for any anomalies
- [ ] Verify all Prometheus targets are healthy (`http://localhost:9090/targets`)
- [ ] Confirm backup heartbeat is current
- [ ] Read the previous shift's incident notes

---

## Adding a New Alert

1. Create or update the appropriate YAML file in `monitoring/alerts/`.
2. Add a `runbook_url` annotation pointing to the relevant runbook in `docs/runbooks/` or `docs/operator-runbooks.md`.
3. Add a `dashboard_url` annotation if a relevant Grafana dashboard exists.
4. Add the alert to the catalog in this document with severity, trigger, typical cause, response steps, and owner.
5. Open a PR — the `alertRules.test.js` CI test validates YAML syntax and required annotation fields.

### Required Annotation Fields

Every production alert must include:

```yaml
annotations:
  summary: "Short human-readable description"
  description: >
    Detailed description with metric values and context.
  runbook_url: "https://github.com/onlyonee1/PaymentFlow/blob/main/docs/..."
```
