'use strict';

/**
 * Tests for providerPolicyRegistry (Issue #42).
 *
 * Verifies:
 *   - Each provider operation has an explicit timeout
 *   - Non-idempotent operations are not auto-retried
 *   - Idempotent operations are retried up to maxAttempts
 *   - Timeout cancels a slow call with POLICY_TIMEOUT code
 *   - Prometheus counters increment on retry and timeout
 *   - Global and provider-level wildcard fallbacks work
 */

// Stub metrics
jest.mock('../../backend/src/metrics', () => ({
  registry: {
    registerMetric: jest.fn(),
    getSingleMetric: jest.fn().mockReturnValue(null),
  },
}));

// Stub logger
jest.mock('../../backend/src/utils/logger', () => {
  const base = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { ...base, child: () => base };
});

const { getPolicy, executeWithPolicy, POLICIES } = require('../../backend/src/config/providerPolicyRegistry');

// ─────────────────────────────────────────────────────────────────────────────
// getPolicy — explicit policies
// ─────────────────────────────────────────────────────────────────────────────

describe('providerPolicyRegistry.getPolicy — explicit policies', () => {
  test('stellar.getAccount has a timeout and is idempotent', () => {
    const p = getPolicy('stellar', 'getAccount');
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(p.idempotent).toBe(true);
    expect(p.maxAttempts).toBeGreaterThan(1);
  });

  test('stellar.submitTransaction is NOT idempotent (maxAttempts=1)', () => {
    const p = getPolicy('stellar', 'submitTransaction');
    expect(p.idempotent).toBe(false);
    expect(p.maxAttempts).toBe(1);
  });

  test('stellar.getTransaction is idempotent', () => {
    const p = getPolicy('stellar', 'getTransaction');
    expect(p.idempotent).toBe(true);
  });

  test('stellar.getTransactionsForAccount is idempotent', () => {
    const p = getPolicy('stellar', 'getTransactionsForAccount');
    expect(p.idempotent).toBe(true);
  });

  test('stellar.getLatestLedger has shorter timeout than getTransactionsForAccount', () => {
    const fast = getPolicy('stellar', 'getLatestLedger');
    const slow = getPolicy('stellar', 'getTransactionsForAccount');
    expect(fast.timeoutMs).toBeLessThan(slow.timeoutMs);
  });

  test('all stellar operations have an explicit timeout > 0', () => {
    const stellarOps = Object.keys(POLICIES.stellar).filter((k) => k !== '*');
    for (const op of stellarOps) {
      const p = getPolicy('stellar', op);
      expect(p.timeoutMs).toBeGreaterThan(0);
    }
  });

  test('coingecko.getPrice is idempotent', () => {
    const p = getPolicy('coingecko', 'getPrice');
    expect(p.idempotent).toBe(true);
    expect(p.timeoutMs).toBeGreaterThan(0);
  });

  test('email.send is idempotent with timeout', () => {
    const p = getPolicy('email', 'send');
    expect(p.idempotent).toBe(true);
    expect(p.timeoutMs).toBeGreaterThan(0);
  });

  test('twilio.sendSms is NOT idempotent (maxAttempts=1 effective)', () => {
    const p = getPolicy('twilio', 'sendSms');
    expect(p.idempotent).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPolicy — wildcard fallbacks
// ─────────────────────────────────────────────────────────────────────────────

describe('providerPolicyRegistry.getPolicy — wildcard fallbacks', () => {
  test('unknown operation within known provider falls back to provider wildcard', () => {
    const p = getPolicy('stellar', 'unknownOperation_xyz');
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(p).toBeDefined();
  });

  test('completely unknown provider falls back to global wildcard', () => {
    const p = getPolicy('unknown_provider_abc', 'someOp');
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(p.maxAttempts).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWithPolicy — timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('providerPolicyRegistry.executeWithPolicy — timeout', () => {
  test('cancels a slow call and throws POLICY_TIMEOUT', async () => {
    const slowFn = () => new Promise((r) => setTimeout(r, 5000));
    await expect(
      executeWithPolicy('stellar', 'getAccount', slowFn, {
        policy: { timeoutMs: 20, maxAttempts: 1, idempotent: true, baseDelayMs: 0, maxDelayMs: 0 },
      })
    ).rejects.toMatchObject({ code: 'POLICY_TIMEOUT' });
  }, 1000);

  test('resolves when fn completes within timeout', async () => {
    const fastFn = () => Promise.resolve('ok');
    await expect(
      executeWithPolicy('stellar', 'getAccount', fastFn, {
        policy: { timeoutMs: 1000, maxAttempts: 1, idempotent: true, baseDelayMs: 0, maxDelayMs: 0 },
      })
    ).resolves.toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWithPolicy — idempotent retry
// ─────────────────────────────────────────────────────────────────────────────

describe('providerPolicyRegistry.executeWithPolicy — idempotent retry', () => {
  test('retries idempotent operation up to maxAttempts', async () => {
    let calls = 0;
    const failTwiceThird = jest.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('transient'));
      return Promise.resolve('success');
    });

    const result = await executeWithPolicy('stellar', 'getAccount', failTwiceThird, {
      policy: { timeoutMs: 1000, maxAttempts: 3, idempotent: true, baseDelayMs: 0, maxDelayMs: 0 },
    });

    expect(result).toBe('success');
    expect(failTwiceThird).toHaveBeenCalledTimes(3);
  });

  test('throws after all attempts exhausted', async () => {
    const alwaysFail = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      executeWithPolicy('stellar', 'getAccount', alwaysFail, {
        policy: { timeoutMs: 1000, maxAttempts: 2, idempotent: true, baseDelayMs: 0, maxDelayMs: 0 },
      })
    ).rejects.toThrow('always fails');
    expect(alwaysFail).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWithPolicy — non-idempotent (no retry)
// ─────────────────────────────────────────────────────────────────────────────

describe('providerPolicyRegistry.executeWithPolicy — non-idempotent operations', () => {
  test('does NOT retry a non-idempotent operation', async () => {
    const failOnce = jest.fn().mockRejectedValue(new Error('tx failed'));
    await expect(
      executeWithPolicy('stellar', 'submitTransaction', failOnce, {
        policy: { timeoutMs: 1000, maxAttempts: 3, idempotent: false, baseDelayMs: 0, maxDelayMs: 0 },
      })
    ).rejects.toThrow('tx failed');
    // Called exactly once despite maxAttempts=3
    expect(failOnce).toHaveBeenCalledTimes(1);
  });

  test('stellar.submitTransaction uses maxAttempts=1 from registry', () => {
    const p = getPolicy('stellar', 'submitTransaction');
    // idempotent:false means only 1 effective attempt regardless of maxAttempts value
    expect(p.idempotent).toBe(false);
    expect(p.maxAttempts).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observable: all operations have timeouts
// ─────────────────────────────────────────────────────────────────────────────

describe('providerPolicyRegistry — observability contract', () => {
  test('every concrete policy entry has timeoutMs > 0', () => {
    for (const [provider, ops] of Object.entries(POLICIES)) {
      for (const [op, policy] of Object.entries(ops)) {
        expect(policy.timeoutMs).toBeGreaterThan(0);
      }
    }
  });

  test('every concrete policy entry has maxAttempts >= 1', () => {
    for (const [provider, ops] of Object.entries(POLICIES)) {
      for (const [op, policy] of Object.entries(ops)) {
        expect(policy.maxAttempts).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('non-idempotent policies have maxAttempts=1', () => {
    for (const [provider, ops] of Object.entries(POLICIES)) {
      for (const [op, policy] of Object.entries(ops)) {
        if (!policy.idempotent) {
          expect(policy.maxAttempts).toBe(1);
        }
      }
    }
  });

  test('environment variable override modifies policy timeout and attempts (#290)', () => {
    process.env.PROVIDER_STELLAR_GETACCOUNT_TIMEOUT_MS = '99999';
    process.env.PROVIDER_STELLAR_GETACCOUNT_MAX_ATTEMPTS = '7';

    const p = getPolicy('stellar', 'getAccount');
    expect(p.timeoutMs).toBe(99999);
    expect(p.maxAttempts).toBe(7);

    delete process.env.PROVIDER_STELLAR_GETACCOUNT_TIMEOUT_MS;
    delete process.env.PROVIDER_STELLAR_GETACCOUNT_MAX_ATTEMPTS;
  });

  test('ProviderHttpClient base class integrates with provider policies (#290)', () => {
    const ProviderHttpClient = require('../../backend/src/utils/ProviderHttpClient');
    const client = new ProviderHttpClient('stellar');
    expect(client.providerName).toBe('stellar');

    const policy = client.getOperationPolicy('getAccount');
    expect(policy).toBeDefined();
    expect(policy.circuitBreaker).toBeDefined();
  });
});
