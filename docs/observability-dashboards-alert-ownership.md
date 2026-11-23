# Observability Dashboards and Alert Ownership

> **Purpose:** Document every production alert, its Prometheus metric, associated
> Grafana dashboard, linked runbook, and escalation owner. All labels and metric
> names in this document are verified against the configurations in
> `monitoring/alerts/` and `monitoring/grafana/dashboards/`.
>
> Update this document whenever an alert rule, dashboard, or runbook is added,
> modified, or retired.

---

## Table of Contents

1. [Monitoring Stack](#1-monitoring-stack)
2. [Grafana Dashboards](#2-grafana-dashboards)
3. [Alert Inventory](#3-alert-inventory)
   - [API Errors](#31-api-errors)
   - [API Latency](#32-api-latency)
   - [MongoDB](#33-mongodb)
   - [Transaction Queue](#34-transaction-queue)
   - [Queue Backpressure](#35-queue-backpressure)
   - [Horizon Poll](#36-horizon-poll)
   - [Webhooks](#37-webhooks)
   - [Price Feed](#38-price-feed)
   - [Backup](#39-backup)
   - [Leader Election](#310-leader-election)
   - [Payment Processing Latency](#311-payment-processing-latency)
   - [Payment Limits](#312-payment-limits)
   - [Heap Usage](#313-heap-usage)
   - [Receipts](#314-receipts)
4. [Metric Reference](#4-metric-reference)
5. [Escalation Ownership Summary](#5-escalation-ownership-summary)
6. [Stale or Unowned Alerts](#6-stale-or-unowned-alerts)
7. [Runbook Index](#7-runbook-index)

---

## 1. Monitoring Stack

| Component | Default URL | Config File |
|-----------|------------|-------------|
| Prometheus | `http://localhost:9090` | `monitoring/prometheus.yml` |
| Grafana | `http://localhost:3001` | `monitoring/grafana/provisioning/` |
| Metrics endpoint | `http://localhost:5000/metrics` | `backend/src/metrics/index.js` |

Start the full monitoring stack:

```sh
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up
```

Prometheus scrapes `/metrics` on the backend container. Grafana datasource is
pre-provisioned via `monitoring/grafana/provisioning/datasources/`.

---

## 2. Grafana Dashboards

The following dashboards are provisioned automatically from
`monitoring/grafana/dashboards/` on Grafana startup.

| Dashboard File | Title / Purpose | Primary Audience |
|----------------|----------------|-----------------|
| `payments.json` | Payment pipeline health — confirmation rates, processing times, error distribution | API Operator, Product |
| `infrastructure.json` | Node.js process health — heap usage, event loop lag, HTTP throughput, MongoDB connection state | API Operator |
| `webhooks.json` | Webhook delivery rates, failure rate, dead-letter queue depth, latency | API Operator |
| `transaction_queue.json` | BullMQ transaction queue depth vs. alert threshold | API Operator, Blockchain Operator |
| `price_feed.json` | CoinGecko / Coinbase feed staleness, last success timestamp, fiat availability | API Operator |

**To access a dashboard:**

1. Navigate to Grafana at `http://localhost:3001`.
2. Sign in (default credentials in `docker-compose.monitoring.yml`; change in production).
3. Browse to "Dashboards" → the dashboard is listed under the provisioned folder.

---

## 3. Alert Inventory

Each alert entry includes: the rule name (as declared in the YAML file),
the Prometheus expression used, the firing threshold, the owner who must be
paged, and the runbook link.

### 3.1 API Errors

**Source file:** `monitoring/alerts/api_errors.yml`  
**Metric:** `http_request_duration_seconds_count{status=~"5.."}`  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `ApiHigh5xxRateWarning` | warning | 5xx rate / total rate | > 5% | 10 min |
| `ApiHigh5xxRateCritical` | critical | 5xx rate / total rate (5m window) | > 20% | 5 min |

**Runbook:** See `docs/operator-runbooks.md § General Incident Steps`. When
this alert fires, check `mongodb_connection_state` and
`horizon_circuit_breaker_state` for a root cause.

---

### 3.2 API Latency

**Source file:** `monitoring/alerts/api_latency.yml`  
**Metric:** `http_request_duration_seconds_bucket`  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `ApiLatencyP95High` | warning | `histogram_quantile(0.95, ...)` over all routes | > 1 s | 10 min |
| `ApiLatencyP99Critical` | critical | `histogram_quantile(0.99, ...)` over all routes | > 2.5 s | 10 min |

**Runbook:** When latency alerts fire, check:
- `mongodb_connection_state` for database bottleneck.
- `horizon_request_duration_seconds` for Stellar Horizon latency.
- The `infrastructure` Grafana dashboard for event-loop lag.

---

### 3.3 MongoDB

**Source file:** `monitoring/alerts/mongodb.yml`  
**Metrics:** `mongodb_connection_state`, `mongodb_connection_errors_total`  
**Owner:** Database Operator  
**Escalation channel:** `#db-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `MongoDBDisconnected` | critical | `mongodb_connection_state != 1` | Not connected | 1 min |
| `MongoDBConnectionErrorsElevated` | warning | `rate(mongodb_connection_errors_total[5m]) > 0` | Any errors | 5 min |

**Metric values:** `mongodb_connection_state`: 0 = disconnected, 1 = connected,
2 = connecting, 3 = disconnecting.

**Runbook:** `docs/operator-runbooks.md § Mongo Or Database Down`. When
`MongoDBDisconnected` fires, payment reads and writes are failing — treat as
SEV-1.

---

### 3.4 Transaction Queue

**Source file:** `monitoring/alerts/transaction_queue.yml`  
**Metrics:** `transaction_queue_depth`, `transaction_queue_depth_alert_threshold`  
**Owner:** API Operator, Blockchain Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `TransactionQueueBacklogSustained` | warning | `transaction_queue_depth >= transaction_queue_depth_alert_threshold` | At or above threshold (default 100) | 5 min |

**Note:** `transaction_queue_depth_alert_threshold` mirrors the
`TRANSACTION_QUEUE_ALERT_THRESHOLD` env var. Tune the threshold without
redeploying by updating the env var; the alert stays correct automatically.

**Runbook:** Check BullMQ worker liveness at `/health workers.transactionQueueWorker`.
See `docs/operator-runbooks.md § Redis Or Queue Down`.

---

### 3.5 Queue Backpressure

**Source file:** `monitoring/alerts/queue_backpressure.yml`  
**Metrics:** `payment_processor_queue_depth`, `payment_processor_queue_backpressure_high_water`,
`payment_processor_queue_max_depth`  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `PaymentQueueBackpressureHighWater` | warning | `payment_processor_queue_depth >= payment_processor_queue_backpressure_high_water` | At high-water mark | 5 min |
| `PaymentQueueNearCapacity` | critical | `payment_processor_queue_depth >= payment_processor_queue_max_depth` | At MAX_QUEUE_DEPTH | 2 min |

When `PaymentQueueNearCapacity` fires, new payments are being rejected with
`QUEUE_FULL`. Page on-call immediately; consider raising `MAX_QUEUE_DEPTH` or
investigating Horizon / MongoDB latency.

---

### 3.6 Horizon Poll

**Source file:** `monitoring/alerts/horizon_poll.yml`  
**Metrics:** `horizon_poll_max_deferral_cycles`, `horizon_rate_limited_total`,
`horizon_poll_budget_ceiling`, `horizon_poll_deferred_schools`  
**Owner:** Blockchain Operator  
**Escalation channel:** `#blockchain-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `HorizonPollSchoolFallingBehind` | warning | `horizon_poll_max_deferral_cycles > 5` | > 5 consecutive deferred cycles | 15 min |
| `HorizonRateLimitedDespiteBudget` | warning | `rate(horizon_rate_limited_total[15m]) > 0` | Any 429s | 15 min |
| `HorizonPollBudgetCollapsed` | critical | `horizon_poll_budget_ceiling <= 4` | Budget at floor | 30 min |
| `HorizonPollBudgetSaturated` | warning | `horizon_poll_deferred_schools > 0` | Any deferred schools | 1 h |

**Runbook:** `docs/horizon-rate-limits.md § Operational guidance`.

---

### 3.7 Webhooks

**Source file:** `monitoring/alerts/webhook_alerts.yml`  
**Metrics:** `webhook_deliveries_total{outcome}`, `webhook_dead_letter_total`,
`webhook_delivery_duration_ms_bucket`  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `WebhookHighFailureRate` | warning | Failure rate / total rate (5m) | > 20% | 5 min |
| `WebhookDeadLetterGrowing` | critical | `webhook_dead_letter_total > 50` (per school) | > 50 DLQ entries | Immediate |
| `WebhookHighLatency` | warning | `histogram_quantile(0.95, ...)` of delivery duration | > 5 000 ms | 5 min |

**Runbook:** Replay dead-letter jobs via
`POST /api/webhook-deliveries/:id/replay` or the admin DLQ endpoint. See
`docs/WEBHOOK_INTEGRATION.md`.

---

### 3.8 Price Feed

**Source file:** `monitoring/alerts/price_feed.yml`  
**Metrics:** `price_feed_staleness_seconds`, `price_feed_stale{provider}`,
`price_feed_last_success_timestamp{provider}`  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `PriceFeedStalenessWarning` | warning | `price_feed_staleness_seconds > 300` | > 5 min stale | 2 min |
| `PriceFeedStale` | critical | `price_feed_stale == 1` | Cache window exhausted | 15 min |
| `PriceFeedNoRecentSuccess` | warning | `(time() - price_feed_last_success_timestamp) > 600` | > 10 min since success | 5 min |

**Dashboard:** `monitoring/grafana/dashboards/price_feed.json`  
**Runbook:** `docs/runbooks/price-feed-staleness.md`

---

### 3.9 Backup

**Source file:** `monitoring/alerts/backup.yml`  
**Metrics:** `backup_last_success_timestamp_seconds`,
`last_backup_restore_test_age_seconds`, `last_backup_verification_age_seconds`  
**Owner:** Database Operator  
**Escalation channel:** `#db-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `BackupStale` | warning | `time() - backup_last_success_timestamp_seconds > 93600` | > 26 h since backup | 5 min |
| `BackupCriticallyStale` | critical | Same, > 172 800 | > 48 h since backup | 5 min |
| `BackupNotRun` | warning | `backup_last_success_timestamp_seconds == 0` | No heartbeat ever | 26 h |
| `BackupRestoreTestStale` | warning | `last_backup_restore_test_age_seconds > 691200` | > 8 days since CI restore test | 5 min |
| `BackupVerificationStale` | warning | `last_backup_verification_age_seconds > 691200` | > 8 days since backup verification | 5 min |

**Runbook:** `docs/runbooks/price-feed-staleness.md` (referenced in alert YAML;
a dedicated `docs/runbooks/backup-staleness.md` should be created — see §6).

---

### 3.10 Leader Election

**Source file:** `monitoring/alerts/leader_election.yml`  
**Metrics:** `leader_election_is_leader`, `leader_election_tenure_seconds`  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| `LeaderElectionSplitBrain` | critical | `sum(leader_election_is_leader) > 1` | > 1 replica claims leadership | 1 min |
| `LeaderElectionNoLeader` | critical | `sum(leader_election_is_leader) == 0` | No replica holds leadership | 5 min |
| `LeaderElectionChurning` | warning | `max(leader_election_tenure_seconds) < 300` | Max tenure < 5 min | 15 min |

When `LeaderElectionNoLeader` fires, reminder dispatch, reconciliation, and
payment finalization are not running anywhere. Page on-call immediately.

---

### 3.11 Payment Processing Latency

**Source file:** `monitoring/alerts/payment_processing_latency.yml`  
**Metric:** `payment_processing_duration_seconds` (histogram)  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

| Alert Name | Severity | Expression Summary | Threshold | For |
|-----------|----------|-------------------|-----------|-----|
| *(see file)* | warning / critical | Payment p95 processing time | Per file thresholds | Per file |

---

### 3.12 Payment Limits

**Source file:** `monitoring/alerts/payment_limits.yml`  
**Metrics:** Payment limit breach counters  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

Review the file for current rule definitions. This group covers scenarios where
payments are rejected at the limits layer (too low / too high).

---

### 3.13 Heap Usage

**Source file:** `monitoring/alerts/heap_usage.yml`  
**Metric:** Node.js heap metrics (`process_heap_bytes` or similar)  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

---

### 3.14 Receipts

**Source file:** `monitoring/alerts/receipts.yml`  
**Metrics:** Receipt generation failure counters  
**Owner:** API Operator  
**Escalation channel:** `#backend-on-call`

---

## 4. Metric Reference

The following metrics are recorded by `backend/src/metrics/index.js` and used
by the alerts above. All metric names here match the alert expressions exactly.

| Metric | Type | Source | Description |
|--------|------|--------|-------------|
| `http_request_duration_seconds` | histogram | `requestLogger` middleware | HTTP request latency — labels: `method`, `route`, `status` |
| `mongodb_connection_state` | gauge | `config/database.js` | Mongoose `readyState` — 0/1/2/3 |
| `mongodb_connection_errors_total` | counter | `config/database.js` | Increments on driver `error` event |
| `payment_processor_queue_depth` | gauge | `concurrentRequestHandler.js` | Active in-flight count |
| `payment_processor_queue_backpressure_high_water` | gauge | `config/index.js` | Live value of `QUEUE_BACKPRESSURE_HIGH_WATER` |
| `payment_processor_queue_max_depth` | gauge | `config/index.js` | Live value of `MAX_QUEUE_DEPTH` |
| `transaction_queue_depth` | gauge | `queue/transactionQueue.js` | BullMQ waiting job count |
| `transaction_queue_depth_alert_threshold` | gauge | `config/index.js` | Live `TRANSACTION_QUEUE_ALERT_THRESHOLD` |
| `horizon_poll_max_deferral_cycles` | gauge | `transactionPollingService.js` | Max consecutive deferred cycles across schools |
| `horizon_rate_limited_total` | counter | `stellarRateLimitedClient.js` | Total 429 responses from Horizon |
| `horizon_poll_budget_ceiling` | gauge | `transactionPollingService.js` | Current AIMD adaptive ceiling |
| `horizon_poll_deferred_schools` | gauge | `transactionPollingService.js` | Schools deferred in last cycle |
| `webhook_deliveries_total` | counter | `webhookService.js` | Labels: `outcome` (success \| failure) |
| `webhook_dead_letter_total` | gauge | `webhookService.js` | Per-school DLQ depth — label: `schoolId` |
| `webhook_delivery_duration_ms` | histogram | `webhookService.js` | Delivery time in milliseconds |
| `price_feed_staleness_seconds` | gauge | `currencyConversionService.js` | Seconds since last fresh rate — label: `provider` |
| `price_feed_stale` | gauge | `currencyConversionService.js` | 1 when cache window exhausted — label: `provider` |
| `price_feed_last_success_timestamp` | gauge | `currencyConversionService.js` | Unix timestamp of last successful fetch — label: `provider` |
| `backup_last_success_timestamp_seconds` | gauge | `metrics/index.js` (via backup heartbeat) | Unix timestamp of last successful backup |
| `last_backup_restore_test_age_seconds` | gauge | `metrics/index.js` | Seconds since last CI restore test success |
| `last_backup_verification_age_seconds` | gauge | `metrics/index.js` | Seconds since last backup verification |
| `leader_election_is_leader` | gauge | `leaderElection.js` | 1 if this replica holds the leader lock |
| `leader_election_tenure_seconds` | gauge | `leaderElection.js` | Seconds this replica has held leadership |

---

## 5. Escalation Ownership Summary

| Domain | Primary Owner | Secondary Owner | Channel |
|--------|--------------|----------------|---------|
| API errors, latency, backpressure | API Operator | Incident Commander | `#backend-on-call` |
| MongoDB connectivity | Database Operator | API Operator | `#db-on-call` |
| Transaction queue (BullMQ) | API Operator | Blockchain Operator | `#backend-on-call` |
| Stellar Horizon polling | Blockchain Operator | API Operator | `#blockchain-on-call` |
| Webhooks | API Operator | — | `#backend-on-call` |
| Price feed | API Operator | — | `#backend-on-call` |
| Backup staleness | Database Operator | — | `#db-on-call` |
| Leader election | API Operator | Database Operator | `#backend-on-call` |
| Heap / Node.js process | API Operator | — | `#backend-on-call` |
| Receipts | API Operator | — | `#backend-on-call` |
| Credential exposure | Security Lead | Incident Commander | `#security-incidents` |

---

## 6. Stale or Unowned Alerts

The following issues were identified during the audit that produced this document.
File issues to resolve them and update this section when resolved.

| Issue | Alert / File | Status |
|-------|-------------|--------|
| `BackupStale`, `BackupCriticallyStale`, `BackupRestoreTestStale`, `BackupVerificationStale` reference `docs/runbooks/backup-staleness.md` in their `runbook_url`, but that file does not exist in this repo | `monitoring/alerts/backup.yml` | **Open** — create `docs/runbooks/backup-staleness.md` |
| `admin-alerts.yml` contains only a placeholder (247 bytes); no active alert rules | `monitoring/alerts/admin-alerts.yml` | **Open** — define rules or remove the file |
| `payment_processing_latency.yml` and `payment_limits.yml` contain rules that are not fully documented in this inventory | `monitoring/alerts/payment_processing_latency.yml`, `monitoring/alerts/payment_limits.yml` | **Open** — complete §3.11 and §3.12 once rules are confirmed stable |
| `horizon_failover.yml` is present but not listed above — review and add to inventory | `monitoring/alerts/horizon_failover.yml` | **Open** |

---

## 7. Runbook Index

| Runbook | Path | Covers |
|---------|------|--------|
| Operator Runbooks (main) | `docs/operator-runbooks.md` | Redis/queue down, Horizon down, MongoDB down, stuck payments, key rotation, restore procedure, canary deployment |
| Price Feed Staleness | `docs/runbooks/price-feed-staleness.md` | CoinGecko / Coinbase feed recovery |
| Wallet Rotation | `docs/runbooks/wallet-rotation.md` | Rotating the school Stellar wallet address |
| Signer Key Rotation | `docs/runbooks/signer-key-rotation.md` | Rotating `SIGNER_MASTER_KEY` |
| Incident Response | `docs/incident-response-checklist.md` | End-to-end incident handling |
| Backup Staleness | `docs/runbooks/backup-staleness.md` | **Missing** — referenced by backup alerts; needs to be created |

---

*Last reviewed: 2026-09-27. Update this document whenever an alert rule, metric,
dashboard, or runbook changes.*
