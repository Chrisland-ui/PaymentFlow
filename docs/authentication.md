# Authentication & Authorization Guide

Complete reference for PaymentFlow's authentication model, token lifecycle, role hierarchy, and JWT claim structure.

---

## Table of Contents

- [Overview](#overview)
- [Authentication Flow](#authentication-flow)
  - [Login](#login)
  - [Token Refresh](#token-refresh)
  - [Logout & Session Revocation](#logout--session-revocation)
  - [Session Expiry](#session-expiry)
- [Multi-Factor Authentication (MFA)](#multi-factor-authentication-mfa)
- [JWT Claim Structure](#jwt-claim-structure)
- [Token Lifetime & Storage](#token-lifetime--storage)
- [Role Hierarchy](#role-hierarchy)
- [Endpoint Authentication Requirements](#endpoint-authentication-requirements)
- [Step-Up Authentication](#step-up-authentication)
- [Sending Authenticated Requests](#sending-authenticated-requests)
- [Error Reference](#error-reference)
- [OpenAPI Security Scheme](#openapi-security-scheme)

---

## Overview

PaymentFlow uses **JWT-based authentication** with short-lived access tokens and long-lived refresh tokens. All JWTs are signed with `HMAC-SHA256` using the server-side `JWT_SECRET`.

Key properties:

- Access tokens expire in **8 hours** (configurable via `JWT_EXPIRES_IN`).
- Refresh tokens expire in **30 days** (configurable via `JWT_REFRESH_TOKEN_TTL`).
- Refresh tokens are never stored in plaintext — the server stores only a `SHA-256` hash.
- Tokens are delivered via **HttpOnly cookies** to prevent XSS theft, and also included in the response body for API consumers that cannot use cookies.
- **Token family rotation** detects refresh-token theft: reuse of a superseded token revokes the entire session family.

---

## Authentication Flow

### Login

```
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "your-password"
}
```

**Successful response** (`200 OK`):

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "8h",
  "user": {
    "username": "admin",
    "role": "admin"
  }
}
```

The server also sets two **HttpOnly cookies**:

| Cookie | Contents | SameSite | Secure |
|--------|----------|----------|--------|
| `admin_token` | Access JWT | `Strict` | `true` (production) |
| `refresh_token` | Opaque refresh token | `Strict` | `true` (production) |

#### Login flow diagram

```
Client                          Server
  │                                │
  │── POST /api/auth/login ────────►│
  │   { username, password }        │ 1. Validate credentials (bcrypt)
  │                                 │ 2. Check IP block list
  │                                 │ 3. Check MFA enrollment
  │                                 │ 4. Sign JWT (access token)
  │                                 │ 5. Generate opaque refresh token
  │                                 │ 6. Store SHA-256(refresh) in Redis/memory
  │◄── 200 { token, expiresIn } ───│ 7. Set HttpOnly cookies
  │    Set-Cookie: admin_token      │
  │    Set-Cookie: refresh_token    │
```

#### IP brute-force protection

After **5 consecutive failed authentication attempts** from the same IP within a 5-minute window, that IP is blocked for **15 minutes**. The block is stored in Redis (cluster-wide) when available, or in-process otherwise.

---

### Token Refresh

Exchange a valid refresh token for a new access token and refresh token pair.

```
POST /api/auth/refresh
```

The refresh token is read from the `refresh_token` HttpOnly cookie. No body is required.

**Successful response** (`200 OK`):

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "8h"
}
```

A new `refresh_token` cookie is also set. The old refresh token is immediately invalidated.

#### Token refresh flow

```
Client                          Server
  │                                │
  │── POST /api/auth/refresh ─────►│
  │   Cookie: refresh_token=<tok>  │ 1. Read cookie
  │                                 │ 2. Hash token with SHA-256
  │                                 │ 3. Look up hash in store
  │                                 │ 4. Check family revocation
  │                                 │ 5. Delete old token from store
  │                                 │ 6. Sign new access JWT
  │                                 │ 7. Store new SHA-256(new refresh)
  │◄── 200 { token, expiresIn } ───│ 8. Set new HttpOnly cookies
  │    Set-Cookie: admin_token      │
  │    Set-Cookie: refresh_token    │
```

#### Refresh token theft detection (family rotation)

Every refresh token belongs to a **family** (identified by `familyId`). On each rotation:

1. The old token hash is deleted.
2. The new token hash is stored with the same `familyId`.

If an **already-used** token is presented again (e.g., a stolen token):

1. The family is immediately **revoked** — all sessions in the family are terminated.
2. An admin alert is triggered.
3. The user must log in again.

This ensures that even if an attacker captures a refresh token, they cannot silently extend a stolen session.

---

### Logout & Session Revocation

```
POST /api/auth/logout
```

Clears the `admin_token` and `refresh_token` cookies and revokes the current session family in the store.

**Response**: `200 OK` with empty body.

To revoke **all sessions** for a user (e.g., after a password change):

```
POST /api/auth/sessions/revoke-all
Authorization: Bearer <token>
```

---

### Session Expiry

| Token | Lifetime | What happens when expired |
|-------|----------|--------------------------|
| Access token (`admin_token`) | 8 hours | API returns `401 TOKEN_EXPIRED`; client must refresh |
| Refresh token (`refresh_token`) | 30 days | Refresh returns `401`; user must log in again |

The frontend intercepts `401 TOKEN_EXPIRED` responses and automatically calls `POST /api/auth/refresh` before retrying the original request (see `frontend/src/services/authRefresh.js`).

---

## Multi-Factor Authentication (MFA)

PaymentFlow supports **TOTP-based MFA** (Google Authenticator, Authy, 1Password, etc.). MFA is optional per-admin unless `REQUIRE_MFA=true` is set.

### MFA enrollment flow

```
1. POST /api/auth/mfa/setup
   ← Returns QR code URI + backup codes

2. Scan QR code in authenticator app

3. POST /api/auth/mfa/verify
   Body: { "totp": "123456" }
   ← MFA is now enabled; new tokens no longer carry mfaSetupPending
```

### MFA enforcement

When `REQUIRE_MFA=true`, admins who have not completed MFA setup receive tokens with `mfaSetupPending: true`. These tokens can **only** reach:

- `POST /api/auth/mfa/setup`
- `POST /api/auth/mfa/verify`
- `POST /api/auth/logout`

All other endpoints return `403 MFA_SETUP_REQUIRED` until setup is complete.

### Login with MFA enabled

```
POST /api/auth/login
{ "username": "admin", "password": "...", "totp": "123456" }
```

The `totp` field is required once MFA is enabled on the account.

---

## JWT Claim Structure

### Access token (decoded payload)

```json
{
  "sub": "admin",
  "username": "admin",
  "schoolId": "SCH-1",
  "role": "admin",
  "roles": ["super_admin"],
  "sessionId": "sess_abc123",
  "familyId": "fam_xyz789",
  "mfaSetupPending": false,
  "iat": 1729526400,
  "exp": 1729555200
}
```

| Claim | Type | Meaning |
|-------|------|---------|
| `sub` | string | Subject — typically the username or user ID |
| `username` | string | Human-readable username |
| `schoolId` | string | Tenant scope. Present on school-operator tokens. Absent on global super-admin tokens. |
| `role` | string | Legacy single role: `"admin"` for the env-configured break-glass super-admin |
| `roles` | string[] | Array of DB-persisted roles. See [Role Hierarchy](#role-hierarchy) below. |
| `sessionId` | string | Unique session identifier for session management |
| `familyId` | string | Refresh token family identifier for theft detection |
| `mfaSetupPending` | boolean | `true` if MFA enrollment is incomplete; access is restricted until setup |
| `iat` | number | Issued-at timestamp (Unix seconds) |
| `exp` | number | Expiry timestamp (Unix seconds) |

### Example decoded payloads

#### Global super-admin (env-configured break-glass account)

```json
{
  "sub": "admin",
  "username": "admin",
  "role": "admin",
  "roles": [],
  "mfaSetupPending": false,
  "iat": 1729526400,
  "exp": 1729555200
}
```

Note: no `schoolId` — this token has cross-school access.

#### School owner

```json
{
  "sub": "user_42",
  "username": "principal@greenoak.edu",
  "schoolId": "SCH-GREEN-OAK",
  "role": null,
  "roles": ["owner", "finance"],
  "sessionId": "sess_def456",
  "familyId": "fam_ghi012",
  "mfaSetupPending": false,
  "iat": 1729526400,
  "exp": 1729555200
}
```

---

## Token Lifetime & Storage

| Token | Storage | Lifetime | Notes |
|-------|---------|----------|-------|
| Access token | HttpOnly cookie (`admin_token`) + response body | 8 hours | Short-lived; do not store in `localStorage` |
| Refresh token | HttpOnly cookie (`refresh_token`) | 30 days | Never sent in the request body; stored as `SHA-256` hash on server |

### Why HttpOnly cookies?

HttpOnly cookies are inaccessible to JavaScript, preventing XSS attacks from stealing tokens. The `SameSite=Strict` flag prevents CSRF. This is why the frontend uses cookies rather than `localStorage` for token storage.

### For API consumers (non-browser)

If you cannot use cookies, include the access token as a Bearer token in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

The middleware accepts both the cookie and the Bearer header; the cookie takes precedence when both are present.

---

## Role Hierarchy

PaymentFlow has two authentication tiers: **global** and **school-scoped**.

### Global tier

| Role | Claim | Description |
|------|-------|-------------|
| `super_admin` | `roles: ["super_admin"]` | DB-persisted global admin. Can access any school without a matching `X-School-ID`. |
| `admin` (legacy) | `role: "admin"` | The env-configured break-glass super-admin (`ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH`). Same privileges as `super_admin`. |

### School-scoped tier

Tokens in this tier carry a `schoolId` claim that must match the `X-School-ID` request header.

| Role | Description | Key Capabilities |
|------|-------------|-----------------|
| `owner` | School owner / principal | Full read/write on school resources; can run reports |
| `finance` | Finance manager / accountant | Read/write on payments, fee structures, reports |
| `staff` | General school staff | Read-only on students and payments |
| `viewer` | Read-only observer | Read-only access to most endpoints |

### Role mapping to endpoints

| Endpoint Group | Required Role(s) |
|---------------|-----------------|
| Admin runtime (`/api/admin/*`) | `super_admin` / `admin` |
| Audit logs (`/api/audit/*`) | `super_admin` / `admin` |
| Students (write) | `super_admin` / `admin` |
| Students (read) | `super_admin` / `admin` |
| Fee structures (write) | `super_admin` / `admin` |
| Fee structures (read) | Any school role |
| Payments (write/admin actions) | `super_admin` / `admin` |
| Payments (read) | Any school role |
| Reports | `owner`, `finance` |
| Disputes (resolve) | `super_admin` / `admin` |
| Public student lookup | No auth |
| Payment verification (public) | No auth |

For the full per-endpoint matrix, see [`docs/authorization-matrix.md`](authorization-matrix.md).

---

## Endpoint Authentication Requirements

The middleware that enforces authentication lives in `backend/src/middleware/auth.js`. There are two factories:

### `requireAdminAuth`

Used for **global super-admin** endpoints. Accepts tokens where:
- `role === 'admin'` (legacy break-glass), **or**
- `roles` includes `'super_admin'`

### `requireSchoolAuth(allowedRoles)`

Used for **school-scoped** endpoints. Rules:
1. Token must be valid and signed with `JWT_SECRET`.
2. For non-super-admin tokens: `token.schoolId` must match the `X-School-ID` request header.
3. If `allowedRoles` is non-empty, `token.roles` must contain at least one of them.
4. A `super_admin`/`admin` token **bypasses** the school scope check (break-glass path).

#### Sending the school scope header

```
GET /api/students
Authorization: Bearer <school-token>
X-School-ID: SCH-GREEN-OAK
```

For EventSource (SSE) connections, which cannot send custom headers, pass the school ID as a query parameter instead:

```
GET /api/sse/payments?schoolId=SCH-GREEN-OAK&token=<access-token>
```

---

## Step-Up Authentication

Sensitive admin operations (such as confirming a refund or bulk-updating payment statuses) require **step-up authentication**: the admin must re-verify their identity even if they have an active session.

Step-up is triggered by the `/api/auth/stepup` endpoint and produces a short-lived elevated token that is valid for a single operation or for a configurable window.

```
POST /api/auth/stepup
Authorization: Bearer <token>
Content-Type: application/json

{
  "password": "your-password",
  "totp": "123456"
}
```

The elevated token is passed as `X-Step-Up-Token` on the sensitive operation endpoint.

---

## Sending Authenticated Requests

### Browser / frontend (cookie-based)

The `admin_token` HttpOnly cookie is sent automatically by the browser. No `Authorization` header is needed for browser requests.

```js
// Frontend example using fetch
const response = await fetch('/api/students', {
  credentials: 'include', // Required to send cookies cross-origin
});
```

### API client / server-to-server (Bearer token)

```js
const response = await fetch('https://api.school.com/api/students', {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'X-School-ID': 'SCH-GREEN-OAK',
  },
});
```

### Complete login + authenticated call example (Node.js)

```js
const axios = require('axios');

const API = 'http://localhost:5000/api';

// 1. Login
const loginRes = await axios.post(`${API}/auth/login`, {
  username: 'admin',
  password: 'your-password',
});
const { token } = loginRes.data;

// 2. Use the access token
const studentsRes = await axios.get(`${API}/students`, {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-School-ID': 'SCH-1',
  },
});
console.log(studentsRes.data);

// 3. Refresh before expiry
const refreshRes = await axios.post(`${API}/auth/refresh`, {}, {
  withCredentials: true, // send the refresh_token cookie
});
const newToken = refreshRes.data.token;
```

---

## Error Reference

All authentication and authorization failures return `{ "error": "...", "code": "..." }`.

| Scenario | HTTP | Code |
|----------|------|------|
| No token provided | `401` | `MISSING_AUTH_TOKEN` |
| Token expired | `401` | `TOKEN_EXPIRED` |
| Token invalid / malformed | `401` | `INVALID_AUTH_TOKEN` |
| IP temporarily blocked | `429` | `IP_BLOCKED` |
| Insufficient role | `403` | `INSUFFICIENT_ROLE` |
| Token not scoped to a school | `403` | `MISSING_TENANT_CLAIM` |
| Token `schoolId` ≠ `X-School-ID` | `403` | `TENANT_MISMATCH` |
| MFA setup not complete | `403` | `MFA_SETUP_REQUIRED` |

---

## OpenAPI Security Scheme

The OpenAPI specification at `GET /api/docs.json` includes the following security scheme definition:

```yaml
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: >
        JWT signed with HMAC-SHA256 (HS256). Obtain via POST /api/auth/login.
        Pass as Authorization: Bearer <token> or via the admin_token HttpOnly cookie.
    CookieAuth:
      type: apiKey
      in: cookie
      name: admin_token
      description: >
        Access JWT stored in an HttpOnly cookie. Set automatically by POST /api/auth/login.

security:
  - BearerAuth: []
  - CookieAuth: []
```

All protected endpoints are annotated with `security: [{ BearerAuth: [] }]` in the OpenAPI spec.

---

## Implementation References

| Component | File |
|-----------|------|
| Auth middleware | `backend/src/middleware/auth.js` |
| Auth controller (login, refresh, logout, MFA) | `backend/src/controllers/authController.js` |
| MFA controller | `backend/src/controllers/mfaController.js` |
| Auth routes | `backend/src/routes/authRoutes.js` |
| Authorization matrix | `backend/src/middleware/authorizationMatrix.md` → `docs/authorization-matrix.md` |
| Frontend auth refresh | `frontend/src/services/authRefresh.js` |
| Frontend session guard | `frontend/src/hooks/useSessionGuard.js` |
| Refresh token theft detection tests | `tests/refreshTokenTheftDetection.test.js` |
| JWT secret validation tests | `tests/jwtSecretValidation.test.js` |
| MFA lifecycle tests | `tests/mfaLifecycle.integration.test.js` |
