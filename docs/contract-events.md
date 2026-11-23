# Soroban Escrow Contract — Event Schema

**Schema version:** `1`  
**Last updated:** 2026-10-22  
**Status:** Active

---

## Overview

The Soroban escrow contract emits one event per lifecycle operation. These
events are the primary mechanism by which the off-chain indexer and backend
reconciliation jobs learn about state changes without polling the contract
storage directly.

Every event carries:

1. A **topic array** — a positional, typed tuple used by the indexer to filter
   and route events efficiently.
2. A **data map** — a key/value payload containing all fields necessary for
   off-chain reconciliation.

All string fields use Soroban `Symbol` or `Bytes` types. Numeric fields are
`i128` (fixed-point, 7 decimal places, matching Stellar's `stroops` convention)
unless otherwise noted. Account addresses are Soroban `Address` types.

---

## Schema versioning

The `schemaVersion` field is present in every event's data map.

| Situation | Action |
|-----------|--------|
| Backward-compatible addition | Increment **minor** version in documentation; no code changes required by consumers |
| Breaking field change or removal | Increment **major** `schemaVersion` integer; maintain the old version for one full release cycle; consumers **must** handle both |
| New event type | Add section below; no version bump required if existing events are unchanged |

---

## Common topic structure

Each event's topic array always starts with two fixed elements:

| Position | Type | Value |
|----------|------|-------|
| `topics[0]` | `Symbol` | `"escrow"` — contract namespace, constant |
| `topics[1]` | `Symbol` | Event type name (see per-event sections below) |

Additional topic elements are **indexed** (filterable by the Horizon API) and
are documented per event.

---

## Common data fields

Every event's data map contains these fields:

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `u32` | Integer schema version, currently `1` |
| `contractId` | `Address` | Soroban contract address that emitted this event |
| `ledgerSequence` | `u32` | Ledger number at the time of emission |
| `timestampMs` | `u64` | Unix timestamp in milliseconds at ledger close |

---

## Events

### 1. `EscrowCreated`

Emitted when a new escrow is created and funds are locked.

#### Topics

| Position | Type | Value | Indexed |
|----------|------|-------|---------|
| `topics[0]` | `Symbol` | `"escrow"` | no |
| `topics[1]` | `Symbol` | `"EscrowCreated"` | no |
| `topics[2]` | `Symbol` | `paymentId` | **yes** |
| `topics[3]` | `Address` | `schoolAccount` | **yes** |

#### Data fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `u32` | ✓ | `1` |
| `contractId` | `Address` | ✓ | Emitting contract |
| `ledgerSequence` | `u32` | ✓ | Ledger of creation |
| `timestampMs` | `u64` | ✓ | Creation time (ms) |
| `paymentId` | `Symbol` | ✓ | Unique escrow/payment identifier (matches `txHash` in backend) |
| `schoolId` | `Symbol` | ✓ | Multi-tenant school identifier |
| `studentId` | `Symbol` | ✓ | Student identifier for reconciliation |
| `schoolAccount` | `Address` | ✓ | School's Stellar account address |
| `depositorAccount` | `Address` | ✓ | Parent/payer's Stellar account address |
| `amount` | `i128` | ✓ | Escrowed amount in stroops (1 XLM = 10,000,000) |
| `asset` | `Symbol` | ✓ | Asset code: `"XLM"` or `"USDC"` |
| `feeCategory` | `Symbol` | ✓ | Fee category key (e.g. `"TUITION_2026"`) |
| `expectedFeeAmount` | `i128` | ✓ | Expected fee in stroops |
| `memoText` | `Bytes` | ✓ | Raw memo used for payment matching (UTF-8, max 28 bytes) |
| `expiresAtMs` | `u64` | ✓ | Escrow expiry timestamp in milliseconds |

#### Example (JSON representation)

```json
{
  "topics": ["escrow", "EscrowCreated", "TXabc123", "GSCHOOL..."],
  "data": {
    "schemaVersion": 1,
    "contractId": "CCONTRACT...",
    "ledgerSequence": 5000000,
    "timestampMs": 1761177600000,
    "paymentId": "TXabc123",
    "schoolId": "SCH-DEFAULT",
    "studentId": "STU001",
    "schoolAccount": "GSCHOOL...",
    "depositorAccount": "GPARENT...",
    "amount": 2500000000,
    "asset": "XLM",
    "feeCategory": "TUITION_2026",
    "expectedFeeAmount": 2500000000,
    "memoText": "STU001",
    "expiresAtMs": 1761264000000
  }
}
```

---

### 2. `FundsReleased`

Emitted when the escrow releases funds to the school upon successful fee
validation.

#### Topics

| Position | Type | Value | Indexed |
|----------|------|-------|---------|
| `topics[0]` | `Symbol` | `"escrow"` | no |
| `topics[1]` | `Symbol` | `"FundsReleased"` | no |
| `topics[2]` | `Symbol` | `paymentId` | **yes** |
| `topics[3]` | `Address` | `schoolAccount` | **yes** |

#### Data fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `u32` | ✓ | `1` |
| `contractId` | `Address` | ✓ | Emitting contract |
| `ledgerSequence` | `u32` | ✓ | Ledger of release |
| `timestampMs` | `u64` | ✓ | Release time (ms) |
| `paymentId` | `Symbol` | ✓ | Escrow/payment identifier |
| `schoolId` | `Symbol` | ✓ | School identifier |
| `studentId` | `Symbol` | ✓ | Student identifier |
| `schoolAccount` | `Address` | ✓ | Destination account |
| `depositorAccount` | `Address` | ✓ | Original payer account |
| `releasedAmount` | `i128` | ✓ | Amount released to school in stroops |
| `excessAmount` | `i128` | ✓ | Overpaid amount returned to payer (0 if exact) |
| `asset` | `Symbol` | ✓ | `"XLM"` or `"USDC"` |
| `feeValidationStatus` | `Symbol` | ✓ | `"valid"` \| `"overpaid"` \| `"underpaid"` |
| `releasedBy` | `Address` | ✓ | Account that triggered release (admin or contract automation) |

#### Example (JSON representation)

```json
{
  "topics": ["escrow", "FundsReleased", "TXabc123", "GSCHOOL..."],
  "data": {
    "schemaVersion": 1,
    "contractId": "CCONTRACT...",
    "ledgerSequence": 5000050,
    "timestampMs": 1761177900000,
    "paymentId": "TXabc123",
    "schoolId": "SCH-DEFAULT",
    "studentId": "STU001",
    "schoolAccount": "GSCHOOL...",
    "depositorAccount": "GPARENT...",
    "releasedAmount": 2500000000,
    "excessAmount": 0,
    "asset": "XLM",
    "feeValidationStatus": "valid",
    "releasedBy": "GADMIN..."
  }
}
```

---

### 3. `RefundIssued`

Emitted when escrowed funds are returned to the depositor (full or partial).

#### Topics

| Position | Type | Value | Indexed |
|----------|------|-------|---------|
| `topics[0]` | `Symbol` | `"escrow"` | no |
| `topics[1]` | `Symbol` | `"RefundIssued"` | no |
| `topics[2]` | `Symbol` | `paymentId` | **yes** |
| `topics[3]` | `Address` | `depositorAccount` | **yes** |

#### Data fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `u32` | ✓ | `1` |
| `contractId` | `Address` | ✓ | Emitting contract |
| `ledgerSequence` | `u32` | ✓ | Ledger of refund |
| `timestampMs` | `u64` | ✓ | Refund time (ms) |
| `paymentId` | `Symbol` | ✓ | Original escrow/payment identifier |
| `refundTxHash` | `Symbol` | ✓ | Transaction hash of the refund operation |
| `schoolId` | `Symbol` | ✓ | School identifier |
| `studentId` | `Symbol` | ✓ | Student identifier |
| `depositorAccount` | `Address` | ✓ | Account receiving the refund |
| `schoolAccount` | `Address` | ✓ | School account (for reconciliation) |
| `refundAmount` | `i128` | ✓ | Amount refunded in stroops |
| `asset` | `Symbol` | ✓ | `"XLM"` or `"USDC"` |
| `reason` | `Symbol` | ✓ | Refund reason code: `"dispute_resolved"` \| `"overpayment"` \| `"admin_initiated"` \| `"escrow_expired"` |
| `initiatedBy` | `Address` | ✓ | Account that initiated the refund |

#### Example (JSON representation)

```json
{
  "topics": ["escrow", "RefundIssued", "TXabc123", "GPARENT..."],
  "data": {
    "schemaVersion": 1,
    "contractId": "CCONTRACT...",
    "ledgerSequence": 5000200,
    "timestampMs": 1761190000000,
    "paymentId": "TXabc123",
    "refundTxHash": "TXrefund456",
    "schoolId": "SCH-DEFAULT",
    "studentId": "STU001",
    "depositorAccount": "GPARENT...",
    "schoolAccount": "GSCHOOL...",
    "refundAmount": 2500000000,
    "asset": "XLM",
    "reason": "dispute_resolved",
    "initiatedBy": "GADMIN..."
  }
}
```

---

### 4. `DisputeRaised`

Emitted when a dispute is opened against a payment held in escrow.

#### Topics

| Position | Type | Value | Indexed |
|----------|------|-------|---------|
| `topics[0]` | `Symbol` | `"escrow"` | no |
| `topics[1]` | `Symbol` | `"DisputeRaised"` | no |
| `topics[2]` | `Symbol` | `paymentId` | **yes** |
| `topics[3]` | `Symbol` | `disputeId` | **yes** |

#### Data fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `u32` | ✓ | `1` |
| `contractId` | `Address` | ✓ | Emitting contract |
| `ledgerSequence` | `u32` | ✓ | Ledger of dispute creation |
| `timestampMs` | `u64` | ✓ | Dispute open time (ms) |
| `paymentId` | `Symbol` | ✓ | Payment under dispute |
| `disputeId` | `Symbol` | ✓ | Unique dispute identifier |
| `schoolId` | `Symbol` | ✓ | School identifier |
| `studentId` | `Symbol` | ✓ | Student identifier |
| `raisedBy` | `Address` | ✓ | Account that raised the dispute |
| `schoolAccount` | `Address` | ✓ | School account |
| `depositorAccount` | `Address` | ✓ | Payer account |
| `disputedAmount` | `i128` | ✓ | Amount under dispute in stroops |
| `asset` | `Symbol` | ✓ | `"XLM"` or `"USDC"` |
| `reasonCode` | `Symbol` | ✓ | Machine-readable reason: `"wrong_amount"` \| `"not_received"` \| `"duplicate"` \| `"other"` |
| `slaDeadlineMs` | `u64` | ✓ | SLA deadline timestamp in milliseconds |

#### Example (JSON representation)

```json
{
  "topics": ["escrow", "DisputeRaised", "TXabc123", "DISPxyz789"],
  "data": {
    "schemaVersion": 1,
    "contractId": "CCONTRACT...",
    "ledgerSequence": 5000100,
    "timestampMs": 1761180000000,
    "paymentId": "TXabc123",
    "disputeId": "DISPxyz789",
    "schoolId": "SCH-DEFAULT",
    "studentId": "STU001",
    "raisedBy": "GPARENT...",
    "schoolAccount": "GSCHOOL...",
    "depositorAccount": "GPARENT...",
    "disputedAmount": 2500000000,
    "asset": "XLM",
    "reasonCode": "wrong_amount",
    "slaDeadlineMs": 1761439200000
  }
}
```

---

### 5. `DisputeResolved`

Emitted when a dispute is closed with a resolution (in favour of either party).

#### Topics

| Position | Type | Value | Indexed |
|----------|------|-------|---------|
| `topics[0]` | `Symbol` | `"escrow"` | no |
| `topics[1]` | `Symbol` | `"DisputeResolved"` | no |
| `topics[2]` | `Symbol` | `paymentId` | **yes** |
| `topics[3]` | `Symbol` | `disputeId` | **yes** |

#### Data fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `u32` | ✓ | `1` |
| `contractId` | `Address` | ✓ | Emitting contract |
| `ledgerSequence` | `u32` | ✓ | Ledger of resolution |
| `timestampMs` | `u64` | ✓ | Resolution time (ms) |
| `paymentId` | `Symbol` | ✓ | Payment that was under dispute |
| `disputeId` | `Symbol` | ✓ | Unique dispute identifier |
| `schoolId` | `Symbol` | ✓ | School identifier |
| `studentId` | `Symbol` | ✓ | Student identifier |
| `resolvedBy` | `Address` | ✓ | Account that resolved the dispute |
| `schoolAccount` | `Address` | ✓ | School account |
| `depositorAccount` | `Address` | ✓ | Payer account |
| `outcome` | `Symbol` | ✓ | `"released_to_school"` \| `"refunded_to_depositor"` \| `"partial_release"` |
| `schoolAmount` | `i128` | ✓ | Amount released to school (0 if full refund) |
| `depositorAmount` | `i128` | ✓ | Amount returned to depositor (0 if full release) |
| `asset` | `Symbol` | ✓ | `"XLM"` or `"USDC"` |
| `resolutionNote` | `Symbol` | ✗ | Optional human-readable resolution note (max 128 chars) |

#### Example (JSON representation)

```json
{
  "topics": ["escrow", "DisputeResolved", "TXabc123", "DISPxyz789"],
  "data": {
    "schemaVersion": 1,
    "contractId": "CCONTRACT...",
    "ledgerSequence": 5000300,
    "timestampMs": 1761263200000,
    "paymentId": "TXabc123",
    "disputeId": "DISPxyz789",
    "schoolId": "SCH-DEFAULT",
    "studentId": "STU001",
    "resolvedBy": "GADMIN...",
    "schoolAccount": "GSCHOOL...",
    "depositorAccount": "GPARENT...",
    "outcome": "refunded_to_depositor",
    "schoolAmount": 0,
    "depositorAmount": 2500000000,
    "asset": "XLM",
    "resolutionNote": "Duplicate payment confirmed"
  }
}
```

---

## Indexed fields summary

The following fields appear as topic elements (position 2+) and can be used as
Horizon event filter parameters:

| Field | Events that index it |
|-------|---------------------|
| `paymentId` | All five events |
| `schoolAccount` | `EscrowCreated`, `FundsReleased` |
| `depositorAccount` | `RefundIssued` |
| `disputeId` | `DisputeRaised`, `DisputeResolved` |

---

## Off-chain reconciliation mapping

| Event | Backend action |
|-------|---------------|
| `EscrowCreated` | Create/update Payment record; set status `PENDING` |
| `FundsReleased` | Set payment status `SUCCESS`; update `feeValidationStatus`; trigger webhook |
| `RefundIssued` | Set payment status `REFUNDED`; update Refund record; trigger webhook |
| `DisputeRaised` | Create Dispute record; set payment status `DISPUTED`; start SLA timer |
| `DisputeResolved` | Close Dispute record; set final payment/refund status; trigger webhook |

---

## Amount encoding

All amounts are `i128` values representing **stroops** (the smallest Stellar
unit: 1 XLM = 10,000,000 stroops). Divide by `10_000_000` to obtain the
human-readable decimal value.

```
stroopsToDecimal(amount) = amount / 10_000_000
decimalToStroops(decimal) = decimal * 10_000_000
```

The backend stores decimal values in MongoDB. The parser converts stroops to
decimal on ingestion.

---

## Schema change process

1. Open a PR that modifies this document.
2. Increment `schemaVersion` in the data section for the affected event(s) if
   the change is breaking (field removed, type changed, enum value removed).
3. Update `backend/src/types/contractEvents.js` and
   `backend/src/services/contractEventParser.js` in the same PR.
4. Add a test case in `tests/contractEvents.test.js` covering the new version.
5. Maintain backward compatibility for one release cycle when breaking.
