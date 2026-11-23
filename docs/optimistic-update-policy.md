# Frontend Optimistic Update Policy

Optimistic updates are limited to reversible, non-financial metadata where the previous value can be restored without changing payment state.

## Allowed

- Student profile fields: name, class, parent email, parent phone, and reminder opt-out preference.
- Future student tags or payment notes may be added only when their mutation follows the same snapshot, rollback, and user-visible failure pattern.

## Disallowed

- Payment amounts, balances, fees, refunds, and payment-plan installment amounts.
- Payment, refund, dispute, or installment status transitions.
- Any operation whose failure could imply funds moved, were received, or were returned.

## Required mutation lifecycle

1. Snapshot the prior values of only the fields being changed.
2. Apply the safe metadata update immediately.
3. On failure, restore the snapshot without overwriting unrelated or financial fields and show an accessible error with the failure reason.
4. On success, reconcile with server data.

The student profile edit follows this policy in the dashboard. It uses the existing API client and local React state because React Query is not a project dependency. Financial and status mutations remain server-confirmed.
