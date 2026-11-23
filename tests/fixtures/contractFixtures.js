'use strict';

/**
 * contractFixtures — deterministic test fixture accounts for contract testing.
 *
 * Issue #303: Build deterministic test fixture accounts for contract testing.
 *
 * Problem:
 *   Current contract tests create new Stellar keypairs at runtime via
 *   StellarSdk.Keypair.random() and fund them through Friendbot. This makes
 *   tests slow, network-dependent, and non-deterministic.  Parallel test runs
 *   can also conflict when they share the same funded accounts.
 *
 * Solution:
 *   Define a set of FIXED, HD-derived (hierarchical deterministic) keypairs for
 *   each test role — admin, school, student, platformFee, escrow — derived
 *   from a well-known master seed phrase.  These keypairs are identical on every
 *   test run, making tests fast, offline-capable, and fully reproducible.
 *
 *   A snapshot mechanism allows test suites to save and restore account state
 *   (balances, nonces) between tests without hitting any network.
 *
 * Roles and purposes:
 *   - admin        : Contract admin authority (can whitelist assets, reset nonces).
 *   - school       : School operator wallet (receives fee payments).
 *   - student      : Student/parent wallet (sends fee payments).
 *   - platformFee  : Platform fee collection account.
 *   - escrow       : Escrow holding account for in-flight operations.
 *
 * Derivation:
 *   Stellar uses SLIP-0010 Ed25519 HD key derivation with the path
 *   m/44'/148'/<index>'. We simulate this deterministically by using SHA-256
 *   HMAC of (MASTER_SEED + role) — a portable approach that avoids adding a
 *   heavy HD-wallet library as a dependency while remaining deterministic.
 *
 * Usage in tests:
 *   const { FIXTURE_ACCOUNTS, snapshotState, restoreState } = require('./contractFixtures');
 *   // Access fixed keypairs:
 *   const schoolPubKey = FIXTURE_ACCOUNTS.school.publicKey;
 *   // Save / restore balances between tests:
 *   const snap = snapshotState();
 *   // ... mutate state ...
 *   restoreState(snap);
 */

const crypto = require('crypto');

// ── Master seed ───────────────────────────────────────────────────────────────
// This seed is ONLY for tests. It must never be used in production.
const MASTER_SEED = 'paymentflow-test-fixture-master-seed-v1';

// ── Stellar key format helpers ────────────────────────────────────────────────
// We don't depend on the Stellar SDK here (it's optional in test environments)
// so we implement only what we need: convert a 32-byte seed into Stellar G/S
// base32 key strings using StrKey encoding.

/**
 * Encode a raw 32-byte buffer as a Stellar Ed25519 public key (G…).
 * Uses the Stellar StrKey format: version byte 0x06 << 3 = 0x30.
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0023.md
 *
 * @param {Buffer} rawBytes – 32-byte public key seed.
 * @returns {string}
 */
function encodePublicKey(rawBytes) {
  // StrKey version byte for Ed25519 public key = 6 << 3 = 48 = 0x30
  const VERSION_PUBLIC = 0x30;
  return strKeyEncode(VERSION_PUBLIC, rawBytes);
}

/**
 * Encode a raw 32-byte buffer as a Stellar Ed25519 secret key (S…).
 * StrKey version byte for Ed25519 secret key = 18 << 3 = 144 = 0x90
 *
 * @param {Buffer} rawBytes – 32-byte secret seed.
 * @returns {string}
 */
function encodeSecretKey(rawBytes) {
  const VERSION_SECRET = 0x90;
  return strKeyEncode(VERSION_SECRET, rawBytes);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function strKeyEncode(versionByte, payload) {
  // Payload: version byte + 32-byte key
  const data = Buffer.alloc(1 + payload.length);
  data[0] = versionByte;
  payload.copy(data, 1);

  // CRC-16/XModem checksum (Stellar spec)
  const crc = crc16xmodem(data);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16LE(crc, 0);

  const fullBuf = Buffer.concat([data, crcBuf]);
  return base32Encode(fullBuf);
}

function crc16xmodem(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i];
    for (let j = 0; j < 8; j++) {
      const xorFlag = ((crc ^ (b << 8)) & 0x8000) !== 0;
      crc = (crc << 1) & 0xffff;
      if (xorFlag) crc ^= 0x1021;
      b = (b << 1) & 0xff;
    }
  }
  return crc;
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// ── Deterministic key derivation ──────────────────────────────────────────────

/**
 * Derive a deterministic 32-byte seed for a given role index.
 * Uses HMAC-SHA256(MASTER_SEED, role) so each role gets a unique but
 * reproducible key seed.
 *
 * @param {string} role – e.g. 'admin', 'school', 'student'
 * @returns {Buffer} 32-byte seed
 */
function deriveKeySeed(role) {
  return crypto.createHmac('sha256', MASTER_SEED).update(role).digest();
}

/**
 * Build a full fixture account record for a given role.
 *
 * @param {string} role
 * @param {string} description
 * @param {number} initialBalance – XLM balance to simulate at test startup.
 * @returns {{ role, description, secretSeed: Buffer, publicKey: string, secretKey: string, initialBalance: number }}
 */
function buildFixtureAccount(role, description, initialBalance) {
  const seed = deriveKeySeed(role);
  return {
    role,
    description,
    secretSeed: seed,
    publicKey: encodePublicKey(seed),
    secretKey: encodeSecretKey(seed),
    initialBalance,
  };
}

// ── Fixture account definitions ───────────────────────────────────────────────

/**
 * The canonical set of fixture accounts.
 * These are the same keypairs on every test run — import and use directly.
 *
 * @type {Object.<string, { role: string, description: string, publicKey: string, secretKey: string, initialBalance: number }>}
 */
const FIXTURE_ACCOUNTS = {
  /**
   * Contract admin authority.
   * Can add/remove assets from the whitelist, reset nonces, and perform
   * break-glass operations.
   * Initial balance: 10,000 XLM (enough for any admin operation in tests).
   */
  admin: buildFixtureAccount(
    'admin',
    'Contract admin authority — whitelist management, nonce reset',
    10000,
  ),

  /**
   * School operator wallet.
   * Receives fee payments and triggers release-escrow operations.
   * Initial balance: 1,000 XLM (pre-funded for trustlines and reserves).
   */
  school: buildFixtureAccount(
    'school',
    'School operator wallet — receives fee payments',
    1000,
  ),

  /**
   * Student / parent wallet.
   * Sends fee payments to the escrow account.
   * Initial balance: 500 XLM (enough to cover typical fee payments in tests).
   */
  student: buildFixtureAccount(
    'student',
    'Student/parent wallet — sends fee payments to escrow',
    500,
  ),

  /**
   * Platform fee collection account.
   * Receives the platform's portion of each transaction.
   * Initial balance: 100 XLM (minimum reserve).
   */
  platformFee: buildFixtureAccount(
    'platformFee',
    'Platform fee collection account',
    100,
  ),

  /**
   * Escrow holding account.
   * Temporarily holds funds during the payment lifecycle before release or refund.
   * Initial balance: 100 XLM (minimum reserve to open trustlines).
   */
  escrow: buildFixtureAccount(
    'escrow',
    'Escrow holding account — in-flight payment funds',
    100,
  ),
};

// ── In-memory state (balances, nonces) ────────────────────────────────────────

/**
 * Mutable runtime state, keyed by account public key.
 * Balances are in XLM (7 decimal places), nonces are integers.
 *
 * @type {Map<string, { balance: number, nonce: number, sequenceNumber: number }>}
 */
let _state = new Map();

/**
 * Initialise (or re-initialise) the in-memory state from fixture initial balances.
 * Call this in beforeAll / beforeEach to guarantee a clean starting state.
 */
function initFixtureState() {
  _state = new Map();
  for (const account of Object.values(FIXTURE_ACCOUNTS)) {
    _state.set(account.publicKey, {
      balance: account.initialBalance,
      nonce: 0,
      sequenceNumber: 1,
    });
  }
}

/**
 * Get the current simulated state for an account.
 *
 * @param {string} publicKey
 * @returns {{ balance: number, nonce: number, sequenceNumber: number }|null}
 */
function getAccountState(publicKey) {
  return _state.get(publicKey) ?? null;
}

/**
 * Update the simulated state for an account (partial update).
 *
 * @param {string} publicKey
 * @param {Partial<{ balance: number, nonce: number, sequenceNumber: number }>} patch
 */
function setAccountState(publicKey, patch) {
  const current = _state.get(publicKey) ?? { balance: 0, nonce: 0, sequenceNumber: 1 };
  _state.set(publicKey, { ...current, ...patch });
}

// ── Snapshot / restore ────────────────────────────────────────────────────────

/**
 * Capture a deep snapshot of the current in-memory state.
 * Use in beforeEach to save a clean baseline and restore it afterEach.
 *
 * @returns {Map<string, { balance: number, nonce: number, sequenceNumber: number }>}
 */
function snapshotState() {
  const snap = new Map();
  for (const [k, v] of _state) {
    snap.set(k, { ...v });
  }
  return snap;
}

/**
 * Restore previously snapshotted state.
 * Discards all mutations made since the snapshot was taken.
 *
 * @param {Map<string, { balance: number, nonce: number, sequenceNumber: number }>} snapshot
 */
function restoreState(snapshot) {
  _state = new Map();
  for (const [k, v] of snapshot) {
    _state.set(k, { ...v });
  }
}

// ── Helpers for test scenarios ────────────────────────────────────────────────

/**
 * Simulate a payment from one fixture account to another.
 * Mutates the in-memory state; does NOT hit any network.
 *
 * @param {string} fromPublicKey
 * @param {string} toPublicKey
 * @param {number} amount – XLM
 * @returns {{ success: boolean, reason?: string }}
 */
function simulatePayment(fromPublicKey, toPublicKey, amount) {
  const from = _state.get(fromPublicKey);
  const to = _state.get(toPublicKey);

  if (!from) return { success: false, reason: 'SENDER_NOT_FOUND' };
  if (!to)   return { success: false, reason: 'RECIPIENT_NOT_FOUND' };
  if (from.balance < amount) return { success: false, reason: 'INSUFFICIENT_BALANCE' };

  _state.set(fromPublicKey, {
    ...from,
    balance: parseFloat((from.balance - amount).toFixed(7)),
    nonce: from.nonce + 1,
    sequenceNumber: from.sequenceNumber + 1,
  });
  _state.set(toPublicKey, {
    ...to,
    balance: parseFloat((to.balance + amount).toFixed(7)),
  });

  return { success: true };
}

// Initialise state when the module is first loaded.
initFixtureState();

module.exports = {
  FIXTURE_ACCOUNTS,
  MASTER_SEED,
  initFixtureState,
  getAccountState,
  setAccountState,
  snapshotState,
  restoreState,
  simulatePayment,
  // Exported for advanced test use
  deriveKeySeed,
  buildFixtureAccount,
};
