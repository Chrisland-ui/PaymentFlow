# On-Chain Payment Settlement Model

This document is the canonical reference for how PaymentFlow bridges the Stellar
blockchain with its MongoDB database. It defines every on-chain identifier that is
persisted, describes the full payment lifecycle from wallet send to student record
update, and enumerates all known failure cases.

---

## Table of Contents

- [Overview](#overview)
- [Accounts and Trust Boundaries](#accounts-and-trust-boundaries)
- [Assets and Trustlines](#assets-and-trustlines)
- [Memo Field Usage](#memo-field-usage)
- [PaymentIntent Lifecycle](#paymentintent-lifecycle)
- [End-to-End Sequence: Polling Path](#end-to-end-sequence-polling-path)
- [End-to-End Sequence: Manual Verification Path](#end-to-end-sequence-manual-verification-path)
- [Persisted On-Chain Identifiers](#persisted-on-chain-identifiers)
- [Confirmation State Machine](#confirmation-state-machine)
- [Balance and Fee Tracking](#balance-and-fee-tracking)
- [On-Chain vs Database State Boundary](#on-chain-vs-database-state-boundary)
- [Idempotency](#idempotency)
- [Failure Cases](#failure-cases)
- [Sequence Handling](#sequence-handling)

---

## Overview

PaymentFlow never submits transactions on behalf of the school. Instead, it operates
in a **read-only observer** role:

1. Parents send XLM or USDC to the school's Stellar wallet using their own wallet app.
2. PaymentFlow polls the Stellar Horizon API for new transactions arriving at the
   school wallet.
3. On each transaction the backend extracts the memo (student ID), validates the
   amount against the school's fee structure, and writes a Payment record to MongoDB.
4. The student's balance and `feePaid` flag are updated atomically only after the
   payment passes all validation checks.

The only outgoing Stellar transactions PaymentFlow ever builds are **refunds** and
**account setup operations**, handled by `StellarTransactionManager`
(`backend/src/services/stellarTransactionManager.js`). Those paths are out of scope
for this settlement model document.

---

## Accounts and Trust Boundaries

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  TRUST BOUNDARY: Stellar Network (public ledger)                             │
│                                                                              │
│   ┌──────────────┐          ┌──────────────────────────┐                    │
│   │ Parent Wallet│ ───────► │  School Wallet            │                    │
│   │ (G…PARENT)   │  XLM /   │  (G…SCHOOL)              │                    │
│   │              │  USDC +  │  Public key only          │                    │
│   └──────────────┘  memo    │  Backend NEVER holds key  │                    │
│                             └──────────────────────────┘                    │
│                                          │                                   │
│                                   Horizon API                                │
│                              (read transactions)                             │
└──────────────────────────────────────────────────────────────────────────────┘
                                          │
                                  TRUST BOUNDARY
                                  Backend process
                                          │
                    ┌─────────────────────▼──────────────────────────┐
                    │  Backend: transactionPollingService             │
                    │  • Fetches tx pages from Horizon                │
                    │  • Validates memo, asset, amount                │
                    │  • Writes Payment + updates Student in MongoDB  │
                    └────────────────────────────────────────────────┘
                                          │
                                          ▼
                               ┌──────────────────┐
                               │  MongoDB          │
                               │  Payment records  │
                               │  Student records  │
                               │  PaymentIntents   │
                               └──────────────────┘
```

| Actor | Role | Key held by |
|---|---|---|
| Parent Wallet | Payment sender | Parent / guardian |
| School Wallet | Payment destination | School admin (never the backend) |
| Horizon API | Read-only ledger interface | Stellar Foundation / operators |
| Backend | Observer, validator, recorder | Platform operator |

---

## Assets and Trustlines

### Accepted Assets

Two asset types are supported, configured via `ACCEPTED_ASSET` in `.env`:

| Asset | Type | Issuer | Trustline required on school wallet? |
|---|---|---|---|
| `XLM` | `native` | none | No (native asset) |
| `USDC` | `credit_alphanum4` | Pinned per network (see below) | **Yes** |

The issuer address is derived automatically from `STELLAR_NETWORK`:

```
testnet: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
```

Source: `backend/src/config/index.js` and `backend/src/config/stellarConfig.js`.

### Trustline Requirement

For a school wallet to receive USDC the administrator must submit a
`ChangeTrust` operation from the school wallet to the USDC issuer before the
first payment arrives. The backend detects missing trustlines at startup via
`stellarAccountVerificationService` and surfaces the state in the `/health`
endpoint. Payments for an asset with no trustline will appear on Horizon as
`op_no_trust` and will be silently skipped by the sync loop.

### Asset Validation

`detectAsset(payOp)` in `stellarService.js` compares each payment operation's
`asset_code` + `asset_type` + `asset_issuer` against the configured accepted
assets. Transactions using any other asset are skipped without recording.

---

## Memo Field Usage

Stellar transactions include an optional **memo** field capped at **28 characters**
for `MEMO_TEXT` type. PaymentFlow uses this field to embed the student ID for
automatic payment matching.

```
Transaction:
  From:   G…PARENT
  To:     G…SCHOOL
  Amount: 500 XLM
  Memo:   "STU-2024-001"   ← student ID, max 28 chars
```

### Memo Processing Rules

1. The memo is trimmed of leading/trailing whitespace before use.
2. A missing or empty memo causes the transaction to be **skipped** (`MISSING_MEMO`).
3. The memo is matched against a `PaymentIntent` record scoped to the same `schoolId`.
4. The same memo value can exist across different schools without conflict (school-scoped lookup).
5. Memo collisions within a school (same memo, different sender address, within 24 hours)
   are flagged as suspicious by `detectMemoCollision`.
6. Cross-school memo collisions (same memo paid to different school within 24 hours)
   are flagged by `detectCrossSchoolMemoCollision` for manual review.

Source: `backend/src/services/stellarService.js` — `syncPaymentsForSchool`,
`detectMemoCollision`, `detectCrossSchoolMemoCollision`.

---

## PaymentIntent Lifecycle

A `PaymentIntent` is created by the backend when the parent requests payment
instructions. It links a memo value to a student and school before any on-chain
transaction occurs.

```
         ┌──────────┐
         │  PENDING │  ◄── Created when parent requests /api/payments/instructions/:studentId
         └────┬─────┘
              │  Matching tx found on-chain during sync or manual verify
              │  Amount valid, memo matches, not duplicate
              ▼
         ┌──────────┐
         │ COMPLETED│  ◄── Intent closed; Payment record created; Student updated
         └──────────┘
```

| Field | Description |
|---|---|
| `schoolId` | Tenant scope |
| `studentId` | The student this intent is for |
| `memo` | The memo value the parent must include |
| `amount` | Expected fee amount |
| `status` | `pending` or `completed` |
| `expiresAt` | TTL index — orphan intents are auto-deleted |

**Lookup during sync:** `PaymentIntent.findOne({ schoolId, memo, status: 'pending' })`.
Only transactions with a matching pending intent are processed. This prevents
arbitrary on-chain payments (spam, misdirected funds) from polluting the database.

Source: `backend/src/models/paymentIntentModel.js`, `backend/src/services/stellarService.js`.

---

## End-to-End Sequence: Polling Path

```
Parent                   Stellar                  Backend Poller              MongoDB
  │                        │                           │                         │
  │── sends XLM/USDC ─────►│                           │                         │
  │   with memo=studentId  │                           │                         │
  │                        │◄─── confirmed (~5s) ──────│                         │
  │                        │                           │                         │
  │                        │    every POLL_INTERVAL_MS │                         │
  │                        │◄── fetchTransactions() ───│                         │
  │                        │    (Horizon, desc, p200)  │                         │
  │                        │                           │                         │
  │                        │──── tx page ─────────────►│                         │
  │                        │                           │                         │
  │                        │              for each tx: │                         │
  │                        │                           │── findOne(txHash) ─────►│
  │                        │                           │◄── exists? skip ────────│
  │                        │                           │                         │
  │                        │              extractValidPayment():                 │
  │                        │                 • tx.successful?                    │
  │                        │                 • memo present?                     │
  │                        │                 • payOp to school wallet?           │
  │                        │                 • isAcceptedAsset?                  │
  │                        │                           │                         │
  │                        │              validatePaymentAmount()                │
  │                        │                           │── findOne(PaymentIntent)►│
  │                        │                           │◄── intent (pending) ────│
  │                        │                           │                         │
  │                        │              validatePaymentAgainstFee()            │
  │                        │              detectMemoCollision()                  │
  │                        │              detectCrossSchoolMemoCollision()       │
  │                        │              determineConfirmationState()           │
  │                        │                           │                         │
  │                        │              ─── session.withTransaction() ────────►│
  │                        │                           │── Payment.create() ────►│
  │                        │                           │── Student.update() ────►│
  │                        │                           │── Intent.complete() ───►│
  │                        │              ◄────────────│◄── committed ───────────│
  │                        │                           │                         │
  │                        │                     emit paymentEvents              │
  │                        │                           │── webhook/SSE/receipt   │
```

### Pagination

Transactions are fetched newest-first in pages of 200. The loop terminates when:
- A transaction is found that already exists in the database (already processed), **or**
- The last page of transactions is reached.

This means only new transactions are processed on each poll cycle.

---

## End-to-End Sequence: Manual Verification Path

```
Client (admin/parent)         Backend API               Horizon               MongoDB
        │                          │                       │                      │
        │── POST /api/payments/verify (txHash) ──────────►│                      │
        │                          │── fetchTx(txHash) ───►│                      │
        │                          │◄── tx data ───────────│                      │
        │                          │                       │                      │
        │                validate:  tx.successful?         │                      │
        │                          memo present?           │                      │
        │                          payOp to school wallet? │                      │
        │                          isAcceptedAsset?        │                      │
        │                          validatePaymentAmount() │                      │
        │                          │                       │                      │
        │                          │── findStudent(memo) ──────────────────────►│
        │                          │◄── student + fee ──────────────────────────│
        │                          │                       │                      │
        │                          │── idempotency check ──────────────────────►│
        │                          │◄── duplicate? ─────────────────────────────│
        │                          │                       │                      │
        │                          │── Payment.create() ───────────────────────►│
        │                          │── Student.update() ───────────────────────►│
        │◄── 200 { verified, amount, feeValidation } ──────│                      │
```

`verifyTransaction` in `stellarService.js` returns a structured result but
**does not persist**. The controller (`paymentController.js`) is responsible for
calling `transactionService.savePayment` to write the record.

---

## Persisted On-Chain Identifiers

Every Payment document in MongoDB stores the following fields derived directly
from the Stellar ledger:

| Field | Type | Source | Description |
|---|---|---|---|
| `txHash` | `String` | `tx.hash` | Stellar transaction hash (unique per payment) |
| `ledger` | `Number` | `tx.ledger_attr` | Ledger sequence number when tx was included |
| `senderAddress` | `String` | `tx.source_account` | Stellar account that sent the payment |
| `memo` | `String` | `tx.memo` (trimmed) | Payment memo — matches student ID |
| `amount` | `Number` | `payOp.amount` | Amount received (7 decimal precision) |
| `assetCode` | `String` | `payOp.asset_code` or `'XLM'` | `XLM` or `USDC` |
| `assetType` | `String` | `payOp.asset_type` | `native` or `credit_alphanum4` |
| `networkFee` | `Number` | `tx.fee_charged / 1e7` | Stellar network fee in XLM (stroops ÷ 10,000,000) |
| `confirmedAt` | `Date` | `tx.created_at` | Timestamp from the Stellar ledger |
| `confirmationState` | `String` | computed | Fine-grained finality state (see below) |
| `confirmationStatus` | `String` | computed | Legacy 3-value field (`pending_confirmation`, `confirmed`, `failed`) |

Additional fields stored in MongoDB but not directly from the ledger:

| Field | Source | Description |
|---|---|---|
| `schoolId` | PaymentIntent | Tenant scope |
| `studentId` | PaymentIntent | Matched via memo |
| `feeAmount` | Student / FeeStructure | Expected fee at time of payment |
| `feeValidationStatus` | computed | `valid` / `overpaid` / `underpaid` |
| `excessAmount` | computed | Amount above fee (0 if not overpaid) |
| `isSuspicious` | computed | `true` if fraud signals detected |
| `suspicionReason` | computed | Human-readable reason for suspicion |
| `status` | computed | `SUCCESS` / `FAILED` |

Source: `backend/src/models/paymentModel.js`.

---

## Confirmation State Machine

Stellar achieves finality in approximately 3–5 seconds. PaymentFlow adds a
configurable ledger-depth safety margin before treating a payment as final.

### States

```
  ┌──────────┐    depth == 0     ┌──────────┐
  │ detected │ ─────────────────►│ detected │ (initial state on first observation)
  └──────────┘                   └────┬─────┘
                                      │  0 < depth < CONFIRMATION_THRESHOLD
                                      ▼
                                 ┌──────────┐
                                 │ pending  │
                                 └────┬─────┘
                                      │  depth >= CONFIRMATION_THRESHOLD
                                      ▼
                                 ┌──────────┐
                                 │confirmed │  ◄── feePaid updated here
                                 └────┬─────┘
                                      │  depth >= FINALIZATION_THRESHOLD
                                      ▼
                                 ┌──────────┐
                                 │finalized │  (terminal — no further transitions)
                                 └──────────┘

  ┌──────────┐
  │  failed  │  (terminal — suspicious or invalid, set at detection time)
  └──────────┘
```

| State | `confirmationStatus` (legacy) | Meaning |
|---|---|---|
| `detected` | `pending_confirmation` | Tx observed, 0 ledgers closed since |
| `pending` | `pending_confirmation` | Awaiting depth threshold |
| `confirmed` | `confirmed` | Safe for balance/UI |
| `finalized` | `confirmed` | Practically irreversible |
| `failed` | `failed` | Suspicious or invalid — terminal |

### Thresholds (configurable)

```
CONFIRMATION_THRESHOLD=2   # default — wait 2 ledgers after tx ledger
FINALIZATION_THRESHOLD=10  # default — 5× CONFIRMATION_THRESHOLD
```

### Idempotency of Transitions

`computeTargetState` is a pure function. Re-polling the same ledger range is always safe:
- Terminal states (`finalized`, `failed`) never transition.
- A target that does not outrank the current state is a no-op.
- Forward jumps are allowed (e.g. `detected` → `confirmed` if first observed past threshold).

Source: `backend/src/services/paymentConfirmationStateMachine.js`.

---

## Balance and Fee Tracking

### Cumulative Payment Aggregation

A student may pay in multiple instalments. The sync loop aggregates all previous
confirmed payments before updating the student record:

```
previousTotal   = sum of all prior confirmed payments for this student
cumulativeTotal = previousTotal + currentPaymentAmount

if cumulativeTotal < feeAmount  → feeValidationStatus = 'underpaid'
if cumulativeTotal > feeAmount  → feeValidationStatus = 'overpaid'
if cumulativeTotal == feeAmount → feeValidationStatus = 'valid'
```

### Student Record Fields Updated

| Field | Updated when |
|---|---|
| `totalPaid` | Payment is confirmed and not suspicious |
| `feePaid` | `totalPaid >= feeAmount` and payment is confirmed and not suspicious |
| `remainingBalance` | Derived from `feeAmount - totalPaid` |

### Underpaid Handling

Underpaid transactions are **accepted and recorded as `SUCCESS`** because the funds
have already arrived on-chain. The `underpaidReconciliationService` tracks the
reconciliation lifecycle (`pending` → `partial_credited` → `refund_initiated` →
`refund_completed`) per payment record.

### Suspicious Payment Guard

When `isSuspicious = true`, the payment is recorded but the student's `feePaid`
flag is **not** updated. An admin must review and manually clear the suspicious flag
before the balance takes effect.

Source: `backend/src/services/stellarService.js` — `syncPaymentsForSchool`.

---

## On-Chain vs Database State Boundary

| Concern | On-chain only | Database only | Both |
|---|---|---|---|
| Transaction existence | ✅ `txHash` on Horizon | | `txHash` stored in Payment |
| Sender account | ✅ Stellar account | | `senderAddress` in Payment |
| Amount & asset | ✅ payment operation | | `amount`, `assetCode` in Payment |
| Memo | ✅ memo field | | `memo` in Payment |
| Ledger / timestamp | ✅ `ledger_attr`, `created_at` | | `ledger`, `confirmedAt` |
| Student assignment | | ✅ PaymentIntent + Student model | |
| Fee validation | | ✅ FeeStructure comparison | |
| Confirmation state | | ✅ derived from ledger depth | |
| `feePaid` flag | | ✅ business logic | |
| Audit trail | | ✅ AuditLog model | |

### Consistency Check

`GET /api/consistency` runs `consistencyService.runChecks(schoolId)` which:
- Finds payments in the database with no matching on-chain record (orphans).
- Finds payments in `FAILED` or `pending_confirmation` state beyond the retry window.
- Reports discrepancies for operator review.

Source: `backend/src/services/consistencyService.js`.

---

## Idempotency

### Duplicate Transaction Prevention

Before processing any transaction from a Horizon page, the sync loop checks:

```js
const existing = await Payment.findOne({ txHash: tx.hash });
if (existing) { done = true; break; }
```

The loop breaks entirely when a known transaction is found, since Horizon returns
results newest-first and all older transactions have already been processed.

### PaymentIntent Deduplication

Only transactions that match a `pending` PaymentIntent are recorded. A transaction
that arrives without a matching intent (e.g. a direct transfer not initiated through
the system) is silently skipped.

### Database Idempotency Key

For the manual verify path, `Payment.txHash` carries a unique index. A second call
to verify the same `txHash` returns the existing payment record without re-writing it.

Source: `backend/src/services/stellarService.js`, `backend/src/models/paymentModel.js`.

---

## Failure Cases

| Failure | Detection point | Behaviour | Error code |
|---|---|---|---|
| Horizon unavailable | `withStellarRetry` | Exponential backoff + circuit breaker; payments queue in retry service | `STELLAR_NETWORK_ERROR` |
| Missing memo | `extractValidPayment` | Transaction skipped; not recorded | `MISSING_MEMO` |
| Wrong asset | `detectAsset` | Transaction skipped; not recorded | `UNSUPPORTED_ASSET` |
| Payment not to school wallet | `extractValidPayment` | Transaction skipped | `INVALID_DESTINATION` |
| Transaction failed on-chain | `tx.successful === false` | Transaction skipped | `TX_FAILED` |
| Duplicate transaction | `Payment.findOne(txHash)` | Loop terminates; not re-recorded | `DUPLICATE_TX` |
| Amount below minimum | `validatePaymentAmount` | Transaction skipped | `AMOUNT_TOO_LOW` |
| Amount above maximum | `validatePaymentAmount` | Transaction skipped | `AMOUNT_TOO_HIGH` |
| No matching PaymentIntent | `PaymentIntent.findOne` | Transaction skipped | — |
| Suspicious payment | `detectMemoCollision` | Recorded with `isSuspicious: true`; `feePaid` NOT updated | — |
| Underpaid | `validatePaymentAgainstFee` | Recorded as `SUCCESS`, `feeValidationStatus: 'underpaid'`; reconciliation required | — |
| MongoDB write failure | `Payment.create` | Error logged; pushed to retry queue for re-processing | — |
| USDC trustline missing | account verification | Reported in `/health`; payments for that asset silently skipped | `op_no_trust` |
| Memo > 28 chars | Stellar network | Transaction rejected by Stellar protocol before reaching backend | — |

---

## Sequence Handling

PaymentFlow never builds or submits payment transactions for the school, so sequence
number management is only relevant for **outgoing refund/setup transactions**
(`StellarTransactionManager`). For the read-only polling path, sequence numbers are
irrelevant — the backend simply reads confirmed transactions.

For outgoing transactions:
- The account's current sequence is fetched fresh from Horizon before each build.
- On `tx_bad_seq` the sequence is re-fetched and the transaction rebuilt once.
- Timebounds (`maxTime`) prevent stuck or replayed transactions.

Source: `backend/src/services/stellarTransactionManager.js`.
