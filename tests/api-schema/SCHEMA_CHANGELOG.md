# API Schema Changelog

This file documents every change to the maintained response schemas in
`tests/api-schema/schemas.js`. Any PR that modifies a schema **must** add an
entry here. The `api-schema-regression` CI job enforces this by failing when
a field is present in the schema but absent from the response.

## Review checklist for schema changes

- [ ] Updated `schemas.js` with the new/modified/removed field
- [ ] Added an entry to this file with date, endpoint, field, and migration path
- [ ] Confirmed with the team that no external consumer depends on the removed field
- [ ] Updated `docs/api-spec.md` if this is a public API surface

---

## History

### 2026-09-26 — Initial schema registry (issue #91)

Added baseline schemas for all major endpoints:

| Endpoint | Schema constant | Notes |
|---|---|---|
| `GET /health` | `HEALTH_OK` | `{ status: string }` |
| `POST /api/auth/login` 200 | `AUTH_LOGIN_SUCCESS` | `{ token, user: { id, role, schoolId } }` |
| `POST /api/auth/login` 4xx | `AUTH_ERROR` | `{ error: string }` |
| `GET /api/students` | `STUDENTS_LIST` | `{ students[], total, page, pages }` |
| `GET /api/payments/:studentId` | `PAYMENTS_HISTORY` | `{ payments[], total }` |
| `GET /api/payments/pending` | `PAYMENTS_PENDING` | `{ pending[], count, pagination: { page, limit, total, totalPages, hasNext, hasPrev } }` |
| `GET /api/payments/overpayments` | `PAYMENTS_OVERPAYMENTS` | `{ overpayments[], total }` |
| `GET /api/fees` | `FEES_LIST` | `{ fees[] }` |
| `GET /api/reports` | `REPORTS_SUCCESS` | `{ summary: object, payments[] }` |
| `GET /api/audit` | `AUDIT_LOGS` | `{ logs[], total, page, limit, pages }` |
| `GET /api/disputes` | `DISPUTES_LIST` | `{ disputes[] }` |
| All 4xx responses | `ERROR_SHAPE` | `{ error: string }` |
