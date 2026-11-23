# Stellar Finality Policy

> **Scope:** This document describes how PaymentFlow enforces on-chain finality
> for the `submitTransaction` endpoint — specifically the `SUBMITTED` intermediate
> status and the `pollForLedgerInclusion` loop.
>
> For the background confirmation state machine that advances payments synced
> from Horizon (the `syncPayments` / `verifyPayment` paths) see
> [`stellar-integration.md — Confirmation Threshold & Finality State Machine`](stellar-integration.md#confirmation-threshold--finality-state-machine).

---

## Table of Contents

- [Why finality matters](#why-finality-matters)
- [Payment status flow for submitted transactions](#payment-status-flow-for-submitted-transactions)
- [The SUBMITTED status](#the-submitted-status)
- [Ledger finality polling](#ledger-finality-polling)
- [Confirmation latency expectations (P50 / P99)](#confirmation-latency-expectations-p50--p99)
- [Failure reasons](#failure-reasons)
- [Environment variables](#environment-variables)
- [Operator guidance for FINALITY_TIMEOUT payments](#operator-guidance-for-finality_timeout-payments)

---

## Why finality matters

Stellar ledgers close approximately every **5 seconds**. When `server.submitTransaction(tx)` returns, it means the network has accepted the transaction and assigned it to a ledger — but the transaction could still fail if:

- The source account's sequence number was already consumed by a concurrent transaction.
- The source account ran out of XLM base reserve after submission.
- A conditional `timeBounds` expired between signing and ledger close.
- The operation itself fails (`op_bad_auth`, `op_no_trust`, etc.).

Marking a payment `SUCCESS` at submission time — before the closed ledger is
confirmed — means schools can issue receipts for payments that technically
failed. `pollForLedgerInclusion` fixes this by blocking the `SUCCESS` transition
until the transaction is verified in a closed ledger at `CONFIRMED` depth or above.

---

## Payment status flow for submitted transactions

```
POST /api/payments/submit  (XDR body)
           │
           ▼
 status = SUBMITTED  ◄── persisted immediately so a crash is recoverable
 submittedAt = now       (stuck-payment reconciliation re-queues SUBMITTED
                          payments older than STUCK_PAYMENT_THRESHOLD_MS)
           │
           ▼
 Horizon.submitTransaction()
           │
           ├─► broadcast error (network / SDK)
           │       status = FAILED
           │       HTTP 400  (code = Horizon result_code or message)
           │
           ▼
 pollForLedgerInclusion()  ◄── polls with exponential backoff
           │
           ├─► tx.successful === false  (on-chain failure)
           │       status = FAILED
           │       failureReason = TX_FAILED_ON_CHAIN
           │       HTTP 400
           │
           ├─► timeout (FINALITY_POLL_TIMEOUT_MS elapsed)
           │       status = FAILED
           │       failureReason = FINALITY_TIMEOUT  (see operator guidance)
           │       HTTP 202  ← client should check status later; funds may
           │                   still confirm via background poller
           │
           ├─► Horizon errors throughout the window
           │       status = FAILED
           │       failureReason = STELLAR_NETWORK_ERROR
           │       HTTP 202
           │
           └─► confirmationState >= CONFIRMED
                   status = SUCCESS
                   confirmationState = "confirmed" | "finalized"
                   HTTP 200
```

---

## The SUBMITTED status

`SUBMITTED` is the **only** intermediate status between `PENDING` and `SUCCESS`
for the submit path. Its purpose is to:

1. Persist a durable record before making the irreversible Horizon call, so
   a server crash after broadcast but before DB write can be recovered by the
   stuck-payment reconciliation scheduler.
2. Make the state clearly observable — callers can distinguish "not yet
   broadcast" (`PENDING`) from "broadcast but awaiting finality" (`SUBMITTED`)
   from "confirmed on-chain" (`SUCCESS`).

Allowed transitions from `SUBMITTED`:

| To | When | Path |
|----|------|------|
| `SUCCESS` | `pollForLedgerInclusion` reaches CONFIRMED/FINALIZED | Normal submit flow |
| `FAILED` | Horizon broadcast error, TX_FAILED_ON_CHAIN, FINALITY_TIMEOUT, STELLAR_NETWORK_ERROR | Normal submit flow |
| `SUCCESS` | Admin manually confirms after on-chain reconciliation | `$locals.adminOverride = true` |
| `FAILED` | Admin manually fails a stuck payment | `$locals.adminOverride = true` |

A payment stuck in `SUBMITTED` for longer than `STUCK_PAYMENT_THRESHOLD_MS`
(default 15 minutes) is automatically re-queued by `stuckPaymentReconciliation`
for reprocessing via the background verification queue.

---

## Ledger finality polling

`pollForLedgerInclusion(paymentDoc, txHash, opts)` in
`backend/src/services/stellarService.js` implements the polling loop:

### Algorithm

```
deadline = now + FINALITY_POLL_TIMEOUT_MS   (default 5 min)
attempt = 0

while now < deadline:
  attempt++
  wait = min(INITIAL_DELAY × 2^(attempt-2), MAX_DELAY) + jitter(±30%)
  sleep(wait)                        # skipped on attempt 1

  tx = Horizon.transactions(txHash)  # single attempt, no internal retry
  if NOT_FOUND:
    continue                         # tx not yet visible — keep polling
  if HORIZON_UNAVAILABLE / error:
    record lastNetworkError
    continue                         # hold per networkErrorBehavior='hold'
  if tx.successful === false:
    return FAILED / TX_FAILED_ON_CHAIN   # immediate — no point waiting
  
  state = determineConfirmationState(tx.ledger, currentState)
  if state >= CONFIRMED:
    return SUCCESS / state
  # else: depth not yet sufficient — keep polling

if lastNetworkError:
  return FAILED / STELLAR_NETWORK_ERROR
return FAILED / FINALITY_TIMEOUT
```

### Backoff parameters (defaults)

| Parameter | Default | Env override |
|-----------|---------|--------------|
| Initial delay | 2 000 ms | `FINALITY_POLL_INITIAL_DELAY_MS` |
| Max delay | 10 000 ms | `FINALITY_POLL_MAX_DELAY_MS` |
| Timeout | 300 000 ms (5 min) | `FINALITY_POLL_TIMEOUT_MS` |
| Jitter | ±30% of computed delay | — |

Approximate poll attempts within the 5-minute window:

| Attempt | Approx delay (ms) |
|---------|-------------------|
| 1 | 0 (immediate) |
| 2 | ~2 000 |
| 3 | ~4 000 |
| 4 | ~8 000 |
| 5–∞ | ~10 000 (capped) |

At the 10 s cap, the poller makes roughly **30 attempts** in 5 minutes.

---

## Confirmation latency expectations (P50 / P99)

These figures assume the Stellar **testnet** (ledger close ~5 s) and **mainnet**
(ledger close ~5 s) with `CONFIRMATION_THRESHOLD = 2` (default).

### Testnet and Mainnet

| Metric | Expected latency | Notes |
|--------|-----------------|-------|
| **P50 (median)** | **5–10 s** | First poll hits within one ledger close; tx confirmed at depth 2 after ~2 ledger closes |
| **P90** | **15–20 s** | Occasional Horizon propagation delay or busy ledger |
| **P99** | **30–45 s** | Horizon replica lag, brief network congestion, or sequence contention requiring a retry |
| **Timeout (FINALITY_TIMEOUT)** | **5 min** | Configurable via `FINALITY_POLL_TIMEOUT_MS`; should only trigger under extreme Horizon outage or a genuinely failed-to-propagate transaction |

> **Key point:** P50 latency under normal conditions is dominated by the two
> ledger closes required to reach `CONFIRMATION_THRESHOLD = 2` (~10 s total),
> not by the polling backoff. The first poll at t=0 typically catches the
> transaction at depth 0–1; the second poll at ~2 s confirms depth ≥ 2.

### Adjusting for production SLAs

- **Lower latency requirement (< 10 s):** Reduce `FINALITY_POLL_INITIAL_DELAY_MS`
  to `500`. This polls more aggressively but adds Horizon load.
- **Lower confirmation threshold:** Reducing `CONFIRMATION_THRESHOLD` to `1`
  cuts median latency to ~5 s but slightly reduces protection against ephemeral
  forks (extremely rare on Stellar).
- **Longer timeout:** Increase `FINALITY_POLL_TIMEOUT_MS` to `600000` (10 min)
  if your school operates in a region with consistently high Horizon latency.
  Pairs well with increasing `STUCK_PAYMENT_THRESHOLD_MS` to `20` min.

---

## Failure reasons

These values are stored in `payment.suspicionReason` and returned in the API
response body as `code`. Defined in
`backend/src/constants/paymentStatus.js → PAYMENT_FAILURE_REASONS`.

| Code | HTTP | Meaning | Action |
|------|------|---------|--------|
| `TX_FAILED_ON_CHAIN` | 400 | Horizon confirms the tx was included in a ledger but `tx.successful === false` (e.g. `op_bad_auth`, `op_no_trust`). Funds never moved. | Ask the payer to fix and resubmit. The failed tx hash can be inspected on Stellar Expert. |
| `FINALITY_TIMEOUT` | 202 | The tx was broadcast but finality could not be confirmed within `FINALITY_POLL_TIMEOUT_MS`. The transaction **may still confirm** on-chain. | See [Operator guidance](#operator-guidance-for-finality_timeout-payments) below. |
| `STELLAR_NETWORK_ERROR` | 202 | Horizon was unreachable for the entire polling window. | Treat the same as `FINALITY_TIMEOUT`. Monitor Horizon availability via `/health`. |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FINALITY_POLL_TIMEOUT_MS` | `300000` (5 min) | Maximum time `pollForLedgerInclusion` waits for ledger confirmation. After this the payment is marked `FAILED` with reason `FINALITY_TIMEOUT`. |
| `FINALITY_POLL_INITIAL_DELAY_MS` | `2000` | Delay before the second poll attempt (first is immediate). |
| `FINALITY_POLL_MAX_DELAY_MS` | `10000` | Upper cap on backoff delay. |
| `STUCK_PAYMENT_THRESHOLD_MS` | `900000` (15 min) | Age at which a `SUBMITTED` payment is considered stuck and re-queued by the reconciliation scheduler. Should be `> FINALITY_POLL_TIMEOUT_MS`. |

---

## Operator guidance for FINALITY_TIMEOUT payments

A `FINALITY_TIMEOUT` result means the backend could not confirm ledger inclusion
within 5 minutes. This does **not** necessarily mean the transaction failed — it
may still confirm later. Take the following steps:

1. **Check Stellar Expert** using the `hash` returned in the API response:
   - Testnet: `https://stellar.expert/explorer/testnet/tx/<hash>`
   - Mainnet: `https://stellar.expert/explorer/public/tx/<hash>`

2. **If confirmed on-chain:** The payment record is `FAILED` in the database but
   funds have moved. Use the admin API to manually correct the record:
   ```
   PATCH /api/admin/payments/:id/status
   { "status": "SUCCESS", "adminNote": "Manual correction — FINALITY_TIMEOUT, tx confirmed on Stellar Expert" }
   ```
   This path requires `adminOverride = true` and is audit-logged.

3. **If not found on Stellar Expert after 10 minutes:** The transaction was never
   included in any ledger (likely a sequence conflict or expiry). The `FAILED`
   status is correct. Ask the payer to resubmit.

4. **Recurring FINALITY_TIMEOUT in production:** Usually indicates Horizon
   availability issues. Check the `/health` endpoint and Horizon status page.
   Consider increasing `FINALITY_POLL_TIMEOUT_MS` or alerting on
   `payment.suspicionReason = FINALITY_TIMEOUT` count via Prometheus.
