# ADR-004: Multi-Tenancy Isolation Approach

**Status:** Accepted
**Date:** 2024-04-20
**Authors:** PaymentFlow Core Team

---

## Context

StellarEduPay serves multiple schools on a single platform. Each school is a distinct tenant with:
- Its own set of students and fee structures
- Its own Stellar wallet address
- Its own admin user(s)
- Its own webhook configuration and secrets
- Strict confidentiality requirements: one school must never be able to read or write another school's data

The platform must prevent cross-tenant data leakage — both accidentally (a bug exposing wrong tenant's data in a list query) and deliberately (a malicious admin probing other schools' student records).

### Requirements

1. All data reads/writes must be automatically scoped to the authenticated school.
2. A single missed `schoolId` filter in any query must not expose cross-tenant data.
3. New developers should not need to remember to add tenant scope to every query.
4. Each tenant's Stellar wallet and webhook secret must be logically and cryptographically isolated.
5. The isolation mechanism must be testable and auditable.

### Alternatives Evaluated

| Approach | Isolation Level | Dev Ergonomics | Operational Complexity | Verdict |
|----------|----------------|----------------|----------------------|---------|
| **Database-per-tenant** | Strongest | Poor (separate connections per request) | High (N databases to operate, back up, migrate) | Too operationally expensive at current scale |
| **Schema-per-tenant** (MongoDB collection prefix) | Strong | Poor (dynamic collection names) | Medium | Not idiomatic in Mongoose; hard to query across tenants |
| **`schoolId` field with Mongoose plugin** | Good (application-enforced) | Excellent (transparent) | Low | **Chosen** |
| Row-level security (PostgreSQL RLS) | Strong (database-enforced) | Good | Medium | Would require switching to PostgreSQL |
| Application-level middleware guard | Good | Medium | Low | Manual; easy to forget on new routes |

### Considered Risk: Mongoose Plugin vs Database RLS

A Mongoose plugin operates at the application layer, not the database layer. A query built outside the plugin (e.g. a raw `db.payments.find({})` in a migration script) bypasses it. This is an accepted tradeoff:

- Migration scripts operate on controlled infrastructure, not user-facing paths.
- The `tenantScope` plugin covers all Mongoose `find`, `findOne`, `findOneAndUpdate`, `update`, `updateMany`, `count`, `countDocuments`, `aggregate` operations.
- Cross-tenant access tests (`tests/cross-tenant-access.test.js`, `tests/issues-904-tenant-isolation.test.js`) provide regression coverage.

## Decision

Implement **application-level tenant isolation via a Mongoose plugin (`tenantScope`)**. The plugin is applied to all multi-tenant models and automatically injects the `schoolId` filter on every query using the authenticated school context from the request.

Key implementation details:
- `backend/src/plugins/tenantScope.js` — the plugin itself
- Every model that holds tenant-scoped data applies `schema.plugin(tenantScope, { modelName: '...' })`
- The authenticated school context is carried in `req.schoolId` (set by `requireAdminAuth` middleware) and thread-locally available via `AsyncLocalStorage` for service-layer calls not directly tied to an HTTP request
- Webhook secrets are additionally encrypted per-school at rest; a database dump does not expose another school's secret in plaintext

### Models with tenantScope applied

- `Payment` — schoolId scoped
- `Student` — schoolId scoped
- `FeeStructure` — schoolId scoped
- `FeeAdjustmentRule` — schoolId scoped
- `PaymentPlan` — schoolId scoped
- `Dispute` — schoolId scoped
- `AuditLog` — schoolId scoped
- `WebhookDelivery` — schoolId scoped
- `ReminderLog` — schoolId scoped
- `SourceValidationRule` — schoolId scoped (migration 020)

### Models without tenantScope (intentionally cross-tenant)

- `School` — the tenant registry itself; access controlled by `requireAdminAuth`
- `User` — global admin users; access controlled by JWT
- `IdempotencyKey` — global deduplication; scoped by `txHash` which embeds schoolId semantically
- `Migration` — infrastructure-level; no schoolId concept

## Consequences

**Positive:**
- New developers writing Mongoose queries against scoped models get tenant isolation automatically.
- Cross-tenant data leakage from a missed `where schoolId = ?` is structurally prevented for all Mongoose query paths.
- A single plugin keeps the implementation DRY and auditable in one place.

**Negative:**
- The plugin is a Mongoose-level control, not a database-level control. Raw MongoDB queries (migrations, one-off scripts) bypass it.
- If the `AsyncLocalStorage` context is lost (e.g. in a callback that crosses a worker thread boundary), the plugin may receive an undefined `schoolId` and either fail closed (throws) or requires explicit override. Current implementation throws on undefined context, which is the safer behavior.
- Aggregation pipelines require a manual `$match: { schoolId }` as the first stage — the plugin's auto-injection is less reliable across all aggregation patterns. Controllers that use aggregations must be audited manually.

**Security controls:**
- Integration tests in `tests/cross-tenant-access.test.js` assert that admin JWTs for School A cannot retrieve records belonging to School B across all major entity types.
- The tenantScope plugin logs a warning (level `warn`) when it detects a query running without a school context — this surfaces misconfigured service calls in logs during development.

---

## References

- Tenant scope plugin: [`backend/src/plugins/tenantScope.js`](../../backend/src/plugins/tenantScope.js)
- Cross-tenant access tests: [`tests/cross-tenant-access.test.js`](../../tests/cross-tenant-access.test.js)
- Tenant isolation tests: [`tests/issues-904-tenant-isolation.test.js`](../../tests/issues-904-tenant-isolation.test.js)
- Auth middleware: [`backend/src/middleware/`](../../backend/src/middleware/)
