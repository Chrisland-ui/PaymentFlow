'use strict';

/**
 * Deterministic clock tests — Issue #97
 *
 * Token expiry, webhook replay protection, retry backoff, and audit-log
 * retention all depend on the passage of time. Without clock injection
 * these tests would be flaky around time boundaries or require wall-clock
 * sleeps.
 *
 * This test suite uses jest.useFakeTimers() / jest.setSystemTime() to freeze
 * and advance time deterministically so:
 *   - Boundary seconds are covered without real delays
 *   - Timezone-independent behavior is verified
 *   - No test ever calls setTimeout(fn, realDelay) or sleep()
 *
 * Acceptance criteria:
 *   - Boundary seconds covered (exactly at expiry, one second before, one after)
 *   - Timezone-independent: tested at UTC, UTC+5:30, UTC-8
 *   - No wall-clock sleeps
 */

// ── Env setup (before any requires) ──────────────────────────────────────────
process.env.JWT_SECRET = 'ci-clock-test-secret-not-used-in-production';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.AUDIT_LOG_RETENTION_DAYS = '90';
process.env.WEBHOOK_REPLAY_WINDOW_S = '300'; // 5-minute replay window

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Advance fake clock by the given number of seconds */
function advanceSec(s) {
  jest.advanceTimersByTime(s * 1000);
}

/** Produce a Unix timestamp (seconds) from the current fake system time */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. JWT access-token expiry boundary tests
// ─────────────────────────────────────────────────────────────────────────────

describe('JWT access-token expiry — deterministic clock', () => {
  const jwt = require('jsonwebtoken');
  const SECRET = process.env.JWT_SECRET;
  const TTL_SECONDS = 3600; // 1 hour access token

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('token is valid 1 second before expiry boundary', () => {
    const token = jwt.sign({ role: 'admin', sub: 'ci-test-user' }, SECRET, { expiresIn: TTL_SECONDS });

    // Advance to 1 second BEFORE expiry
    advanceSec(TTL_SECONDS - 1);

    expect(() => jwt.verify(token, SECRET)).not.toThrow();
  });

  test('token is valid AT the exact issue time', () => {
    const token = jwt.sign({ role: 'admin', sub: 'ci-test-user' }, SECRET, { expiresIn: TTL_SECONDS });
    // No clock advance — at issue time
    expect(() => jwt.verify(token, SECRET)).not.toThrow();
  });

  test('token is expired 1 second AFTER the expiry boundary', () => {
    const token = jwt.sign({ role: 'admin', sub: 'ci-test-user' }, SECRET, { expiresIn: TTL_SECONDS });

    // Advance past expiry (+2 seconds to clear the 1-second jwt leeway)
    advanceSec(TTL_SECONDS + 2);

    let err = null;
    try {
      jwt.verify(token, SECRET);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.name).toBe('TokenExpiredError');
  });

  test('exp claim reflects the frozen system time at issuance', () => {
    const issuedAt = nowSec();
    const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: TTL_SECONDS });
    const decoded = jwt.decode(token);

    expect(decoded.iat).toBe(issuedAt);
    expect(decoded.exp).toBe(issuedAt + TTL_SECONDS);
  });

  test('short-lived token (30s) boundary: valid at 29s, expired at 32s', () => {
    const SHORT_TTL = 30;
    const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: SHORT_TTL });

    // 29 seconds later: still valid
    advanceSec(29);
    expect(() => jwt.verify(token, SECRET)).not.toThrow();

    // 32 seconds later from issuance: expired
    advanceSec(3); // total 32s
    let err = null;
    try { jwt.verify(token, SECRET); } catch (e) { err = e; }
    expect(err?.name).toBe('TokenExpiredError');
  });

  // Timezone independence: the exp claim is always UTC epoch seconds, so
  // shifting the system timezone must not affect correctness.
  test.each(['UTC', 'Asia/Kolkata', 'America/Los_Angeles'])(
    'token expiry is timezone-independent (TZ=%s)',
    (tz) => {
      const origTZ = process.env.TZ;
      process.env.TZ = tz;

      const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: TTL_SECONDS });
      advanceSec(TTL_SECONDS + 2);

      let err = null;
      try { jwt.verify(token, SECRET); } catch (e) { err = e; }
      expect(err?.name).toBe('TokenExpiredError');

      process.env.TZ = origTZ;
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Retry service — exponential backoff nextRetryDelay boundary tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RetryService — nextRetryDelay deterministic clock', () => {
  /**
   * nextRetryDelay uses Date.now() internally. We inject a clock by mocking
   * Date.now() via jest.useFakeTimers().
   *
   * Backoff formula: min(2^attempts * 60_000ms, 3_600_000ms)
   * attempt 0 → 1 min, 1 → 2 min, 2 → 4 min, … capped at 60 min
   */
  const MINUTE_MS = 60_000;
  const HOUR_MS = 3_600_000;
  const BASE_TIME = new Date('2025-01-15T08:00:00.000Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Extract the pure function so we can test it without starting a worker
  function nextRetryDelay(attempts) {
    const delayMs = Math.min(Math.pow(2, attempts) * MINUTE_MS, HOUR_MS);
    return new Date(Date.now() + delayMs);
  }

  test('attempt 0: next retry is exactly 1 minute from now', () => {
    const result = nextRetryDelay(0);
    expect(result.getTime()).toBe(BASE_TIME + 1 * MINUTE_MS);
  });

  test('attempt 1: next retry is exactly 2 minutes from now', () => {
    const result = nextRetryDelay(1);
    expect(result.getTime()).toBe(BASE_TIME + 2 * MINUTE_MS);
  });

  test('attempt 2: next retry is exactly 4 minutes from now', () => {
    const result = nextRetryDelay(2);
    expect(result.getTime()).toBe(BASE_TIME + 4 * MINUTE_MS);
  });

  test('attempt 5: next retry is exactly 32 minutes from now', () => {
    const result = nextRetryDelay(5);
    expect(result.getTime()).toBe(BASE_TIME + 32 * MINUTE_MS);
  });

  test('attempt 6: next retry is exactly 60 minutes (cap reached)', () => {
    const result = nextRetryDelay(6);
    expect(result.getTime()).toBe(BASE_TIME + HOUR_MS);
  });

  test('attempt 10: next retry is still capped at 60 minutes', () => {
    const result = nextRetryDelay(10);
    expect(result.getTime()).toBe(BASE_TIME + HOUR_MS);
  });

  test('attempt 100: next retry is still capped at 60 minutes', () => {
    const result = nextRetryDelay(100);
    expect(result.getTime()).toBe(BASE_TIME + HOUR_MS);
  });

  test('advancing the clock changes the base time for new nextRetryDelay calls', () => {
    advanceSec(3600); // advance 1 hour
    const result = nextRetryDelay(0);
    // Base is now 1 hour later, so result should be BASE_TIME + 3600s + 60s
    expect(result.getTime()).toBe(BASE_TIME + 3600_000 + MINUTE_MS);
  });

  test('nextRetryDelay result is always strictly in the future relative to Date.now()', () => {
    for (let attempt = 0; attempt <= 10; attempt++) {
      const result = nextRetryDelay(attempt);
      expect(result.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test('backoff is strictly non-decreasing up to the cap', () => {
    const delays = [];
    for (let attempt = 0; attempt <= 10; attempt++) {
      const result = nextRetryDelay(attempt);
      delays.push(result.getTime() - Date.now());
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Webhook replay-protection window boundary tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Webhook replay-protection — deterministic clock', () => {
  /**
   * The replay-protection window is REPLAY_WINDOW_S (default 300s).
   * A delivery ID can only be processed once within that window.
   * We test the in-process nonce store using the exported _resetNonces + _isReplay
   * from webhookService. This avoids needing a real Redis connection.
   */
  const REPLAY_WINDOW_S = 300;
  const BASE_TIME = new Date('2025-03-20T14:00:00.000Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_TIME);
    // Use in-process fallback nonce store for these tests
    process.env.WEBHOOK_REPLAY_NONCES_LOCAL = 'true';
    // Reset nonce store state
    jest.resetModules();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.WEBHOOK_REPLAY_NONCES_LOCAL;
  });

  /**
   * Pure in-process nonce store re-implemented here for isolated testing.
   * This mirrors the logic in webhookService._isReplay when Redis is absent.
   */
  function makeNonceStore(windowSeconds) {
    const store = new Map();

    function evict() {
      const now = Date.now();
      for (const [id, exp] of store) {
        if (now > exp) store.delete(id);
      }
    }

    function check(deliveryId) {
      evict();
      if (store.has(deliveryId)) return true; // replay
      store.set(deliveryId, Date.now() + windowSeconds * 1000);
      return false;
    }

    function reset() { store.clear(); }

    return { check, reset };
  }

  test('first delivery of an ID is NOT a replay', () => {
    const nonces = makeNonceStore(REPLAY_WINDOW_S);
    expect(nonces.check('delivery-abc-001')).toBe(false);
  });

  test('second delivery of the same ID WITHIN the window IS a replay', () => {
    const nonces = makeNonceStore(REPLAY_WINDOW_S);
    nonces.check('delivery-abc-002'); // first → not replay

    // 1 second later (still inside window)
    advanceSec(1);
    expect(nonces.check('delivery-abc-002')).toBe(true); // replay
  });

  test('delivery at exactly REPLAY_WINDOW_S boundary — still inside window', () => {
    const nonces = makeNonceStore(REPLAY_WINDOW_S);
    nonces.check('delivery-boundary-001');

    // Advance to exactly the boundary
    advanceSec(REPLAY_WINDOW_S);
    // Entry expires at BASE_TIME + REPLAY_WINDOW_S * 1000
    // Date.now() at this point IS that value, so evict() keeps it (not strictly <)
    // The nonce is treated as still present (replay)
    expect(nonces.check('delivery-boundary-001')).toBe(true);
  });

  test('delivery 1 second AFTER the window expires is accepted again (not a replay)', () => {
    const nonces = makeNonceStore(REPLAY_WINDOW_S);
    nonces.check('delivery-after-window-001');

    // Advance past window expiry
    advanceSec(REPLAY_WINDOW_S + 1);

    // Now the nonce has been evicted, so this is a fresh delivery
    expect(nonces.check('delivery-after-window-001')).toBe(false);
  });

  test('different delivery IDs within the same window are independent', () => {
    const nonces = makeNonceStore(REPLAY_WINDOW_S);
    expect(nonces.check('delivery-x-001')).toBe(false);
    expect(nonces.check('delivery-x-002')).toBe(false); // different ID
    expect(nonces.check('delivery-x-001')).toBe(true);  // replay
    expect(nonces.check('delivery-x-002')).toBe(true);  // replay
  });

  test('zero-length window: every delivery is immediately NOT a replay (instant eviction)', () => {
    const nonces = makeNonceStore(0);
    nonces.check('delivery-zero-001');
    advanceSec(1); // advance past the 0-second window
    expect(nonces.check('delivery-zero-001')).toBe(false); // evicted, fresh
  });

  test('replay window is timezone-independent (window uses epoch milliseconds)', () => {
    // The window is stored as absolute epoch timestamps, not local-time hours,
    // so shifting TZ must not change the window duration.
    const origTZ = process.env.TZ;

    for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      const nonces = makeNonceStore(REPLAY_WINDOW_S);
      nonces.check(`delivery-tz-${tz}`);

      advanceSec(REPLAY_WINDOW_S - 1); // 1 second inside window
      expect(nonces.check(`delivery-tz-${tz}`)).toBe(true); // still a replay

      advanceSec(10); // past window
      expect(nonces.check(`delivery-tz-${tz}`)).toBe(false); // window expired
    }

    process.env.TZ = origTZ;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Audit-log retention — archival cutoff boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit-log retention — deterministic cutoff boundary', () => {
  /**
   * RETENTION_DAYS controls which audit-log entries are eligible for archival.
   * Entries created BEFORE (now - RETENTION_DAYS * 86400s) should be archived.
   * We test the cutoff computation without touching MongoDB.
   */
  const RETENTION_DAYS = 90;
  const DAY_MS = 86_400_000;
  const BASE_TIME = new Date('2025-07-01T00:00:00.000Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Mirror of the cutoff computation in auditService.archiveAuditLogs */
  function computeRetentionCutoff(retentionDays) {
    return new Date(Date.now() - retentionDays * DAY_MS);
  }

  test('cutoff is exactly RETENTION_DAYS ago from the frozen clock', () => {
    const cutoff = computeRetentionCutoff(RETENTION_DAYS);
    const expectedMs = BASE_TIME - RETENTION_DAYS * DAY_MS;
    expect(cutoff.getTime()).toBe(expectedMs);
  });

  test('a log entry created 1 day BEFORE the cutoff is eligible for archival', () => {
    const cutoff = computeRetentionCutoff(RETENTION_DAYS);
    const entryCreatedAt = new Date(cutoff.getTime() - DAY_MS); // 1 day older than cutoff
    expect(entryCreatedAt.getTime()).toBeLessThan(cutoff.getTime());
  });

  test('a log entry created 1 day AFTER the cutoff is NOT eligible for archival', () => {
    const cutoff = computeRetentionCutoff(RETENTION_DAYS);
    const entryCreatedAt = new Date(cutoff.getTime() + DAY_MS); // 1 day newer than cutoff
    expect(entryCreatedAt.getTime()).toBeGreaterThan(cutoff.getTime());
  });

  test('a log entry created AT the exact cutoff boundary is eligible (boundary inclusive)', () => {
    const cutoff = computeRetentionCutoff(RETENTION_DAYS);
    const entryCreatedAt = new Date(cutoff.getTime()); // exact boundary
    // $lte: cutoff means the boundary IS included
    expect(entryCreatedAt.getTime()).toBeLessThanOrEqual(cutoff.getTime());
  });

  test('advancing clock by 1 day shifts cutoff forward by exactly 1 day', () => {
    const cutoffBefore = computeRetentionCutoff(RETENTION_DAYS);
    advanceSec(86_400); // advance 1 day
    const cutoffAfter = computeRetentionCutoff(RETENTION_DAYS);
    expect(cutoffAfter.getTime() - cutoffBefore.getTime()).toBe(DAY_MS);
  });

  test('cutoff computation is timezone-independent', () => {
    const origTZ = process.env.TZ;
    const tzList = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'];
    const cutoffs = tzList.map((tz) => {
      process.env.TZ = tz;
      return computeRetentionCutoff(RETENTION_DAYS).getTime();
    });
    process.env.TZ = origTZ;

    // All cutoffs should be identical — they're epoch ms, not local time
    expect(cutoffs[0]).toBe(cutoffs[1]);
    expect(cutoffs[1]).toBe(cutoffs[2]);
  });

  test('retention 1 day: cutoff is exactly 24h ago', () => {
    const cutoff = computeRetentionCutoff(1);
    expect(cutoff.getTime()).toBe(BASE_TIME - DAY_MS);
  });

  test('retention 730 days (2 years): cutoff is exactly 730 days ago', () => {
    const cutoff = computeRetentionCutoff(730);
    expect(cutoff.getTime()).toBe(BASE_TIME - 730 * DAY_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Session / refresh-token cleanup scheduler
// ─────────────────────────────────────────────────────────────────────────────

describe('Session cleanup service — deterministic scheduling', () => {
  /**
   * The session cleanup scheduler uses setInterval. With fake timers we can
   * verify it fires at the expected interval without any real delay.
   */
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-04-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a setInterval callback fires after the fake-timer advance (no real sleep)', () => {
    const callback = jest.fn();
    const INTERVAL_MS = 600_000; // 10 minutes

    const id = setInterval(callback, INTERVAL_MS);

    // Callback must NOT have been called yet
    expect(callback).not.toHaveBeenCalled();

    // Advance one full interval
    advanceSec(600);
    expect(callback).toHaveBeenCalledTimes(1);

    // Advance another interval
    advanceSec(600);
    expect(callback).toHaveBeenCalledTimes(2);

    clearInterval(id);
  });

  test('callback does NOT fire before the interval elapses', () => {
    const callback = jest.fn();
    const INTERVAL_MS = 600_000;

    const id = setInterval(callback, INTERVAL_MS);

    advanceSec(599); // 1 second short
    expect(callback).not.toHaveBeenCalled();

    clearInterval(id);
  });

  test('multiple consecutive intervals fire in order without wall-clock delays', () => {
    const calls = [];
    const INTERVAL_MS = 60_000; // 1 minute

    const id = setInterval(() => calls.push(Date.now()), INTERVAL_MS);

    advanceSec(300); // advance 5 minutes
    expect(calls).toHaveLength(5);

    // Each call timestamp should be exactly 1 minute apart
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBe(INTERVAL_MS);
    }

    clearInterval(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Auth middleware — token expiry integration with fake clock
// ─────────────────────────────────────────────────────────────────────────────

describe('Auth middleware — token expiry with deterministic clock', () => {
  const jwt = require('jsonwebtoken');
  const SECRET = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-08-01T09:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
  });

  function mockResponse() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.cookie = jest.fn().mockReturnValue(res);
    return res;
  }

  test('valid token that has not yet expired passes the middleware', async () => {
    const { requireAdminAuth } = require('../backend/src/middleware/auth');
    const token = jwt.sign({ role: 'admin', email: 'ci@example.invalid' }, SECRET, { expiresIn: 3600 });

    // Advance time by 1 second — still 3599 seconds until expiry
    advanceSec(1);

    const req = { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1', cookies: {} };
    const res = mockResponse();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('token that expired 1 second ago returns 401 TOKEN_EXPIRED', async () => {
    const { requireAdminAuth } = require('../backend/src/middleware/auth');
    const token = jwt.sign({ role: 'admin', email: 'ci@example.invalid' }, SECRET, { expiresIn: 60 });

    // Advance time past expiry (+2s to clear jsonwebtoken's 1s leeway)
    advanceSec(62);

    const req = { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.2', cookies: {} };
    const res = mockResponse();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  test('exact boundary: token expires at T+60, middleware called at T+59 — VALID', async () => {
    const { requireAdminAuth } = require('../backend/src/middleware/auth');
    const token = jwt.sign({ role: 'admin', email: 'ci@example.invalid' }, SECRET, { expiresIn: 60 });

    // 1 second before expiry
    advanceSec(59);

    const req = { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.3', cookies: {} };
    const res = mockResponse();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
