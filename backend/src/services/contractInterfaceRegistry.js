'use strict';

/**
 * Contract Interface Registry and Versioning Policy (Issue #54).
 *
 * Clients need a stable way to identify contract versions and supported
 * entry points. This module defines:
 *   1. Stable interface IDs for every entry point, enabling client discovery.
 *   2. Semantic compatibility rules (major = breaking, minor = additive, patch = bugfix).
 *   3. Migration strategy for incompatible upgrades (via deprecation timeline).
 *   4. Deprecation deadline calculator (default 90 days).
 *
 * Design:
 *   - `discoverInterfaces()` lets any client enumerate supported interfaces without
 *     out-of-band documentation.
 *   - `isCompatibleUpgrade(from, to)` can be called before applying an upgrade to
 *     confirm the change will not break existing clients.
 *   - Interface IDs are stable strings; they MUST NOT change between compatible
 *     versions of the same interface.
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Current canonical version of the contract interface set.
 * Follows semantic versioning (MAJOR.MINOR.PATCH).
 */
const CONTRACT_VERSION = '1.0.0';

/**
 * Compatibility policy definitions.
 * A MAJOR bump signals a breaking change; clients must re-negotiate.
 * A MINOR bump adds new entry points; existing clients continue to work.
 * A PATCH bump fixes behaviour without changing signatures.
 */
const COMPATIBILITY_POLICY = Object.freeze({
  MAJOR: 'breaking',
  MINOR: 'additive',
  PATCH: 'bugfix',
});

/**
 * Number of calendar days from a deprecation announcement until an interface
 * version is removed. This gives integrators a firm migration deadline.
 */
const DEPRECATION_TIMELINE_DAYS = 90;

// ---------------------------------------------------------------------------
// Interface ID registry
// ---------------------------------------------------------------------------

class UnknownInterfaceError extends Error {
  /**
   * @param {string} interfaceId  The unknown interface ID.
   */
  constructor(interfaceId) {
    super(`Unknown interface ID: "${interfaceId}". Use discoverInterfaces() to list supported IDs.`);
    this.name = 'UnknownInterfaceError';
    this.interfaceId = interfaceId;
  }
}

/**
 * Stable interface ID constants.
 * Each constant maps one-to-one to an entry point from PRIVILEGED_ENTRY_POINTS.
 * The suffix _V1 will be incremented (e.g. _V2) only on a breaking change to
 * that specific entry point's signature; other interfaces remain at _V1.
 */
const INTERFACE_IDS = Object.freeze({
  VERSION: 'IFACE_VERSION_V1',
  INITIALIZE: 'IFACE_INITIALIZE_V1',
  DEPOSIT: 'IFACE_DEPOSIT_V1',
  RELEASE: 'IFACE_RELEASE_V1',
  REFUND: 'IFACE_REFUND_V1',
  DISPUTE: 'IFACE_DISPUTE_V1',
  RESOLVE_DISPUTE: 'IFACE_RESOLVE_DISPUTE_V1',
  PAUSE: 'IFACE_PAUSE_V1',
  UNPAUSE: 'IFACE_UNPAUSE_V1',
  UPDATE_CONFIG: 'IFACE_UPDATE_CONFIG_V1',
  ROTATE_SIGNER: 'IFACE_ROTATE_SIGNER_V1',
});

// Internal registry — populated at module load time via registerInterface().
const _registry = new Map();

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

/**
 * Registers an interface specification in the registry.
 *
 * @param {string} interfaceId  Stable interface ID (from INTERFACE_IDS).
 * @param {object} spec         Interface specification.
 * @param {string} spec.entryPoint   Name of the contract entry point.
 * @param {string} spec.version      Semantic version string.
 * @param {string} spec.description  Human-readable description.
 * @param {object} [spec.input]      Input schema summary.
 * @param {object} [spec.output]     Output schema summary.
 * @param {boolean} [spec.deprecated] Whether this interface is deprecated.
 * @param {string}  [spec.deprecatedAt] ISO date string when deprecation started.
 */
function registerInterface(interfaceId, spec) {
  if (!interfaceId || typeof interfaceId !== 'string') {
    throw new TypeError('interfaceId must be a non-empty string');
  }
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('spec must be an object');
  }
  _registry.set(interfaceId, {
    interfaceId,
    entryPoint: spec.entryPoint,
    version: spec.version || CONTRACT_VERSION,
    description: spec.description || '',
    input: spec.input || null,
    output: spec.output || null,
    deprecated: spec.deprecated || false,
    deprecatedAt: spec.deprecatedAt || null,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all registered interface specifications.
 * Clients call this to discover which entry points are available and what
 * version they are at, without requiring out-of-band documentation.
 *
 * @returns {object[]} Array of interface specification objects.
 */
function discoverInterfaces() {
  return Array.from(_registry.values());
}

/**
 * Validates that an interface ID is known.
 *
 * @param {string} interfaceId
 * @returns {true}
 * @throws {UnknownInterfaceError} When the ID is not registered.
 */
function validateInterfaceId(interfaceId) {
  if (!_registry.has(interfaceId)) {
    throw new UnknownInterfaceError(interfaceId);
  }
  return true;
}

/**
 * Retrieves the specification for a known interface ID.
 *
 * @param {string} interfaceId
 * @returns {object} Interface specification.
 * @throws {UnknownInterfaceError}
 */
function getInterface(interfaceId) {
  validateInterfaceId(interfaceId);
  return _registry.get(interfaceId);
}

/**
 * Evaluates whether upgrading from `fromVersion` to `toVersion` is compatible.
 *
 * Rules:
 *   - Same version → compatible (no-op).
 *   - PATCH increment → compatible.
 *   - MINOR increment → compatible (additive only).
 *   - MAJOR increment → incompatible (breaking change, clients must re-negotiate).
 *
 * @param {string} fromVersion  Current version (e.g. '1.0.0').
 * @param {string} toVersion    Proposed new version (e.g. '1.1.0').
 * @returns {{ compatible: boolean, reason: string, policy: string }}
 */
function isCompatibleUpgrade(fromVersion, toVersion) {
  if (!fromVersion || !toVersion) {
    return {
      compatible: false,
      reason: 'Both fromVersion and toVersion are required.',
      policy: COMPATIBILITY_POLICY.MAJOR,
    };
  }

  const parseSemver = (v) => {
    const match = String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), patch: parseInt(match[3], 10) };
  };

  const from = parseSemver(fromVersion);
  const to = parseSemver(toVersion);

  if (!from || !to) {
    return {
      compatible: false,
      reason: `Invalid semantic version format. Received fromVersion="${fromVersion}", toVersion="${toVersion}".`,
      policy: COMPATIBILITY_POLICY.MAJOR,
    };
  }

  if (to.major !== from.major) {
    return {
      compatible: false,
      reason: `Major version mismatch: upgrading from ${fromVersion} to ${toVersion} is a breaking change (major version ${from.major} → ${to.major}). Existing clients MUST be updated before deploying this upgrade.`,
      policy: COMPATIBILITY_POLICY.MAJOR,
    };
  }

  if (to.minor > from.minor) {
    return {
      compatible: true,
      reason: `Minor version increment (${fromVersion} → ${toVersion}): additive change. Existing clients continue to work.`,
      policy: COMPATIBILITY_POLICY.MINOR,
    };
  }

  if (to.patch > from.patch) {
    return {
      compatible: true,
      reason: `Patch version increment (${fromVersion} → ${toVersion}): bugfix only. No signature changes.`,
      policy: COMPATIBILITY_POLICY.PATCH,
    };
  }

  // Same version or downgrade
  if (to.major === from.major && to.minor === from.minor && to.patch === from.patch) {
    return {
      compatible: true,
      reason: `Same version (${fromVersion}). No change.`,
      policy: COMPATIBILITY_POLICY.PATCH,
    };
  }

  return {
    compatible: false,
    reason: `Downgrade from ${fromVersion} to ${toVersion} is not permitted.`,
    policy: COMPATIBILITY_POLICY.MAJOR,
  };
}

/**
 * Calculates the deprecation deadline for an interface that was deprecated on
 * a given date.
 *
 * @param {string|Date} deprecatedAt  ISO 8601 date string or Date object.
 * @param {number} [timelineDays=DEPRECATION_TIMELINE_DAYS]
 * @returns {Date} The deadline date after which the interface may be removed.
 */
function getDeprecationDeadline(deprecatedAt, timelineDays = DEPRECATION_TIMELINE_DAYS) {
  const start = new Date(deprecatedAt);
  if (isNaN(start.getTime())) {
    throw new TypeError(`Invalid deprecatedAt value: "${deprecatedAt}"`);
  }
  const deadline = new Date(start);
  deadline.setDate(deadline.getDate() + timelineDays);
  return deadline;
}

/**
 * Returns the INTERFACE_IDS constant for external reference.
 * Clients can use this to resolve interface IDs without pattern-matching strings.
 */
function getInterfaceIds() {
  return INTERFACE_IDS;
}

// ---------------------------------------------------------------------------
// Bootstrap: register all v1 interfaces at module load time
// ---------------------------------------------------------------------------

registerInterface(INTERFACE_IDS.VERSION, {
  entryPoint: 'version',
  version: CONTRACT_VERSION,
  description:
    'Read-only (view) function that returns the deployed contract\'s semantic version string. ' +
    'Requires no authorisation and modifies no state. Used by the backend compatibility adapter ' +
    '(contractVersionAdapter.js) to determine which call-builder set to use at runtime.',
  input: null,
  output: { version: 'string' },
});

registerInterface(INTERFACE_IDS.INITIALIZE, {
  entryPoint: 'initialize',
  version: CONTRACT_VERSION,
  description: 'Initialise the contract storage and accepted asset list. Called once by the deployer.',
  input: { admin: 'address', acceptedAssets: 'array' },
  output: { success: 'bool' },
});

registerInterface(INTERFACE_IDS.DEPOSIT, {
  entryPoint: 'deposit',
  version: CONTRACT_VERSION,
  description: 'Lock funds in escrow. Payer must authorise this call. Memo must contain the student ID.',
  input: { payer: 'address', beneficiary: 'address', arbiter: 'address', amount: 'i128', asset: 'asset', memo: 'string', timeoutLedger: 'u32' },
  output: { escrowId: 'bytes32' },
});

registerInterface(INTERFACE_IDS.RELEASE, {
  entryPoint: 'release',
  version: CONTRACT_VERSION,
  description: 'Release escrowed funds to the beneficiary. Caller must be beneficiary or arbiter.',
  input: { escrowId: 'bytes32', caller: 'address' },
  output: { releasedAmount: 'i128' },
});

registerInterface(INTERFACE_IDS.REFUND, {
  entryPoint: 'refund',
  version: CONTRACT_VERSION,
  description: 'Return escrowed funds to the payer. Caller must be arbiter.',
  input: { escrowId: 'bytes32', caller: 'address', reason: 'string' },
  output: { refundedAmount: 'i128' },
});

registerInterface(INTERFACE_IDS.DISPUTE, {
  entryPoint: 'dispute',
  version: CONTRACT_VERSION,
  description: 'Open a dispute on a funded escrow. Only the payer may open a dispute.',
  input: { escrowId: 'bytes32', initiator: 'address', reason: 'string' },
  output: { disputeId: 'bytes32' },
});

registerInterface(INTERFACE_IDS.RESOLVE_DISPUTE, {
  entryPoint: 'resolveDispute',
  version: CONTRACT_VERSION,
  description: 'Resolve an open dispute. Arbiter may release or refund.',
  input: { escrowId: 'bytes32', arbiter: 'address', resolution: 'enum(release|refund)' },
  output: { finalState: 'string' },
});

registerInterface(INTERFACE_IDS.PAUSE, {
  entryPoint: 'pause',
  version: CONTRACT_VERSION,
  description: 'Pause the contract, blocking all state-changing operations except unpause.',
  input: { caller: 'address', reason: 'string' },
  output: { paused: 'bool' },
});

registerInterface(INTERFACE_IDS.UNPAUSE, {
  entryPoint: 'unpause',
  version: CONTRACT_VERSION,
  description: 'Resume normal contract operation. Only the OWNER may call this.',
  input: { caller: 'address' },
  output: { paused: 'bool' },
});

registerInterface(INTERFACE_IDS.UPDATE_CONFIG, {
  entryPoint: 'updateConfig',
  version: CONTRACT_VERSION,
  description: 'Update contract configuration (e.g. accepted assets, fee caps). OWNER only.',
  input: { caller: 'address', configKey: 'string', configValue: 'bytes' },
  output: { updated: 'bool' },
});

registerInterface(INTERFACE_IDS.ROTATE_SIGNER, {
  entryPoint: 'rotateSigner',
  version: CONTRACT_VERSION,
  description: 'Replace a signer key. Part of the key-rotation runbook.',
  input: { caller: 'address', oldSigner: 'address', newSigner: 'address' },
  output: { rotated: 'bool' },
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  CONTRACT_VERSION,
  COMPATIBILITY_POLICY,
  DEPRECATION_TIMELINE_DAYS,
  INTERFACE_IDS,

  // Errors
  UnknownInterfaceError,

  // Functions
  registerInterface,
  discoverInterfaces,
  validateInterfaceId,
  getInterface,
  isCompatibleUpgrade,
  getDeprecationDeadline,
  getInterfaceIds,
};
