# Soroban Escrow Contract Requirements

> **Issue:** [#300 — Define Soroban smart contract requirements for fee escrow](https://github.com/onlyonee1/PaymentFlow/issues/300)
> **Status:** Draft — awaiting stakeholder approval before implementation begins
> **Author:** Platform Engineering
> **Last updated:** 2026-10-20

This document defines the requirements for a Soroban smart contract that provides
escrow semantics for PaymentFlow school fee payments. It is intended to serve as
the approved baseline before implementation begins.

---

## Table of Contents

- [Overview and Purpose](#overview-and-purpose)
- [Relationship to Existing Architecture](#relationship-to-existing-architecture)
- [Actors and Roles](#actors-and-roles)
- [State Machine](#state-machine)
- [Function Specifications](#function-specifications)
- [Authorization Checks](#authorization-checks)
- [Invalid Call Behaviors](#invalid-call-behaviors)
- [Replay Protection](#replay-protection)
- [Fee Behavior](#fee-behavior)
- [Fee Distribution](#fee-distribution)
- [Timeout and Expiry](#timeout-and-expiry)
- [Dispute Handling](#dispute-handling)
- [Events](#events)
- [Backend Integration Requirements](#backend-integration-requirements)
- [Out of Scope (v1)](#out-of-scope-v1)
- [Open Questions and Approval Checklist](#open-questions-and-approval-checklist)

---

## Overview and Purpose

The existing PaymentFlow architecture records school fee payments by observing
direct wallet-to-wallet transfers on the Stellar network. This model has a
key limitation: once a parent sends funds directly to the school wallet, there
is no on-chain mechanism to hold the funds pending dispute resolution or partial
reconciliation. Refunds require a separate outgoing transaction initiated off-chain.

A **Soroban escrow contract** adds an on-chain hold layer:

1. The parent deposits funds into the escrow contract rather than directly to the
   school wallet.
2. The contract holds the funds until one of several terminal conditions is reached
   (release to school, refund to parent, cancellation).
3. Disputes can be opened on-chain and resolved by a designated arbiter.
4. Timeouts protect payers from funds being locked indefinitely.

This is a **v1 escrow contract**. It covers single-asset, single-beneficiary escrow
for a defined fee amount. Multi-asset and multi-beneficiary scenarios are out of scope.

---

## Relationship to Existing Architecture

The Soroban escrow contract is an **optional settlement layer** alongside the
existing direct-transfer model. The backend's `transactionPollingService` is
extended to listen for contract events (specifically `Released`) in addition to
standard payment operations.

The existing PaymentIntent, Student, Payment, and Dispute models remain authoritative
on the database side. The contract's escrow ID maps 1:1 to a PaymentIntent record.

```
Existing flow (no escrow):
  Parent Wallet ──► School Wallet (direct)
  Backend polls Horizon, records Payment

New flow (with escrow):
  Parent Wallet ──► Soroban Escrow Contract
  Contract holds funds pending release/dispute
  On Released event ──► Backend records Payment + updates Student
```

---

## Actors and Roles

| Actor | Description | Can initiate |
|---|---|---|
| **Payer** | The parent or guardian paying fees | `deposit`, `dispute`, `cancel` (within timeout) |
| **Beneficiary** | The school's Stellar wallet address | `release` |
| **Arbiter** | Platform operator or designated dispute resolver | `release`, `cancel`, `resolveDispute` |
| **Contract Admin** | Account that deployed the contract | Contract upgrade/migration only (out of scope v1) |

The Payer, Beneficiary, and Arbiter addresses are set at deposit time and stored in
contract storage for the lifetime of that escrow instance.

---

## State Machine

```
         ┌──────┐
         │ IDLE │  (no active escrow — initial state)
         └──┬───┘
            │  deposit(payer, beneficiary, arbiter, amount, asset, memo, timeout_ledger)
            │  Requires: Payer authorization + sufficient balance
            ▼
         ┌────────┐
         │ FUNDED │ ◄──────────────────────────────────────────────┐
         └────┬───┘                                                │
              │                                                    │
      ┌───────┼──────────────────┐                                │
      │       │                  │                                │
      │       │ dispute()        │ cancel() [payer, within timeout │
      │       │ by Payer         │  OR arbiter anytime]           │
      │       ▼                  ▼                                │
      │  ┌──────────┐    ┌────────────┐                           │
      │  │ DISPUTED │    │ CANCELLED  │ (terminal)                │
      │  └────┬─────┘    └────────────┘                           │
      │       │                                                   │
      │ resolveDispute(release)  resolveDispute(refund)           │
      │       │                       │                           │
      │       ▼                       ▼                           │
      │  ┌──────────┐         ┌──────────┐                        │
      │  │ RELEASED │         │ REFUNDED │ (terminal)             │
      │  │(terminal)│         │(terminal)│                        │
      │  └──────────┘         └──────────┘                        │
      │                                                           │
      │  release() [beneficiary or arbiter, FUNDED state only]    │
      └──────────────────────────────────────────────────────────►│
                                                        RELEASED  │
                                                                  │
         ledger >= timeout_ledger (FUNDED state, no dispute)      │
              ▼                                                   │
         ┌─────────┐                                              │
         │ EXPIRED │ ──► claimExpired() by Payer ──► REFUNDED ◄──┘
         └─────────┘
```

### Terminal States

| State | Who receives funds |
|---|---|
| `RELEASED` | Beneficiary (school) |
| `REFUNDED` | Payer (parent) |
| `CANCELLED` | Payer (parent) |

Once in a terminal state, no further state transitions are possible. All function
calls on a terminal escrow MUST return an error.

---

## Function Specifications

### `deposit(payer, beneficiary, arbiter, amount, asset, memo, timeout_ledger)`

**Purpose:** Lock funds in the contract and create an escrow instance.

**Authorization:** Payer must sign the transaction invoking this function.

**Pre-conditions:**
- `amount > 0`
- `asset` is in the contract's configured accepted asset list
- `memo` length ≤ 28 bytes (UTF-8), non-empty
- `timeout_ledger > ledger_sequence` at time of call (not already expired)
- No existing escrow for the same `(schoolId, memo)` pair in a non-terminal state
  (deduplication — see [Replay Protection](#replay-protection))
- Payer has sufficient balance

**State transition:** `IDLE` → `FUNDED`

**Events emitted:** `Deposited(escrow_id, payer, beneficiary, amount, asset, memo)`

**Replay behavior:** A second `deposit` call with the same escrow parameters MUST
fail with `EscrowAlreadyExists` if a non-terminal escrow with the same
`(schoolId, memo)` exists.

---

### `release(caller)`

**Purpose:** Release escrowed funds to the beneficiary.

**Authorization:** Beneficiary or Arbiter only.

**Pre-conditions:**
- Escrow state is `FUNDED` (direct release) or `DISPUTED` (arbiter override)
- Caller's address matches stored `beneficiary` or `arbiter`

**State transition:** `FUNDED` → `RELEASED`, or `DISPUTED` → `RELEASED`

**Events emitted:** `Released(escrow_id, beneficiary, amount)`

**Replay behavior:** Calling `release()` on an already-`RELEASED` escrow MUST
return `EscrowAlreadyTerminal`.

---

### `cancel(caller)`

**Purpose:** Cancel the escrow and return funds to the payer.

**Authorization:**
- Payer may cancel if `ledger_sequence < timeout_ledger` (i.e. within the active window)
- Arbiter may cancel at any time while escrow is `FUNDED`

**Pre-conditions:**
- Escrow state is `FUNDED`
- If caller is Payer: `ledger_sequence < timeout_ledger`
- If caller is Arbiter: no ledger restriction

**State transition:** `FUNDED` → `CANCELLED`

**Events emitted:** `Cancelled(escrow_id, caller)`

---

### `dispute(caller)`

**Purpose:** Mark the escrow as under dispute, preventing release until resolved.

**Authorization:** Payer only.

**Pre-conditions:**
- Escrow state is `FUNDED`
- Payer's address matches stored `payer`

**State transition:** `FUNDED` → `DISPUTED`

**Events emitted:** `Disputed(escrow_id, payer, reason_hash)`

**Note on `reason_hash`:** The dispute reason is stored off-chain in the backend
`DisputeModel`. The on-chain event carries only a hash of the reason string for
integrity verification without PII disclosure.

---

### `resolveDispute(caller, decision)`

**Purpose:** Arbiter resolves a disputed escrow.

**Authorization:** Arbiter only.

**Parameters:**
- `decision`: `"release"` (funds to beneficiary) or `"refund"` (funds to payer)

**Pre-conditions:**
- Escrow state is `DISPUTED`
- Caller's address matches stored `arbiter`

**State transitions:**
- `decision = "release"` → `DISPUTED` → `RELEASED`
- `decision = "refund"` → `DISPUTED` → `REFUNDED`

**Events emitted:** `Resolved(escrow_id, decision, arbiter)`

---

### `claimExpired(caller)`

**Purpose:** Allow the payer to reclaim funds after the timeout_ledger has passed.

**Authorization:** Payer or Arbiter.

**Pre-conditions:**
- Escrow state is `FUNDED` (not `DISPUTED` — an active dispute suspends expiry)
- `ledger_sequence >= timeout_ledger`

**State transition:** `FUNDED` → `REFUNDED`

**Events emitted:** `Expired(escrow_id)`, then `Refunded(escrow_id, payer, amount)`

---

### `getStatus()`

**Purpose:** Read-only query returning current escrow state.

**Authorization:** No restrictions (public read).

**Returns:**
```
{
  escrow_id:       string,
  state:           "FUNDED" | "DISPUTED" | "RELEASED" | "REFUNDED" | "CANCELLED" | "EXPIRED",
  payer:           Address,
  beneficiary:     Address,
  arbiter:         Address,
  amount:          i128,
  asset:           Asset,
  memo:            string,
  timeout_ledger:  u32,
  created_at:      u64  (Unix timestamp)
}
```

---

## Authorization Checks

| Function | Authorized Callers | Unauthorized Callers | Rejection Code |
|---|---|---|---|
| `deposit` | Payer (must sign) | Any other account | `Unauthorized` |
| `release` | Beneficiary, Arbiter | Payer, third parties | `Unauthorized` |
| `cancel` | Payer (within timeout), Arbiter | Beneficiary, third parties | `Unauthorized` or `TimeoutNotExpired` |
| `dispute` | Payer | Beneficiary, Arbiter, third parties | `Unauthorized` |
| `resolveDispute` | Arbiter | Payer, Beneficiary, third parties | `Unauthorized` |
| `claimExpired` | Payer, Arbiter | Beneficiary, third parties | `Unauthorized` |
| `getStatus` | Anyone | — | — |

---

## Invalid Call Behaviors

The contract MUST reject the following calls with explicit error codes:

| Scenario | Error Code | Description |
|---|---|---|
| `release()` on `RELEASED` escrow | `EscrowAlreadyTerminal` | Terminal state, no transition possible |
| `release()` on `CANCELLED` escrow | `EscrowAlreadyTerminal` | Terminal state |
| `release()` on `DISPUTED` escrow by Beneficiary | `EscrowDisputed` | Only Arbiter may release from DISPUTED |
| `deposit()` when non-terminal escrow exists for same (schoolId, memo) | `EscrowAlreadyExists` | Replay / deduplication |
| `deposit()` with `amount = 0` | `InvalidAmount` | Zero-value escrow is not meaningful |
| `deposit()` with `memo` exceeding 28 bytes | `MemoTooLong` | Stellar memo constraint |
| `deposit()` with `timeout_ledger` already passed | `TimeoutAlreadyExpired` | Cannot create an immediately-expired escrow |
| `deposit()` with unsupported asset | `UnsupportedAsset` | Must match configured accepted assets |
| `dispute()` on non-`FUNDED` escrow | `InvalidState` | Can only dispute FUNDED state |
| `cancel()` by Payer after `timeout_ledger` | `TimeoutExpired` | Use `claimExpired()` instead |
| `cancel()` on `DISPUTED` escrow by Payer | `EscrowDisputed` | Dispute in progress — arbiter must resolve |
| `resolveDispute()` on non-`DISPUTED` escrow | `NotDisputed` | No active dispute to resolve |
| `claimExpired()` before `timeout_ledger` | `TimeoutNotExpired` | Funds still in active window |
| `claimExpired()` on `DISPUTED` escrow | `EscrowDisputed` | Active dispute suspends expiry |
| Any function call on terminal state | `EscrowAlreadyTerminal` | No transitions from terminal |
| Unauthorized caller on any function | `Unauthorized` | Address mismatch |
| Unknown `decision` value in `resolveDispute` | `InvalidDecision` | Must be `"release"` or `"refund"` |

---

## Replay Protection

### Contract-Level Escrow ID Uniqueness

The contract generates a unique `escrow_id` for each successful `deposit` call,
derived from `(payer, beneficiary, memo, ledger_sequence)`. This ID is stored in
contract persistent storage and referenced in all subsequent calls and events.

### Deduplication at Deposit

Before creating a new escrow, the contract checks whether an escrow with the same
`(schoolId, memo)` combination already exists in a non-terminal state. If one is
found, `deposit()` returns `EscrowAlreadyExists` rather than creating a duplicate.

**Rationale:** `memo` is the student ID. A student should not have two simultaneously
active escrow deposits for the same school. The school admin can cancel the prior
escrow before a new one is accepted.

### Idempotency for Resolution

`release()`, `resolveDispute()`, and `cancel()` are idempotent in the sense that
calling them on an already-terminal escrow returns a predictable error
(`EscrowAlreadyTerminal`) without side effects. Backend callers should treat this
error as a no-op confirmation rather than a failure.

### Backend Idempotency Alignment

The backend's existing idempotency key mechanism (`IdempotencyKey` model) MUST be
applied to any API call that triggers an on-chain escrow function. The `escrow_id`
returned from `deposit` is stored in the `PaymentIntent` record alongside the
existing `memo` and `txHash`.

---

## Fee Behavior

### Stellar Network Fee

The Stellar network fee (charged in XLM stroops) is paid by the transaction submitter,
not deducted from the escrowed amount. The escrowed amount MUST equal the full
fee amount specified in the payment instructions.

**Implication for validation:** The backend compares `escrowed_amount` (from the
`Deposited` event) against `intent.amount` (from the PaymentIntent). The network
fee is tracked separately in the `networkFee` field on the Payment record, consistent
with the existing direct-transfer model.

### Fee Bump Transactions

If a `deposit` or `release` transaction is stuck due to insufficient fee,
a fee-bump envelope can be submitted by the Arbiter (or school admin) using a
separate fee-source account. The inner transaction is unchanged; only the fee wrapper
changes. This is consistent with the existing `StellarTransactionManager.submitFeeBump`
implementation.

### Overpayment

If the payer deposits an amount exceeding the required fee:
- The full deposited amount is held and transferred on `release`.
- The backend records `feeValidationStatus: 'overpaid'` and `excessAmount`.
- The school receives the full deposited amount (overpayment goes to school, v1 behavior).
- A future v2 requirement may split the release (exact fee to school + refund of excess).

---

## Fee Distribution

This section specifies how the escrowed amount is split between parties at the
moment funds leave the contract (i.e. on `release()` or `resolveDispute("release")`).
In v1 the contract transfers the full deposited amount in a single operation. The
distribution logic described here is partially enforced on-chain and partially
reconciled off-chain by the backend.

### Parties in the Distribution

| Party | Role | How funds reach them |
|---|---|---|
| **School (Beneficiary)** | Receives the net fee amount | Direct on-chain transfer from contract on `release()` |
| **Platform (Operator)** | Receives a platform service fee | Off-chain settlement via backend reconciliation in v1; on-chain split in v2 |
| **Gas Reserve** | Covers Stellar network transaction fees for future contract operations | Funded by the platform from its own XLM reserve; NOT deducted from the escrow amount |

### v1 Distribution Model (On-Chain Single Transfer)

In v1 the contract performs a **single atomic transfer** of the full escrowed amount
to the beneficiary on release. Platform fee extraction is handled off-chain:

```
Escrowed amount (e.g. 500 USDC)
        │
        ├─ release() called
        │
        ▼
School Wallet receives 500 USDC  ← full amount, on-chain
        │
        ▼
Backend calculates platform fee:  500 × PLATFORM_FEE_BPS / 10000
Backend records:  platformFeeAmount, schoolNetAmount in Payment record
Platform invoices school off-chain (monthly batch settlement)
```

**Rationale for v1 off-chain settlement:** A two-output on-chain split requires the
platform wallet to have a trustline for USDC, and increases contract complexity.
The v1 approach ships sooner without these dependencies.

### Platform Fee Configuration

| Parameter | Default | Description |
|---|---|---|
| `PLATFORM_FEE_BPS` | `50` | Platform fee in basis points (50 bps = 0.5%) |
| `PLATFORM_FEE_MIN` | `0.01 USDC` | Minimum fee charged regardless of amount |
| `PLATFORM_FEE_MAX` | `10.00 USDC` | Fee cap to protect high-value payments |

These values are configured per-school via the school settings model and NOT stored
in the Soroban contract in v1. The backend computes `platformFeeAmount` after
observing the `Released` event.

### Gas Reserve

The Soroban contract itself must maintain a minimum XLM balance to cover:
- Soroban contract storage rent (persistent storage TTL renewal)
- Network transaction fees for arbiter-initiated operations (`cancel`, `resolveDispute`)

The **Platform Operator** is responsible for funding the contract's XLM reserve.
The escrowed USDC/XLM is never used for rent. The backend's health check SHOULD
include a check of the contract account's XLM balance against a minimum threshold
(recommended: 5 XLM above the base reserve).

### Overpayment Distribution

If `deposited_amount > intent.feeAmount`:

| Party | Amount | Notes |
|---|---|---|
| School | Full deposited amount | v1: school receives all, including excess |
| Platform | `deposited_amount × PLATFORM_FEE_BPS / 10000` | Calculated on full deposited amount |
| Parent | Nothing | No automatic refund of excess in v1 |

The backend records `feeValidationStatus: 'overpaid'` and `excessAmount` in the
Payment record. School admin is notified and may manually initiate a refund for
the excess via the existing refund workflow.

### Partial Payment (Underpayment) Distribution

If `deposited_amount < intent.feeAmount`:

- The contract holds the partial amount until `release()` is called.
- Release is still valid — the school receives whatever was deposited.
- The backend records `feeValidationStatus: 'underpaid'` and `remainingBalance`.
- `feePaid` is NOT set to `true` until cumulative payments meet `feeAmount`.
- Multiple escrow deposits for the same student (sequential, not concurrent) are
  allowed once the prior escrow reaches a terminal state.

### v2 Distribution (Planned, Out of Scope)

A future v2 may implement an on-chain split within `release()`:

```rust
// Conceptual v2 pseudocode
let platform_fee = deposited_amount * PLATFORM_FEE_BPS / 10000;
let school_net   = deposited_amount - platform_fee;
token.transfer(&env, &contract, &platform_wallet, platform_fee);
token.transfer(&env, &contract, &beneficiary,     school_net);
```

This requires the platform wallet address and fee BPS to be stored as contract
instance storage, settable only by the Contract Admin.

---

## Timeout and Expiry

### Ledger-Based Expiry

Timeouts are expressed as an absolute **ledger sequence number** (`timeout_ledger`)
rather than a wall-clock timestamp. This prevents clock-skew attacks and aligns
with how Stellar's `timeBounds.maxTime` works.

### Default Timeout Recommendation

The recommended `timeout_ledger` is `current_ledger + 17,280` (approximately 24 hours
given ~5 seconds per ledger). This should be configurable via a contract admin setting.

```
~17,280 ledgers × 5 seconds/ledger ≈ 86,400 seconds ≈ 24 hours
```

### Expiry Behavior

- While a non-terminal, non-disputed escrow has `ledger_sequence >= timeout_ledger`:
  - `release()` by Beneficiary is **still valid** (school can still claim).
  - `claimExpired()` by Payer is **also valid** (race condition — first-come-first-served).
- A `DISPUTED` escrow is **immune to timeout**. The arbiter must resolve the dispute
  before expiry can be claimed.

### Arbiter Override

The Arbiter may call `cancel()` on a `FUNDED` escrow at any time, including after
timeout, to return funds to the payer. This provides a manual fallback when the
payer cannot invoke `claimExpired()` directly (e.g. key loss).

---

## Dispute Handling

### Payer-Initiated Dispute

1. Payer calls `dispute(reason_hash)` on a `FUNDED` escrow.
2. Contract transitions to `DISPUTED`. Release to school is blocked.
3. A `Disputed` event is emitted on-chain with the hashed reason.
4. Backend's polling service detects the event and creates a `DisputeModel` record
   with `status: 'open'`, linking `escrow_id` → `disputeId`.

### Arbiter Resolution

1. The Arbiter reviews the off-chain evidence stored in the `DisputeModel`.
2. Arbiter calls `resolveDispute(escrow_id, "release")` or `resolveDispute(escrow_id, "refund")`.
3. A `Resolved` event is emitted.
4. Backend updates the `DisputeModel` status to `resolved_release` or `resolved_refund`.
5. For `"release"`: Payment is recorded as `SUCCESS`; student `feePaid` updated.
6. For `"refund"`: Payment is recorded as `REFUNDED`; student balance unchanged.

### Evidence Storage

Dispute evidence (screenshots, correspondence) is stored **off-chain** in the
backend database under the `DisputeModel.evidence` array. The on-chain contract
stores only the `sha256(reason)` hash for integrity. This design:
- Avoids storing PII or large blobs on-chain.
- Provides a verifiable link between on-chain event and off-chain evidence.

### Relationship to Existing Dispute Model

`backend/src/models/disputeModel.js` is extended to add:
- `escrowId`: the on-chain contract escrow identifier
- `onChainState`: mirrors the contract state for quick queries without Horizon lookups
- `resolvedBy`: Arbiter's address from the `Resolved` event

---

## Events

The contract MUST emit the following events, compatible with Soroban event indexing:

| Event | Fields | Trigger |
|---|---|---|
| `Deposited` | `escrow_id, payer, beneficiary, amount, asset, memo` | Successful `deposit()` |
| `Released` | `escrow_id, recipient, amount` | Successful `release()` or `resolveDispute("release")` |
| `Disputed` | `escrow_id, payer, reason_hash` | Successful `dispute()` |
| `Resolved` | `escrow_id, decision, arbiter` | Successful `resolveDispute()` |
| `Cancelled` | `escrow_id, caller, amount` | Successful `cancel()` |
| `Expired` | `escrow_id` | Emitted before `Refunded` on `claimExpired()` |
| `Refunded` | `escrow_id, recipient, amount` | Successful `claimExpired()` or `resolveDispute("refund")` |

All events MUST include the `escrow_id` as the first field to allow efficient
server-side filtering by contract consumers.

---

## Backend Integration Requirements

### Polling Service Extension

`transactionPollingService` must be extended to:
1. Poll contract events for the school's escrow contract address in addition to
   direct payment operations.
2. Map `Released` events → existing payment recording flow (same as a direct payment,
   with `escrow_id` stored in the Payment record).
3. Map `Disputed` events → create a `DisputeModel` record with `status: 'open'`.
4. Map `Resolved` events → update the linked `DisputeModel` status.
5. Map `Refunded` events → mark the linked Payment as `REFUNDED`.

### PaymentIntent Linkage

The `PaymentIntent` model requires two additional fields:
- `escrowId`: set when a `Deposited` event is observed for the intent's memo.
- `escrowState`: mirrors the contract state (`funded`, `disputed`, `released`, etc.).

### Student Record Updates

The `feePaid` flag update logic remains unchanged. It is triggered by a `Released`
event (equivalent to observing a confirmed direct payment). The `escrow_id` is
included in the Payment record's `metadata` for audit purposes.

### Memo Field Compatibility

The contract's `memo` parameter MUST use the same student ID format as the existing
direct-transfer model. The backend's `PaymentIntent.findOne({ schoolId, memo, status: 'pending' })`
lookup is reused without modification.

### SSE and Webhooks

Existing SSE events (`payment.confirmed`) and webhook deliveries are triggered from
the `paymentSaved` event, which is fired after a Payment record is persisted. The
escrow path fires the same event — no changes required to SSE or webhook services.

---

## Out of Scope (v1)

The following are explicitly excluded from v1 and tracked as future requirements:

- **Multi-asset escrow in a single contract instance:** Each escrow holds exactly
  one asset type. Accepting both XLM and USDC in the same escrow is a v2 concern.
- **Partial release:** The contract releases the full escrowed amount on `release()`.
  Releasing part of the funds to the school and refunding the excess is a v2 concern.
- **Contract upgradeability / governance:** The deploy model, admin key management,
  and upgrade authority are not specified here and require a separate security review.
- **Multi-beneficiary:** A single escrow has exactly one beneficiary (school wallet).
- **Fee splitting:** Network fee handling beyond the existing fee-bump model is out of scope.
- **Automated arbiter (oracle):** The arbiter is a human-controlled account in v1.

---

## Open Questions and Approval Checklist

The following items require stakeholder approval before implementation begins:

- [ ] **Arbiter account**: Who controls the Arbiter address? Platform operator
  multi-sig? DAO? School-level arbiter per deployment?
- [ ] **Default timeout**: Is 24 hours (≈17,280 ledgers) the right default, or
  should it vary by school/fee/academic calendar?
- [ ] **Overpayment handling**: Should excess funds above the required fee be returned
  to the payer at release time, or does the school receive the full deposited amount?
- [ ] **Expiry race condition**: When both `release()` (by school) and `claimExpired()`
  (by payer) are callable simultaneously, should the contract favour one over the other,
  or is first-come-first-served acceptable?
- [ ] **PII in dispute reason hash**: Is `sha256(reason)` sufficient, or should a
  keyed HMAC be used to prevent off-chain preimage revelation?
- [ ] **Contract deployment model**: One contract per school? One global contract
  with school-scoped storage? This affects fee costs and upgrade mechanics.
- [ ] **Horizon event indexing**: Confirm that the RPC/event API used by the polling
  service supports filtering Soroban events by contract address and topic.
- [ ] **Testing environment**: Confirm testnet USDC issuer and contract deployment
  credentials before integration testing begins.
