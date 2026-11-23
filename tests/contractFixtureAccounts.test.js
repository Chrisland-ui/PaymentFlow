'use strict';

/**
 * Tests for Issue #55: Build deterministic contract fixture accounts.
 *
 * Acceptance Criteria:
 *   1. A clean environment can reproduce the same fixture state.
 *   2. Secrets are generated at runtime (not hardcoded).
 *   3. Fixtures cannot target production networks accidentally.
 */

const {
  FIXTURE_SEED_DEFAULT,
  FIXTURE_ROLES,
  TESTNET_USDC_ISSUER,
  NetworkGuardError,
  createFixtureAccounts,
  createTrustlineConfig,
  createFundingPlan,
  derivePublicKey,
  deriveSecretKey,
  assertNotProduction,
} = require('./fixtures/contractFixtureAccounts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// ---------------------------------------------------------------------------
// Network Guard
// ---------------------------------------------------------------------------
describe('NetworkGuardError — production network detection', () => {
  test('throws NetworkGuardError when STELLAR_NETWORK=mainnet', () => {
    withEnv('STELLAR_NETWORK', 'mainnet', () => {
      expect(() => createFixtureAccounts()).toThrow(NetworkGuardError);
    });
  });

  test('throws NetworkGuardError when STELLAR_NETWORK=public', () => {
    withEnv('STELLAR_NETWORK', 'public', () => {
      expect(() => createFixtureAccounts()).toThrow(NetworkGuardError);
    });
  });

  test('does NOT throw when STELLAR_NETWORK=testnet', () => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      expect(() => createFixtureAccounts()).not.toThrow();
    });
  });

  test('does NOT throw when STELLAR_NETWORK is unset', () => {
    withEnv('STELLAR_NETWORK', undefined, () => {
      expect(() => createFixtureAccounts()).not.toThrow();
    });
  });

  test('NetworkGuardError message mentions the dangerous network value', () => {
    withEnv('STELLAR_NETWORK', 'mainnet', () => {
      let caught;
      try {
        createFixtureAccounts();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(NetworkGuardError);
      expect(caught.message).toMatch(/mainnet/i);
    });
  });

  test('assertNotProduction is exported for use in other test helpers', () => {
    expect(typeof assertNotProduction).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Determinism: same seed → same accounts
// ---------------------------------------------------------------------------
describe('Deterministic account generation', () => {
  let accounts1;
  let accounts2;

  beforeAll(() => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      accounts1 = createFixtureAccounts('test-seed-abc');
      accounts2 = createFixtureAccounts('test-seed-abc');
    });
  });

  test('same seed produces identical payer publicKey on two calls', () => {
    expect(accounts1.payer.publicKey).toBe(accounts2.payer.publicKey);
  });

  test('same seed produces identical payer secretKey on two calls', () => {
    expect(accounts1.payer.secretKey).toBe(accounts2.payer.secretKey);
  });

  test('same seed produces identical beneficiary publicKey on two calls', () => {
    expect(accounts1.beneficiary.publicKey).toBe(accounts2.beneficiary.publicKey);
  });

  test('same seed produces identical arbiter publicKey on two calls', () => {
    expect(accounts1.arbiter.publicKey).toBe(accounts2.arbiter.publicKey);
  });

  test('same seed produces identical school publicKey on two calls', () => {
    expect(accounts1.school.publicKey).toBe(accounts2.school.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Different seeds → different accounts
// ---------------------------------------------------------------------------
describe('Seed isolation', () => {
  let accountsA;
  let accountsB;

  beforeAll(() => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      accountsA = createFixtureAccounts('seed-alpha');
      accountsB = createFixtureAccounts('seed-beta');
    });
  });

  test('different seeds produce different payer publicKeys', () => {
    expect(accountsA.payer.publicKey).not.toBe(accountsB.payer.publicKey);
  });

  test('different seeds produce different beneficiary publicKeys', () => {
    expect(accountsA.beneficiary.publicKey).not.toBe(accountsB.beneficiary.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Default seed
// ---------------------------------------------------------------------------
describe('Default seed behaviour', () => {
  test('FIXTURE_SEED_DEFAULT is a non-empty string', () => {
    expect(typeof FIXTURE_SEED_DEFAULT).toBe('string');
    expect(FIXTURE_SEED_DEFAULT.length).toBeGreaterThan(0);
  });

  test('createFixtureAccounts() with no argument uses the default seed', () => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      const a = createFixtureAccounts();
      const b = createFixtureAccounts(FIXTURE_SEED_DEFAULT);
      expect(a.payer.publicKey).toBe(b.payer.publicKey);
    });
  });
});

// ---------------------------------------------------------------------------
// Account shape and roles
// ---------------------------------------------------------------------------
describe('Fixture account shape', () => {
  let accounts;

  beforeAll(() => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      accounts = createFixtureAccounts();
    });
  });

  test('all required roles are present: payer, beneficiary, arbiter, school', () => {
    expect(accounts.payer).toBeDefined();
    expect(accounts.beneficiary).toBeDefined();
    expect(accounts.arbiter).toBeDefined();
    expect(accounts.school).toBeDefined();
  });

  test('payer publicKey starts with "G" (Stellar public key format)', () => {
    expect(accounts.payer.publicKey).toMatch(/^G/);
  });

  test('payer secretKey starts with "S" (Stellar secret key format)', () => {
    expect(accounts.payer.secretKey).toMatch(/^S/);
  });

  test('beneficiary publicKey starts with "G"', () => {
    expect(accounts.beneficiary.publicKey).toMatch(/^G/);
  });

  test('arbiter publicKey starts with "G"', () => {
    expect(accounts.arbiter.publicKey).toMatch(/^G/);
  });

  test('each account has an initialBalanceXLM greater than zero', () => {
    for (const roleLabel of Object.values(FIXTURE_ROLES)) {
      expect(accounts[roleLabel].initialBalanceXLM).toBeGreaterThan(0);
    }
  });

  test('each account has a role label matching the key', () => {
    for (const roleLabel of Object.values(FIXTURE_ROLES)) {
      expect(accounts[roleLabel].role).toBe(roleLabel);
    }
  });

  test('publicKey and secretKey are different for the same account', () => {
    expect(accounts.payer.publicKey).not.toBe(accounts.payer.secretKey);
  });

  test('publicKey and secretKey have the expected length (56 chars)', () => {
    for (const roleLabel of Object.values(FIXTURE_ROLES)) {
      const acc = accounts[roleLabel];
      expect(acc.publicKey.length).toBe(56);
      expect(acc.secretKey.length).toBe(56);
    }
  });

  test('accounts object includes the seed used', () => {
    expect(typeof accounts.seed).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Secrets are not hardcoded
// ---------------------------------------------------------------------------
describe('Secrets are generated at runtime', () => {
  test('secretKey is not a static hardcoded string (varies with seed)', () => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      const a = createFixtureAccounts('seed-one');
      const b = createFixtureAccounts('seed-two');
      expect(a.payer.secretKey).not.toBe(b.payer.secretKey);
    });
  });

  test('secretKey is derived from role (payer secretKey differs from beneficiary secretKey)', () => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      const accounts = createFixtureAccounts();
      expect(accounts.payer.secretKey).not.toBe(accounts.beneficiary.secretKey);
    });
  });

  test('publicKey is derived from role (payer publicKey differs from arbiter publicKey)', () => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      const accounts = createFixtureAccounts();
      expect(accounts.payer.publicKey).not.toBe(accounts.arbiter.publicKey);
    });
  });
});

// ---------------------------------------------------------------------------
// Trustline config
// ---------------------------------------------------------------------------
describe('createTrustlineConfig', () => {
  let accounts;
  let trustlines;

  beforeAll(() => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      accounts = createFixtureAccounts();
      trustlines = createTrustlineConfig(accounts);
    });
  });

  test('trustline config includes XLM for each account', () => {
    const xlmLines = trustlines.filter(t => t.asset.code === 'XLM');
    expect(xlmLines.length).toBe(Object.keys(FIXTURE_ROLES).length);
  });

  test('trustline config includes USDC for each account', () => {
    const usdcLines = trustlines.filter(t => t.asset.code === 'USDC');
    expect(usdcLines.length).toBe(Object.keys(FIXTURE_ROLES).length);
  });

  test('USDC trustline has the correct testnet issuer', () => {
    const usdcLine = trustlines.find(t => t.asset.code === 'USDC');
    expect(usdcLine.asset.issuer).toBe(TESTNET_USDC_ISSUER);
  });

  test('XLM trustline does not require an on-chain trustline operation', () => {
    const xlmLine = trustlines.find(t => t.asset.code === 'XLM');
    expect(xlmLine.asset.requiresTrustline).toBe(false);
  });

  test('USDC trustline requires an on-chain trustline operation', () => {
    const usdcLine = trustlines.find(t => t.asset.code === 'USDC');
    expect(usdcLine.asset.requiresTrustline).toBe(true);
  });

  test('each trustline entry has account, role, and asset fields', () => {
    for (const line of trustlines) {
      expect(typeof line.account).toBe('string');
      expect(typeof line.role).toBe('string');
      expect(typeof line.asset).toBe('object');
    }
  });

  test('throws NetworkGuardError when called with mainnet set', () => {
    withEnv('STELLAR_NETWORK', 'mainnet', () => {
      expect(() => createTrustlineConfig(accounts)).toThrow(NetworkGuardError);
    });
  });
});

// ---------------------------------------------------------------------------
// Funding plan
// ---------------------------------------------------------------------------
describe('createFundingPlan', () => {
  let accounts;
  let plan;

  beforeAll(() => {
    withEnv('STELLAR_NETWORK', 'testnet', () => {
      accounts = createFixtureAccounts();
      plan = createFundingPlan(accounts);
    });
  });

  test('funding plan has one entry per fixture role', () => {
    expect(plan.length).toBe(Object.keys(FIXTURE_ROLES).length);
  });

  test('each entry has publicKey, role, and amountXLM', () => {
    for (const entry of plan) {
      expect(typeof entry.publicKey).toBe('string');
      expect(typeof entry.role).toBe('string');
      expect(entry.amountXLM).toBeGreaterThan(0);
    }
  });

  test('throws NetworkGuardError on mainnet', () => {
    withEnv('STELLAR_NETWORK', 'mainnet', () => {
      expect(() => createFundingPlan(accounts)).toThrow(NetworkGuardError);
    });
  });
});

// ---------------------------------------------------------------------------
// Low-level derivation
// ---------------------------------------------------------------------------
describe('Key derivation internals', () => {
  test('derivePublicKey is deterministic for the same seed+role', () => {
    const k1 = derivePublicKey('myseed', 'payer');
    const k2 = derivePublicKey('myseed', 'payer');
    expect(k1).toBe(k2);
  });

  test('deriveSecretKey is deterministic for the same seed+role', () => {
    const k1 = deriveSecretKey('myseed', 'payer');
    const k2 = deriveSecretKey('myseed', 'payer');
    expect(k1).toBe(k2);
  });

  test('derivePublicKey and deriveSecretKey produce different values', () => {
    const pub = derivePublicKey('myseed', 'payer');
    const sec = deriveSecretKey('myseed', 'payer');
    expect(pub).not.toBe(sec);
  });

  test('derivePublicKey starts with G', () => {
    expect(derivePublicKey('anyseed', 'anyRole')).toMatch(/^G/);
  });

  test('deriveSecretKey starts with S', () => {
    expect(deriveSecretKey('anyseed', 'anyRole')).toMatch(/^S/);
  });
});
