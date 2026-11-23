# UX Review Checklist for Financial Actions

## Purpose

This checklist must be attached to every pull request that touches a page or component involved in a financial action — payments, fee adjustments, refunds, disputes, payment plan modifications, or any operation with monetary or irreversible consequences.

**When to use:** Copy this checklist into your PR description and check off each item before requesting review. Mark items `N/A` (with a brief reason) only when the [Not Applicable](#not-applicable-guidance) guidance below explicitly allows it.

Reviewers should not approve a PR where unchecked items lack a documented `N/A` justification.

---

## 1. Clarity

The user must understand exactly what they are about to do and what the consequences are before they act.

- [ ] The action is described in plain language — no jargon, no ambiguous labels (e.g., "Submit Payment of 250 XLM to School Wallet" not just "Submit").
- [ ] The full amount and currency/asset are visible on the confirmation screen (e.g., "250 XLM" or "100.00 USDC" — never bare numbers without units).
- [ ] The destination (school name, wallet address prefix) is shown before the user confirms.
- [ ] Consequences of the action are stated where relevant (e.g., "This payment is final and cannot be reversed on-chain.").
- [ ] If the action affects multiple students or records, the count and scope are explicitly stated.

---

## 2. Confirmation

Destructive or irreversible actions must require a deliberate, separate confirmation step.

- [ ] Any action that cannot be undone (payment submission, dispute resolution, fee structure deletion) requires an explicit confirmation step beyond the initial form submit.
- [ ] The confirmation step is visually distinct from the form — it is a separate modal, page, or clearly bounded review panel, not just a second click on the same button.
- [ ] The confirmation shows a summary of what will happen: amount, recipient, student ID, and asset.
- [ ] Bulk actions (bulk student import, mass reminder send) show a count and allow the user to cancel before proceeding.
- [ ] Cancellation is always possible up until the point of irreversible submission, and the cancel control is equally prominent as confirm.

---

## 3. Error Recovery

Errors should never leave the user stuck or force them to restart a flow from scratch.

- [ ] Every error state displays a human-readable message explaining what went wrong (e.g., "Payment not found on-chain — the transaction hash may be incorrect."), not a raw error code.
- [ ] Each error message includes a specific next step or action the user can take (e.g., "Check the transaction hash on Stellar Expert, then retry." or "Contact support with reference #XYZ.").
- [ ] On error, form fields retain previously entered values so the user does not need to re-enter data.
- [ ] Partial failures (e.g., one student in a bulk import failed) are clearly distinguished from full failures — the UI shows which records succeeded and which failed.
- [ ] Network or timeout errors trigger a retry option, not just a generic failure screen.
- [ ] Validation errors are shown inline, adjacent to the relevant field, not only at the top of the form.

---

## 4. Accessibility

All users, including those relying on assistive technology, must be able to complete financial flows independently.

- [ ] Every interactive element (button, input, link, toggle) has an accessible label — either visible text, `aria-label`, or `aria-labelledby`. Labels are verified with a screen reader or automated tool (e.g., axe, Lighthouse).
- [ ] Status indicators (payment verified ✓, payment failed ✗, pending ⏳) use text or iconography in addition to color — color is never the sole differentiator.
- [ ] Focus is managed correctly: after a modal opens, focus moves to the modal; after it closes, focus returns to the triggering element.
- [ ] The entire flow is keyboard-navigable: all actions can be triggered with `Tab`, `Enter`, and `Escape` alone.
- [ ] Dynamic content changes (payment status updates via SSE, inline validation messages) are announced to screen readers via `aria-live` regions.
- [ ] Touch targets for mobile are at least 44×44 px.

---

## 5. Localization

Monetary and temporal data must be rendered correctly for the user's locale and timezone.

- [ ] Monetary amounts are formatted using the browser/user locale (e.g., `Intl.NumberFormat`) — decimal separators, thousands separators, and currency symbols are locale-correct.
- [ ] Currency and asset codes are always shown alongside amounts (e.g., "250 XLM", "100.00 USDC") and are not reliant on page context alone.
- [ ] All date and time values (payment timestamps, due dates, audit log entries) are displayed in the user's local timezone with the offset or timezone name shown.
- [ ] Error and status messages are sourced from translatable strings — no hardcoded English copy in component logic.
- [ ] Layouts do not break under RTL text direction; flex/grid directions and text alignment are logical, not physical, where they affect meaning.

---

## 6. Audit Expectations

Every financial action must leave a verifiable, tamper-evident record.

- [ ] The action generates an audit log entry in the backend `AuditLog` collection — confirmed by checking `backend/src/services/auditService.js` is called in the relevant controller/service.
- [ ] The audit entry records the actor: authenticated user ID, role (admin/parent), and school tenant ID.
- [ ] The audit entry records the full outcome — success with result details, or failure with error reason.
- [ ] The audit entry includes a timestamp, resource type, resource ID, and the action performed.
- [ ] Audit entries are immutable after creation — no update or delete path exists for audit records in the data model.
- [ ] The UI for admins surfaces the audit trail for the affected record (student payment history, dispute log) so changes are visible without needing database access.

---

## 7. Security

The UI must not expose data beyond what is necessary, and must enforce the correct authentication level.

- [ ] The page/action is protected by the appropriate authentication guard — admin-only actions cannot be reached by parent-role sessions.
- [ ] Sensitive operations (fee structure changes, admin creation, dispute resolution) are gated behind step-up authentication where required by the backend.
- [ ] Wallet addresses and transaction hashes are truncated in display (e.g., `GABCD...WXYZ`) with a copy-to-clipboard affordance for the full value — they are never rendered in full in page text by default.
- [ ] The UI does not expose other tenants' data — school IDs, wallet addresses, and student records are scoped to the authenticated school.
- [ ] API responses are not forwarded verbatim to the UI if they contain fields beyond what the component needs (e.g., internal IDs, raw DB objects).
- [ ] Error messages do not leak implementation details (stack traces, internal error codes, DB field names) to the end user.

---

## Examples

### ✅ Acceptable: Payment Confirmation Dialog

```
┌─────────────────────────────────────────────┐
│  Confirm Payment                            │
│                                             │
│  Student:      Jane Doe (STU-042)           │
│  Amount:       250 XLM                      │
│  Destination:  Greenwood Academy            │
│                (GSCHOOL...3XYZ)             │
│  Memo:         STU-042                      │
│                                             │
│  ⚠️  Blockchain payments are irreversible.  │
│                                             │
│  [ Cancel ]          [ Confirm Payment ]    │
└─────────────────────────────────────────────┘
```

Key points: amount + asset, destination with truncated address, student ID, irreversibility warning, and equal-weight cancel/confirm controls.

---

### ✅ Acceptable: Inline Validation Error

```
Transaction Hash *
[ abc123xyz...                        ]
  ✖ Transaction not found on Stellar testnet.
    Verify the hash at stellar.expert, then retry.
```

Key points: error adjacent to the field, message explains what's wrong, provides a next step.

---

### ❌ Unacceptable: Bare Confirmation

```
Are you sure?   [ OK ]
```

Missing: amount, asset, destination, consequence statement, and a meaningful cancel path.

---

### ❌ Unacceptable: Error without Action

```
Error: TX_FAILED
```

Missing: plain-language explanation, next step for the user.

---

## Tracking Findings

When a checklist item cannot be checked off:

1. **Do not merge** until the item is resolved or formally waived.
2. **Open a GitHub issue** for each unchecked item using the label `ux-debt`:
   - Title: `[UX] <Component>: <short description of the gap>` (e.g., `[UX] PaymentConfirmModal: wallet address shown in full`)
   - Body: reference this checklist section, describe the observed behaviour, and the expected behaviour.
   - Link the new issue in the PR description under a **"UX Findings"** heading.
3. **Waivers**: if a finding is accepted as out-of-scope for this PR, add a comment in the PR with the issue number and the approving reviewer's sign-off. The linked issue must still be open and tracked.

Example PR description entry:

```
## UX Findings
- [ ] #234 — Wallet address displayed in full (Security §7, item 3)
```

---

## Not Applicable Guidance

Mark a section `N/A` only when **all** of the following are true. Include a one-line reason in the PR.

| Section | Skip when… |
|---|---|
| **Clarity** | The PR contains no user-facing copy or UI changes. |
| **Confirmation** | The action is fully reversible and has no monetary consequence (e.g., updating a display name). |
| **Error Recovery** | The PR contains no form inputs or submission paths. |
| **Accessibility** | The PR is backend-only with zero frontend changes. |
| **Localization** | The PR contains no user-facing strings, amounts, or timestamps. |
| **Audit Expectations** | The PR touches only read-only views with no state-changing actions. |
| **Security** | The PR is a documentation or test-only change. |

When in doubt, keep the section and check the boxes — it takes less time than a post-merge finding.
