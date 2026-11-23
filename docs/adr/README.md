# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for PaymentFlow.
Each ADR captures the context, decision, alternatives considered, and
consequences for a significant architectural or design choice.

## Format

Each ADR follows this structure:

| Section | Content |
|---------|---------|
| **Status** | Proposed / Accepted / Deprecated / Superseded |
| **Date** | Date the decision was accepted |
| **Review date** | When the decision should be re-evaluated |
| **Authors** | Team or individuals responsible |
| **Code references** | Source files that implement or depend on this decision |
| **Context** | Why the decision was needed |
| **Decision** | What was decided |
| **Alternatives considered** | What was evaluated and why it was rejected |
| **Consequences** | Positive and negative outcomes |
| **Review criteria** | Conditions that would trigger revisiting the decision |

## Index

| ADR | Title | Status | Review date |
|-----|-------|--------|-------------|
| [ADR-001](./ADR-001-payment-provider-selection.md) | Payment Provider Selection — Stellar Network | Accepted | 2027-01-15 |
| [ADR-002](./ADR-002-timeout-retry-semantics.md) | Timeout and Retry Semantics for Payment Verification | Accepted | 2027-03-01 |
| [ADR-003](./ADR-003-webhook-ownership-hmac-signing.md) | Webhook Ownership and HMAC Signing | Accepted | 2027-05-10 |
| [ADR-004](./ADR-004-failover-boundaries.md) | Failover Boundaries for the Stellar Horizon Integration | Accepted | 2027-07-20 |

## How to propose a new ADR

1. Copy an existing ADR as a template.
2. Assign the next sequential number (`ADR-00N`).
3. Fill in all sections; set **Status** to `Proposed`.
4. Open a pull request. The PR description should link to any related issues.
5. After team review and approval, change **Status** to `Accepted` and merge.

## Superseding an ADR

If a decision changes:
1. Create a new ADR documenting the new decision.
2. Add a note at the top of the old ADR: `Superseded by [ADR-00N](./ADR-00N-...)`.
3. Change the old ADR's **Status** to `Superseded`.
