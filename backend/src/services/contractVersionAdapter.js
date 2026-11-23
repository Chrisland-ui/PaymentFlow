'use strict';

/**
 * Contract Version Adapter (Issue #302).
 *
 * Provides two capabilities required by the versioning policy:
 *
 * 1. `getContractVersion(contractId, networkPassphrase)`
 *    Queries the deployed Soroban contract's `version()` view function to
 *    determine what interface version is actually running on-chain. This is
 *    the authoritative source of truth, distinct from the in-memory registry.
 *
 * 2. N / N-1 compatibility adapter
 *    Exposes call-builder functions (`buildDepositArgs`, `buildReleaseArgs`,
 *    `buildRefundArgs`) that automatically select the correct parameter set
 *    for the deployed contract version. This allows the backend to communicate
 *    with both the current (N) and previous major (N-1) contract version during
 *    a rolling upgrade window, without requiring a simultaneous backend + contract
 *    deployment.
 *
 * Usage:
 *
 *   const adapter = require('./contractVersionAdapter');
 *
 *   // Discover on-chain version (no transaction, simulation only)
 *   const version = await adapter.getContractVersion(contractId, networkPassphrase);
 *
 *   // Assert the on-chain version is within supported range
 *   adapter.assertVersionSupported(version);
 *
 *   // Build call args for any supported version
 *   const args = adapter.buildDepositArgs(version, { payer, beneficiary, amount, memo, timeoutLedger });
 *
 * Adding a new major version (v3):
 *   1. Add a `buildersV3` object below with the v3 parameter layouts.
 *   2. Add `'3': buildersV3` to SUPPORTED_VERSIONS.
 *   3. Remove `'1': buildersV1` from SUPPORTED_VERSIONS (v1 is no longer N-1).
 *   4. Update CONTRACT_VERSION in contractInterfaceRegistry.js.
 *   5. Document the change in CHANGELOG.md and docs/contract-versioning-policy.md.
 */

const { CONTRACT_VERSION } = require('./contractInterfaceRegistry');

// ---------------------------------------------------------------------------
// Supported version range
// ---------------------------------------------------------------------------

/**
 * Major version of the currently deployed contract interface set.
 * Derived from the registry's CONTRACT_VERSION.
 */
const CURRENT_MAJOR = parseInt(CONTRACT_VERSION.split('.')[0], 10);

/**
 * Minimum supported major version (N-1).
 * The adapter will reject any on-chain version older than this.
 */
const MIN_SUPPORTED_MAJOR = Math.max(1, CURRENT_MAJOR - 1);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class UnsupportedContractVersionError extends Error {
  /**
   * @param {string} onChainVersion  The version string read from the contract.
   * @param {string} supportedRange  Human-readable description of what is supported.
   */
  constructor(onChainVersion, supportedRange) {
    super(
      `On-chain contract version "${onChainVersion}" is outside the supported range (${supportedRange}). ` +
      `Update the backend or redeploy the contract to a supported version.`
    );
    this.name = 'UnsupportedContractVersionError';
    this.onChainVersion = onChainVersion;
    this.supportedRange = supportedRange;
  }
}

class ContractVersionQueryError extends Error {
  /**
   * @param {string} contractId  Contract ID that could not be queried.
   * @param {Error}  cause       Underlying error.
   */
  constructor(contractId, cause) {
    super(`Failed to query version() from contract "${contractId}": ${cause.message}`);
    this.name = 'ContractVersionQueryError';
    this.contractId = contractId;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Call builders — v1 (N-1)
// ---------------------------------------------------------------------------

/**
 * Parameter builders for contract interface version 1.x.x.
 * These produce the argument layout expected by a v1-deployed contract.
 */
const buildersV1 = {
  /**
   * Builds deposit() call arguments for v1.
   * v1 signature: deposit(payer, beneficiary, arbiter, amount, asset, memo, timeoutLedger)
   *
   * @param {object} params
   * @param {string} params.payer           Stellar account address of the payer.
   * @param {string} params.beneficiary     Stellar account address of the school.
   * @param {string} params.arbiter         Stellar account address of the arbiter.
   * @param {string|number} params.amount   Payment amount in stroops (i128-compatible).
   * @param {object} params.asset           Asset descriptor { code, issuer } or native.
   * @param {string} params.memo            Student ID memo (max 28 chars).
   * @param {number} params.timeoutLedger   Ledger sequence number after which escrow times out.
   * @returns {object} Structured call arguments ready for XDR encoding.
   */
  buildDepositArgs({ payer, beneficiary, arbiter, amount, asset, memo, timeoutLedger }) {
    return {
      fnName: 'deposit',
      version: '1',
      args: { payer, beneficiary, arbiter, amount, asset, memo, timeoutLedger },
    };
  },

  /**
   * Builds release() call arguments for v1.
   * v1 signature: release(escrowId, caller)
   *
   * @param {object} params
   * @param {string} params.escrowId  Escrow record identifier (bytes32).
   * @param {string} params.caller    Address of the caller (beneficiary or arbiter).
   * @returns {object}
   */
  buildReleaseArgs({ escrowId, caller }) {
    return {
      fnName: 'release',
      version: '1',
      args: { escrowId, caller },
    };
  },

  /**
   * Builds refund() call arguments for v1.
   * v1 signature: refund(escrowId, caller, reason)
   *
   * @param {object} params
   * @param {string} params.escrowId  Escrow record identifier (bytes32).
   * @param {string} params.caller    Address of the caller (arbiter only).
   * @param {string} params.reason    Human-readable refund reason.
   * @returns {object}
   */
  buildRefundArgs({ escrowId, caller, reason }) {
    return {
      fnName: 'refund',
      version: '1',
      args: { escrowId, caller, reason },
    };
  },
};

// ---------------------------------------------------------------------------
// Call builders — v2 (N, current)
// ---------------------------------------------------------------------------

/**
 * Parameter builders for contract interface version 2.x.x.
 *
 * Placeholder: when a v2 is released this object should contain the updated
 * parameter layouts. Until then v2 mirrors v1 signatures to demonstrate the
 * adapter pattern. Replace the bodies below when actual v2 signatures differ.
 *
 * Example v2 change: deposit() adds a `schoolId` param to support multi-school
 * escrow contracts without needing a separate contract per school.
 */
const buildersV2 = {
  /**
   * Builds deposit() call arguments for v2.
   * v2 signature: deposit(payer, beneficiary, arbiter, schoolId, amount, asset, memo, timeoutLedger)
   * (new: schoolId parameter added for multi-school escrow support)
   *
   * @param {object} params
   * @param {string} params.payer           Stellar account address of the payer.
   * @param {string} params.beneficiary     Stellar account address of the school.
   * @param {string} params.arbiter         Stellar account address of the arbiter.
   * @param {string} params.schoolId        School identifier for multi-school contracts.
   * @param {string|number} params.amount   Payment amount in stroops (i128-compatible).
   * @param {object} params.asset           Asset descriptor { code, issuer } or native.
   * @param {string} params.memo            Student ID memo (max 28 chars).
   * @param {number} params.timeoutLedger   Ledger sequence after which escrow times out.
   * @returns {object}
   */
  buildDepositArgs({ payer, beneficiary, arbiter, schoolId, amount, asset, memo, timeoutLedger }) {
    return {
      fnName: 'deposit',
      version: '2',
      args: { payer, beneficiary, arbiter, schoolId, amount, asset, memo, timeoutLedger },
    };
  },

  /**
   * Builds release() call arguments for v2.
   * v2 signature: release(escrowId, caller)  — unchanged from v1.
   *
   * @param {object} params
   * @returns {object}
   */
  buildReleaseArgs({ escrowId, caller }) {
    return {
      fnName: 'release',
      version: '2',
      args: { escrowId, caller },
    };
  },

  /**
   * Builds refund() call arguments for v2.
   * v2 signature: refund(escrowId, caller, reason)  — unchanged from v1.
   *
   * @param {object} params
   * @returns {object}
   */
  buildRefundArgs({ escrowId, caller, reason }) {
    return {
      fnName: 'refund',
      version: '2',
      args: { escrowId, caller, reason },
    };
  },
};

// ---------------------------------------------------------------------------
// Supported version registry
// ---------------------------------------------------------------------------

/**
 * Maps a major version string to the corresponding set of call builders.
 *
 * To add support for a new major version (e.g. v3):
 *   1. Create a `buildersV3` object above.
 *   2. Add `'3': buildersV3` below.
 *   3. Remove the oldest entry (N-2) to keep the window at N and N-1.
 */
const SUPPORTED_VERSIONS = Object.freeze({
  '1': buildersV1,
  '2': buildersV2,
});

// ---------------------------------------------------------------------------
// Adapter public API
// ---------------------------------------------------------------------------

/**
 * Parses a semantic version string and returns the major version integer.
 *
 * @param {string} version  e.g. "1.0.0"
 * @returns {number} Major version number.
 * @throws {Error} If the version string is not valid semver.
 */
function parseMajor(version) {
  const match = String(version).match(/^(\d+)\.\d+\.\d+$/);
  if (!match) {
    throw new Error(`Invalid semantic version: "${version}"`);
  }
  return parseInt(match[1], 10);
}

/**
 * Returns a human-readable description of the currently supported version range.
 *
 * @returns {string}
 */
function getSupportedRange() {
  const keys = Object.keys(SUPPORTED_VERSIONS).map(Number).sort((a, b) => a - b);
  return `v${keys[0]}.x.x – v${keys[keys.length - 1]}.x.x`;
}

/**
 * Returns the call builders for the given on-chain version.
 * Throws if the version is outside the supported major version range.
 *
 * @param {string} version  Semantic version string read from the on-chain contract.
 * @returns {object} The builders for that version.
 * @throws {UnsupportedContractVersionError}
 */
function getBuildersForVersion(version) {
  const major = parseMajor(version);
  const builders = SUPPORTED_VERSIONS[String(major)];
  if (!builders) {
    throw new UnsupportedContractVersionError(version, getSupportedRange());
  }
  return builders;
}

/**
 * Asserts that the given on-chain version is within the supported range.
 * Callers should invoke this before constructing any contract call.
 *
 * @param {string} version  On-chain version string.
 * @returns {{ supported: true, version: string }}
 * @throws {UnsupportedContractVersionError}
 */
function assertVersionSupported(version) {
  getBuildersForVersion(version); // throws if unsupported
  return { supported: true, version };
}

/**
 * Queries the deployed Soroban contract's `version()` view function and returns
 * the semantic version string it reports.
 *
 * The call is a simulation (no transaction, no fee) using the Stellar SDK's
 * `simulateTransaction` RPC method. The result is the authoritative on-chain
 * version and should be used in preference to the in-memory registry version
 * when making pre-flight compatibility checks.
 *
 * If the RPC endpoint is unavailable, the function throws `ContractVersionQueryError`.
 * Callers should catch this and fall back to `CONTRACT_VERSION` from the registry
 * with a warning log, since the registry version represents the expected version.
 *
 * @param {string} contractId          The contract's Stellar contract ID (C… address).
 * @param {string} networkPassphrase   Stellar network passphrase (testnet or mainnet).
 * @param {object} [rpcServer]         Optional: pre-constructed SorobanRpc.Server instance.
 *                                     If omitted, the function creates one from env config.
 * @returns {Promise<string>} Semantic version string (e.g. "1.0.0").
 * @throws {ContractVersionQueryError} When the RPC call fails.
 *
 * @example
 * const version = await getContractVersion(
 *   'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
 *   Networks.TESTNET
 * );
 * // => "1.0.0"
 */
async function getContractVersion(contractId, networkPassphrase, rpcServer = null) {
  // Lazy-require Stellar SDK to avoid hard dependency in environments where
  // the SDK is not installed (e.g. test environments that mock this module).
  let StellarSdk;
  try {
    StellarSdk = require('@stellar/stellar-sdk');
  } catch (sdkError) {
    throw new ContractVersionQueryError(contractId, new Error(
      'The @stellar/stellar-sdk package is required for on-chain version queries. ' +
      `SDK load error: ${sdkError.message}`
    ));
  }

  const { SorobanRpc, Contract, Networks, xdr } = StellarSdk;

  try {
    // Use provided server or construct from environment
    const server = rpcServer || (() => {
      const rpcUrl = process.env.SOROBAN_RPC_URL || (
        networkPassphrase === Networks.MAINNET
          ? 'https://soroban-rpc.mainnet.stellar.gateway.fm'
          : 'https://soroban-testnet.stellar.org'
      );
      return new SorobanRpc.Server(rpcUrl);
    })();

    // Build the `version()` invocation — no arguments, no auth required
    const contract = new Contract(contractId);
    const callOperation = contract.call('version');

    // Wrap in a transaction for simulation (source account is arbitrary for view calls)
    const sourceKey = StellarSdk.Keypair.random();
    const account = await server.getAccount(sourceKey.publicKey()).catch(() => ({
      accountId: () => sourceKey.publicKey(),
      sequenceNumber: () => '0',
      incrementSequenceNumber() {},
    }));

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(callOperation)
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    // Decode the return value (should be a Soroban String)
    const returnVal = result.result?.retval;
    if (!returnVal) {
      throw new Error('Contract returned no value from version() call');
    }

    const versionString = returnVal.value();
    if (typeof versionString !== 'string' && !versionString?.toString) {
      throw new Error(`Unexpected return type from version(): ${typeof versionString}`);
    }

    return String(versionString);
  } catch (err) {
    if (err instanceof ContractVersionQueryError) throw err;
    throw new ContractVersionQueryError(contractId, err);
  }
}

/**
 * Builds deposit() arguments for the given on-chain contract version.
 *
 * @param {string} onChainVersion  Version string from `getContractVersion()`.
 * @param {object} params          Call parameters (version-agnostic).
 * @returns {object} Structured call arguments.
 * @throws {UnsupportedContractVersionError}
 */
function buildDepositArgs(onChainVersion, params) {
  return getBuildersForVersion(onChainVersion).buildDepositArgs(params);
}

/**
 * Builds release() arguments for the given on-chain contract version.
 *
 * @param {string} onChainVersion  Version string from `getContractVersion()`.
 * @param {object} params
 * @returns {object}
 * @throws {UnsupportedContractVersionError}
 */
function buildReleaseArgs(onChainVersion, params) {
  return getBuildersForVersion(onChainVersion).buildReleaseArgs(params);
}

/**
 * Builds refund() arguments for the given on-chain contract version.
 *
 * @param {string} onChainVersion  Version string from `getContractVersion()`.
 * @param {object} params
 * @returns {object}
 * @throws {UnsupportedContractVersionError}
 */
function buildRefundArgs(onChainVersion, params) {
  return getBuildersForVersion(onChainVersion).buildRefundArgs(params);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  CURRENT_MAJOR,
  MIN_SUPPORTED_MAJOR,
  SUPPORTED_VERSIONS,

  // Errors
  UnsupportedContractVersionError,
  ContractVersionQueryError,

  // Core API
  getContractVersion,
  assertVersionSupported,
  getSupportedRange,

  // Call builders (version-agnostic entry points)
  buildDepositArgs,
  buildReleaseArgs,
  buildRefundArgs,

  // Low-level helpers (for testing and custom callers)
  getBuildersForVersion,
  parseMajor,
};
