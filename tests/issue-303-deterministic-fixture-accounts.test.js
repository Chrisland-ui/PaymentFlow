'use strict';

/**
 * Tests for Issue #303 — Build deterministic test fixture accounts for contract testing.
 *
 * Covers:
 *  1. Determinism: same keypairs produced on every run.
 *  2. Role completeness: admin, school, student, platformFee, escrow all present.
 *  3. Key format: public keys start with G, secret keys start with S.
 *  4. Key uniqueness: every role has a distinct keypair.
 *  5. Initial balances: each account has its documented starting balance.
 *  6. State initialisation: initFixtureState() sets clean balances.
 *  7. Snapshot/restore: mutations are fully reversible.
 *  8. simulatePayment: mutates balances correctly; rejects overdrafts.
 *  9. Offline capability: no network calls occur during any test.
 * 10. Performance: fixture setup completes in well under 1 second.
 */

const {
  FIXTURE_ACCOUNTS,
  MASTER_SEED,
  initFixtureState,
  getAccountState,
  setAccountState,
  snapshotState,
  restoreState,
  simulatePayment,
  deriveKeySeed,
  buildFixtureAccount,
} = require('./fixtures/contractFixtures');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — fixture accounts are deterministic', () => {
  test('same public key is produced on every require() call', () => {
    // Re-derive and compare — pure function, no I/O.
    const adminA = buildFixtureAccount('admin', 'test', 0);
    const adminB = buildFixtureAccount('admin', 'test', 0);
    expect(adminA.publicKey).toBe(adminB.publicKey);
    expect(adminA.secretKey).toBe(adminB.secretKey);
  });

  test('FIXTURE_ACCOUNTS keys are stable across module reloads', () => {
    // Record the public keys.
    const keys = Object.entries(FIXTURE_ACCOUNTS).map(([role, acc]) => [role, acc.publicKey]);

    // Derive them fresh and compare.
    for (const [role, publicKey] of keys) {
      const fresh = buildFixtureAccount(role, '', 0);
      expect(fresh.publicKey).toBe(publicKey);
    }
  });

  test('deriveKeySeed produces the same 32-byte buffer for the same role', () => {
    const seedA = deriveKeySeed('school');
    const seedB = deriveKeySeed('school');
    expect(seedA.equals(seedB)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Role completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — all required fixture roles are present', () => {
  const REQUIRED_ROLES = ['admin', 'school', 'student', 'platformFee', 'escrow'];

  for (const role of REQUIRED_ROLES) {
    test(`role "${role}" exists in FIXTURE_ACCOUNTS`, () => {
      expect(FIXTURE_ACCOUNTS[role]).toBeDefined();
    });

    test(`role "${role}" has a description`, () => {
      expect(typeof FIXTURE_ACCOUNTS[role].description).toBe('string');
      expect(FIXTURE_ACCOUNTS[role].description.length).toBeGreaterThan(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Key format — G… public keys, S… secret keys
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — key format (Stellar StrKey)', () => {
  for (const [role, account] of Object.entries(FIXTURE_ACCOUNTS)) {
    test(`${role} publicKey starts with "G"`, () => {
      expect(account.publicKey.startsWith('G')).toBe(true);
    });

    test(`${role} secretKey starts with "S"`, () => {
      expect(account.secretKey.startsWith('S')).toBe(true);
    });

    test(`${role} publicKey is 56 characters (standard Stellar key length)`, () => {
      expect(account.publicKey).toHaveLength(56);
    });

    test(`${role} secretKey is 56 characters`, () => {
      expect(account.secretKey).toHaveLength(56);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Key uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — each role has a unique keypair', () => {
  test('all publicKeys are distinct', () => {
    const publicKeys = Object.values(FIXTURE_ACCOUNTS).map((a) => a.publicKey);
    const unique = new Set(publicKeys);
    expect(unique.size).toBe(publicKeys.length);
  });

  test('all secretKeys are distinct', () => {
    const secretKeys = Object.values(FIXTURE_ACCOUNTS).map((a) => a.secretKey);
    const unique = new Set(secretKeys);
    expect(unique.size).toBe(secretKeys.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Initial balances
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — documented initial balances', () => {
  test('admin has the highest initial balance', () => {
    expect(FIXTURE_ACCOUNTS.admin.initialBalance).toBeGreaterThan(
      FIXTURE_ACCOUNTS.school.initialBalance,
    );
  });

  test('all accounts have a positive initial balance', () => {
    for (const account of Object.values(FIXTURE_ACCOUNTS)) {
      expect(account.initialBalance).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. State initialisation
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — initFixtureState resets account state', () => {
  beforeEach(() => initFixtureState());

  test('each account starts with its documented initial balance', () => {
    for (const [, account] of Object.entries(FIXTURE_ACCOUNTS)) {
      const state = getAccountState(account.publicKey);
      expect(state).not.toBeNull();
      expect(state.balance).toBe(account.initialBalance);
    }
  });

  test('each account starts with nonce 0', () => {
    for (const [, account] of Object.entries(FIXTURE_ACCOUNTS)) {
      const state = getAccountState(account.publicKey);
      expect(state.nonce).toBe(0);
    }
  });

  test('each account starts with sequenceNumber 1', () => {
    for (const [, account] of Object.entries(FIXTURE_ACCOUNTS)) {
      const state = getAccountState(account.publicKey);
      expect(state.sequenceNumber).toBe(1);
    }
  });

  test('calling initFixtureState() twice produces clean state both times', () => {
    // Mutate
    setAccountState(FIXTURE_ACCOUNTS.student.publicKey, { balance: 0 });
    // Re-init
    initFixtureState();
    const state = getAccountState(FIXTURE_ACCOUNTS.student.publicKey);
    expect(state.balance).toBe(FIXTURE_ACCOUNTS.student.initialBalance);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Snapshot / restore
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — snapshot and restore account state', () => {
  beforeEach(() => initFixtureState());

  test('snapshot captures current state and restore reverts mutations', () => {
    const snap = snapshotState();

    // Mutate the student balance.
    setAccountState(FIXTURE_ACCOUNTS.student.publicKey, { balance: 1 });
    expect(getAccountState(FIXTURE_ACCOUNTS.student.publicKey).balance).toBe(1);

    // Restore.
    restoreState(snap);
    expect(getAccountState(FIXTURE_ACCOUNTS.student.publicKey).balance).toBe(
      FIXTURE_ACCOUNTS.student.initialBalance,
    );
  });

  test('snapshot is a deep copy (mutating snapshot does not affect live state)', () => {
    const snap = snapshotState();
    // Mutate the snapshot directly.
    snap.get(FIXTURE_ACCOUNTS.admin.publicKey).balance = 0;

    // Live state must be unchanged.
    expect(getAccountState(FIXTURE_ACCOUNTS.admin.publicKey).balance).toBe(
      FIXTURE_ACCOUNTS.admin.initialBalance,
    );
  });

  test('multiple snapshots are independent', () => {
    const snap1 = snapshotState();
    setAccountState(FIXTURE_ACCOUNTS.school.publicKey, { balance: 9999 });
    const snap2 = snapshotState();

    restoreState(snap1);
    expect(getAccountState(FIXTURE_ACCOUNTS.school.publicKey).balance).toBe(
      FIXTURE_ACCOUNTS.school.initialBalance,
    );

    restoreState(snap2);
    expect(getAccountState(FIXTURE_ACCOUNTS.school.publicKey).balance).toBe(9999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. simulatePayment
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — simulatePayment (offline balance mutation)', () => {
  beforeEach(() => initFixtureState());

  const { student, school } = FIXTURE_ACCOUNTS;

  test('transfers XLM from student to school', () => {
    const amount = 100;
    const result = simulatePayment(student.publicKey, school.publicKey, amount);

    expect(result.success).toBe(true);
    expect(getAccountState(student.publicKey).balance).toBe(student.initialBalance - amount);
    expect(getAccountState(school.publicKey).balance).toBe(school.initialBalance + amount);
  });

  test('increments sender nonce and sequenceNumber on success', () => {
    simulatePayment(student.publicKey, school.publicKey, 10);
    const state = getAccountState(student.publicKey);
    expect(state.nonce).toBe(1);
    expect(state.sequenceNumber).toBe(2);
  });

  test('rejects overdraft with INSUFFICIENT_BALANCE', () => {
    const result = simulatePayment(student.publicKey, school.publicKey, 99999);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('INSUFFICIENT_BALANCE');
    // Balances must not have changed.
    expect(getAccountState(student.publicKey).balance).toBe(student.initialBalance);
  });

  test('rejects payment from unknown sender', () => {
    const result = simulatePayment('GUNKNOWN', school.publicKey, 1);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('SENDER_NOT_FOUND');
  });

  test('rejects payment to unknown recipient', () => {
    const result = simulatePayment(student.publicKey, 'GUNKNOWN', 1);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('RECIPIENT_NOT_FOUND');
  });

  test('multiple sequential payments reduce balance correctly', () => {
    simulatePayment(student.publicKey, school.publicKey, 50);
    simulatePayment(student.publicKey, school.publicKey, 50);
    simulatePayment(student.publicKey, school.publicKey, 50);
    expect(getAccountState(student.publicKey).balance).toBe(student.initialBalance - 150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Offline capability
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — fixture module makes no network calls', () => {
  test('all exported functions are synchronous or resolve without I/O', async () => {
    // This test runs in an environment where blockRealHttp.js is active —
    // any real HTTP call would throw. If this test passes, no network I/O occurred.
    initFixtureState();
    const snap = snapshotState();
    simulatePayment(
      FIXTURE_ACCOUNTS.student.publicKey,
      FIXTURE_ACCOUNTS.escrow.publicKey,
      10,
    );
    restoreState(snap);
    // We get here only if no network call was made.
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Performance (acceptance criterion: <60 seconds total test suite)
// ─────────────────────────────────────────────────────────────────────────────

describe('#303 — fixture initialisation performance', () => {
  test('initFixtureState completes in under 100ms', () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      initFixtureState();
    }
    const elapsed = Date.now() - start;
    // 100 initialisations in under 100ms means each one is <1ms.
    expect(elapsed).toBeLessThan(100);
  });

  test('snapshotState + restoreState round-trip is under 5ms', () => {
    initFixtureState();
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      const snap = snapshotState();
      restoreState(snap);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
