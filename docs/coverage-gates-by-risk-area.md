# Coverage Gates by Risk Area — Issue #100

> Implements focused coverage thresholds for financial, security-critical,
> and integration-critical modules where a regression carries the highest risk.

## Rationale

Global coverage thresholds hide dangerous gaps in the most critical modules.
A module at 90 % global coverage can still have 0 % coverage in
`backend/src/services/stellarService.js` (payment validation) or
`backend/src/middleware/auth.js` (authentication).

This document defines per-risk-area thresholds versioned alongside the code.
Any change that lowers a threshold MUST include a justification in the PR
description and MUST open a follow-up issue to restore it.

---

## Risk areas and thresholds

### 1. Payment state transitions (`backend/src/services/`)

Financial correctness — wrong payment status transitions result in under/
over-charging students and broken reconciliation.

| Metric     | Threshold | Rationale |
|------------|-----------|-----------|
| branches   | 45 %      | Baseline; raise to 70 % by Q2 |
| functions  | 51 %      | Baseline; raise to 70 % by Q2 |
| lines      | 53 %      | Baseline; raise to 70 % by Q2 |
| statements | 52 %      | Baseline; raise to 70 % by Q2 |

Configured in: `package.json` → `coverageThreshold["./backend/src/services/"]`

### 2. Authentication & authorisation (`backend/src/middleware/`)

Security-critical — bugs here allow unauthorised access to payment data.

| Metric     | Threshold | Rationale |
|------------|-----------|-----------|
| branches   | 45 %      | Baseline; raise to 75 % by Q2 |
| functions  | 42 %      | Baseline; raise to 65 % by Q2 |
| lines      | 52 %      | Baseline; raise to 70 % by Q2 |
| statements | 50 %      | Baseline; raise to 70 % by Q2 |

Configured in: `package.json` → `coverageThreshold["./backend/src/middleware/"]`

### 3. Controllers — payment & auth (`backend/src/controllers/`)

API surface — incorrect error handling or missing input validation at the
controller level leaks internal errors and allows malformed state.

| Metric     | Threshold | Rationale |
|------------|-----------|-----------|
| branches   | 32 %      | Baseline; raise to 60 % by Q2 |
| functions  | 32 %      | Baseline; raise to 60 % by Q2 |
| lines      | 37 %      | Baseline; raise to 60 % by Q2 |
| statements | 36 %      | Baseline; raise to 60 % by Q2 |

Configured in: `package.json` → `coverageThreshold["./backend/src/controllers/"]`

### 4. Webhook delivery (`backend/src/services/webhookService.js` via services/)

Contract integration — webhook delivery failures mean downstream systems
miss payment events; HMAC signing errors expose replay attack vectors.

Covered by the services-level threshold (item 1) until a dedicated threshold
is warranted (tracked in: issue #100).

### 5. Reconciliation (`backend/src/services/`)

Financial correctness — reconciliation failures result in students being
marked unpaid when they have paid (or vice-versa).

Covered by the services-level threshold (item 1) until a dedicated threshold
is warranted (tracked in: issue #100).

---

## How CI reports each risk area

The `coverage` CI job (`.github/workflows/ci.yml`) runs:

```bash
npm run coverage        # backend (root Jest config)
npm run coverage:frontend  # frontend
```

Jest's `--coverage` flag collects per-file metrics.  The `coverageThreshold`
entries in `package.json` are evaluated directory-by-directory; Jest exits
non-zero if any threshold is breached.

The `ci-gate` job depends on `coverage`, so a threshold breach blocks the PR
via the single required status check **"CI gate"**.

Coverage artefacts are uploaded as GitHub Actions artefacts
(`coverage-backend`, `coverage-frontend`) with 14-day retention so reviewers
can inspect exactly which lines were missed.

---

## Exclusions

Excluded from coverage collection (`collectCoverageFrom` in `package.json`):

| Pattern | Reason |
|---------|--------|
| `backend/src/**/*.test.js` | Test files — not production code |
| `backend/src/**/__tests__/**` | Test helpers |

Any **new exclusion** requires an explanation in the PR that introduces it,
referencing this document.  Blanket exclusions of entire modules are not
acceptable without an explicit architectural decision record.

---

## Adding a new risk-area threshold

1. Measure current coverage for the target path:

   ```bash
   npm run coverage -- \
     --collectCoverageFrom='backend/src/services/stellarService.js' \
     --coverageReporters=text-summary
   ```

2. Round each metric **down** to the nearest whole number.

3. Add an entry to `package.json → jest.coverageThreshold`:

   ```json
   "./backend/src/services/stellarService.js": {
     "branches":   42,
     "functions":  55,
     "lines":      60,
     "statements": 59
   }
   ```

4. Document it in this file with the rationale and target.

5. Open a follow-up issue to raise the threshold to ≥ 80 % in future sprints.

---

## Threshold ladder

Thresholds must only go **up**.  Lower thresholds require an explicit decision
logged in the PR description and a follow-up issue to restore them.

| Sprint  | Target                                      |
|---------|---------------------------------------------|
| Now     | Baseline values above (see table per area)  |
| +1      | +5 pp per area                              |
| +2      | +5 pp per area                              |
| Long-term | ≥ 80 % globally across all risk areas    |
