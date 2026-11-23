# ADR-004: Failover Boundaries for the Stellar Horizon Integration

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2024-07-20 |
| **Review date** | 2027-07-20 |
| **Authors** | Payment Platform Team |
| **Code references** | `backend/src/services/stellarRateLimitedClient.js`, `backend/src/services/transactionPollingService.js`, `backend/src/services/retryServiceSelector.js`, `monitoring/alerts/horizon_failover.yml`, `monitoring/alerts/horizon_poll.yml`, `docs/operator-runbooks.md` |

---

## Context

PaymentFlow depends on the Stellar Horizon API for all payment verification:
reading transaction details, confirming amounts and memos, and polling for new
transactions. Horizon is a public, free API operated by the Stellar Development
Foundation (SDF) and independent node operators.

Horizon outages have occurred. When Horizon is unavailable, new payments cannot
be verified. The system must decide:

1. What to do with new payment submissions during a Horizon outage.
2. How long to wait before treating a payment as permanently unverifiable.
3. Whether to switch to an alternative Horizon endpoint automatically.
4. What operator actions are required vs what is handled automatically.

There is a critical constraint: **a payment must not be marked as failed if
Horizon simply could not be reached**. The blockchain is the source of truth;
a network error from Horizon is not evidence that a payment failed.

---

## Decision

**Fail-safe retry with configurable failover endpoint; no automatic permanent failure.**

Specific decisions:

1. **Never mark a payment `failed` due to a Horizon network error alone.**
   Network errors, 5xx responses, and timeouts are classified as transient
   (`retryContract.js`). The payment stays in the retry queue until Horizon
   responds conclusively or max attempts are exhausted (dead-letter).

2. **Rate-limited client with circuit breaker** (`stellarRateLimitedClient.js`):
   - [Bottleneck](https://www.npmjs.com/package/bottleneck) enforces Horizon's
     rate limit (configurable via `STELLAR_RATE_LIMIT_*` env vars).
   - A circuit breaker opens after `HORIZON_CB_FAILURE_THRESHOLD` consecutive
     failures, short-circuiting new requests for `HORIZON_CB_RESET_TIMEOUT_MS`
     to avoid hammering an unavailable endpoint.
   - When the circuit is open, requests fail immediately with a transient error
     (retried by the retry backend).

3. **Failover Horizon endpoint**: `STELLAR_HORIZON_FAILOVER_URL` may be set to
   a secondary Horizon instance. When the primary Horizon fails and the circuit
   opens, the client retries against the failover URL.
   - Failover is **not automatic in production without configuration**. It
     requires `STELLAR_HORIZON_FAILOVER_URL` to be set.
   - Valid failover options: SDF's public endpoint, a self-hosted Horizon, or a
     managed Horizon from a provider such as Meridian or Futurenet.

4. **Transaction polling continues through outages.** The polling service
   maintains a cursor (`reconciliationCursorModel.js`) and resumes from the last
   known ledger after an outage. No transactions are skipped.

5. **Operators must resolve dead-letter jobs manually.** After max retry
   attempts, a payment enters the dead-letter queue. An operator must investigate
   via `GET /api/admin/retry-queue` and re-drive once the Horizon issue is
   resolved (see `docs/runbooks/stuck-payments.md`).

---

## Alternatives considered

### 1. Automatic failover to a secondary Horizon without operator action

**Partially accepted.** Automatic failover is implemented when
`STELLAR_HORIZON_FAILOVER_URL` is configured. However, automatic failover was
not made the default because:
- A secondary Horizon must be validated before trusting it for payment
  verification. An untested failover endpoint could return stale or incorrect
  data.
- SDF provides a single canonical mainnet Horizon; third-party Horizon nodes
  may lag the ledger by several seconds.
- The cost of operating a private Horizon is significant; not all deployments
  will have one.

### 2. Mark payments as failed after N Horizon timeout retries

**Rejected.** A Horizon timeout is not proof that a transaction failed.
Stellar ledger finality is 3–5 seconds; a payment confirmed before the outage
can be recovered when Horizon comes back. Marking it `failed` during the
outage would require a later correction, which is operationally riskier than
keeping it in `pending` with a clear escalation path.

### 3. Synchronous retry in the HTTP request handler (no queue)

**Rejected.** See ADR-002. Synchronous retries block the API thread and time out
from the client's perspective. Durable out-of-process retry is required.

### 4. Use the Stellar SDK's built-in retry logic only

**Rejected.** The Stellar SDK does not provide a rate limiter or a circuit
breaker. Without a circuit breaker, a sustained Horizon outage would cause
every backend replica to hammer the unavailable endpoint, potentially triggering
IP-level rate limiting or bans.

### 5. Accept payments as confirmed without Horizon verification during outages

**Rejected.** The backend would be confirming payments it has not verified on
chain. This could allow a student to submit a fake transaction hash and receive
a fee confirmation. Horizon verification is mandatory for all payments.

---

## Consequences

**Positive:**
- No payment is ever permanently failed due to a transient Horizon unavailability.
- The circuit breaker prevents the backend from degrading further during an
  outage (no thundering-herd effect against Horizon).
- The polling cursor ensures no transactions are missed after an outage; the
  backlog is re-processed automatically.
- Operators have a clear escalation path (dead-letter queue, re-drive once
  Horizon is healthy).

**Negative:**
- During a prolonged Horizon outage, payment confirmations are delayed. Parents
  and schools see `pending` status until the outage resolves.
- Without `STELLAR_HORIZON_FAILOVER_URL`, there is no automatic recovery path
  if the SDF public Horizon endpoint is permanently unavailable.
- Dead-letter jobs after max retries require manual operator action.

**Monitoring and alerting:**

| Metric / Alert | Threshold | File |
|---------------|-----------|------|
| `horizon_circuit_open` | > 0 for 5 min | `monitoring/alerts/horizon_failover.yml` |
| `horizon_poll_lag_seconds` | > 300 s | `monitoring/alerts/horizon_poll.yml` |
| `pending_verification_backlog{status="dead_letter"}` | > 0 | `monitoring/alerts/queue_backpressure.yml` |
| Health check `GET /health` | `degraded` for > 2 consecutive checks | `monitoring/alerts/` |

**Configuration reference:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `STELLAR_HORIZON_URL` | Auto from `STELLAR_NETWORK` | Primary Horizon endpoint |
| `STELLAR_HORIZON_FAILOVER_URL` | — | Secondary Horizon (optional) |
| `HORIZON_CB_FAILURE_THRESHOLD` | `5` | Failures before circuit opens |
| `HORIZON_CB_RESET_TIMEOUT_MS` | `30000` | Circuit-open duration (30 s) |
| `POLL_INTERVAL_MS` | `30000` | Transaction polling interval |

---

## Review criteria

Revisit this ADR if:
- The SDF deprecates or changes the public Horizon API endpoint.
- A Horizon outage persists for > 4 hours in production (current dead-letter
  escalation assumes shorter outages).
- A Horizon provider other than SDF achieves significantly better reliability
  (potential case for changing the default primary endpoint).
- The circuit breaker thresholds cause false positives (circuit opens under
  acceptable load) — tune `HORIZON_CB_FAILURE_THRESHOLD` first before changing
  the architecture.
