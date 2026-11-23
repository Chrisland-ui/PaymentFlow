# Contract Upgrade Failure Recovery Runbook

**Audience:** Platform operators and on-call engineers  
**Scope:** Soroban escrow contract upgrade failures, key loss, and rollback procedures  
**Related:** `backend/src/services/contractUpgradeControls.js`, `docs/smart-contract-threat-model.md` (SC-08)

---

## Table of Contents

- [Overview](#overview)
- [Upgrade Failure Recovery](#upgrade-failure-recovery)
- [Key Loss Recovery](#key-loss-recovery)
- [Rollback Procedure](#rollback-procedure)
- [Post-Incident Verification](#post-incident-verification)
- [Escalation Path](#escalation-path)

---

## Overview

Contract upgrades on Stellar/Soroban are irreversible on-chain transactions.
A failed or mis-deployed upgrade can leave the contract in an inconsistent state,
lock user funds, or expose authorization bypasses.

This runbook covers three distinct failure scenarios:

| Scenario | Impact | Recovery Time Estimate |
|----------|--------|------------------------|
| Upgrade execution failure (WASM error) | Funds may be locked | 15–60 min |
| Upgrade with incorrect logic deployed | Potential fund loss | 30–120 min |
| OWNER key loss | Upgrade/unpause path unavailable | 4–24 hours (threshold procedure) |

---

## Upgrade Failure Recovery

### 1. Detect the failure

The upgrade worker calls `executeUpgrade()` and writes the proposal record to the
database. Watch for the `state: EXECUTING` record that never transitions to `COMPLETED`.

```bash
# Check proposal state in the database
mongosh stellaredupay --eval "db.upgradeProposals.findOne({state:'EXECUTING'}, {newContractHash:1,executionStartedAt:1,executor:1})"
```

Prometheus alert: `contract_upgrade_stuck_executing` fires if the record remains
in `EXECUTING` state for more than 10 minutes.

### 2. Pause the contract immediately

If the new contract code is live but behaving incorrectly, pause it to prevent
further state mutations:

```bash
# Via admin API (requires OPERATOR or OWNER JWT)
curl -X POST http://localhost:5000/api/admin/contract/pause \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Upgrade failure detected — pausing for investigation"}'
```

Only `unpause` calls by OWNER will succeed while the contract is paused.
See `getAllowedActionsWhilePaused()` in `contractUpgradeControls.js`.

### 3. Record the rollback

Call `rollbackUpgrade(proposal, reason, rolledBackBy)` to transition the proposal
to `ROLLED_BACK` and append the audit trail:

```js
const { rollbackUpgrade } = require('./backend/src/services/contractUpgradeControls');

const rolled = rollbackUpgrade(executingProposal, 'WASM execution trap at entry point deposit()', ownerKey);
// Persist rolled to the database
```

The rollback record contains `rolledBackAt`, `rolledBackBy`, `reason`, and
`previousState` for audit purposes.

### 4. Investigate root cause

- Compare `newContractHash` in the proposal against the deployed WASM hash from Horizon.
- Review the contract invocation error from Stellar's diagnostic events or the Horizon
  `/transactions/:hash/effects` endpoint.
- Check whether the new contract initialized its storage correctly (no missing
  keys, no failed `soroban_storage` reads).

### 5. Unpause the contract (if original code is intact)

Once you confirm the original contract code is still serving correctly (the upgrade
did not complete on-chain), unpause via OWNER:

```bash
curl -X POST http://localhost:5000/api/admin/contract/unpause \
  -H "Authorization: Bearer $OWNER_TOKEN"
```

This calls `unpauseContract(caller, 'OWNER', pauseRecord)` internally.

---

## Key Loss Recovery

Key loss falls into two categories: **OPERATOR key loss** and **OWNER key loss**.

### OPERATOR key loss

An OPERATOR key compromise or loss affects pause/unpause authority and dispute
resolution. It does **not** affect upgrade authority (OWNER-only).

**Steps:**

1. Pause the contract immediately using the remaining OWNER key.
2. Call `rotateSigner` via the existing `scripts/rotate-signer-key-staged.js`
   workflow to replace the OPERATOR key.
3. Run `scripts/verify-rotation.js` to confirm the new key is active.
4. Unpause the contract.
5. Revoke / invalidate the old OPERATOR key in your key management system.

See `docs/runbooks/signer-key-rotation.md` for the full key-rotation procedure.

### OWNER key loss

OWNER key loss is the most severe scenario because it blocks:

- Unpause (if contract was paused)
- Upgrade proposals and approvals
- `updateConfig` and `rotateSigner` operations

**Steps:**

1. **Assess urgency.** If the contract is currently paused, users cannot interact
   with it. Treat this as P0.

2. **Invoke the threshold recovery procedure.** The upgrade quorum requires at least
   two OWNER keys (`UPGRADE_QUORUM = 2`). If one OWNER key is lost:
   - The remaining OWNER key-holder must immediately propose a new key rotation
     upgrade (`proposeUpgrade` → `approveUpgrade` by themselves and a second
     trusted OWNER key from cold storage).
   - If both OWNER keys are lost, escalate to the Stellar Foundation emergency
     support channel and the platform's legal/trustee contact for cold-storage access.

3. **Document the incident.** Record the key ID, last-known use, and whether the
   key may have been compromised (vs. simply lost). Treat any ambiguous case as
   compromised.

4. **After recovery**, rotate all remaining keys as a precaution.
   See `docs/runbooks/secret-rotation-rollback.md`.

---

## Rollback Procedure

A rollback records the failure reason and prevents re-execution of the same
proposal. It does **not** revert on-chain state — on Stellar, contract code
upgrades are one-way. Use this procedure to document what happened and prevent
re-use of a faulty proposal.

### When to roll back

- The upgrade WASM contained a bug detected before or during execution.
- The upgrade was executed but the contract is producing unexpected behaviour.
- A security vulnerability was discovered in the proposed code.

### Steps

1. Retrieve the proposal from the database:

```bash
mongosh stellaredupay --eval "db.upgradeProposals.findOne({state:{$in:['EXECUTING','APPROVED']}})"
```

2. Call `rollbackUpgrade`:

```js
const rolled = rollbackUpgrade(proposal, 'Reason: storage key collision bug in v1.2.0', 'GOWNER_KEY');
await db.collection('upgradeProposals').replaceOne({ _id: proposal._id }, rolled);
```

3. Create a new proposal with the corrected WASM hash after the root cause is fixed.

4. Audit log entry: the rollback record is written to the `upgradeProposals` collection
   with `state: ROLLED_BACK`, `rollback.reason`, `rollback.rolledBackBy`, and
   `rollback.rolledBackAt`. This satisfies the audit requirement.

---

## Post-Incident Verification

After completing recovery, verify the following before considering the incident closed:

| Check | Command / Method |
|-------|-----------------|
| Contract is unpaused | `GET /health` — `contractPaused: false` |
| No stuck payments in queue | `GET /api/admin/retry-queue` — depth should drain |
| Upgrade proposal state is `ROLLED_BACK` or `COMPLETED` | Check `upgradeProposals` collection |
| New OWNER key is active (if rotated) | `node scripts/verify-rotation.js` |
| Audit log has rollback entry | `GET /api/audit?action=contract_rollback` |
| No open disputes older than SLA | `GET /api/disputes?status=open` |

Run the data consistency check:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:5000/api/consistency
```

If the consistency check reports discrepancies, follow `docs/runbooks/stuck-payments.md`.

---

## Escalation Path

| Tier | Contact | When |
|------|---------|------|
| On-call operator | PagerDuty rotation | Any P1/P0 incident |
| Platform OWNER key-holder | Secure out-of-band channel | OWNER key loss |
| Stellar Foundation support | https://developers.stellar.org/support | Protocol-level issues |
| Legal / trustee | Defined in incident response plan | Both OWNER keys lost |

**Always document the incident timeline in `docs/incident-response-checklist.md`.**
