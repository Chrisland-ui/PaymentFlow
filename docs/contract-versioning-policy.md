# Contract Interface Versioning and Upgrade Policy

**Issue:** [#302](https://github.com/onlyonee1/PaymentFlow/issues/302)  
**Scope:** Soroban contract interfaces, on-chain version storage, upgrade process,
backend compatibility adapter, and minimum notice periods.  
**Related:** `backend/src/services/contractInterfaceRegistry.js`,
`backend/src/services/contractUpgradeControls.js`,
`backend/src/services/contractVersionAdapter.js`,
`docs/contract-interface-versioning.md`,
`docs/soroban-escrow-requirements.md`

---

## Table of Contents

- [Why This Policy Exists](#why-this-policy-exists)
- [Semantic Versioning for Contract Interfaces](#semantic-versioning-for-contract-interfaces)
- [On-Chain Version Storage](#on-chain-version-storage)
- [The `version()` View Function](#the-version-view-function)
- [Upgrade Process](#upgrade-process)
- [Minimum Notice Periods](#minimum-notice-periods)
- [Backend Compatibility Adapter (N / N-1)](#backend-compatibility-adapter-n--n-1)
- [Version Policy Decision Table](#version-policy-decision-table)
- [Deprecation Timeline](#deprecation-timeline)
- [Backend Client Responsibilities](#backend-client-responsibilities)
- [Rollback Policy](#rollback-policy)
- [Policy Exceptions and Overrides](#policy-exceptions-and-overrides)

---

## Why This Policy Exists

Soroban contracts are **immutable once deployed to a given contract ID**. Upgrading
requires deploying new WASM via `contract.upload_wasm` + `contract.update`. If the
new interface is incompatible with the backend client that is already running in
production, payments will stall and funds already in escrow may become inaccessible
until the backend is also updated.

This policy ensures:

1. No contract is deployed to testnet or mainnet without a declared version.
2. The backend always knows what version it is talking to before executing any transaction.
3. Breaking changes follow a mandatory notice period so that operators can coordinate
   backend updates before the new contract goes live.
4. A compatibility adapter exists in the backend so that a rolling upgrade does not
   require a simultaneous code + contract deployment.

---

## Semantic Versioning for Contract Interfaces

The contract interface set follows [Semantic Versioning 2.0.0](https://semver.org/):

```
MAJOR.MINOR.PATCH
```

| Component | When to increment | Impact on clients |
|-----------|-------------------|-------------------|
| `PATCH`   | Bug fix in entry point logic, no signature change | No client change needed |
| `MINOR`   | New entry point added; existing entry points unchanged | Clients may adopt the new entry point when ready |
| `MAJOR`   | Any existing entry point renamed, removed, or has its parameter types changed | All clients **must** update before the new contract is activated |

The current canonical version is stored in `CONTRACT_VERSION` inside
`backend/src/services/contractInterfaceRegistry.js`.

### Version Compatibility Rule

```
isCompatibleUpgrade(fromVersion, toVersion)
```

| Result | Condition |
|--------|-----------|
| `compatible: true, policy: 'bugfix'` | Patch increment |
| `compatible: true, policy: 'additive'` | Minor increment |
| `compatible: false, policy: 'breaking'` | Major increment or downgrade |

**A major version upgrade MUST NOT be deployed while any backend client is still
using the previous major version.**

---

## On-Chain Version Storage

The contract stores its own version as a persistent storage entry under the key
`CONTRACT_VERSION`. This makes the version queryable via a read-only (view) call
without requiring a full interface discovery handshake.

### Storage Schema

```
Key:   "CONTRACT_VERSION"
Type:  String (semantic version, e.g. "1.0.0")
Set:   At `initialize()` call time
Updated: At each WASM upgrade via `update_contract` (must be explicit)
```

The backend reads this value on startup and caches it for the session. If the
on-chain version and the registry version mismatch, the backend logs a warning
and falls back to the adapter layer (see [Backend Compatibility Adapter](#backend-compatibility-adapter-n--n-1)).

---

## The `version()` View Function

Every deployed contract version MUST expose a `version()` read-only (view) entry
point that returns the contract's semantic version string without requiring auth
or modifying state.

### Soroban Rust Signature

```rust
/// Returns the semantic version of this contract's interface set.
/// This is a pure read-only call — it does not require authorisation and
/// does not modify any contract state.
///
/// # Returns
/// A String in the form "MAJOR.MINOR.PATCH" (e.g. "1.0.0").
pub fn version(env: Env) -> String {
    env.storage()
        .instance()
        .get(&Symbol::new(&env, "CONTRACT_VERSION"))
        .unwrap_or_else(|| String::from_str(&env, "unknown"))
}
```

### Backend Query (Node.js / Stellar SDK)

The backend queries the on-chain version via a simulation (no transaction fee):

```js
const { getContractVersion } = require('./contractVersionAdapter');

const onChainVersion = await getContractVersion(contractId, networkPassphrase);
// Returns: "1.0.0"
```

See `backend/src/services/contractVersionAdapter.js` — `getContractVersion()`.

### Why a Dedicated View Function

- Calling `discoverInterfaces()` from the backend's in-memory registry returns the
  **expected** version, not the **deployed** version.
- The `version()` view call is the only authoritative source of truth for what is
  actually running on-chain.
- It can be called at any time with zero gas cost (simulation only), making it
  suitable for health checks and pre-flight compatibility assertions.

---

## Upgrade Process

The full upgrade lifecycle is governed by `contractUpgradeControls.js`. The steps
below are mandatory — skipping any step is a policy violation.

### Step 1: Announce the New Version

- Open a GitHub issue or PR describing the change.
- Classify as `PATCH`, `MINOR`, or `MAJOR` bump.
- For `MAJOR` bumps: notify all known webhook consumers and registered integrators
  at least **30 days** before deployment (see [Minimum Notice Periods](#minimum-notice-periods)).

### Step 2: Build and Hash the New WASM

```bash
cargo build --release --target wasm32-unknown-unknown
sha256sum target/wasm32-unknown-unknown/release/paymentflow_escrow.wasm
```

Record the SHA-256 hash. This hash is required for the upgrade proposal.

### Step 3: Propose the Upgrade (OWNER only)

```js
const { proposeUpgrade } = require('./contractUpgradeControls');

const proposal = proposeUpgrade(
  ownerPublicKey,
  'OWNER',
  '3a7f9b12...', // SHA-256 of the new WASM
  {
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    description: 'Breaking change: deposit() now requires schoolId param',
    migrationNotes: 'See docs/contract-versioning-policy.md#upgrade-process',
  }
);
```

### Step 4: Collect Approvals (quorum = 2)

A second OWNER must approve before execution:

```js
const { approveUpgrade } = require('./contractUpgradeControls');
const approvedProposal = approveUpgrade(proposal, secondOwnerKey, 'OWNER');
```

### Step 5: Deploy New WASM to Contract

Only after `proposal.state === 'APPROVED'`:

1. Upload the new WASM to the Stellar network.
2. Call `contract.update()` on the existing contract ID with the new WASM hash.
3. The contract's storage persists — only the code changes.

### Step 6: Execute Upgrade Record

```js
const { executeUpgrade } = require('./contractUpgradeControls');
const executing = executeUpgrade(approvedProposal, ownerPublicKey, 'OWNER');
```

### Step 7: Redirect Backend Client

1. Update `CONTRACT_VERSION` in `contractInterfaceRegistry.js` to the new version.
2. Update the compatibility adapter (`contractVersionAdapter.js`) to add the new version's
   call builders under the new major version key.
3. Deploy the updated backend. The adapter will continue supporting N-1 contracts
   during the transition window.

### Step 8: Migrate State (if required)

For MAJOR upgrades that change storage layout:

1. Write a one-off migration script under `backend/migrations/`.
2. Run the migration against the deployed contract via simulation first.
3. Execute on-chain after confirming simulation success.
4. Record migration in `CHANGELOG.md` under `## Breaking Changes`.

### Step 9: Remove Deprecated Entry Points

After the deprecation deadline has passed and all clients have confirmed migration,
the deprecated entry points may be removed in the next MAJOR bump.

---

## Minimum Notice Periods

| Change type | Minimum notice period | Announcement channel |
|-------------|----------------------|----------------------|
| `PATCH`     | None — deployable immediately after approval | `CHANGELOG.md` |
| `MINOR`     | 7 days | `CHANGELOG.md` + webhook notification |
| `MAJOR`     | **30 days** | `CHANGELOG.md` + webhook notification + direct email to registered integrators |

The 30-day period for breaking changes begins on the date the GitHub issue is opened,
not the date of deployment.

**Exception:** A security fix that requires a breaking interface change may have this
period waived by the platform operator with written justification recorded in the issue.

---

## Backend Compatibility Adapter (N / N-1)

The compatibility adapter (`backend/src/services/contractVersionAdapter.js`) allows
the backend to communicate with both the current (N) and the previous major (N-1)
version of the contract during a rolling upgrade window.

### How It Works

```
Backend process
       │
       ▼
contractVersionAdapter.js
       │
       ├─── getContractVersion(contractId) ──► on-chain version()
       │
       ├─── if version matches N  ──► use v2 call builders
       │
       └─── if version matches N-1 ──► use v1 call builders (legacy path)
```

### Adapter API

```js
const adapter = require('./contractVersionAdapter');

// Query the on-chain version
const version = await adapter.getContractVersion(contractId, networkPassphrase);

// Build a deposit call — automatically selects v1 or v2 builder
const callArgs = adapter.buildDepositArgs(version, {
  payer, beneficiary, amount, memo, timeoutLedger
});

// Check if the deployed version is within supported range
const check = adapter.assertVersionSupported(version);
// { supported: true }  or throws UnsupportedContractVersionError
```

### Supported Version Range

The adapter maintains explicit builders for the **current (N)** and **previous (N-1)**
major versions:

```js
const SUPPORTED_VERSIONS = {
  '1': buildersV1,   // N-1 — supported until deprecation deadline
  '2': buildersV2,   // N   — current
};
```

When a third major version is released (`v3`), the `v1` builders are removed from
`SUPPORTED_VERSIONS`. The backend then supports only `v2` and `v3`.

### Unsupported Version Behaviour

If the on-chain version is outside the supported range, the adapter throws
`UnsupportedContractVersionError`. The calling service should:

1. Log the error with the on-chain version for operator visibility.
2. Return `503 Service Unavailable` from the affected API endpoint.
3. Alert on the `contract_version_mismatch` metric.

### Version Mismatch Metric

The adapter emits a Prometheus counter on every version check:

```
contract_version_checks_total{version, supported}
```

An alert should fire when `supported="false"` count exceeds 0.

---

## Version Policy Decision Table

| Scenario | Version bump | Client action required | Deployment order |
|----------|--------------|------------------------|------------------|
| Fix rounding error in `release()` | PATCH (1.0.0 → 1.0.1) | None | Contract first, then backend (optional) |
| Add new `getBatchStatus()` entry point | MINOR (1.0.0 → 1.1.0) | None (may adopt new entry point later) | Contract first, then backend |
| Rename `deposit()` parameter `amount` → `amountStroops` | MAJOR (1.x.x → 2.0.0) | Backend must update call builders | Backend adapter first, then contract, then backend cleanup |
| Remove deprecated `initiatePayment()` entry point | MAJOR | Backend must remove usage | After deprecation deadline |
| Change `release()` return type from `i128` to `struct` | MAJOR | Backend must update response parsing | Backend adapter first, then contract |
| Security patch requiring signature change | MAJOR (expedited) | Immediate backend update with 0-day notice (with operator sign-off) | Backend adapter first |

---

## Deprecation Timeline

The default deprecation window before an interface is removed is **90 days**.

```js
const { getDeprecationDeadline } = require('./contractInterfaceRegistry');

const deadline = getDeprecationDeadline('2026-10-20T00:00:00.000Z');
// → 2027-01-18 (90 days later)
```

### Deprecation Process

1. Mark the interface as `deprecated: true` in the registry with `deprecatedAt` timestamp.
2. Publish a deprecation notice in `CHANGELOG.md`.
3. Add a deprecation warning to the affected API endpoint responses:
   ```json
   { "warning": "IFACE_DEPOSIT_V1 is deprecated. Migrate to IFACE_DEPOSIT_V2 by 2027-01-18." }
   ```
4. After the deadline, the entry point may be removed in the next MAJOR release.

### Extension Requests

Integrators that cannot meet the 90-day deadline may request an extension by opening
a GitHub issue with the `deprecation-extension` label and providing:

- The reason migration cannot complete by the deadline.
- A proposed revised deadline with a migration plan.

Extensions are granted at the platform operator's discretion and recorded in the
relevant deprecation issue.

---

## Backend Client Responsibilities

Any service in the backend that calls contract entry points must:

1. **On startup**, call `getContractVersion()` via the adapter and log the result.
2. **Before any transaction**, call `adapter.assertVersionSupported(version)` to
   confirm the on-chain contract is within the supported range.
3. **Use the adapter** (`buildDepositArgs`, `buildReleaseArgs`, etc.) rather than
   constructing call arguments inline. This ensures the correct parameter set for
   the deployed contract version is used.
4. **Subscribe to the `contract.version_changed` webhook event** to receive proactive
   notification of version bumps and re-check compatibility.

Services that call contract entry points today:

| Service | Entry points used |
|---------|-------------------|
| `stellarService.js` | `deposit`, `release`, `refund` (via `StellarTransactionManager`) |
| `transactionPollingService.js` | read-only observer (no direct contract calls) |
| `contractInterfaceRegistry.js` | `discoverInterfaces` (off-chain registry, not on-chain) |

---

## Rollback Policy

If an upgrade fails after execution:

1. Call `rollbackUpgrade(proposal, reason, rolledBackBy)` to record the failure.
2. The previous WASM cannot be automatically restored — Stellar contract upgrades are
   one-way by default. A new upgrade proposal must be created with the previous WASM
   hash to effectively downgrade.
3. If the contract is in a broken state, call `pauseContract()` immediately to prevent
   further damage.
4. Follow the runbook at `docs/runbooks/contract-upgrade-failure.md`.

---

## Policy Exceptions and Overrides

All exceptions to this policy (emergency security patches, notice period waivers,
extension grants) must be:

1. Approved by at least one OWNER.
2. Documented in the relevant GitHub issue with a justification.
3. Recorded in `CHANGELOG.md` with a `[POLICY EXCEPTION]` prefix.
