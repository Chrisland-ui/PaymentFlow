'use strict';

/**
 * assetRegistry — on-chain asset whitelist with type and decimal precision.
 *
 * Issue #306: Define and validate asset type and decimal precision on-chain.
 *
 * Centralises the canonical list of accepted assets and enforces:
 *   1. Asset whitelist — only registered assets may be used in contract operations.
 *   2. Asset type — every asset has an explicit Stellar asset type string.
 *   3. Decimal precision — amounts must be representable within the asset's
 *      defined minor-unit precision before any on-chain processing occurs.
 *
 * The admin authority is the only caller permitted to add new assets (via
 * addWhitelistedAsset). This mirrors the contract admin role described in the
 * issue; on-chain enforcement is delegated to this registry which the backend
 * contract layer must consult before broadcasting any transaction.
 */

const Decimal = require('decimal.js');

// ── Default whitelist ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} AssetDefinition
 * @property {string}      code        – Stellar asset code ('XLM', 'USDC', …)
 * @property {string}      type        – Stellar asset_type ('native' | 'credit_alphanum4' | 'credit_alphanum12')
 * @property {string|null} issuer      – Issuer G-address for credit assets; null for native.
 * @property {string}      displayName – Human-readable label.
 * @property {number}      decimals    – Maximum significant decimal places (e.g. 7 for Stellar assets).
 */

/** @type {Map<string, AssetDefinition>} */
const _registry = new Map([
  [
    'XLM',
    {
      code: 'XLM',
      type: 'native',
      issuer: null,
      displayName: 'Stellar Lumens',
      decimals: 7,
    },
  ],
  [
    'USDC',
    {
      code: 'USDC',
      type: 'credit_alphanum4',
      // Resolved at runtime via USDC_ISSUER env var — the registry stores null
      // as the sentinel and resolveIssuer() fills it in from the environment.
      issuer: null,
      displayName: 'USD Coin',
      decimals: 7,
    },
  ],
]);

// ── Admin authority ───────────────────────────────────────────────────────────
// In a full Soroban contract the admin would be a contract-level keypair.
// In this Node backend layer, the admin identity is the JWT role:'admin' claim
// verified by requireAdminAuth before any mutating registry call.

let _adminAddress = process.env.CONTRACT_ADMIN_ADDRESS || null;

/**
 * Return the current contract-admin address (G-public-key or null if unset).
 * @returns {string|null}
 */
function getAdminAddress() {
  return _adminAddress;
}

/**
 * Assign a new contract-admin address.  Intended for test setup and initial
 * provisioning; in production set CONTRACT_ADMIN_ADDRESS in the environment.
 * @param {string} address – Stellar public key (G…)
 */
function setAdminAddress(address) {
  _adminAddress = address;
}

// ── Issuer resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the live issuer address for a credit asset, falling back to the
 * environment variables set in stellarConfig.
 *
 * @param {string} code
 * @returns {string|null}
 */
function resolveIssuer(code) {
  if (code === 'USDC') {
    return process.env.USDC_ISSUER || null;
  }
  return _registry.get(code)?.issuer ?? null;
}

// ── Core registry API ─────────────────────────────────────────────────────────

/**
 * Return the full map of whitelisted assets (read-only snapshot).
 * Issuers are resolved from environment at call time so callers always get the
 * current configuration.
 *
 * @returns {Object.<string, AssetDefinition>}
 */
function getWhitelistedAssets() {
  const result = {};
  for (const [code, def] of _registry) {
    result[code] = { ...def, issuer: resolveIssuer(code) };
  }
  return result;
}

/**
 * Check whether an asset code is on the whitelist.
 *
 * @param {string} code
 * @returns {boolean}
 */
function isWhitelisted(code) {
  return _registry.has(code);
}

/**
 * Return the AssetDefinition for a whitelisted code, or null.
 *
 * @param {string} code
 * @returns {AssetDefinition|null}
 */
function getAssetDefinition(code) {
  const def = _registry.get(code);
  if (!def) return null;
  return { ...def, issuer: resolveIssuer(code) };
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate that an asset is whitelisted, that its type matches the on-chain
 * type, and (for credit assets) that the issuer matches the pinned value.
 *
 * @param {string}      code   – Asset code from the incoming operation.
 * @param {string}      type   – Asset type from the incoming operation.
 * @param {string|null} issuer – Asset issuer from the incoming operation.
 * @returns {{ valid: boolean, reason?: string, asset?: AssetDefinition }}
 */
function validateAsset(code, type, issuer = null) {
  const def = _registry.get(code);

  if (!def) {
    return { valid: false, reason: 'ASSET_NOT_WHITELISTED' };
  }

  if (def.type !== type) {
    return { valid: false, reason: 'ASSET_TYPE_MISMATCH' };
  }

  if (def.type === 'native') {
    // XLM: no issuer must be present on-chain.
    if (issuer) {
      return { valid: false, reason: 'UNEXPECTED_ISSUER_ON_NATIVE' };
    }
    return { valid: true, asset: { ...def, issuer: null } };
  }

  // Credit asset: issuer is mandatory and must match the pinned value.
  const pinnedIssuer = resolveIssuer(code);
  if (!pinnedIssuer) {
    return { valid: false, reason: 'ISSUER_NOT_CONFIGURED' };
  }
  if (!issuer || issuer !== pinnedIssuer) {
    return { valid: false, reason: 'ISSUER_MISMATCH' };
  }

  return { valid: true, asset: { ...def, issuer: pinnedIssuer } };
}

/**
 * Validate that an amount can be represented exactly within the asset's
 * defined decimal precision.
 *
 * Stellar amounts are expressed to 7 decimal places (1 stroop = 0.0000001 XLM).
 * An amount of 1.00000001 XLM would imply 8 decimal places and MUST be
 * rejected before it reaches the network — it cannot be represented faithfully.
 *
 * Uses Decimal.js for exact arithmetic; floating-point comparisons are not
 * reliable at 7 d.p.
 *
 * @param {number|string} amount – Proposed operation amount.
 * @param {string}        code   – Asset code used to look up allowed precision.
 * @returns {{ valid: boolean, reason?: string, normalised?: string }}
 */
function validateAmountPrecision(amount, code) {
  const def = _registry.get(code);
  if (!def) {
    return { valid: false, reason: 'ASSET_NOT_WHITELISTED' };
  }

  let d;
  try {
    d = new Decimal(amount);
  } catch {
    return { valid: false, reason: 'INVALID_AMOUNT_FORMAT' };
  }

  if (!d.isFinite() || d.isNaN()) {
    return { valid: false, reason: 'INVALID_AMOUNT_FORMAT' };
  }

  if (d.isNegative()) {
    return { valid: false, reason: 'NEGATIVE_AMOUNT' };
  }

  // Count decimal places via Decimal.js — it preserves exact representation.
  const decimalPlaces = d.decimalPlaces();
  if (decimalPlaces > def.decimals) {
    return {
      valid: false,
      reason: 'AMOUNT_EXCEEDS_PRECISION',
      detail: `${code} supports at most ${def.decimals} decimal places; got ${decimalPlaces}`,
    };
  }

  // Return the amount normalised to the asset's canonical decimal width so
  // callers can store the canonical form consistently.
  return { valid: true, normalised: d.toFixed(def.decimals) };
}

// ── Admin-gated mutations ─────────────────────────────────────────────────────

/**
 * Add a new asset to the whitelist.
 *
 * This is an admin-only operation. In the HTTP layer the caller must verify
 * the request is authorised by requireAdminAuth before invoking this function.
 *
 * @param {AssetDefinition} assetDef
 * @throws {Error} if the asset definition is invalid or already registered.
 */
function addWhitelistedAsset(assetDef) {
  const { code, type, issuer, displayName, decimals } = assetDef;

  if (!code || typeof code !== 'string') throw new Error('assetDef.code is required');
  if (!type || typeof type !== 'string') throw new Error('assetDef.type is required');
  if (typeof decimals !== 'number' || decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error('assetDef.decimals must be a non-negative integer');
  }
  if (!displayName || typeof displayName !== 'string') throw new Error('assetDef.displayName is required');
  if (type !== 'native' && !issuer) throw new Error('assetDef.issuer is required for non-native assets');

  if (_registry.has(code)) {
    throw new Error(`Asset ${code} is already whitelisted`);
  }

  _registry.set(code, { code, type, issuer: issuer || null, displayName, decimals });
}

/**
 * Remove an asset from the whitelist.
 *
 * Admin-only. Removing an asset prevents new escrow operations from using it
 * but does not affect in-flight transactions already on-chain.
 *
 * @param {string} code
 * @throws {Error} if the asset is not currently whitelisted.
 */
function removeWhitelistedAsset(code) {
  if (!_registry.has(code)) {
    throw new Error(`Asset ${code} is not in the whitelist`);
  }
  _registry.delete(code);
}

// ── Upgrade-runbook helper ────────────────────────────────────────────────────

/**
 * List whitelisted assets as an array, sorted by code.
 * Useful for runbook scripts and the admin GET endpoint.
 *
 * @returns {AssetDefinition[]}
 */
function listWhitelistedAssets() {
  return Array.from(_registry.keys())
    .sort()
    .map((code) => ({ ..._registry.get(code), issuer: resolveIssuer(code) }));
}

module.exports = {
  getWhitelistedAssets,
  isWhitelisted,
  getAssetDefinition,
  validateAsset,
  validateAmountPrecision,
  addWhitelistedAsset,
  removeWhitelistedAsset,
  listWhitelistedAssets,
  getAdminAddress,
  setAdminAddress,
};
