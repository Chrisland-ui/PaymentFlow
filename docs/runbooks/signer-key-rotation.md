# Signer Key Rotation Runbook

**Issue #63** — Long-lived operational keys create avoidable blast radius
without a tested rotation process. This runbook documents the staged rotation
procedure with verification, rollback, and audit logging.

---

## Overview

PaymentFlow encrypts school Stellar signing keys at rest using AES-256-GCM
with a master key (`SIGNER_MASTER_KEY`). Rotating this master key requires:

1. Re-encrypting every stored signing key under the new master key.
2. Verifying every re-encrypted record produces a valid Stellar keypair.
3. Updating the deployment secret and redeploying.
4. Revoking the old key **only after** step 3 is confirmed.

The `scripts/rotate-signer-key-staged.js` script automates phases 1–3 and
prints commit instructions for phase 4.

**Security constraints:**
- Private keys are never written to logs, stdout, files, or issue comments.
- Audit log entries contain school IDs and status only — no key material.
- The old key is never dropped automatically. The operator must do it manually
  after verification.

---

## Pre-rotation Checklist

Before starting a production rotation, complete every item:

- [ ] **Testnet rehearsal** — run the full procedure on testnet first:
  ```bash
  # Generate test keys
  OLD_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  
  SIGNER_MASTER_KEY_OLD=$OLD_KEY \
    SIGNER_MASTER_KEY=$NEW_KEY \
    ROTATION_OPERATOR=your-name \
    MONGO_URI=mongodb://localhost:27017/stellaredupay-test?replicaSet=rs0 \
    node scripts/rotate-signer-key-staged.js --apply
  ```

- [ ] **Backup verification** — confirm a recent DB backup exists and restores:
  ```bash
  ./scripts/verify-latest-backup.sh
  ```

- [ ] **Off-peak window** — schedule during a low-traffic period.

- [ ] **Two-person review** — a second operator should monitor the run.

- [ ] **Notify stakeholders** — inform the team before starting.

- [ ] **New key generated securely**:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Store it in your password manager or secrets vault. Do not write it in chat,
  email, tickets, or commit messages.

---

## Step-by-step Procedure

### Step 1 — Dry run (Phase 1 only)

Verify the current key can decrypt every record without writing anything:

```bash
SIGNER_MASTER_KEY_OLD=<current key> \
  SIGNER_MASTER_KEY=<new key> \
  ROTATION_OPERATOR=your-name \
  node scripts/rotate-signer-key-staged.js
```

**Expected output:** structured JSON audit log showing `phase: "prepare"`,
`result: "ok"`, and the count of affected schools.

If `result: "failed"` — stop. Do not proceed. Investigate why records cannot
be decrypted under the current key before rotating.

### Step 2 — Apply (Phases 1–4)

```bash
SIGNER_MASTER_KEY_OLD=<current key> \
  SIGNER_MASTER_KEY=<new key> \
  ROTATION_OPERATOR=your-name \
  node scripts/rotate-signer-key-staged.js --apply
```

Watch for:
- `phase: "prepare"` — `result: "ok"` ✅
- `phase: "apply"` — `result: "ok"` ✅
- `phase: "verify"` — `result: "ok"` ✅
- Phase 4 commit instructions printed to stdout ✅

If any phase shows `result: "failed"` or `result: "partial_failure"`, see
[Rollback Procedure](#rollback-procedure) below. **Do not proceed to step 3.**

### Step 3 — Update deployment secret

After all phases pass:

1. Update `SIGNER_MASTER_KEY` in your deployment secrets store (Kubernetes
   Secret, AWS Secrets Manager, HashiCorp Vault, etc.) to the **new** key.

2. Redeploy the API and all workers:
   ```bash
   kubectl rollout restart deployment/paymentflow-backend
   # or your deployment mechanism
   ```

3. Confirm the new deployment is healthy:
   ```bash
   curl https://your-domain/health
   ```

### Step 4 — Smoke test

After redeployment, verify end-to-end functionality:

1. Process a test payment on testnet.
2. Confirm the payment reaches `confirmed` status.
3. Confirm webhook delivery succeeds.

### Step 5 — Revoke old key

Only after step 4 passes:

1. Remove `SIGNER_MASTER_KEY_OLD` from all environments (CI, staging, prod).
2. Redeploy if `SIGNER_MASTER_KEY_OLD` was in a live environment variable.
3. Record the rotation completion in your audit trail.

---

## Verification Commands

After each phase, you can independently verify:

```bash
# Confirm Phase 1 — spot-check one school ID from the audit log
# (uses old key — run before committing)
SIGNER_MASTER_KEY=<old key> node -e "
  require('dotenv').config({ path: 'backend/.env' });
  const { decryptSecretKey } = require('./backend/src/utils/signerKeyManager');
  const blob = '<paste encryptedSigningKey from DB>';
  const secret = decryptSecretKey(blob);
  console.log('Decrypts OK, starts with S:', secret.startsWith('S'));
"

# Confirm Phase 3 — spot-check under new key
SIGNER_MASTER_KEY=<new key> node -e "
  require('dotenv').config({ path: 'backend/.env' });
  const { decryptSecretKey } = require('./backend/src/utils/signerKeyManager');
  const blob = '<paste updated encryptedSigningKey from DB>';
  const secret = decryptSecretKey(blob);
  console.log('Decrypts OK, starts with S:', secret.startsWith('S'));
"
```

---

## Rollback Procedure

If Phase 2 (apply) or Phase 3 (verify) fails:

1. **Keep `SIGNER_MASTER_KEY_OLD` set** in the environment. Do not remove it.

2. **Do not redeploy** — the running API still uses the old key and can still
   decrypt records that have not been migrated.

3. Re-run Phase 1 dry run with the old key to identify which records are
   still readable:
   ```bash
   SIGNER_MASTER_KEY_OLD=<old key> \
     SIGNER_MASTER_KEY=<old key> \
     node scripts/rotate-signer-key-staged.js
   ```
   (Using the old key as both OLD and NEW just runs the check without
   rotating — because the script requires them to differ, use this only for
   manual inspection via the signerKeyManager directly.)

4. For records that failed verification — query the DB and compare
   `encryptedSigningKey` blobs before/after from the backup.

5. Contact the on-call engineer. Document the incident.

6. Once root cause is understood, either:
   - Restore affected records from backup and retry the rotation, **or**
   - Manually re-encrypt specific records and re-verify.

---

## Old Key Revocation

Old keys are revoked **only after**:

1. All records verified readable under the new key (Phase 3 passed).
2. New key deployed and live in all environments.
3. Smoke tests passed.

Revocation is manual — remove `SIGNER_MASTER_KEY_OLD` from secrets stores and
redeploy. The script never drops the old key automatically.

---

## Audit Trail

Every run emits structured JSON audit entries to stdout. Capture them:

```bash
SIGNER_MASTER_KEY_OLD=<old> SIGNER_MASTER_KEY=<new> \
  ROTATION_OPERATOR=alice \
  node scripts/rotate-signer-key-staged.js --apply \
  | tee /var/log/paymentflow/signer-rotation-$(date +%Y%m%dT%H%M%S).log
```

Store the log in your audit system. Entries include: `timestamp`, `operator`,
`phase`, `result`, `affectedCount`, `failedCount`, `affectedSchools` (IDs
only — no key material is ever logged).

---

## Related

- `scripts/rotate-signer-master-key.js` — original, non-staged rotation script
- `backend/src/utils/signerKeyManager.js` — encryption/decryption implementation
- `docs/security.md` — full threat model
- `docs/runbooks/wallet-rotation.md` — school wallet key rotation
