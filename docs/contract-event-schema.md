# Contract Event Schema for Indexing

This specification documents the event schema and indexing requirements for PaymentFlow escrow and smart contracts.

---

## 1. Overview & Objectives

Off-chain services, reconcilers, and indexers require a predictable, versioned stream of contract events to track payments and rebuild projections without relying on raw, untyped ledger data.

Key objectives:
- **Idempotency**: Indexers must be able to process identical events multiple times without producing duplicate state mutations.
- **Correlation**: Every event links back to the originating off-chain entity (student ID, payment intent, or operation ID).
- **Projection Rebuilding**: A complete projection of student balances, escrow holdings, and dispute statuses can be rebuilt purely from replaying historical events.
- **Versioning & Compatibility**: Strict schema versioning ensuring backward and forward compatibility.

---

## 2. Event Envelope Structure

Every emitted event conforms to a standardized envelope:

```json
{
  "eventId": "<txHash>:<topic>:<index>",
  "eventVersion": "1.0.0",
  "topic": "deposit | release | refund | dispute",
  "contractId": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "ledger": 1234567,
  "txHash": "a1b2c3d4e5f6...",
  "timestamp": "2026-09-27T12:00:00.000Z",
  "correlationId": "op_release_001",
  "payload": { ... }
}
```

---

## 3. Topic Payloads

### 3.1 `deposit`
Emitted when funds are locked into escrow for a student.
- `payer`: Stellar public key of the depositor / parent.
- `studentId`: Student identifier.
- `schoolId`: School tenant identifier.
- `asset`: `{ code, type, issuer }`.
- `amountStroops`: Exact integer stroops as a string/number.
- `amountDecimal`: Exact 7-decimal representation string.
- `memo`: Stellar memo text.

### 3.2 `release`
Emitted when escrowed funds are released to the school.
- `beneficiary`: School wallet destination.
- `studentId`: Student identifier.
- `schoolId`: School tenant identifier.
- `asset`: `{ code, type, issuer }`.
- `amountStroops`: Released amount in stroops.
- `amountDecimal`: Human-readable 7-decimal string.
- `authorizedBy`: Operator or contract administrator address.

### 3.3 `refund`
Emitted when funds are refunded back to the payer.
- `recipient`: Destination refund wallet address.
- `studentId`: Student identifier.
- `schoolId`: School tenant identifier.
- `asset`: `{ code, type, issuer }`.
- `amountStroops`: Refund amount in stroops.
- `amountDecimal`: Human-readable 7-decimal string.
- `reason`: Explanation for refund.
- `authorizedBy`: Authorizing identity.

### 3.4 `dispute`
Emitted when a dispute is opened, updated, or settled.
- `disputeId`: Unique dispute identifier.
- `studentId`: Student identifier.
- `schoolId`: School tenant identifier.
- `initiator`: Dispute filer address.
- `status`: `'opened'` | `'under_review'` | `'resolved_refund'` | `'resolved_release'` | `'dismissed'`.
- `amountStroops`: Disputed amount in stroops.
- `amountDecimal`: 7-decimal string.
- `reason`: Dispute grounds.

---

## 4. Idempotent Indexer Guidelines

Indexers maintaining projections must:
1. Maintain a persistent set or index of processed `eventId` values.
2. If `eventId` is already present in the store, acknowledge the event immediately as a no-op without mutating projection balances.
3. Validate `eventVersion` — reject unsupported major versions while tolerating additive non-breaking fields in minor/patch versions.
