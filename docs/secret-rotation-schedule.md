# Secret Rotation Schedule

This document defines the rotation schedule for all critical secrets in PaymentFlow,
the procedures for rotating each, and how to record a rotation in the CI audit trail.

---

## Rotation Schedule

| Secret | Max Age | Rotation Script | Runbook |
|--------|---------|-----------------|---------|
| `JWT_SECRET` | **90 days** | `scripts/rotate-jwt-secret.js` | [JWT Secret](#jwt_secret) |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | **90 days** | `scripts/rotate-webhook-encryption-key.js` | [Webhook Encryption Key](#webhook_secret_encryption_key) |
| `SIGNER_MASTER_KEY` | **180 days** | `scripts/rotate-signer-key-staged.js` | [Signer Master Key](#signer_master_key) |
| MongoDB credentials | **180 days** | Manual | [MongoDB Credentials](#mongodb-credentials) |
| API keys / external tokens | **365 days** | Manual | [API Keys](#api-keys--external-tokens) |

The CI workflow (`.github/workflows/secret-rotation.yml`) runs daily at 08:00 UTC and
alerts if any secret is past its due date. It reads the `SECRET_ROTATION_LAST_*` GitHub
Secrets to determine last-rotation dates.

---

## Tracking Last Rotation Dates

After rotating a secret, update the corresponding GitHub Secret under
**Settings → Secrets and variables → Actions**:

| GitHub Secret | Secret it tracks |
|--------------|-----------------|
| `SECRET_ROTATION_LAST_JWT` | `JWT_SECRET` |
| `SECRET_ROTATION_LAST_WEBHOOK_ENC` | `WEBHOOK_SECRET_ENCRYPTION_KEY` |
| `SECRET_ROTATION_LAST_SIGNER` | `SIGNER_MASTER_KEY` |
| `SECRET_ROTATION_LAST_MONGO` | MongoDB credentials |

Set the value to an ISO-8601 date, e.g., `2026-10-19`.

Then trigger the CI audit log workflow to create a permanent record:

```
GitHub Actions → Secret Rotation Audit → Run workflow
  rotation_type: <type>
  operator: <your-name>
  confirm: CONFIRM   (only for jwt-secret)
```

---

## JWT_SECRET

**Purpose**: Signs and verifies all JWT access tokens and refresh tokens.

**Rotation period**: 90 days

**Impact of rotation**:
- All live sessions are **immediately invalidated** — users must log in again.
- MFA secrets stored encrypted with the old key become unreadable — enrolled users must re-enroll.
- Audit log HMAC entries (when `AUDIT_HMAC_KEY` is unset) use `JWT_SECRET`; set `AUDIT_HMAC_KEY` independently before rotating if audit-trail verification across the rotation boundary matters.
- Outstanding email unsubscribe links stop validating (low-stakes, regenerated on next email).

**Procedure**:

```bash
# 1. Review the impact section above.
# 2. Run the rotation script locally with --confirm once you accept the fallout:
node scripts/rotate-jwt-secret.js --confirm \
  [--secret-name stellaredupay] \
  [--deployment backend] \
  [--namespace <ns>]

# The script will:
#   a. Generate a new 384-bit secret
#   b. kubectl patch the Kubernetes Secret
#   c. kubectl rollout restart the deployment
#   d. Wait for the rollout to complete (timeout: 300s)

# 3. Verify /health is green:
curl https://<your-domain>/health | jq .status

# 4. Confirm a fresh login issues a working token.

# 5. Update SECRET_ROTATION_LAST_JWT in GitHub Secrets to today's date.

# 6. Trigger the CI audit log:
#    GitHub Actions → Secret Rotation Audit → Run workflow
#    rotation_type: jwt-secret, operator: <name>, confirm: CONFIRM
```

---

## WEBHOOK_SECRET_ENCRYPTION_KEY

**Purpose**: AES-256 key that encrypts per-school webhook HMAC signing secrets at rest.

**Rotation period**: 90 days

**Impact of rotation**:
- No session or user impact — purely at-rest encryption.
- There is a **grace period** via `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS`; existing webhooks continue to work while re-encryption is in progress.

**Procedure**:

```bash
# 1. Generate a new 32-byte hex key:
NEW_KEY=$(node -e "require('crypto').randomBytes(32).toString('hex').then ? '' : console.log(require('crypto').randomBytes(32).toString('hex'))")
# or simply:
NEW_KEY=$(openssl rand -hex 32)

# 2. Set both keys in the deployment environment (Kubernetes Secret):
#    WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS = current WEBHOOK_SECRET_ENCRYPTION_KEY value
#    WEBHOOK_SECRET_ENCRYPTION_KEY = $NEW_KEY

# 3. Dry run (no writes):
WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS=<old-key> \
WEBHOOK_SECRET_ENCRYPTION_KEY=<new-key> \
MONGO_URI=<uri> \
node scripts/rotate-webhook-encryption-key.js

# 4. Apply rotation:
WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS=<old-key> \
WEBHOOK_SECRET_ENCRYPTION_KEY=<new-key> \
MONGO_URI=<uri> \
node scripts/rotate-webhook-encryption-key.js --apply

# 5. Rolling restart to pick up the new key:
kubectl rollout restart deployment/backend

# 6. After all pods are running on the new key, remove WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS.

# 7. Update SECRET_ROTATION_LAST_WEBHOOK_ENC in GitHub Secrets.

# 8. Trigger the CI audit log workflow.
```

---

## SIGNER_MASTER_KEY

**Purpose**: AES-256 key that encrypts per-school Stellar signing keys at rest.

**Rotation period**: 180 days

**Impact of rotation**:
- No user-facing impact — the rotation is transparent if all phases succeed.
- Uses a four-phase staged rotation (prepare → apply → verify → commit) with
  explicit operator approval at each step.

**Procedure**: See `docs/runbooks/signer-key-rotation.md` for the full guided procedure.

```bash
# Quick reference — full procedure in docs/runbooks/signer-key-rotation.md

# Phase 1 — dry run (no writes):
SIGNER_MASTER_KEY_OLD=<old> SIGNER_MASTER_KEY=<new> \
ROTATION_OPERATOR=<your-name> MONGO_URI=<uri> \
node scripts/rotate-signer-key-staged.js

# Phases 1-4 — full rotation (writes to DB):
SIGNER_MASTER_KEY_OLD=<old> SIGNER_MASTER_KEY=<new> \
ROTATION_OPERATOR=<your-name> MONGO_URI=<uri> \
node scripts/rotate-signer-key-staged.js --apply

# After completion, update deployment secret and trigger audit log workflow.
```

---

## MongoDB Credentials

**Purpose**: MongoDB root user and application-user passwords.

**Rotation period**: 180 days

**Impact of rotation**:
- Brief connection interruption during the rolling restart.
- The replica set requires coordinated credential updates.

**Procedure**:

1. Generate new credentials:
   ```bash
   NEW_PASS=$(openssl rand -base64 32)
   ```
2. Update the MongoDB user password via `mongosh`:
   ```javascript
   db.updateUser("appuser", { pwd: "<new-password>" })
   ```
3. Update the Kubernetes Secret:
   ```bash
   kubectl patch secret stellaredupay --type=merge \
     -p '{"stringData":{"MONGO_URI":"mongodb://appuser:<new-password>@mongo:27017/stellaredupay?replicaSet=rs0"}}'
   ```
4. Rolling restart:
   ```bash
   kubectl rollout restart deployment/backend
   kubectl rollout status deployment/backend --timeout=300s
   ```
5. Verify `/health` shows `database.status: "healthy"`.
6. Update `SECRET_ROTATION_LAST_MONGO` in GitHub Secrets.
7. Trigger the CI audit log workflow.

---

## API Keys / External Tokens

**Purpose**: External service credentials (CoinGecko, email provider SMTP, etc.).

**Rotation period**: 365 days

**Procedure**: Varies by service. General steps:
1. Generate a new API key from the provider's dashboard.
2. Update the Kubernetes Secret for the relevant key.
3. Rolling restart the backend deployment.
4. Verify the relevant health check / metric is green.
5. Revoke the old key from the provider's dashboard.

---

## CI Audit Trail

Every rotation must be logged by triggering the
`.github/workflows/secret-rotation.yml` workflow with `workflow_dispatch`.

The audit log entry includes:
- `timestamp` — ISO-8601 rotation timestamp
- `secret_name` — secret type (never the value)
- `operator` — name of the person performing the rotation
- `github_actor` — GitHub username of the person who triggered the workflow
- `workflow_run_id` — permanent link to the CI run for traceability

Audit entries are stored in the GitHub Actions run logs and are immutable
(GitHub does not allow modifying completed workflow run logs).
