## Summary

<!-- One paragraph explaining what this PR does and why. Link to the GitHub issue. -->

Closes #

---

## Changes

<!-- List the key files changed and what each change does. -->

-
-

---

## Testing

<!-- Describe what you tested and how. -->

- [ ] Unit tests added / updated
- [ ] Integration tests pass locally
- [ ] Manual smoke test performed

---

## Migration Checklist

<!-- Complete this section if this PR adds or modifies a file in backend/migrations/. -->
<!-- If no migration changes, delete this section or leave all boxes unchecked. -->

- [ ] **This PR does not include a migration** *(delete remaining items if so)*
- [ ] Migration filename follows `NNN_short_description.js` with a unique, sequential number
- [ ] `version` export matches the filename exactly (without `.js`)
- [ ] `up()` function is implemented and idempotent (safe to run twice)
- [ ] `down()` function is implemented — see [`docs/migrations.md`](../docs/migrations.md) for requirements
- [ ] Large backfills use cursor-based batching (not a single `updateMany` over millions of docs)
- [ ] Index creation wraps `createIndex` in a try/catch for error codes 85 and 86
- [ ] No plaintext PII, passwords, or secret values are logged inside the migration
- [ ] Migration does not read environment variables that are not available in CI
- [ ] `node scripts/validate-migrations.js` passes with no errors
- [ ] Migration has been tested locally with `node scripts/migrate.js`
- [ ] Rollback (`down()`) has been tested locally

---

## Security

<!-- Check any that apply. -->

- [ ] No secrets, keys, or tokens are introduced or logged
- [ ] Input validation is applied to any new API parameters
- [ ] No new admin-only routes are exposed without authentication

---

## Documentation

- [ ] README or relevant docs updated (if user-facing behaviour changed)
- [ ] `[Unreleased]` section in `CHANGELOG.md` updated

---

<!-- ──────────────────────────────────────────────────────────────────────
     UI/UX SECTION — complete this block for any PR labelled `ui-ux`.
     Delete this section for PRs that do not touch user-facing screens.
     Full checklist: docs/ux-review-checklist.md
     ────────────────────────────────────────────────────────────────── -->

## UX Review (required for `ui-ux` labelled PRs)

> Complete every item in the checklist below. Check the box only when you have
> verified the criterion — not as a formality. Refer to the full guidance in
> [`docs/ux-review-checklist.md`](docs/ux-review-checklist.md).

### 1. Confirmation Step
- [ ] User sees a clear summary before committing to an irreversible action
- [ ] High-value / destructive actions have a secondary confirmation
- [ ] CTA button copy reflects the specific action (not just "Submit")
- [ ] Cancel / back path is always available

### 2. Error States
- [ ] All API failure cases render a visible, actionable error message
- [ ] 409 Conflict (duplicate submission) handled with a friendly message
- [ ] Validation errors shown inline next to the offending field
- [ ] Error element receives focus for screen reader announcement

### 3. Accessibility
- [ ] All interactive elements are keyboard-navigable
- [ ] Focus management is correct (modals trap focus; trigger regains focus on close)
- [ ] All form fields have associated labels
- [ ] Status messages use `role="alert"` or `role="status"`
- [ ] Color is not the sole means of conveying information
- [ ] Text contrast meets WCAG AA (≥ 4.5:1)
- [ ] Tested with a screen reader (VoiceOver / NVDA)

### 4. Mobile / Responsive
- [ ] Usable on a 375 px wide viewport without horizontal scrolling
- [ ] Touch targets ≥ 44 × 44 px
- [ ] Long strings (addresses, hashes) break or truncate gracefully

### 5. Copy & Financial Language
- [ ] Amounts formatted consistently with explicit units (e.g. `250 XLM`)
- [ ] Plain language — no unexplained financial jargon
- [ ] All user-visible strings present in every supported locale (`en`, `fr`)

### 6. Undo / Reversal Path
- [ ] Irreversible actions carry a warning before the user commits
- [ ] Reversal path (dispute / refund) is surfaced on the payment record

### UX Sign-off
| Role | Name | Approved |
|------|------|---------|
| UX Designer | | ☐ |
| Accessibility Lead | | ☐ |

Closes #
