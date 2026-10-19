'use strict';

/**
 * Tests for Issue #306 — Define and validate asset type and decimal precision on-chain.
 *
 * Covers:
 *  1. Asset whitelist enforcement — only XLM and USDC are accepted by default.
 *  2. Type validation — asset type must match the registered type.
 *  3. Decimal precision validation — amounts exceeding the asset's decimal
 *     places are rejected before they reach the network.
 *  4. Admin authority — only admin-gated mutations are exposed; the registry
 *     correctly blocks and allows additions/removals.
 *  5. View function (listWhitelistedAssets) — queryable at any time.
 */

// Set required env vars before loading the module.
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// We test the real module (no mocking needed — it has no side-effects at load time).
const {
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
} = require('../backend/src/config/assetRegistry');

// ── Helper ────────────────────────────────────────────────────────────────────

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ATTACKER_ISSUER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Default whitelist
// ─────────────────────────────────────────────────────────────────────────────

describe('#306 — asset whitelist', () => {
  test('XLM is whitelisted by default', () => {
    expect(isWhitelisted('XLM')).toBe(true);
  });

  test('USDC is whitelisted by default', () => {
    expect(isWhitelisted('USDC')).toBe(true);
  });

  test('unknown asset codes are NOT whitelisted', () => {
    expect(isWhitelisted('BTC')).toBe(false);
    expect(isWhitelisted('ETH')).toBe(false);
    expect(isWhitelisted('FAKE')).toBe(false);
  });

  test('getWhitelistedAssets returns XLM and USDC', () => {
    const assets = getWhitelistedAssets();
    expect(Object.keys(assets)).toContain('XLM');
    expect(Object.keys(assets)).toContain('USDC');
  });

  test('listWhitelistedAssets returns an array sorted by code', () => {
    const list = listWhitelistedAssets();
    expect(Array.isArray(list)).toBe(true);
    const codes = list.map((a) => a.code);
    expect(codes).toContain('XLM');
    expect(codes).toContain('USDC');
    // Verify sorted order
    expect(codes).toEqual([...codes].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Asset definition view function
// ─────────────────────────────────────────────────────────────────────────────

describe('#306 — asset definition view', () => {
  test('XLM definition has correct type and 7 decimal places', () => {
    const def = getAssetDefinition('XLM');
    expect(def).not.toBeNull();
    expect(def.type).toBe('native');
    expect(def.decimals).toBe(7);
    expect(def.issuer).toBeNull();
  });

  test('USDC definition has correct type, issuer, and 7 decimal places', () => {
    const def = getAssetDefinition('USDC');
    expect(def).not.toBeNull();
    expect(def.type).toBe('credit_alphanum4');
    expect(def.decimals).toBe(7);
    expect(def.issuer).toBe(TESTNET_USDC);
  });

  test('getAssetDefinition returns null for unknown codes', () => {
    expect(getAssetDefinition('DOGE')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. validateAsset — whitelist + type + issuer
// ─────────────────────────────────────────────────────────────────────────────

describe('#306 — validateAsset', () => {
  test('rejects a non-whitelisted asset', () => {
    const result = validateAsset('BTC', 'credit_alphanum4', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ASSET_NOT_WHITELISTED');
  });

  test('rejects XLM with wrong asset type', () => {
    const result = validateAsset('XLM', 'credit_alphanum4', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ASSET_TYPE_MISMATCH');
  });

  test('accepts XLM with correct type and no issuer', () => {
    const result = validateAsset('XLM', 'native', null);
    expect(result.valid).toBe(true);
    expect(result.asset.code).toBe('XLM');
  });

  test('rejects XLM when a spurious issuer is provided', () => {
    const result = validateAsset('XLM', 'native', ATTACKER_ISSUER);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('UNEXPECTED_ISSUER_ON_NATIVE');
  });

  test('accepts USDC from the pinned testnet issuer', () => {
    const result = validateAsset('USDC', 'credit_alphanum4', TESTNET_USDC);
    expect(result.valid).toBe(true);
    expect(result.asset.code).toBe('USDC');
  });

  test('rejects USDC from an attacker issuer', () => {
    const result = validateAsset('USDC', 'credit_alphanum4', ATTACKER_ISSUER);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ISSUER_MISMATCH');
  });

  test('rejects USDC with a null issuer', () => {
    const result = validateAsset('USDC', 'credit_alphanum4', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ISSUER_MISMATCH');
  });

  test('rejects USDC with wrong asset type', () => {
    const result = validateAsset('USDC', 'native', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ASSET_TYPE_MISMATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. validateAmountPrecision
// ─────────────────────────────────────────────────────────────────────────────

describe('#306 — validateAmountPrecision', () => {
  test('accepts an amount with exactly 7 decimal places (XLM)', () => {
    const result = validateAmountPrecision('100.0000001', 'XLM');
    expect(result.valid).toBe(true);
  });

  test('accepts an amount with fewer than 7 decimal places', () => {
    expect(validateAmountPrecision('250.50', 'XLM').valid).toBe(true);
    expect(validateAmountPrecision('100', 'USDC').valid).toBe(true);
    expect(validateAmountPrecision('0.1', 'USDC').valid).toBe(true);
  });

  test('rejects an amount with 8 decimal places (exceeds XLM precision)', () => {
    const result = validateAmountPrecision('1.00000001', 'XLM');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('AMOUNT_EXCEEDS_PRECISION');
  });

  test('rejects an amount with 8 decimal places for USDC', () => {
    const result = validateAmountPrecision('0.000000001', 'USDC');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('AMOUNT_EXCEEDS_PRECISION');
  });

  test('rejects negative amounts', () => {
    const result = validateAmountPrecision('-10.5', 'XLM');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('NEGATIVE_AMOUNT');
  });

  test('rejects non-numeric strings', () => {
    const result = validateAmountPrecision('abc', 'XLM');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_AMOUNT_FORMAT');
  });

  test('rejects Infinity', () => {
    const result = validateAmountPrecision(Infinity, 'XLM');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_AMOUNT_FORMAT');
  });

  test('rejects an amount for a non-whitelisted asset', () => {
    const result = validateAmountPrecision('100', 'BTC');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('ASSET_NOT_WHITELISTED');
  });

  test('returns normalised amount string to canonical precision', () => {
    const result = validateAmountPrecision('100', 'XLM');
    expect(result.valid).toBe(true);
    expect(result.normalised).toBe('100.0000000');
  });

  test('boundary: exact 7 d.p. is accepted', () => {
    expect(validateAmountPrecision('0.0000001', 'XLM').valid).toBe(true);
  });

  test('boundary: 8 d.p. is rejected', () => {
    expect(validateAmountPrecision('0.00000001', 'XLM').valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Admin-gated mutations — addWhitelistedAsset / removeWhitelistedAsset
// ─────────────────────────────────────────────────────────────────────────────

describe('#306 — admin-gated whitelist management', () => {
  // Use an isolated cleanup strategy: track what we add and remove it after.
  const TEMP_ASSET_CODE = 'TSTT';

  afterEach(() => {
    // Clean up any test asset that was added.
    try {
      removeWhitelistedAsset(TEMP_ASSET_CODE);
    } catch {
      // Already removed or never added — no-op.
    }
  });

  test('admin can add a new asset to the whitelist', () => {
    addWhitelistedAsset({
      code: TEMP_ASSET_CODE,
      type: 'credit_alphanum4',
      issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
      displayName: 'Test Stable Token',
      decimals: 7,
    });

    expect(isWhitelisted(TEMP_ASSET_CODE)).toBe(true);
    const def = getAssetDefinition(TEMP_ASSET_CODE);
    expect(def.decimals).toBe(7);
    expect(def.type).toBe('credit_alphanum4');
  });

  test('newly added asset appears in listWhitelistedAssets', () => {
    addWhitelistedAsset({
      code: TEMP_ASSET_CODE,
      type: 'credit_alphanum4',
      issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
      displayName: 'Test Stable Token',
      decimals: 7,
    });

    const list = listWhitelistedAssets();
    expect(list.map((a) => a.code)).toContain(TEMP_ASSET_CODE);
  });

  test('adding a duplicate asset throws', () => {
    expect(() =>
      addWhitelistedAsset({
        code: 'XLM',
        type: 'native',
        issuer: null,
        displayName: 'Duplicate',
        decimals: 7,
      })
    ).toThrow(/already whitelisted/i);
  });

  test('adding asset with invalid code throws', () => {
    expect(() =>
      addWhitelistedAsset({ code: '', type: 'native', issuer: null, displayName: 'X', decimals: 7 })
    ).toThrow();
  });

  test('adding non-native asset without issuer throws', () => {
    expect(() =>
      addWhitelistedAsset({
        code: 'FAKE',
        type: 'credit_alphanum4',
        issuer: null,
        displayName: 'Fake',
        decimals: 7,
      })
    ).toThrow(/issuer is required/i);
  });

  test('admin can remove a whitelisted asset', () => {
    addWhitelistedAsset({
      code: TEMP_ASSET_CODE,
      type: 'credit_alphanum4',
      issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
      displayName: 'Test Stable Token',
      decimals: 7,
    });
    expect(isWhitelisted(TEMP_ASSET_CODE)).toBe(true);

    removeWhitelistedAsset(TEMP_ASSET_CODE);
    expect(isWhitelisted(TEMP_ASSET_CODE)).toBe(false);
  });

  test('removing a non-existent asset throws', () => {
    expect(() => removeWhitelistedAsset('NOTEXIST')).toThrow(/not in the whitelist/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Admin address management
// ─────────────────────────────────────────────────────────────────────────────

describe('#306 — admin authority address', () => {
  const ORIGINAL = process.env.CONTRACT_ADMIN_ADDRESS;

  afterEach(() => {
    // Restore original value
    if (ORIGINAL !== undefined) setAdminAddress(ORIGINAL);
    else setAdminAddress(null);
  });

  test('getAdminAddress returns value set via setAdminAddress', () => {
    const addr = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    setAdminAddress(addr);
    expect(getAdminAddress()).toBe(addr);
  });

  test('setAdminAddress to null clears the admin', () => {
    setAdminAddress(null);
    expect(getAdminAddress()).toBeNull();
  });
});
