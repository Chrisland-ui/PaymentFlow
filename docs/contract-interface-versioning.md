# Contract Interface and Versioning Policy

**Scope:** Soroban escrow contract interfaces, semantic compatibility rules,
migration strategy, and deprecation timelines.  
**Related:** `backend/src/services/contractInterfaceRegistry.js`,
`docs/soroban-escrow-requirements.md`

---

## Table of Contents

- [Overview](#overview)
- [Interface Discovery](#interface-discovery)
- [Interface IDs](#interface-ids)
- [Semantic Compatibility Rules](#semantic-compatibility-rules)
- [Version Policy Table](#version-policy-table)
- [Migration Strategy for Incompatible Upgrades](#migration-strategy-for-incompatible-upgrades)
- [Deprecation Timeline](#deprecation-timeline)
- [Integration Guide for Clients](#integration-guide-for-clients)

---

## Overview

The PaymentFlow escrow contract exposes a set of versioned entry points.
Each entry point is assigned a stable **interface ID** (e.g. `IFACE_DEPOSIT_V1`)
that clients can use for discovery and compatibility checks without relying on
positional argument matching or ad-hoc string comparisons.

The `contractInterfaceRegistry.js` module is the single source of truth for:

- Which interfaces are currently registered and at what version.
- Whether a proposed upgrade is compatible with the current version.
- When a deprecated interface will be removed.

---

## Interface Discovery

Any client can enumerate supported interfaces at any time using `discoverInterfaces()`:

```js
const { discoverInterfaces } = require('./backend/src/services/contractInterfaceRegistry');

const interfaces = discoverInterfaces();
// Returns an array of { interfaceId, entryPoint, version, description, input, output, deprecated }
```

Example response:

```json
[
  {
    "interfaceId": "IFACE_DEPOSIT_V1",
    "entryPoint": "deposit",
    "version": "1.0.0",
    "description": "Lock funds in escrow. Payer must authorise this call.",
    "input": { "payer": "address", "beneficiary": "address", "amount": "i128", "memo": "string" },
    "output": { "escrowId": "bytes32" },
    "deprecated": false
  }
]
```

Clients should call `discoverInterfaces()` after connecting to the contract to
confirm the entry points they depend on are present before executing any transaction.

---

## Interface IDs

| Interface ID | Entry Point | Description |
|---|---|---|
| `IFACE_INITIALIZE_V1` | `initialize` | One-time contract setup by deployer |
| `IFACE_DEPOSIT_V1` | `deposit` | Lock funds in escrow |
| `IFACE_RELEASE_V1` | `release` | Release funds to beneficiary |
| `IFACE_REFUND_V1` | `refund` | Return funds to payer |
| `IFACE_DISPUTE_V1` | `dispute` | Open a dispute on a funded escrow |
| `IFACE_RESOLVE_DISPUTE_V1` | `resolveDispute` | Resolve a dispute (arbiter only) |
| `IFACE_PAUSE_V1` | `pause` | Pause all contract operations |
| `IFACE_UNPAUSE_V1` | `unpause` | Resume normal operations (OWNER only) |
| `IFACE_UPDATE_CONFIG_V1` | `updateConfig` | Update contract configuration |
| `IFACE_ROTATE_SIGNER_V1` | `rotateSigner` | Replace a signer key |

Interface IDs are stable: the suffix `_V1` is only incremented when a **breaking
change** is made to that specific entry point's signature. All other interfaces
remain at `_V1` across compatible upgrades.

### Validating an interface ID

```js
const { validateInterfaceId, UnknownInterfaceError } = require('./contractInterfaceRegistry');

try {
  validateInterfaceId('IFACE_DEPOSIT_V1'); // returns true
  validateInterfaceId('IFACE_UNKNOWN');    // throws UnknownInterfaceError
} catch (e) {
  if (e instanceof UnknownInterfaceError) {
    console.error('Interface not supported:', e.interfaceId);
  }
}
```

---

## Semantic Compatibility Rules

The contract version follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

| Version bump | Category | Client impact |
|---|---|---|
| `PATCH` (e.g. 1.0.0 → 1.0.1) | `bugfix` | None — no signature changes |
| `MINOR` (e.g. 1.0.0 → 1.1.0) | `additive` | New entry points added; existing clients unaffected |
| `MAJOR` (e.g. 1.0.0 → 2.0.0) | `breaking` | Existing clients MUST be updated before deploying |

Use `isCompatibleUpgrade(fromVersion, toVersion)` to check before applying an upgrade:

```js
const { isCompatibleUpgrade } = require('./contractInterfaceRegistry');

const result = isCompatibleUpgrade('1.0.0', '2.0.0');
// { compatible: false, reason: 'Major version mismatch: ...', policy: 'breaking' }

const result2 = isCompatibleUpgrade('1.0.0', '1.1.0');
// { compatible: true, reason: 'Minor version increment ...', policy: 'additive' }
```

**Rule:** A major version upgrade MUST be rejected if any client is known to be on
the current major version. Use the deprecation timeline (see below) to coordinate
migration.

---

## Version Policy Table

| Scenario | Action required | Example |
|---|---|---|
| Bug fix in existing logic | PATCH bump; no client change needed | 1.0.0 → 1.0.1 |
| New optional entry point | MINOR bump; clients may adopt when ready | 1.0.0 → 1.1.0 |
| Renamed parameter | MAJOR bump; all clients must update | 1.x.x → 2.0.0 |
| Removed entry point | MAJOR bump + 90-day deprecation period | 1.x.x → 2.0.0 |
| Changed return type | MAJOR bump | 1.x.x → 2.0.0 |

---

## Migration Strategy for Incompatible Upgrades

When a MAJOR version bump is required:

1. **Announce deprecation.** Mark the current interface as `deprecated: true` in the
   registry with a `deprecatedAt` timestamp. Run `getDeprecationDeadline(deprecatedAt)`
   to compute the removal date.

2. **Deploy the new version in parallel.** For a transition window, both `v1` and `v2`
   entry points are accessible. Clients migrate at their own pace within the 90-day window.

3. **Notify integrators.** The deprecation notice and deadline must appear in:
   - The OpenAPI specification (`GET /api/docs.json`).
   - The `CHANGELOG.md` under a `## Breaking Changes` section.
   - A direct notification to registered webhook consumers.

4. **Remove the deprecated interface** after the deadline. Increment the major version.
   Verify using `isCompatibleUpgrade` that the new version is flagged as breaking.

5. **Update client code** — the backend's `transactionPollingService.js` and any
   frontend API clients that invoke contract entry points directly.

---

## Deprecation Timeline

The default deprecation window is **90 days** (`DEPRECATION_TIMELINE_DAYS = 90`).

```js
const { getDeprecationDeadline } = require('./contractInterfaceRegistry');

const deadline = getDeprecationDeadline('2026-01-01T00:00:00.000Z');
// Returns Date: 2026-04-01 (90 days later)
```

Clients that have not migrated by the deadline will receive `UNKNOWN_INTERFACE`
errors and must update before interacting with the contract.

To request an extension, open an issue with the `deprecation-extension` label
and provide a migration timeline. Extensions are granted at the platform operator's
discretion and documented in the issue.

---

## Integration Guide for Clients

### Minimum integration steps

1. Call `discoverInterfaces()` and confirm `IFACE_DEPOSIT_V1` and `IFACE_RELEASE_V1`
   are present.
2. Store the `version` field from the registry response in your integration metadata.
3. Before each deployment, call `isCompatibleUpgrade(storedVersion, newVersion)` and
   abort if `compatible === false`.
4. Subscribe to webhook events for `contract.version_changed` to receive proactive
   notification of version bumps.

### Error codes

| Code | Meaning |
|---|---|
| `UNKNOWN_INTERFACE` | Interface ID not found in registry (client must upgrade) |
| `INCOMPATIBLE_VERSION` | Major version mismatch detected before upgrade execution |
| `INTERFACE_DEPRECATED` | Interface is deprecated; migration required before deadline |
