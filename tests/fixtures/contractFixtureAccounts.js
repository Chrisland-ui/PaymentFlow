'use strict';

/**
 * Deterministic Contract Fixture Accounts (Issue #55).
 *
 * Integration tests become difficult to reproduce when accounts and balances are
 * created ad hoc. This module provides deterministic test accounts, assets,
 * trustlines, and funded starting states for local and test networks.
 *
 * Key properties:
 *   1. Same seed → same fixture accounts, every run (reproducibility).
 *   2. Secrets are derived at runtime — never hardcoded.
 *   3. A network guard prevents fixtures from targeting production networks.
 *   4. All fixture accounts have role labels for clarity in test output.
 *
 * Usage:
 *   const { createFixtureAccounts } = require('./tests/fixtures/contractFixtureAccounts');
 *   const accounts = createFixtureAccounts(); // uses FIXTURE_SEED_DEFAULT
 *   // accounts.payer.publicKey, accounts.beneficiary.secretKey, etc.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Network Guard
// ---------------------------------------------------------------------------

class NetworkGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkGuardError';
  }
}

/**
 * Throws if the current environment targets a production network.
 * Call this at the top of any function that creates fixture accounts.
 *
 * @throws {NetworkGuardError}
 */
function assertNotProduction() {
  const network = (process.env.STELLAR_NETWORK || '').toLowerCase().trim();
  if (network === 'mainnet' || network === 'public') {
    throw new NetworkGuardError(
      `Fixture accounts MUST NOT target production networks. ` +
      `STELLAR_NETWORK is set to "${process.env.STELLAR_NETWORK}". ` +
      `Unset STELLAR_NETWORK or set it to "testnet" before running fixtures.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default seed used when no explicit seed is provided.
 * Change the seed to obtain a completely different fixture set.
 */
const FIXTURE_SEED_DEFAULT = 'paymentflow-fixture-seed-v1';

/**
 * Roles present in every fixture account set.
 */
const FIXTURE_ROLES = {
  PAYER: 'payer',
  BENEFICIARY: 'beneficiary',
  ARBITER: 'arbiter',
  SCHOOL: 'school',
};

/**
 * USDC issuer address used in testnet fixtures.
 * This matches the value in stellarConfig.js for the testnet environment.
 */
const TESTNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/**
 * Starting XLM balance for each fixture account.
 * 10,000 XLM is sufficient for all test scenarios without requiring Friendbot
 * calls in unit / integration tests.
 */
const FIXTURE_INITIAL_BALANCE_XLM = 10000;

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic Stellar-style public key from a seed and a role label.
 *
 * On the real Stellar network, public keys are Ed25519 points encoded in
 * Stellar's base32 format and always start with 'G'. For test fixtures we
 * simulate this by producing a 55-character uppercase hex digest and prepending
 * 'G', giving a 56-character string that is visually recognisable as a Stellar
 * public key in test output without requiring the Stellar SDK.
 *
 * @param {string} seed  Fixture seed string.
 * @param {string} role  Role label (e.g. 'payer', 'beneficiary').
 * @returns {string} 56-character uppercase public key starting with 'G'.
 */
function derivePublicKey(seed, role) {
  const hash = crypto
    .createHmac('sha256', seed)
    .update(`pubkey:${role}`)
    .digest('hex')
    .toUpperCase();
  // Truncate/pad to 55 chars and prepend 'G'
  return 'G' + hash.substring(0, 55);
}

/**
 * Derives a deterministic Stellar-style secret key from a seed and a role label.
 *
 * Real Stellar secret keys are base32-encoded 32-byte seeds and always start
 * with 'S'. We simulate this format for test fixtures.
 *
 * @param {string} seed  Fixture seed string.
 * @param {string} role  Role label.
 * @returns {string} 56-character uppercase secret key starting with 'S'.
 */
function deriveSecretKey(seed, role) {
  const hash = crypto
    .createHmac('sha256', seed)
    .update(`secret:${role}`)
    .digest('hex')
    .toUpperCase();
  return 'S' + hash.substring(0, 55);
}

/**
 * Creates a single fixture account for a given role.
 *
 * @param {string} seed
 * @param {string} roleKey  Key from FIXTURE_ROLES (e.g. 'payer').
 * @returns {object} Fixture account descriptor.
 */
function createFixtureAccount(seed, roleKey) {
  return {
    role: roleKey,
    publicKey: derivePublicKey(seed, roleKey),
    secretKey: deriveSecretKey(seed, roleKey),
    initialBalanceXLM: FIXTURE_INITIAL_BALANCE_XLM,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a complete set of deterministic fixture accounts for contract testing.
 *
 * The same seed always produces the same set of accounts. Use different seeds
 * for different test suites that must not share state.
 *
 * @param {string} [seed=FIXTURE_SEED_DEFAULT]
 * @returns {{
 *   payer: object,
 *   beneficiary: object,
 *   arbiter: object,
 *   school: object,
 *   seed: string,
 * }}
 * @throws {NetworkGuardError} When STELLAR_NETWORK=mainnet.
 */
function createFixtureAccounts(seed = FIXTURE_SEED_DEFAULT) {
  assertNotProduction();

  const accounts = {};
  for (const [key, roleLabel] of Object.entries(FIXTURE_ROLES)) {
    accounts[roleLabel] = createFixtureAccount(seed, roleLabel);
  }

  return {
    ...accounts,
    seed,
  };
}

/**
 * Creates a trustline configuration describing which assets each fixture account
 * should trust. In real integration tests this would be used to build
 * `ChangeTrust` operations; in unit tests it serves as configuration metadata.
 *
 * @param {object} accounts  Return value of `createFixtureAccounts`.
 * @returns {object[]} Array of trustline descriptors.
 */
function createTrustlineConfig(accounts) {
  assertNotProduction();

  const trustlines = [];

  const roles = [
    accounts.payer,
    accounts.beneficiary,
    accounts.arbiter,
    accounts.school,
  ].filter(Boolean);

  for (const account of roles) {
    // XLM is the native asset — no explicit trustline required on Stellar,
    // but we include it in the config for completeness and documentation.
    trustlines.push({
      account: account.publicKey,
      role: account.role,
      asset: {
        code: 'XLM',
        type: 'native',
        issuer: null,
        requiresTrustline: false,
      },
    });

    // USDC requires an explicit ChangeTrust operation before receiving funds.
    trustlines.push({
      account: account.publicKey,
      role: account.role,
      asset: {
        code: 'USDC',
        type: 'credit_alphanum4',
        issuer: TESTNET_USDC_ISSUER,
        requiresTrustline: true,
      },
    });
  }

  return trustlines;
}

/**
 * Returns a funding plan describing the initial XLM balance for each fixture
 * account. This can be used by integration test setup hooks to fund accounts
 * via Friendbot (testnet) or a seed wallet (local).
 *
 * @param {object} accounts  Return value of `createFixtureAccounts`.
 * @returns {object[]} Array of funding descriptors.
 */
function createFundingPlan(accounts) {
  assertNotProduction();

  return Object.values(FIXTURE_ROLES).map((roleLabel) => {
    const account = accounts[roleLabel];
    return {
      publicKey: account.publicKey,
      role: roleLabel,
      amountXLM: FIXTURE_INITIAL_BALANCE_XLM,
    };
  });
}

module.exports = {
  // Constants
  FIXTURE_SEED_DEFAULT,
  FIXTURE_ROLES,
  TESTNET_USDC_ISSUER,
  FIXTURE_INITIAL_BALANCE_XLM,

  // Errors
  NetworkGuardError,

  // Functions
  createFixtureAccounts,
  createTrustlineConfig,
  createFundingPlan,

  // Exposed for unit testing
  derivePublicKey,
  deriveSecretKey,
  assertNotProduction,
};
