# Secret Rotation Rollback Runbook

> Companion to `docs/operator-runbooks.md § Key Rotation`.  
> Use this runbook when `scripts/verify-rotation.js` exits non-zero or when
> post-rotation health checks fail.

---

## Decision tree

```
Rotation applied? ──No──► Nothing to roll back; fix the issue before retrying.
      │
     Yes
      │
      ▼
Pods restarted with new secret? ──No──► Patch secret back to old value; pods
      │                                   are still reading the old value anyway.
     Yes
      │
      ▼
Are old credentials still available? ──No──► Escalate to incident commander.
      │                                        Restore from Vault/secret store.
     Yes
      │
      ▼
Follow type-specific rollback below.
```

---

## JWT secret rollback

**Impact**: Every live session is already invalid (the rotation cut over). Rolling
back restores the previous signing key — users that logged in after the cutover
will be logged out again.

```sh
# 1. Restore the old JWT_SECRET into the k8s Secret.
#    Replace <OLD_VALUE> with the value from your secret store / incident ticket.
kubectl patch secret stellaredupay \
  -n <namespace> \
  --type=merge \
  -p '{"stringData":{"JWT_SECRET":"<OLD_VALUE>"}}'

# 2. Restart the backend so it picks up the restored value.
kubectl rollout restart deployment/backend -n <namespace>
kubectl rollout status deployment/backend -n <namespace> --timeout=120s

# 3. Verify.
node scripts/verify-rotation.js --type jwt

# 4. Record the rollback in the incident log:
echo "JWT rollback at $(date -u +%Y-%m-%dT%H:%M:%SZ) by ${USER:-operator}"
```

---

## Webhook encryption key rollback

The dual-key grace period (`WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS`) makes
this rotation partially reversible without data loss.

**Scenario A — `--apply` was NOT run (dry-run only)**  
No database changes were made. Remove the new key from the deployment and
nothing further is required.

**Scenario B — `--apply` WAS run**  
Some or all school records were re-encrypted under the new key.

```sh
# 1. Swap keys: promote the new key to PREVIOUS so decryption can still
#    fall back to it, and restore the old key as the active one.
kubectl patch secret stellaredupay \
  -n <namespace> \
  --type=merge \
  -p '{
    "stringData": {
      "WEBHOOK_SECRET_ENCRYPTION_KEY": "<OLD_KEY>",
      "WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS": "<NEW_KEY>"
    }
  }'

# 2. Restart so both keys are loaded.
kubectl rollout restart deployment/backend -n <namespace>
kubectl rollout status deployment/backend -n <namespace> --timeout=120s

# 3. Re-run the rotation script in --apply mode to re-encrypt records back
#    under the old key (now set as WEBHOOK_SECRET_ENCRYPTION_KEY).
WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS=<NEW_KEY> \
WEBHOOK_SECRET_ENCRYPTION_KEY=<OLD_KEY> \
  node scripts/rotate-webhook-encryption-key.js --apply

# 4. Drop WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS once the run reports zero failures.
kubectl patch secret stellaredupay \
  -n <namespace> \
  --type=json \
  -p '[{"op":"remove","path":"/data/WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS"}]'

# 5. Verify.
WEBHOOK_SECRET_ENCRYPTION_KEY=<OLD_KEY> \
  node scripts/verify-rotation.js --type webhook

# 6. Record rollback in incident log.
```

---

## Signer master key rollback

**Scenario A — `--apply` was NOT run**  
No records were written. No further action needed.

**Scenario B — `--apply` WAS run**

```sh
# 1. Re-add the old key as SIGNER_MASTER_KEY_OLD and set the key that was
#    previously "old" back as SIGNER_MASTER_KEY.
kubectl patch secret stellaredupay \
  -n <namespace> \
  --type=merge \
  -p '{
    "stringData": {
      "SIGNER_MASTER_KEY": "<OLD_KEY>",
      "SIGNER_MASTER_KEY_OLD": "<NEW_KEY>"
    }
  }'

# 2. Restart so both keys are loaded.
kubectl rollout restart deployment/backend -n <namespace>
kubectl rollout status deployment/backend -n <namespace> --timeout=120s

# 3. Re-run rotation in --apply mode to re-encrypt all records under the old key.
SIGNER_MASTER_KEY_OLD=<NEW_KEY> \
SIGNER_MASTER_KEY=<OLD_KEY> \
  node scripts/rotate-signer-master-key.js --apply

# 4. Drop SIGNER_MASTER_KEY_OLD.
kubectl patch secret stellaredupay \
  -n <namespace> \
  --type=json \
  -p '[{"op":"remove","path":"/data/SIGNER_MASTER_KEY_OLD"}]'

# 5. Verify.
SIGNER_MASTER_KEY=<OLD_KEY> \
  node scripts/verify-rotation.js --type signer

# 6. Record rollback in incident log.
```

---

## Escalation

If old credential values are unavailable and `verify-rotation.js` continues to
fail after rollback attempts, escalate to the incident commander. Options are:

- **JWT**: Generate a new JWT_SECRET and accept that all sessions are
  invalidated. No data loss — tokens are stateless.
- **Webhook key / Signer key**: Restore from a database backup taken before
  the rotation (see `docs/operator-runbooks.md § Restore Procedure`). This
  restores the encrypted-at-rest records to a state where the known-good key
  can decrypt them.

Always record: rotation timestamp, operator, rollback timestamp, rollback
operator, and root cause in the incident ticket before closing.
