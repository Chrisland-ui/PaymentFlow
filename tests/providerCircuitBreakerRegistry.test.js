'use strict';

/**
 * Tests for providerCircuitBreakerRegistry (Issue #31).
 *
 * Verifies:
 *   - Each pre-registered provider starts in CLOSED state
 *   - Open circuits fail fast with a stable error
 *   - Successful probes close the circuit (OPEN → HALF_OPEN → CLOSED)
 *   - State transitions are observable via getAllStatuses()
 *   - withBreaker() delegates success/failure recording correctly
 *   - New providers can be registered at runtime
 */

// Stub metrics to avoid prom-client registry collisions in tests
jest.mock('../../backend/src/metrics', () => ({
  registry: { registerMetric: jest.fn() },
}));

// Stub logger to keep output clean
jest.mock('../../backend/src/utils/logger', () => {
  const base = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { ...base, child: () => base };
});

// ── Re-import after mocks ─────────────────────────────────────────────────────
// Use jest.isolateModules so each test suite gets its own registry instance
// and breakers do not bleed state between test files.

let registry;

beforeEach(() => {
  jest.resetModules();
  registry = require('../../backend/src/services/providerCircuitBreakerRegistry');
});

const { CB_STATE } = require('../../backend/src/utils/circuitBreaker');

// ─────────────────────────────────────────────────────────────────────────────
// Initial state
// ─────────────────────────────────────────────────────────────────────────────

describe('providerCircuitBreakerRegistry — initial state', () => {
  test('all pre-registered providers start in CLOSED state', () => {
    const { PROVIDER_NAMES } = registry;
    for (const name of PROVIDER_NAMES) {
      const cb = registry.getBreaker(name);
      expect(cb.getState()).toBe(CB_STATE.CLOSED);
    }
  });

  test('getAllStatuses() returns one entry per provider', () => {
    const statuses = registry.getAllStatuses();
    const { PROVIDER_NAMES } = registry;
    expect(statuses.length).toBe(PROVIDER_NAMES.length);
    for (const s of statuses) {
      expect(s).toMatchObject({
        provider: expect.any(String),
        state:    'closed',
        failures: 0,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Open circuit fails fast
// ─────────────────────────────────────────────────────────────────────────────

describe('providerCircuitBreakerRegistry — open circuit fails fast', () => {
  test('open circuit throws with stable CIRCUIT_OPEN code', async () => {
    const cb = registry.getBreaker('email_smtp');
    // Force threshold failures to open the breaker
    const threshold = cb.failureThreshold;
    for (let i = 0; i < threshold; i++) cb.recordFailure();

    expect(cb.getState()).toBe(CB_STATE.OPEN);

    await expect(
      registry.withBreaker('email_smtp', () => Promise.resolve('should not run'))
    ).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });

  test('open circuit does not call the wrapped function', async () => {
    const cb = registry.getBreaker('coingecko');
    for (let i = 0; i < cb.failureThreshold; i++) cb.recordFailure();

    const fn = jest.fn().mockResolvedValue('ok');
    await expect(registry.withBreaker('coingecko', fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Successful probes close the circuit
// ─────────────────────────────────────────────────────────────────────────────

describe('providerCircuitBreakerRegistry — probe closes circuit', () => {
  test('HALF_OPEN → CLOSED after successThreshold successes', async () => {
    const cb = registry.registerBreaker('test_probe', {
      failureThreshold: 2,
      resetTimeoutMs:   1,   // 1ms so timeout elapses immediately in tests
      successThreshold: 2,
    });

    // Open it
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(CB_STATE.OPEN);

    // Wait 2ms so the reset timeout elapses
    await new Promise((r) => setTimeout(r, 5));

    // First isAvailable() call transitions to HALF_OPEN
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe(CB_STATE.HALF_OPEN);

    // Two successes (successThreshold=2) close the circuit
    cb.recordSuccess();
    expect(cb.getState()).toBe(CB_STATE.HALF_OPEN);
    cb.recordSuccess();
    expect(cb.getState()).toBe(CB_STATE.CLOSED);
  });

  test('HALF_OPEN → OPEN on failure during probe', async () => {
    const cb = registry.registerBreaker('test_probe_fail', {
      failureThreshold: 1,
      resetTimeoutMs:   1,
      successThreshold: 2,
    });

    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 5));
    cb.isAvailable(); // transition to HALF_OPEN

    cb.recordFailure(); // back to OPEN
    expect(cb.getState()).toBe(CB_STATE.OPEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withBreaker records outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe('providerCircuitBreakerRegistry — withBreaker records outcomes', () => {
  test('records success when fn resolves', async () => {
    const cb = registry.getBreaker('stellar_horizon');
    const before = cb.getFailures();

    await registry.withBreaker('stellar_horizon', () => Promise.resolve('ok'));

    // failures counter resets on success when in CLOSED state
    expect(cb.getFailures()).toBe(0);
    expect(cb.getState()).toBe(CB_STATE.CLOSED);
  });

  test('records failure when fn rejects', async () => {
    const cb = registry.getBreaker('coinbase');
    const before = cb.getFailures();

    await expect(
      registry.withBreaker('coinbase', () => Promise.reject(new Error('upstream down')))
    ).rejects.toThrow('upstream down');

    expect(cb.getFailures()).toBeGreaterThan(before);
  });

  test('returns the fn result on success', async () => {
    const result = await registry.withBreaker('email_ses', () => Promise.resolve({ messageId: 'msg-1' }));
    expect(result).toEqual({ messageId: 'msg-1' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic registration
// ─────────────────────────────────────────────────────────────────────────────

describe('providerCircuitBreakerRegistry — dynamic registration', () => {
  test('getBreaker on unknown provider creates one with defaults', () => {
    const cb = registry.getBreaker('unknown_provider_xyz');
    expect(cb).toBeDefined();
    expect(cb.getState()).toBe(CB_STATE.CLOSED);
  });

  test('registerBreaker overrides existing breaker', () => {
    const cb1 = registry.registerBreaker('custom_provider', { failureThreshold: 3 });
    const cb2 = registry.getBreaker('custom_provider');
    expect(cb1).toBe(cb2);
    expect(cb2.failureThreshold).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observable state transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('providerCircuitBreakerRegistry — observable transitions', () => {
  test('getAllStatuses() reflects open state after failures', () => {
    const cb = registry.getBreaker('email_sendgrid');
    for (let i = 0; i < cb.failureThreshold; i++) cb.recordFailure();

    const statuses = registry.getAllStatuses();
    const entry = statuses.find((s) => s.provider === 'email_sendgrid');
    expect(entry.state).toBe(CB_STATE.OPEN);
    expect(entry.failures).toBeGreaterThan(0);
    expect(entry.timeUntilRetryMs).toBeGreaterThan(0);
  });
});
