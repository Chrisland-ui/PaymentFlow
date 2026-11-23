# Data Classification and Redaction Rules

Logs, exports, and support tooling must treat financial and identity data
consistently. This document defines sensitive field categories, prohibited
logging destinations, masking rules, retention limits, and safe code examples.
It aligns with the threat model in [`docs/security.md`](security.md) and the
PII protection tested in [`tests/studentPiiProtection.test.js`](../tests/studentPiiProtection.test.js).

## Table of Contents

- [Data Categories](#data-categories)
- [Sensitive Fields Reference](#sensitive-fields-reference)
  - [Authentication and Secrets](#authentication-and-secrets)
  - [Financial Data](#financial-data)
  - [Student and Parent PII](#student-and-parent-pii)
  - [Blockchain Identifiers](#blockchain-identifiers)
  - [Session and Request Data](#session-and-request-data)
- [Prohibited Logging](#prohibited-logging)
- [Automated Checks and Enforcement](#automated-checks-and-enforcement)
- [Masking and Safe Examples](#masking-and-safe-examples)
- [Allowed Destinations by Category](#allowed-destinations-by-category)
- [Retention Policy](#retention-policy)
- [Incident and Support Handling](#incident-and-support-handling)

---

## Data Categories

| Category | Description | Risk level |
|----------|-------------|------------|
| **Authentication secrets** | Passwords, JWT secrets, MFA codes, API keys | Critical |
| **Financial data** | Transaction hashes, payment amounts, wallet addresses | High |
| **Student PII** | Student IDs, parent email, parent phone | High |
| **Session tokens** | JWT access/refresh tokens, cookies, idempotency keys | High |
| **Operational config** | Database URIs, Redis passwords, SMTP credentials | High |
| **Blockchain identifiers** | Sender addresses, memo fields | High |
| **Non-sensitive operational** | Request method, URL path, response duration, status codes | Low |

---

## Sensitive Fields Reference

### Authentication and Secrets

These values must **never** appear in logs, fixtures, exported files, or issue
comments under any circumstances.

| Field / Variable | Where it lives | Why sensitive |
|-----------------|---------------|---------------|
| `password` | Request body (`POST /api/auth/login`) | Plaintext password in transit |
| `currentPassword` | Request body (password change) | Plaintext password in transit |
| `secret` | MFA setup response, webhook config | TOTP seed or webhook signing secret |
| `token` | Request body, query params | Access or refresh token |
| `mfaCode` | Request body (`POST /api/auth/mfa/verify`) | One-time TOTP code |
| `backupCode` | Request body (MFA recovery) | One-time recovery code |
| `JWT_SECRET` | Env var | Signs all JWTs for this deployment |
| `WEBHOOK_SECRET` | Env var | Signs outbound webhook payloads |
| `MONGO_URI` / `MONGODB_URI` | Env var | Includes database credentials |
| `SMTP_PASS` | Env var | Email service password |
| `REDIS_PASSWORD` | Env var | Redis auth credential |
| `ADMIN_PASSWORD` | Env var | Bootstrap admin account password |

Source of truth: [`backend/src/utils/redactConfig.js`](../backend/src/utils/redactConfig.js)
(`SENSITIVE_KEYS` set).

### Financial Data

| Field | Description | Handling |
|-------|-------------|---------|
| `txHash` | Stellar transaction hash | Redacted from request logs. Safe in audit log (internal, not public). |
| `amount` | Payment amount (XLM / USDC) | Not redacted in logs but must not appear in client-facing error messages. |
| `senderAddress` | Parent's Stellar wallet address | Redacted from request logs. Must not be exposed via public API. |
| `memo` | Stellar memo field (student ID carrier) | Redacted from request logs. Encrypted at rest (migration 011). |
| `remainingBalance` | Unpaid balance amount | Not returned by the public student endpoint. Admin-only. |
| `totalPaid` | Total amount paid | Not returned by the public student endpoint. Admin-only. |
| `feeAmount` | Fee owed | Not returned by the public student endpoint. Admin-only. |

### Student and Parent PII

| Field | Description | Handling |
|-------|-------------|---------|
| `studentId` | Unique student identifier | Redacted from request logs. Embedded in Stellar memo (encrypted at rest). |
| `parentEmail` | Parent/guardian email address | Encrypted at rest (AES-256-GCM, migration 029). Not returned by public endpoint. |
| `parentPhone` | Parent/guardian phone number | Encrypted at rest (AES-256-GCM, migration 029). Not returned by public endpoint. |
| `name` (student) | Student full name | Returned by public endpoint (needed for QR/payment display). Not a redacted log field. |

The `GET /api/students/public/:studentId` endpoint returns only `name`, `class`,
and `feePaid`. It explicitly omits `parentEmail`, `parentPhone`, `totalPaid`,
`remainingBalance`, `feeAmount`, and `studentId`. This is enforced by
[`tests/studentPiiProtection.test.js`](../tests/studentPiiProtection.test.js).

### Blockchain Identifiers

| Field | Description | Handling |
|-------|-------------|---------|
| `senderAddress` | Stellar public key of the payer | Redacted from request logs. Never expose via public endpoint. |
| `SCHOOL_WALLET_ADDRESS` | School's Stellar public key | Safe to log as operational info (public key is not a secret). |
| Stellar secret key (`S...`) | School's Stellar private key | **Never** stored by this backend. Never log, never accept via API. |

### Session and Request Data

| Header / Field | Handling |
|---------------|---------|
| `authorization` | Redacted from request log headers. |
| `cookie` | Redacted from request log headers. |
| `set-cookie` | Redacted from request log headers. |
| `x-api-key` | Redacted from request log headers. |
| `idempotency-key` | Redacted from request log headers. |

These are enforced by the `SENSITIVE_HEADERS` set in
[`backend/src/middleware/requestLogger.js`](../backend/src/middleware/requestLogger.js).

---

## Prohibited Logging

A developer can identify a **prohibited log statement** by checking whether
the value being logged matches any field in the tables above. The following
rules define the boundary:

### Never log

- Plaintext values of any `SENSITIVE_KEYS` env vars (JWT_SECRET, MONGO_URI, etc.)
- Any request body field listed in `REQUEST_LOG_REDACT_FIELDS`:
  `txHash`, `studentId`, `memo`, `senderAddress`, `password`, `secret`,
  `token`, `mfaCode`, `backupCode`, `currentPassword`
- `parentEmail` or `parentPhone` in any form (plaintext or raw ciphertext)
- Authentication headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `idempotency-key`) in any log output
- Full wallet addresses associated with specific students or parents
- Database query results that contain the fields listed above

### Acceptable in logs

- Counts: `"Updated 42 records"`, `"3 students migrated"`
- Non-identifying keys: MongoDB `_id` values (ObjectId), `schoolId`, `class`
- Operational metadata: HTTP method, URL path (not query params that carry PII),
  status code, duration
- Student display name (`name`) where needed for operational visibility
- `SCHOOL_WALLET_ADDRESS` (it is a public blockchain address, not a secret)
- Error codes and messages that do not echo back user-supplied secret values

### Prohibited in test fixtures and issue comments

- Real student names, email addresses, or phone numbers
- Real Stellar wallet addresses (`G...` keys used in production or containing real funds)
- Real transaction hashes from mainnet or testnet accounts with real funds
- JWT tokens, MFA codes, or backup codes even if expired
- MongoDB connection strings containing credentials

Use placeholder values instead — see [Masking and Safe Examples](#masking-and-safe-examples).

---

## Automated Checks and Enforcement

### Request logger redaction (runtime)

`backend/src/middleware/requestLogger.js` calls `redact()` before writing any
request body or query string to the log. The redaction field list is defined in
`backend/src/utils/redactConfig.js` and can be extended via the
`LOG_REDACT_FIELDS` environment variable (comma-separated):

```bash
# Override at runtime — applies in addition to the default list:
LOG_REDACT_FIELDS=myCustomField,anotherField npm start
```

The `redactHeaders()` function in the same file scrubs sensitive HTTP headers
when `LOG_REQUEST_HEADERS=true` logging is enabled.

**Test coverage:** `backend/tests/requestLoggerRedaction.test.js` asserts that
`password`, `mfaCode`, `backupCode`, `secret`, `token`, and `currentPassword`
are replaced with `[REDACTED]` in log output.

### Public student API (runtime)

The public student endpoint projection is enforced at the controller level.
**Test coverage:** `tests/studentPiiProtection.test.js` asserts that
`parentEmail`, `parentPhone`, `totalPaid`, `remainingBalance`, `feeAmount`,
and `studentId` are absent from `GET /api/students/public/:studentId` responses.

### PII encryption at rest (migration)

`backend/migrations/029_encrypt_student_pii.js` encrypts `parentEmail` and
`parentPhone` using AES-256-GCM. The migration is idempotent (detects the
`enc:` prefix) and requires `STUDENT_PII_ENCRYPTION_KEY` (64-char hex) to be
set before running. Values already encrypted are skipped without being logged.

### Secret scan (CI)

The `secret-scan-repo` CI job runs `node scripts/scan-repo-secrets.js` on every
push to detect accidentally committed Stellar secret keys (strings that match
the `S...` keypair format) in tracked files.

The `secret-scan` CI job runs `node scripts/scan-example-secrets.js` on
`.env.example` and similar files to detect secret material that might have been
copied in without sanitisation.

---

## Masking and Safe Examples

When writing tests, documentation, or issue comments that need to reference
sensitive-looking data, use the placeholder values below. These are
recognisably fake and will not trigger secret scans.

| Data type | Safe placeholder |
|-----------|-----------------|
| Student ID | `STU001`, `STU-EXAMPLE-01` |
| Parent email | `parent@example.com` |
| Parent phone | `+1-555-000-1234` |
| Stellar public key (school) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Stellar public key (parent) | `GPARENT000000000000000000000000000000000000000000000000PA` |
| JWT secret | `ci-test-jwt-secret-not-used-in-production` |
| Transaction hash | `abc123def456...` (ellipsis or hex placeholder) |
| MongoDB URI | `mongodb://localhost:27017/stellaredupay?replicaSet=rs0` |
| Encryption key (hex) | `0000...0000` (64 zeroes, clearly not real) |

When a code example needs to show a redacted value, use:

```js
// Log safe — no PII, no secrets:
logger.info('Payment recorded', {
  schoolId: req.schoolId,
  studentClass: student.class,
  status: payment.status,
});

// WRONG — never do this:
// logger.info('Payment recorded', { studentId, parentEmail, txHash });
```

---

## Allowed Destinations by Category

| Destination | Auth secrets | Financial data | Student PII | Operational metadata |
|-------------|:---:|:---:|:---:|:---:|
| Application logs (stdout / file) | ❌ Never | ❌ Redacted | ❌ Redacted | ✅ Allowed |
| Audit log (`auditlogs` collection) | ❌ Never | ✅ Allowed (internal) | ⚠️ Admin-only read | ✅ Allowed |
| MongoDB `students` collection | N/A | ✅ Stored (encrypted) | ✅ Encrypted at rest | ✅ Allowed |
| Outbound webhook payload | ❌ Never | ✅ Signed payload | ❌ Never | ✅ Allowed |
| Email (receipts / reminders) | ❌ Never | ⚠️ Amount only | ⚠️ Name + school only | ✅ Allowed |
| CSV/JSON exports (`/api/reports`) | ❌ Never | ✅ Admin-only | ❌ No raw PII | ✅ Allowed |
| Error responses (HTTP 4xx/5xx) | ❌ Never | ❌ Never | ❌ Never | ⚠️ Code only |
| GitHub issues / PR comments | ❌ Never | ❌ Never | ❌ Never | ✅ Allowed |
| Prometheus metrics (`/metrics`) | ❌ Never | ⚠️ Aggregates only | ❌ Never | ✅ Allowed |

---

## Retention Policy

| Data type | Storage location | Retention |
|-----------|-----------------|-----------|
| Request logs (stdout) | `logs/combined-YYYY-MM-DD.log` | 14 days (`LOG_MAX_FILES=14d`) |
| Error logs | `logs/error-YYYY-MM-DD.log` | 14 days |
| Audit log entries | `auditlogs` collection | TTL index; default per-deployment config |
| Idempotency keys | `idempotencykeys` collection | 24 hours (`IDEMPOTENCY_KEY_TTL_SECONDS`) |
| Payment intents | `paymentintents` collection | TTL index (migration 006) |
| Reminder logs | `reminderlogs` collection | 90 days (`REMINDER_LOG_TTL_SECONDS`) |
| Webhook delivery records | `webhookdeliveries` collection | TTL index (migration 028) |
| Database backups | Host path (`BACKUP_DIR`) | 7 days (`RETAIN_DAYS`) |

PII fields (`parentEmail`, `parentPhone`) are encrypted at rest and are
retained as long as the student record exists. Deleting a student record
(soft-delete via `deletedAt`) does not remove the encrypted PII; a hard
delete of the document removes it.

---

## Incident and Support Handling

When investigating a production issue that involves payment data or student
records:

1. **Use audit logs, not raw DB exports.** Query `GET /api/audit` with
   appropriate date and actor filters. The audit log records who did what and
   when without exposing raw PII fields to support staff.

2. **Mask PII before sharing.** If a support ticket requires attaching a log
   snippet or database document, redact `parentEmail`, `parentPhone`, and
   `senderAddress` before pasting. Replace with `[REDACTED]`.

3. **Never attach `.env` files or logs containing real secrets** to issue
   trackers, Slack threads, or email. If secrets may have been exposed, treat
   it as a security incident and rotate them immediately per the procedures in
   [`docs/security.md`](security.md) and [`docs/operator-runbooks.md`](operator-runbooks.md).

4. **Use `LOG_LEVEL=debug` only in a controlled environment.** Debug-level
   logging may surface additional request context. Ensure debug mode is not
   left enabled in production after investigation.
