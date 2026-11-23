# Secret Rotation Runbook

This runbook covers rotating every secret class used by PaymentFlow. Follow it whenever a secret is suspected or confirmed to have been leaked.

---

## 1. Identify the leaked secret type

| Secret | Format | Where used |
|--------|--------|-----------|
| JWT signing secret | 64+ char hex or random string | `JWT_SECRET` env var, Kubernetes secret |
| Stellar signer secret key | `S` + 55 Base32 chars (56 total) | `SIGNER_SECRET_KEY` / encrypted in MongoDB |
| MongoDB credentials | Arbitrary string | `MONGO_ROOT_PASSWORD`, connection URI |
| Webhook HMAC secret | 32+ char hex | Per-school `webhookSecret` in DB |
| Session / TOTP secrets | Random bytes | In-memory / per-user |

---

## 2. JWT secret rotation

**When:** `JWT_SECRET` is committed to git, exposed in logs, or any token compromise is suspected.

### Steps

1. **Generate a new secret**

   ```bash
   node scripts/rotate-jwt-secret.js --confirm
   ```

   Or generate manually:

   ```bash
   openssl rand -hex 64
   ```

2. **Update the secret in Kubernetes**

   ```bash
   kubectl create secret generic stellaredupay \
     --from-literal=JWT_SECRET=<new-secret> \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. **Roll the backend deployment** to pick up the new secret:

   ```bash
   kubectl rollout restart deployment/backend
   kubectl rollout status deployment/backend
   ```

4. **Invalidate all active sessions** — existing JWTs signed with the old secret will immediately become invalid once the deployment rolls. Users will be signed out and must re-authenticate.

5. **Verify** — confirm the `/health` endpoint returns 200 and that a fresh login succeeds.

6. **Record** — document the rotation date and reason in the incident log.

---

## 3. Stellar signer secret key rotation

**When:** A Stellar secret key (56-char Base32 starting with `S`) is committed or suspected leaked.

### Steps

1. **Identify the exposed key** — check `git log -p` or the gitleaks report for the exact key value.

2. **Generate a new Stellar keypair**

   ```bash
   node -e "const { Keypair } = require('@stellar/stellar-sdk'); const kp = Keypair.random(); console.log('Public:', kp.publicKey()); console.log('Secret:', kp.secret());"
   ```

3. **Run the signer key rotation script** to re-encrypt all school records under the new master key:

   ```bash
   SIGNER_MASTER_KEY_OLD=<old-master-key> \
   SIGNER_MASTER_KEY=<new-master-key> \
   node scripts/rotate-signer-master-key.js --confirm
   ```

4. **Update Kubernetes secrets**

   ```bash
   kubectl create secret generic stellaredupay \
     --from-literal=SIGNER_MASTER_KEY=<new-master-key> \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

5. **Roll the deployment**

   ```bash
   kubectl rollout restart deployment/backend
   kubectl rollout status deployment/backend
   ```

6. **Revoke the exposed Stellar account** on the network if necessary — merge remaining XLM to a safe account and stop using the compromised keypair.

7. **Verify** — confirm payment flows work end-to-end on staging before marking resolved.

---

## 4. MongoDB credential rotation

**When:** `MONGO_ROOT_USERNAME` or `MONGO_ROOT_PASSWORD` is exposed.

### Steps

1. Connect to the MongoDB primary as an admin user and change the password:

   ```bash
   mongosh "mongodb://localhost:27017" -u <admin> -p <old-password> --authenticationDatabase admin \
     --eval "db.getSiblingDB('admin').changeUserPassword('<username>', '<new-password>')"
   ```

2. Update the `MONGO_ROOT_PASSWORD` / `MONGO_URI` Kubernetes secret and roll the backend.

3. Update the `BACKUP_NOTIFY_TOKEN` and backup service credentials if they share the same secret.

---

## 5. Webhook HMAC secret rotation

**When:** A `webhookSecret` for a school is compromised.

### Steps

1. Generate a new 32-byte hex secret:

   ```bash
   openssl rand -hex 32
   ```

2. Update the school record in MongoDB:

   ```js
   db.schools.updateOne({ _id: ObjectId('<school-id>') }, { $set: { webhookSecret: '<new-secret>' } })
   ```

3. Notify the school's webhook consumer to update their HMAC validation key.

---

## 6. After any rotation

- [ ] Rotate the secret in all relevant environments (staging and production).
- [ ] Update the secret in Kubernetes / your secrets manager.
- [ ] Roll affected deployments.
- [ ] Scan git history for any other occurrences: `node scripts/scan-repo-secrets.js`.
- [ ] File an incident report if the secret was confirmed leaked externally.
- [ ] Add an entry to `security-exceptions.json` if the leaked value appears in test fixtures that cannot be changed (with a `reason` explaining it is no longer active).
- [ ] Notify affected users or downstream systems as appropriate.

---

## 7. Preventing future leaks

- Run `npm run prepare` after cloning to install the gitleaks pre-commit hook.
- Never commit `.env` files — use `.env.example` with placeholder values only.
- Use `kubectl create secret` or a secrets manager rather than storing real secrets in YAML files.
- Review `docs/security.md` for the full threat model.
