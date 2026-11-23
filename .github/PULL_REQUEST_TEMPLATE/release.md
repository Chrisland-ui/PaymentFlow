## Release PR — Pre-Release Checklist

> **Instructions:** Complete every item below before merging this release. See [docs/release-process.md](../docs/release-process.md) for full details on each step.

---

### Release Type

- [ ] Patch (bug fix, dependency update, config change — no migrations)
- [ ] Minor (new features, additive schema change — reversible migrations)
- [ ] Major (breaking change, destructive schema change — may require forward-fix)

---

### Code Quality

- [ ] All CI checks pass (linting, tests, security audit, secret scan, migration validation)
- [ ] No new high/critical severity dependency vulnerabilities (`npm audit`)
- [ ] CHANGELOG.md updated with an `[Unreleased]` entry

---

### Migrations

- [ ] New migrations in this release (list numbers): _____
- [ ] Migrations tested against a staging database
- [ ] Migrations are idempotent (safe to re-run)
- [ ] Irreversible migrations documented here: _____ *(or N/A)*
- [ ] Migration rollback strategy confirmed (see [Rollback Procedures](../docs/release-process.md#rollback-procedures))

---

### Stellar / Blockchain

- [ ] Payment processing changes tested on **testnet** first *(or N/A)*
- [ ] Backend remains read-only — no private key storage added
- [ ] Fee validation edge cases tested *(or N/A)*

---

### Environment & Configuration

- [ ] New environment variables documented in `README.md` and `.env.example` *(or N/A)*
- [ ] Kubernetes manifests updated if resources or env vars changed *(or N/A)*
- [ ] No secrets committed (CI secret-scan passes)

---

### Observability

- [ ] New features have metrics or log statements *(or N/A)*
- [ ] New alert rules include `runbook_url` annotations *(or N/A)*
- [ ] `docs/observability.md` updated if new alerts/dashboards added *(or N/A)*

---

### Rollback Plan

- [ ] Rollback procedure identified: **code-only** / **reversible migration** / **forward-fix**
- [ ] On-call engineer notified of release window
- [ ] Database snapshot taken immediately before deploy

---

### Post-Deploy (complete after deployment)

- [ ] `GET /health` returns `200 ok` (not unhealthy)
- [ ] Smoke tests passed (see [Post-Deploy Smoke Tests](../docs/release-process.md#post-deploy-smoke-tests))
- [ ] 30-minute monitoring watch period completed with no critical alerts
- [ ] At least one payment successfully processed (or system confirmed healthy)
- [ ] On-call engineer sign-off: @_____

---

### Notes

<!-- Any deviations from the standard process, special considerations, or known issues -->
