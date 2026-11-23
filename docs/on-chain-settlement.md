# On-Chain Payment Settlement

**Issue:** [#299](https://github.com/onlyonee1/PaymentFlow/issues/299)  
**Scope:** Stellar account structure, transaction lifecycle, settlement finality model,
off-chain/on-chain reconciliation, and failure/rollback scenarios.  
**Related:** `docs/on-chain-payment-settlement.md` (detailed implementation reference),
`backend/src/services/stellarService.js`,
`backend/src/services/paymentConfirmationStateMachine.js`,
`backend/src/services/transactionPollingService.js`,
`backend/src/services/reconciliationService.js`

---

## Table of Contents

- [Overview](#overview)
- [Stellar Account Structure](#stellar-account-structure)
- [Transaction Lifecycle](#transaction-lifecycle)
- [Settlement Finality Model](#settlement-finality-model)
- [Off-Chain / On-Chain Reconciliation Flow](#off-chain--on-chain-reconciliation-flow)
- [Failure Scenarios and Recovery](#failure-scenarios-and-recovery)
- [Ledger Rollback and Reorg Handling](#ledger-rollback-and-reorg-handling)
- [Confirmation Thresholds Reference](#confirmation-thresholds-reference)

---

## Overview

PaymentFlow bridges the Stellar blockchain with a MongoDB database to automate school
fee reconciliation. The system operates as a **read-only observer** of the Stellar
ledger: parents send funds directly from their own wallets, and the backend watches
the school's wallet address for incoming transactions.

The backend never holds a private key and never submits payment transactions on behalf
of the school. This design eliminates custodial risk at the cost of requiring careful
state synchronisation between on-chain events and the off-chain database.

```
 Parent Wallet                  Stellar Ledger                   Backend
      │                               │                              │
      │──── XLM / USDC + memo ───────►│                              │
      │                               │◄── confirmed in ~3-5s ───────│
      │                               │                              │
      │                               │    (poll every N seconds)    │
      │                               │◄── fetchTransactions() ──────│
      │                               │──── tx page ────────────────►│
      │                               │                         validate:
      │                               │                           memo?
      │                               │                           asset?
      │                               │                           amount?
      │                               │                              │
      │                               │                         ─── write to MongoDB ───►
      │                               │                              │
```

---

## Stellar Account Structure

PaymentFlow uses a minimal two-account model. More complex escrow flows using a
Soroban contract are described in `docs/soroban-escrow-requirements.md`.

### Account Roles

| Account | Controlled by | Purpose |
|---------|--------------|---------|
| **School Wallet** (`G…SCHOOL`) | School administrator | Receives all fee payments |
| **Parent Wallet** (`G…PARENT`) | Parent / guardian | Sends fee payments |

The backend only knows the school wallet's **public key**. The private key never
leaves the school administrator's control. This means:

- The backend cannot sign or send transactions for the school.
- The only outgoing transactions the backend can ever sign are refunds and account
  setup operations, and only when explicitly configured with a separate operational
  key. See `backend/src/services/stellarTransactionManager.js`.

### Platform Fee Account

PaymentFlow does not currently route a platform fee at the Stellar layer. All
on-chain amounts go directly to the school wallet. Platform fees, if any, are
accounted for off-chain in the MongoDB fee structure records.

### Escrow Account (Soroban path)

When the Soroban escrow contract is deployed, a contract-owned address acts as the
escrow. Funds are locked in the contract until the `release()` or `refund()` entry
points are called. This is separate from the direct-payment (non-escrow) flow
documented here. See `docs/soroban-escrow-requirements.md`.

---

## Transaction Lifecycle

### Stage 1 — Intent Creation

Before sending any funds, the parent requests payment instructions from the backend:

```
POST /api/payments/instructions/:studentId
```

The backend creates a `PaymentIntent` record in MongoDB:

```
PaymentIntent {
  schoolId:   "SCH-001"
  studentId:  "STU-2024-042"
  memo:       "STU-2024-042"   ← parent must include this in the tx memo
  amount:     500              ← expected fee (XLM or USDC)
  status:     "pending"
  expiresAt:  <now + TTL>
}
```

The memo value is what ties the on-chain transaction back to a specific student.

### Stage 2 — On-Chain Transaction

The parent opens their Stellar wallet (e.g. Lobstr, LOBSTR, Freighter) and sends
funds to the school's wallet address with the memo exactly as shown. Stellar
confirms the transaction within **3–5 seconds**.

Key transaction fields used by PaymentFlow:

| Field | Usage |
|-------|-------|
| `hash` | Globally unique transaction identifier — used as idempotency key |
| `memo` | Student ID — used to match payment to student record |
| `ledger_attr` | Ledger sequence number — used to compute confirmation depth |
| `created_at` | Ledger timestamp — stored as `confirmedAt` |
| `source_account` | Sender address — stored as `senderAddress` for fraud detection |
| `fee_charged` | Network fee in stroops — stored as `networkFee` |

### Stage 3 — Backend Detection

The `transactionPollingService` polls the Stellar Horizon API on a configurable
interval (`POLL_INTERVAL_MS`). It fetches the newest transactions arriving at the
school wallet in pages of 200, newest first. The loop stops when it encounters a
transaction it has already processed.

For each new transaction:

1. `extractValidPayment()` — filters out failed txs, wrong asset, wrong destination,
   and missing memo.
2. `validatePaymentAmount()` — checks against configured min/max limits.
3. `PaymentIntent.findOne({ schoolId, memo, status: 'pending' })` — matches the tx
   to the student.
4. `validatePaymentAgainstFee()` — compares amount to the student's fee structure.
5. `detectMemoCollision()` / `detectCrossSchoolMemoCollision()` — flags suspicious
   patterns.
6. `determineConfirmationState()` — computes initial state based on ledger depth.

### Stage 4 — Atomic Write

If all checks pass, a MongoDB multi-document transaction commits:

1. `Payment.create(paymentDoc)` — creates the immutable payment record.
2. `Student.findOneAndUpdate()` — updates `totalPaid`, `remainingBalance`, `feePaid`.
3. `PaymentIntent.findOneAndUpdate()` — marks intent as `completed`.

All three writes are within a single `session.withTransaction()` call. If any write
fails, all three are rolled back and the transaction is queued for retry.

### Stage 5 — Post-Commit Events

After the MongoDB transaction commits:

- A `paymentSaved` event fires, triggering:
  - Webhook delivery to registered endpoints.
  - Server-Sent Event (SSE) push to connected admin clients.
  - Receipt generation and optional email delivery.
  - Audit log entry.

---

## Settlement Finality Model

### Stellar's Ledger Finality

Stellar uses a federated Byzantine agreement (FBA) consensus protocol. Ledger
closings are **final** — there are no reorgs in the traditional sense. Once a
transaction is included in a closed ledger, it is immutable. Ledgers close every
**3–5 seconds**.

Despite this inherent finality, PaymentFlow uses configurable confirmation thresholds
to provide a safety margin for:

- Horizon propagation lag (Horizon may lag by 1–2 ledgers during high load).
- Detection of malformed transactions that appear valid on first observation.
- Operator preference for higher confidence before marking fees as paid.

### Confirmation State Machine

```
  (transaction observed by polling loop)
              │
              ▼
         ┌──────────┐
         │ detected │  depth = 0 (ledger just closed)
         └────┬─────┘
              │  0 < depth < CONFIRMATION_THRESHOLD
              ▼
         ┌──────────┐
         │ pending  │  waiting for ledger depth
         └────┬─────┘
              │  depth >= CONFIRMATION_THRESHOLD
              ▼
         ┌──────────┐
         │confirmed │  ← feePaid flag updated, UI shows paid
         └────┬─────┘
              │  depth >= FINALIZATION_THRESHOLD
              ▼
         ┌──────────┐
         │finalized │  terminal — no further transitions
         └──────────┘

  ┌──────────┐
  │  failed  │  terminal — suspicious / invalid (set at detection)
  └──────────┘
```

State transitions are computed by `paymentConfirmationStateMachine.js`. The machine
is pure and idempotent — replaying the same ledger range never produces a different
result.

### Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `CONFIRMATION_THRESHOLD` | `2` | Ledgers after tx ledger before `confirmed` |
| `FINALIZATION_THRESHOLD` | `10` | Ledgers after tx ledger before `finalized` |

These are configurable via environment variables. At 5-second ledger times:

- `confirmed` is reached in roughly **10 seconds** (2 × 5s).
- `finalized` is reached in roughly **50 seconds** (10 × 5s).

### When `feePaid` is Updated

The student's `feePaid` flag is set to `true` only when:

1. `confirmationState` reaches `confirmed` (or better), **and**
2. `isSuspicious === false`, **and**
3. `cumulativeTotal >= feeAmount`.

Suspicious payments are recorded but held pending manual admin review.

---

## Off-Chain / On-Chain Reconciliation Flow

### Normal Reconciliation

Under normal operation, every on-chain payment that matches a pending intent is
mirrored in MongoDB within one polling interval. The database record is the
authoritative source for the student's fee status; the blockchain record is the
authoritative source for whether value was actually transferred.

```
On-chain truth:   txHash → amount, memo, ledger, timestamp
Off-chain truth:  Payment → studentId, feeValidation, confirmationState, feePaid
```

The system never modifies or invalidates on-chain data. If the off-chain record
is wrong (e.g. database corruption), the recovery path is to re-derive it from
Horizon using the stored `txHash`.

### Consistency Check

`GET /api/consistency` triggers `consistencyService.runChecks(schoolId)`, which:

1. Queries MongoDB for all `Payment` records within a recent window.
2. Re-fetches each `txHash` from Horizon to confirm the record still exists and matches.
3. Reports orphans (payments in DB not found on-chain) and discrepancies
   (amount or memo mismatch).

Run this after any incident or suspected data corruption.

### Startup Reconciliation

On backend startup, `stuckPaymentReconciliation.js` scans for payments in
`pending_confirmation` state older than the retry window and either advances their
state or queues them for manual review.

### Manual Verification

An admin or parent can trigger verification of a specific transaction:

```
POST /api/payments/verify  { txHash: "abc123..." }
```

This fetches the transaction directly from Horizon, re-validates it, and either
creates a new payment record (if not yet recorded) or returns the existing one.

---

## Failure Scenarios and Recovery

### F1 — Horizon Unavailable

**Detection:** `withStellarRetry` wrapper catches `STELLAR_NETWORK_ERROR`.  
**Behaviour:** Exponential backoff with jitter. Circuit breaker opens after threshold.
Payments are queued in the retry service and processed when Horizon recovers.  
**Data impact:** No payments are recorded during the outage. On recovery, the poller
catches up by fetching all missed transactions from the last processed ledger cursor.  
**Recovery:** Horizon availability is automatically detected. No manual intervention
needed unless the circuit breaker stays open (see `docs/runbooks/stuck-payments.md`).

### F2 — Transaction Missing Memo

**Detection:** `extractValidPayment()` — memo is empty or whitespace-only.  
**Behaviour:** Transaction is silently skipped. Not recorded. No retry.  
**Data impact:** None. The payment is on-chain but not matched to any student.  
**Recovery:** The parent must submit a new transaction with the correct memo. A support
process should guide parents to use the memo field from the payment instructions page.

### F3 — Wrong Asset or Wrong Destination

**Detection:** `detectAsset()` or destination address check in `extractValidPayment()`.  
**Behaviour:** Transaction silently skipped. Not recorded.  
**Data impact:** None. Funds remain in the school wallet (wrong asset) or were never
received (wrong destination).  
**Recovery:** If the school wallet received an unsupported asset, the administrator
must manually return it. If sent to the wrong address, PaymentFlow cannot help — the
parent must contact whoever controls that address.

### F4 — MongoDB Write Failure

**Detection:** Exception from `Payment.create()` or `Student.findOneAndUpdate()`.  
**Behaviour:** The entire MongoDB transaction is rolled back. The transaction is pushed
to the retry queue with exponential backoff.  
**Data impact:** None (atomicity guaranteed). The on-chain transaction is unchanged.  
**Recovery:** Automatic via retry queue. If retries are exhausted, the payment enters
the dead-letter queue and an alert fires.

### F5 — Duplicate Transaction (Replay Attack)

**Detection:** `Payment.findOne({ txHash })` check before processing.  
**Behaviour:** Polling loop stops at the known transaction — all older transactions
have already been processed. For the manual verify path, the existing record is
returned without re-writing.  
**Data impact:** None.  
**Recovery:** Not applicable — this is normal idempotent behaviour.

### F6 — Suspicious Payment (Memo Collision)

**Detection:** `detectMemoCollision()` or `detectCrossSchoolMemoCollision()`.  
**Behaviour:** Payment is recorded as `SUCCESS` but `isSuspicious: true`. The student's
`feePaid` flag is NOT updated until an admin clears the suspicious flag.  
**Data impact:** Payment record exists; student balance is not updated.  
**Recovery:** Admin reviews the flagged payment in the admin dashboard and either
confirms it (clears flag, balance updates) or marks it as fraudulent (initiates refund).

### F7 — Underpaid Transaction

**Detection:** `validatePaymentAgainstFee()` — `cumulativeTotal < feeAmount`.  
**Behaviour:** Payment recorded as `SUCCESS` with `feeValidationStatus: 'underpaid'`.
Student `feePaid` remains `false`. `underpaidReconciliationService` tracks the
lifecycle (`pending` → `partial_credited` → `refund_initiated` → `refund_completed`).  
**Data impact:** Partial payment recorded; student balance updated proportionally.  
**Recovery:** Parent pays the remaining balance in a subsequent transaction. The poller
aggregates cumulative totals and sets `feePaid: true` once the full amount is received.

### F8 — USDC Trustline Missing

**Detection:** `stellarAccountVerificationService` at startup; also surfaces in
`/health` as `degraded`.  
**Behaviour:** Incoming USDC payments arrive on-chain but produce `op_no_trust` on
Horizon. The sync loop encounters the failed transaction and skips it.  
**Data impact:** USDC payment is on-chain but not recorded in MongoDB.  
**Recovery:** School administrator must submit a `ChangeTrust` operation to establish
the USDC trustline. Once the trustline exists, the manual `/api/payments/verify`
endpoint can be used to record previously missed payments by their `txHash`.

### F9 — Amount Below Minimum or Above Maximum

**Detection:** `validatePaymentAmount()` in `paymentLimitsService.js`.  
**Behaviour:** Transaction silently skipped. Not recorded.  
**Data impact:** None. Funds arrived on-chain but are not reconciled.  
**Recovery:** If the limits are misconfigured, an admin can adjust them and then use
`/api/payments/verify` to manually record the transaction.

---

## Ledger Rollback and Reorg Handling

Stellar's FBA consensus guarantees **no ledger rollbacks** under normal operation.
A closed Stellar ledger is final. This is different from probabilistic finality
blockchains (e.g. Ethereum before merge) where a short reorg is theoretically
possible.

**There is no reorg recovery path needed for PaymentFlow on Stellar.**

In the extremely unlikely event of a network-level incident (e.g. a validator quorum
fault), the Stellar Foundation would coordinate a network-level resolution. In that
case:

1. Halt the PaymentFlow backend immediately (use `pauseContract()` if using Soroban escrow).
2. Wait for official Stellar network status.
3. Run the consistency check (`GET /api/consistency`) once the network recovers.
4. Cross-reference any discrepancies against the Stellar Horizon API before making
   any manual corrections.

The `CONFIRMATION_THRESHOLD` and `FINALIZATION_THRESHOLD` settings exist primarily
to account for Horizon API propagation lag and operator preference, not for reorg
protection.

---

## Confirmation Thresholds Reference

| Environment variable | Default | Meaning |
|----------------------|---------|---------|
| `CONFIRMATION_THRESHOLD` | `2` | Ledgers after tx ledger → `confirmed` state |
| `FINALIZATION_THRESHOLD` | `10` | Ledgers after tx ledger → `finalized` state |

With default Stellar ledger close time of ~5 seconds:

| State | Time after tx | Description |
|-------|--------------|-------------|
| `detected` | 0s | Tx first seen by polling loop |
| `pending` | 0–10s | Awaiting ledger depth |
| `confirmed` | ~10s | Safe for balance and UI updates |
| `finalized` | ~50s | Practically irreversible — use for reporting |
| `failed` | Any | Suspicious or invalid — requires admin review |

Operators who require tighter SLAs (e.g. near-instant payment confirmation for
kiosk use cases) may lower `CONFIRMATION_THRESHOLD` to `0` to skip the depth wait
entirely, relying on Stellar's inherent finality.

Operators who require higher confidence for high-value transactions may raise
`FINALIZATION_THRESHOLD` to `20` or more.

---

## See Also

- `docs/on-chain-payment-settlement.md` — comprehensive implementation reference with
  full sequence diagrams and all persisted field definitions
- `docs/payment-lifecycle.md` — payment status state machine and retry lifecycle
- `docs/idempotency-payment-verification.md` — idempotency key design
- `docs/stellar-integration.md` — Stellar SDK configuration, rate limiting, circuit breaker
- `docs/soroban-escrow-requirements.md` — escrow contract design for the Soroban path
- `docs/runbooks/stuck-payments.md` — operator runbook for stuck or unconfirmed payments
