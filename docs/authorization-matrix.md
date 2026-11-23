# Authorization Matrix

Single authoritative reference for authentication level, role requirements, and ownership constraints for every protected endpoint in PaymentFlow.

---

## Auth Levels

| Level | Middleware | Description |
|-------|-----------|-------------|
| `SUPER_ADMIN` | `requireAdminAuth` | Global administrator. Accepts tokens with `role:'admin'` or `roles:['super_admin']`. Not restricted to a single school. |
| `SCHOOL_ADMIN` | `requireSchoolAuth(roles)` | Tenant-scoped. Token `schoolId` must match `X-School-ID` request header. Optional per-group role restriction. |
| `PUBLIC` | none | No authentication required. |

**Super-admin bypass**: a valid `SUPER_ADMIN` token can reach any `SCHOOL_ADMIN` endpoint without a matching `X-School-ID`. This is the break-glass path for cross-school operations.

---

## Ownership Check Policy

When **Ownership Check = Yes**, the controller must verify that the target resource (student, payment, fee structure) belongs to `req.schoolId` **before** performing any mutation. The auth middleware enforces tenant isolation at the token level; controllers enforce resource-level ownership.

---

## Endpoint Matrix

### Super-Admin: Runtime Administration (`/api/admin/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `POST` | `/api/admin/log-level` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/webhooks/dlq` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `POST` | `/api/admin/webhooks/dlq/:id/retry` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `POST` | `/api/admin/webhooks/:id/replay` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/pending-verifications/backlog` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/pending-verifications/dead-letter` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/pending-verifications/:id` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `POST` | `/api/admin/pending-verifications/:id/retry` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/payment-limits` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `PUT` | `/api/admin/payment-limits` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `DELETE` | `/api/admin/payment-limits/:schoolId` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/retry-queue/failed` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/retry-queue/failed/:jobId` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `POST` | `/api/admin/retry-queue/failed/:jobId/retry` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `DELETE` | `/api/admin/retry-queue/failed/:jobId` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/retry-queue/stats` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/outbox/dead-letter` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/outbox/dead-letter/:eventId` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `POST` | `/api/admin/outbox/dead-letter/:eventId/replay` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `DELETE` | `/api/admin/outbox/dead-letter/:eventId` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/outbox/stats` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/consistency` | SUPER_ADMIN | admin, super_admin | Yes | No |

---

### Super-Admin: Audit Logs (`/api/audit/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `GET` | `/api/audit` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/audit/recent` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/audit/export` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/audit/verify-chain` | SUPER_ADMIN | admin, super_admin | Yes | No |

---

### Students (`/api/students/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `POST` | `/api/students` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/students/bulk` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/students` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/students/export` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/students/:studentId` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `PUT` | `/api/students/:studentId` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `DELETE` | `/api/students/:studentId` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/students/:studentId/restore` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/students/:studentId/payments/audit` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/students/:studentId/reset-payment` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/students/:studentId/reconcile` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/students/:studentId/credit-adjustments` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/students/:studentId/fee-history` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/students/public/:studentId` | PUBLIC | — | Yes | No |

---

### Fee Structures (`/api/fees/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `POST` | `/api/fees` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `GET` | `/api/fees` | SCHOOL_ADMIN | any | No | No |
| `GET` | `/api/fees/:className` | SCHOOL_ADMIN | any | No | No |
| `PUT` | `/api/fees/:className` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `DELETE` | `/api/fees/:className` | SUPER_ADMIN | admin, super_admin | No | Yes |

---

### Payments (`/api/payments/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `GET` | `/api/payments/verify/:txHash` | PUBLIC | — | Yes | No |
| `POST` | `/api/payments/verify` | PUBLIC | — | Yes | No |
| `POST` | `/api/payments/intent` | PUBLIC | — | Yes | No |
| `POST` | `/api/payments/submit` | PUBLIC | — | Yes | No |
| `GET` | `/api/payments` | SCHOOL_ADMIN | any | No | Yes |
| `GET` | `/api/payments/:studentId` | SCHOOL_ADMIN | any | No | Yes |
| `GET` | `/api/payments/overpayments` | SCHOOL_ADMIN | any | No | Yes |
| `GET` | `/api/payments/pending` | SCHOOL_ADMIN | any | No | Yes |
| `GET` | `/api/payments/suspicious` | SCHOOL_ADMIN | any | No | Yes |
| `POST` | `/api/payments/sync` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/payments/finalize` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `PATCH` | `/api/payments/:txHash/status` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `PATCH` | `/api/payments/bulk/status` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `PATCH` | `/api/payments/:txHash/suspicion-review` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/payments/:txHash/refund` | SUPER_ADMIN | admin, super_admin | No | Yes |

---

### Disputes (`/api/disputes/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `POST` | `/api/disputes` | PUBLIC (school context) | — | No | No |
| `GET` | `/api/disputes` | PUBLIC (school context) | — | No | No |
| `GET` | `/api/disputes/:id` | PUBLIC (school context) | — | No | No |
| `PATCH` | `/api/disputes/:id/resolve` | SUPER_ADMIN | admin, super_admin | No | Yes |
| `POST` | `/api/disputes/:id/evidence` | SUPER_ADMIN | admin, super_admin | No | Yes |

---

### Reports (`/api/reports/*`)

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `GET` | `/api/reports` | SCHOOL_ADMIN | owner, finance | No | No |
| `GET` | `/api/reports/dashboard` | SCHOOL_ADMIN | owner, finance | No | No |
| `GET` | `/api/reports/jobs/:jobId` | SCHOOL_ADMIN | owner, finance | No | No |
| `GET` | `/api/reports/jobs/:jobId/download` | SCHOOL_ADMIN | owner, finance | No | No |

---

## Error Response Contract

All auth failures return a consistent `{ error: string, code: string }` JSON body:

| Scenario | HTTP Status | Code |
|----------|------------|------|
| No token provided | `401` | `MISSING_AUTH_TOKEN` |
| Token expired | `401` | `TOKEN_EXPIRED` |
| Invalid / malformed token | `401` | `INVALID_AUTH_TOKEN` |
| IP temporarily blocked | `429` | `IP_BLOCKED` |
| Insufficient role | `403` | `INSUFFICIENT_ROLE` |
| Token not scoped to a school | `403` | `MISSING_TENANT_CLAIM` |
| Token schoolId ≠ X-School-ID | `403` | `TENANT_MISMATCH` |
| MFA setup required | `403` | `MFA_SETUP_REQUIRED` |

---

## Cross-School Access Prevention

The `requireSchoolAuth` middleware enforces tenant isolation automatically:

1. The JWT `schoolId` claim is compared to the `X-School-ID` request header.
2. A mismatch returns `403 TENANT_MISMATCH` before the controller runs.
3. Controllers receive `req.schoolId` populated from the **token** (not the header) and must use it for all database queries to prevent data leakage.
4. Super-admin tokens (`role:'admin'` or `roles:['super_admin']`) bypass the schoolId check — this is the intentional break-glass path.

---

## Implementation References

| Component | File |
|-----------|------|
| Auth middleware | `backend/src/middleware/auth.js` |
| Authorization matrix module | `backend/src/middleware/authorizationMatrix.js` |
| Admin routes | `backend/src/routes/adminRoutes.js` |
| Student routes | `backend/src/routes/studentRoutes.js` |
| Payment routes | `backend/src/routes/paymentRoutes.js` |
| Fee routes | `backend/src/routes/feeRoutes.js` |
| Dispute routes | `backend/src/routes/disputeRoutes.js` |
| Audit routes | `backend/src/routes/auditRoutes.js` |
| Report routes | `backend/src/routes/reportRoutes.js` |

---

### Reconciliation Admin (`/api/admin/reconciliation/*`)

> Added in Issue #283.

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `POST` | `/api/admin/reconciliation/run` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `GET` | `/api/admin/reconciliation` | SUPER_ADMIN | admin, super_admin | Yes | No |
| `PATCH` | `/api/admin/reconciliation/:id` | SUPER_ADMIN | admin, super_admin | Yes | No |

---

### Analytics (`/api/analytics/*`)

> Added in Issue #283.

| Method | Endpoint | Auth Level | Roles | Cross-School | Ownership Check |
|--------|----------|-----------|-------|-------------|----------------|
| `GET` | `/api/analytics` | SCHOOL_ADMIN | owner, finance | No | No |
| `GET` | `/api/analytics/summary` | SCHOOL_ADMIN | owner, finance | No | No |

---

## Role Enforcement Middleware (Issue #283)

Two new middleware helpers complement the existing auth middleware:

### `requireRole(...roles)`

File: `backend/src/middleware/requireRole.js`

Enforces explicit role requirements **after** `requireAdminAuth` or
`requireSchoolAuth` has run.  If the authenticated user does not hold any of the
listed roles, the request is rejected with `403 INSUFFICIENT_ROLE`.

```js
const { requireRole } = require('../middleware/requireRole');

// Only owner or finance may generate reports
router.get('/reports', requireSchoolAuth(), requireRole('owner', 'finance'), handler);
```

**Super-admin bypass**: tokens with `role: 'admin'` or `roles: ['super_admin']`
always pass.

### `assertTenantScope`

File: `backend/src/middleware/tenantIsolation.js`

Defence-in-depth layer that verifies the school in the URL/body matches the
token's `schoolId` claim, preventing a correctly-authenticated user from acting
on a resource belonging to a different school.

```js
const { assertTenantScope } = require('../middleware/tenantIsolation');

router.get('/students', requireSchoolAuth(), assertTenantScope, handler);
```

Returns `403 TENANT_ISOLATION_VIOLATION` on a cross-tenant attempt.

---

## Cross-Tenant Isolation

Cross-tenant data access is prevented at three levels:

1. **Token level** (`requireSchoolAuth`): JWT `schoolId` must match the
   `X-School-ID` header.  Mismatch → `403 TENANT_MISMATCH`.
2. **Resource level** (`assertTenantScope`): schoolId in URL params / body must
   match the token claim.  Mismatch → `403 TENANT_ISOLATION_VIOLATION`.
3. **Query level** (controllers): every database query includes `schoolId`
   from `req.schoolId` (set from the token, not the request) as an equality
   filter.  This is enforced by the `tenantScope` Mongoose plugin and
   documented in the ownership-check column of the matrix above.

All three layers must be satisfied for a request to succeed.

---

## Testing the Authorization Matrix

The `flattenMatrix()` function exported from `authorizationMatrix.js` returns a
flat list of every endpoint with its auth config.  Use it in test suites to
enumerate all endpoints and assert that the correct middleware is registered:

```js
const { flattenMatrix } = require('../src/middleware/authorizationMatrix');

test('all SUPER_ADMIN endpoints are protected', () => {
  const endpoints = flattenMatrix().filter(e => e.authLevel === 'SUPER_ADMIN');
  // For each endpoint, verify the route stack in the Express app includes requireAdminAuth
  for (const ep of endpoints) {
    // ... assert middleware presence
  }
});
```

The `validateMatrix()` function checks the matrix for structural correctness
(all required fields present, valid auth levels, valid HTTP methods):

```js
const { validateMatrix } = require('../src/middleware/authorizationMatrix');
test('authorization matrix is valid', () => {
  expect(validateMatrix()).toBe(true);
});
```

---

## Updated Error Response Contract

| Scenario | HTTP Status | Code |
|----------|------------|------|
| No token provided | `401` | `MISSING_AUTH_TOKEN` |
| Token expired | `401` | `TOKEN_EXPIRED` |
| Invalid / malformed token | `401` | `INVALID_AUTH_TOKEN` |
| IP temporarily blocked | `429` | `IP_BLOCKED` |
| Insufficient role (`requireRole`) | `403` | `INSUFFICIENT_ROLE` |
| Token not scoped to a school | `403` | `MISSING_TENANT_CLAIM` |
| Token schoolId ≠ X-School-ID | `403` | `TENANT_MISMATCH` |
| Cross-tenant resource access | `403` | `TENANT_ISOLATION_VIOLATION` |
| MFA setup required | `403` | `MFA_SETUP_REQUIRED` |
