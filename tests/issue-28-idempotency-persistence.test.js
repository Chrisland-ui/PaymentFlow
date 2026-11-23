'use strict';

/**
 * Tests for Issue #28 — Idempotency-Key Persistence for Payment Creation
 *
 * Verifies all three acceptance criteria:
 *   AC1: Same key + same body → original result is returned (replay semantics)
 *   AC2: Same key + different body → 422 IDEMPOTENCY_KEY_REUSE conflict
 *   AC3: Concurrent requests with the same key cannot duplicate work (409)
 *
 * Additional scenarios:
 *   - Missing header → 400 MISSING_IDEMPOTENCY_KEY
 *   - 5xx response releases the reservation so the client can retry
 *   - 404 response releases the reservation (transient errors must be retryable)
 *   - Stale in-flight reservation is taken over (crashed request never wedges a key)
 *   - fail-closed vs fail-open behaviour when the store is unavailable
 *
 * The middleware and store are tested using a small in-process Express app with
 * a fully mocked idempotencyStore so no real DB or Redis is needed.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

// ── Mock idempotencyStore before any require loads it ────────────────────────
let mockStore;

jest.mock('../backend/src/services/idempotencyStore', () => {
  const store = {
    IN_FLIGHT_TTL_MS: 30000,
    getFull: jest.fn(),
    reserve: jest.fn(),
    complete: jest.fn(),
    release: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    redisEnabled: false,
  };
  mockStore = store;
  return store;
});

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: false,
    localAmount: null,
    currency: 'USD',
    rate: null,
    rateTimestamp: null,
  }),
}));

jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const express = require('express');
const request = require('supertest');
const idempotency = require('../backend/src/middleware/idempotency');
const { fingerprintRequest, deriveIdempotencyKey, canonicalize } = require('../backend/src/utils/idempotencyKey');

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(handler, opts = {}) {
  const app = express();
  app.use(express.json());
  app.post('/api/payments/verify', idempotency(opts), handler);
  return app;
}

function successHandler(body = { status: 'ok', txHash: 'tx1' }, status = 200) {
  return (req, res) => res.status(status).json(body);
}

function errorHandler(status = 500) {
  return (req, res) => res.status(status).json({ error: 'Server error', code: 'INTERNAL_ERROR' });
}

function configureStoreForFreshRequest() {
  mockStore.getFull.mockResolvedValue(null);
  mockStore.reserve.mockResolvedValue({ reserved: true });
  mockStore.complete.mockResolvedValue();
  mockStore.release.mockResolvedValue();
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Missing / blank header
// ─────────────────────────────────────────────────────────────────────────────

describe('Missing Idempotency-Key header', () => {
  test('returns 400 MISSING_IDEMPOTENCY_KEY when header is absent', async () => {
    const res = await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .send({ txHash: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test('returns 400 when header value is blank', async () => {
    const res = await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .set('Idempotency-Key', '   ')
      .send({ txHash: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — Same key + same body returns the original result
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1: Same key + same body returns the original result (replay)', () => {
  test('replays a 200 response from a completed record', async () => {
    const cachedBody = { status: 'verified', txHash: 'tx-abc', amount: 100 };
    const fp = fingerprintRequest({ txHash: 'tx-abc' });

    mockStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: fp,
      responseStatus: 200,
      responseBody: cachedBody,
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    const res = await request(buildApp(successHandler({ status: 'should-not-appear' })))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-replay-200')
      .send({ txHash: 'tx-abc' });

    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe('tx-abc');
    expect(res.body.status).toBe('verified');
    // reserve() must NOT be called when replaying a completed record
    expect(mockStore.reserve).not.toHaveBeenCalled();
  });

  test('replays a 201 response verbatim', async () => {
    mockStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: null,
      responseStatus: 201,
      responseBody: { created: true, id: 'pay-001' },
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    const res = await request(buildApp(successHandler({ created: false }, 201)))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-replay-201')
      .send({ txHash: 'tx-new' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.id).toBe('pay-001');
  });

  test('first request persists result so subsequent calls replay it', async () => {
    configureStoreForFreshRequest();

    const res = await request(buildApp(successHandler({ txHash: 'tx-first', status: 'ok' })))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-first-persist')
      .send({ txHash: 'tx-first' });

    expect(res.status).toBe(200);
    expect(mockStore.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        responseStatus: 200,
        responseBody: expect.objectContaining({ txHash: 'tx-first' }),
      })
    );
  });

  test('replays a response that survived a process restart (from persistent store)', async () => {
    mockStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: null,
      responseStatus: 200,
      responseBody: { txHash: 'tx-persisted', status: 'verified' },
      scope: '/api/payments/verify',
      createdAt: new Date(Date.now() - 5_000),
    });

    const res = await request(buildApp(successHandler({ txHash: 'would-duplicate', status: 'bad' })))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-after-restart')
      .send({ txHash: 'tx-persisted' });

    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe('tx-persisted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — Same key + different body returns 422 conflict
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2: Same key with different request body returns conflict', () => {
  test('returns 422 IDEMPOTENCY_KEY_REUSE when fingerprint differs', async () => {
    const originalFp = fingerprintRequest({ txHash: 'original-tx' });

    mockStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: originalFp,
      responseStatus: 200,
      responseBody: { status: 'ok' },
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    // Same key, different body
    const res = await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-conflict')
      .send({ txHash: 'different-tx' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(res.body.error).toMatch(/different request body/i);
  });

  test('does NOT conflict when fingerprints match (safe retry)', async () => {
    const body = { txHash: 'same-tx' };
    const fp = fingerprintRequest(body);

    mockStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: fp,
      responseStatus: 200,
      responseBody: { txHash: 'same-tx', status: 'ok' },
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    const res = await request(buildApp(successHandler({ txHash: 'same-tx', status: 'ok' })))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-safe-retry')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
  });

  test('does NOT conflict when stored fingerprint is null (legacy record)', async () => {
    mockStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: null,
      responseStatus: 200,
      responseBody: { status: 'ok' },
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    const res = await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-legacy')
      .send({ txHash: 'any-body' });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — Concurrent requests cannot duplicate work
// ─────────────────────────────────────────────────────────────────────────────

describe('AC3: Concurrent requests with same key cannot duplicate work', () => {
  test('returns 409 IDEMPOTENCY_KEY_IN_PROGRESS for a non-stale in_progress record', async () => {
    mockStore.getFull.mockResolvedValue({
      state: 'in_progress',
      requestFingerprint: null,
      responseStatus: null,
      responseBody: null,
      scope: '/api/payments/verify',
      createdAt: new Date(), // fresh — not stale
    });

    const res = await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-in-progress')
      .send({ txHash: 'tx-concurrent' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(res.body.error).toMatch(/already being processed/i);
  });

  test('handler is never invoked for the concurrent duplicate', async () => {
    const handlerSpy = jest.fn((req, res) => res.status(200).json({ ok: true }));

    mockStore.getFull.mockResolvedValue({
      state: 'in_progress',
      requestFingerprint: null,
      responseStatus: null,
      responseBody: null,
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    await request(buildApp(handlerSpy))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-handler-not-called')
      .send({ txHash: 'tx-dup' });

    expect(handlerSpy).not.toHaveBeenCalled();
  });

  test('reserve() atomically claims the key for the winning request', async () => {
    configureStoreForFreshRequest();

    await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-race-winner')
      .send({ txHash: 'tx-win' });

    expect(mockStore.reserve).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fingerprint: expect.any(String) })
    );
  });

  test('losing racer receives 409 when reserve reports not-reserved with in_progress record', async () => {
    mockStore.getFull.mockResolvedValue(null);
    mockStore.reserve.mockResolvedValue({
      reserved: false,
      record: {
        state: 'in_progress',
        requestFingerprint: null,
        responseStatus: null,
        responseBody: null,
        scope: '/api/payments/verify',
        createdAt: new Date(),
      },
    });

    const res = await request(buildApp(successHandler()))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-race-loser')
      .send({ txHash: 'tx-lost' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
  });

  test('stale in_progress reservation is taken over and request proceeds normally', async () => {
    // Stale = older than IN_FLIGHT_TTL_MS (30s)
    mockStore.getFull.mockResolvedValue({
      state: 'in_progress',
      requestFingerprint: null,
      responseStatus: null,
      responseBody: null,
      scope: '/api/payments/verify',
      createdAt: new Date(Date.now() - (mockStore.IN_FLIGHT_TTL_MS + 5_000)),
    });

    // Falls through to reserve() which takes over the stale record
    mockStore.reserve.mockResolvedValue({ reserved: true });
    mockStore.complete.mockResolvedValue();

    const res = await request(buildApp(successHandler({ ok: true })))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-stale-takeover')
      .send({ txHash: 'tx-stale' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockStore.reserve).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5xx releases the reservation for retry
// ─────────────────────────────────────────────────────────────────────────────

describe('5xx response: reservation is released so client can retry', () => {
  test('release() is called and complete() is NOT called for 500', async () => {
    configureStoreForFreshRequest();

    const res = await request(buildApp(errorHandler(500)))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-500')
      .send({ txHash: 'tx-fail' });

    expect(res.status).toBe(500);
    expect(mockStore.release).toHaveBeenCalled();
    expect(mockStore.complete).not.toHaveBeenCalled();
  });

  test('release() is called for 503', async () => {
    configureStoreForFreshRequest();

    const res = await request(buildApp(errorHandler(503)))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-503')
      .send({ txHash: 'tx-fail-503' });

    expect(res.status).toBe(503);
    expect(mockStore.release).toHaveBeenCalled();
    expect(mockStore.complete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 releases the reservation (transient — resource may appear later)
// ─────────────────────────────────────────────────────────────────────────────

describe('404 response: reservation is released for retry', () => {
  test('release() is called for 404', async () => {
    configureStoreForFreshRequest();

    const handler = (req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const res = await request(buildApp(handler))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-404')
      .send({ txHash: 'tx-missing' });

    expect(res.status).toBe(404);
    expect(mockStore.release).toHaveBeenCalled();
    expect(mockStore.complete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4xx (not 404) results are cached
// ─────────────────────────────────────────────────────────────────────────────

describe('4xx (non-404) response: result is cached for replay', () => {
  test('complete() is called for 400', async () => {
    configureStoreForFreshRequest();

    const handler = (req, res) => res.status(400).json({ error: 'Bad request', code: 'VALIDATION_ERROR' });
    const res = await request(buildApp(handler))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-400')
      .send({ txHash: 'tx-bad' });

    expect(res.status).toBe(400);
    expect(mockStore.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ responseStatus: 400 })
    );
    expect(mockStore.release).not.toHaveBeenCalled();
  });

  test('complete() is called for 422', async () => {
    configureStoreForFreshRequest();

    const handler = (req, res) => res.status(422).json({ error: 'Unprocessable', code: 'UNPROCESSABLE' });
    const res = await request(buildApp(handler))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-422')
      .send({ txHash: 'tx-422' });

    expect(res.status).toBe(422);
    expect(mockStore.complete).toHaveBeenCalled();
    expect(mockStore.release).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fail-closed vs fail-open
// ─────────────────────────────────────────────────────────────────────────────

describe('Store unavailability: fail-closed vs fail-open', () => {
  test('returns 503 IDEMPOTENCY_STORE_UNAVAILABLE when store throws and failClosed=true', async () => {
    mockStore.getFull.mockRejectedValue(new Error('Mongo down'));

    const res = await request(buildApp(successHandler(), { failClosed: true }))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-closed')
      .send({ txHash: 'tx-closed' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('IDEMPOTENCY_STORE_UNAVAILABLE');
  });

  test('proceeds (fail-open) when store throws and failClosed=false', async () => {
    mockStore.getFull.mockRejectedValue(new Error('Mongo down'));

    const res = await request(buildApp(successHandler({ ok: true }), { failClosed: false }))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-open')
      .send({ txHash: 'tx-open' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('criticalPaymentEndpoints option also fails closed on store error', async () => {
    mockStore.getFull.mockRejectedValue(new Error('Redis down'));

    const res = await request(buildApp(successHandler(), { criticalPaymentEndpoints: true }))
      .post('/api/payments/verify')
      .set('Idempotency-Key', 'key-critical')
      .send({ txHash: 'tx-critical' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('IDEMPOTENCY_STORE_UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveIdempotencyKey and fingerprintRequest utilities
// ─────────────────────────────────────────────────────────────────────────────

describe('idempotencyKey utility functions', () => {
  test('deriveIdempotencyKey returns null for empty/null key', () => {
    expect(deriveIdempotencyKey(null)).toBeNull();
    expect(deriveIdempotencyKey('')).toBeNull();
    expect(deriveIdempotencyKey('  ')).toBeNull();
  });

  test('same key + same scope always yields the same canonical key', () => {
    const k1 = deriveIdempotencyKey('my-key', '/api/payments/verify');
    const k2 = deriveIdempotencyKey('my-key', '/api/payments/verify');
    expect(k1).toBe(k2);
  });

  test('same key + different scope yields different canonical keys', () => {
    const k1 = deriveIdempotencyKey('my-key', '/api/payments/verify');
    const k2 = deriveIdempotencyKey('my-key', '/api/payments/intent');
    expect(k1).not.toBe(k2);
  });

  test('fingerprintRequest is deterministic for the same body', () => {
    const body = { txHash: 'abc', studentId: 'STU001', amount: 250 };
    expect(fingerprintRequest(body)).toBe(fingerprintRequest(body));
  });

  test('fingerprintRequest is order-independent (canonicalized)', () => {
    const b1 = { txHash: 'abc', studentId: 'STU001' };
    const b2 = { studentId: 'STU001', txHash: 'abc' };
    expect(fingerprintRequest(b1)).toBe(fingerprintRequest(b2));
  });

  test('fingerprintRequest produces different hashes for different bodies', () => {
    expect(fingerprintRequest({ txHash: 'abc' })).not.toBe(fingerprintRequest({ txHash: 'xyz' }));
  });

  test('fingerprintRequest handles undefined body without throwing', () => {
    expect(() => fingerprintRequest(undefined)).not.toThrow();
    expect(typeof fingerprintRequest(undefined)).toBe('string');
  });

  test('canonicalize is stable for nested objects with re-ordered keys', () => {
    const a = canonicalize({ b: [1, 2], a: { x: 1 } });
    const b = canonicalize({ a: { x: 1 }, b: [1, 2] });
    expect(a).toBe(b);
  });
});
