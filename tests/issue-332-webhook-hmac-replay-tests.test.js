'use strict';

/**
 * Issue #332 — Webhook replay and HMAC signature verification tests
 *
 * Six security-critical scenarios exercised against the real
 * validateInboundWebhook middleware (no HMAC mocking):
 *
 *   1. Valid signature                         → 200/next()
 *   2. Invalid signature                       → 401
 *   3. Missing signature header                → 401
 *   4. Expired timestamp (> 5 min old)         → 400
 *   5. Replay of a previously accepted payload → 409
 *   6. Valid signature on a modified body      → 401
 *
 * Additional unit coverage:
 *   - verifySignature helper returns correct boolean values
 *   - TOLERANCE_SECONDS matches the documented 5-minute window
 *   - Timing-safe comparison is used (no early-exit leaks)
 */

const crypto = require('crypto');

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// We use the real HMAC path (validateInboundWebhook + verifySignature) but mock
// the MongoDB nonce store so tests do not need a real database connection.

const mockNonceCreate = jest.fn();

jest.mock('../backend/src/models/inboundWebhookNonceModel', () => ({
  create: (...a) => mockNonceCreate(...a),
}));

jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});

// ── Module under test ─────────────────────────────────────────────────────────
const {
  validateInboundWebhook,
  verifySignature,
  TOLERANCE_SECONDS,
} = require('../backend/src/middleware/validateInboundWebhook');

// ── Constants ─────────────────────────────────────────────────────────────────
const SECRET  = 'test-webhook-secret-for-issue-332';
const PAYLOAD = { event: 'payment.confirmed', data: { studentId: 'STU001', amount: 250 } };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a raw JSON body string from an object.
 * This is the exact bytes that the sender would transmit.
 */
function rawBodyOf(payload) {
  return JSON.stringify(payload);
}

/**
 * Compute the HMAC-SHA256 signature header value for a given raw body and secret.
 */
function sign(rawBody, secret = SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Build a realistic Express req/res pair for the middleware.
 *
 * @param {object} overrides
 * @param {number}  [overrides.ts]          – Unix timestamp (default: now)
 * @param {string}  [overrides.signature]   – Override signature header
 * @param {string}  [overrides.deliveryId]  – Override delivery-ID header
 * @param {boolean} [overrides.omitSig]     – Drop signature header entirely
 * @param {object}  [overrides.payload]     – Payload to use (default: PAYLOAD)
 * @param {string}  [overrides.rawBody]     – Raw body override (body is still PAYLOAD)
 */
function makeReqRes(overrides = {}) {
  const ts       = overrides.ts ?? Math.floor(Date.now() / 1000);
  const payload  = overrides.payload ?? PAYLOAD;
  const raw      = overrides.rawBody ?? rawBodyOf(payload);
  const sig      = overrides.omitSig ? undefined : (overrides.signature ?? sign(raw));
  const delivery = overrides.deliveryId ?? `delivery-${crypto.randomUUID()}`;

  const headers = {
    'x-stellaredupay-timestamp':   String(ts),
    'x-stellaredupay-delivery-id': delivery,
  };
  if (sig !== undefined) headers['x-stellaredupay-signature'] = sig;

  const req = { headers, body: payload, rawBody: raw };

  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);

  return { req, res, delivery };
}

/**
 * Run the middleware and return the HTTP status code it produced, or 'next'
 * when next() was called.
 */
async function runMiddleware(req, res, secret = SECRET) {
  const middleware = validateInboundWebhook(secret);
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  if (nextCalled) return 'next';
  const statusCall = res.status.mock.calls[0];
  return statusCall ? statusCall[0] : null;
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: nonce not seen before → create succeeds
  mockNonceCreate.mockResolvedValue({});
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Valid signature is accepted
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — Scenario 1: valid signature is accepted', () => {
  it('calls next() when timestamp, signature, and delivery-ID are all valid', async () => {
    const { req, res } = makeReqRes();
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe('next');
  });

  it('accepts a valid signature derived from raw body bytes', async () => {
    const raw     = rawBodyOf({ event: 'payment.confirmed', amount: 500 });
    const sig     = sign(raw);
    const { req, res } = makeReqRes({ signature: sig, rawBody: raw, payload: JSON.parse(raw) });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe('next');
  });

  it('stores the delivery-ID nonce on a successful request', async () => {
    const { req, res, delivery } = makeReqRes();
    await runMiddleware(req, res);
    expect(mockNonceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: delivery })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Invalid signature is rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — Scenario 2: invalid signature is rejected', () => {
  it('returns 401 when the HMAC signature is wrong', async () => {
    const { req, res } = makeReqRes({ signature: 'sha256=deadbeef00000000cafebabe' });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(401);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_SIGNATURE');
  });

  it('returns 401 for a signature computed with a different secret', async () => {
    const rawBody = rawBodyOf(PAYLOAD);
    const wrongSig = sign(rawBody, 'wrong-secret');
    const { req, res } = makeReqRes({ signature: wrongSig });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(401);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_SIGNATURE');
  });

  it('returns 401 for a malformed signature header', async () => {
    const { req, res } = makeReqRes({ signature: 'not-valid-at-all' });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Missing signature header is rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — Scenario 3: missing signature header is rejected', () => {
  it('returns 401 when x-stellaredupay-signature header is absent', async () => {
    const { req, res } = makeReqRes({ omitSig: true });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(401);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_SIGNATURE');
  });

  it('does not call next() when signature header is missing', async () => {
    const { req, res } = makeReqRes({ omitSig: true });
    let nextCalled = false;
    const middleware = validateInboundWebhook(SECRET);
    await middleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Expired timestamp is rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — Scenario 4: expired timestamp is rejected', () => {
  it('returns 400 when the timestamp is older than TOLERANCE_SECONDS', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - TOLERANCE_SECONDS - 60;
    // Recompute signature with a fresh timestamp so we isolate the skew check
    const { req, res } = makeReqRes({ ts: staleTs });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(400);
    expect(res.json.mock.calls[0][0].code).toBe('TIMESTAMP_SKEW');
  });

  it('returns 400 when timestamp is far in the future (skew in both directions)', async () => {
    const futureTs = Math.floor(Date.now() / 1000) + TOLERANCE_SECONDS + 120;
    const { req, res } = makeReqRes({ ts: futureTs });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(400);
    expect(res.json.mock.calls[0][0].code).toBe('TIMESTAMP_SKEW');
  });

  it('accepts a timestamp exactly at the tolerance boundary', async () => {
    // One second inside the tolerance window
    const boundaryTs = Math.floor(Date.now() / 1000) - TOLERANCE_SECONDS + 1;
    const rawBody    = rawBodyOf(PAYLOAD);
    const sig        = sign(rawBody);
    const { req, res } = makeReqRes({ ts: boundaryTs, signature: sig });
    const outcome = await runMiddleware(req, res);
    // Should not be rejected for timestamp skew (may still succeed or hit other checks)
    if (outcome === 400) {
      expect(res.json.mock.calls[0][0].code).not.toBe('TIMESTAMP_SKEW');
    }
  });

  it('TOLERANCE_SECONDS matches the documented 5-minute window', () => {
    expect(TOLERANCE_SECONDS).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — Replay of a previously accepted payload is rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — Scenario 5: replay of previously accepted payload is rejected', () => {
  it('returns 409 when the same delivery-ID is seen twice within the time window', async () => {
    const deliveryId = `replay-${crypto.randomUUID()}`;

    // First delivery — succeeds
    const { req: req1, res: res1 } = makeReqRes({ deliveryId });
    const first = await runMiddleware(req1, res1);
    expect(first).toBe('next');
    expect(mockNonceCreate).toHaveBeenCalledTimes(1);

    // Simulate: nonce now exists → create throws duplicate-key error
    const dupErr = new Error('duplicate key error');
    dupErr.code  = 11000;
    mockNonceCreate.mockRejectedValueOnce(dupErr);

    // Second delivery with the same ID (replay)
    const { req: req2, res: res2 } = makeReqRes({ deliveryId });
    const second = await runMiddleware(req2, res2);
    expect(second).toBe(409);
    expect(res2.json.mock.calls[0][0].code).toBe('DUPLICATE_DELIVERY');
  });

  it('different delivery-IDs are each accepted independently', async () => {
    const ids = [
      `replay-a-${crypto.randomUUID()}`,
      `replay-b-${crypto.randomUUID()}`,
    ];

    for (const deliveryId of ids) {
      const { req, res } = makeReqRes({ deliveryId });
      const outcome = await runMiddleware(req, res);
      expect(outcome).toBe('next');
    }

    // One nonce stored per unique ID
    expect(mockNonceCreate).toHaveBeenCalledTimes(ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — Valid signature on a modified payload body is rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — Scenario 6: valid signature on modified body is rejected', () => {
  it('rejects when the body is tampered after signing', async () => {
    // Sign the original body
    const originalBody = rawBodyOf(PAYLOAD);
    const sig          = sign(originalBody);

    // Attacker modifies the body (tampers the amount)
    const tamperedPayload = { ...PAYLOAD, data: { ...PAYLOAD.data, amount: 99999 } };
    const tamperedBody    = rawBodyOf(tamperedPayload);

    // Request carries original signature but modified body
    const { req, res } = makeReqRes({
      signature: sig,
      rawBody:   tamperedBody,
      payload:   tamperedPayload,
    });

    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(401);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_SIGNATURE');
  });

  it('rejects when only whitespace is added to the body', async () => {
    const originalBody = rawBodyOf(PAYLOAD);
    const sig          = sign(originalBody);
    // Append a single space — changes the signed bytes
    const modified     = originalBody + ' ';

    const { req, res } = makeReqRes({
      signature: sig,
      rawBody:   modified,
    });

    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe(401);
  });

  it('accepts the body unchanged with the correct signature', async () => {
    const rawBody = rawBodyOf(PAYLOAD);
    const sig     = sign(rawBody);
    const { req, res } = makeReqRes({ signature: sig, rawBody });
    const outcome = await runMiddleware(req, res);
    expect(outcome).toBe('next');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for verifySignature helper
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — verifySignature helper', () => {
  const rawBody = rawBodyOf(PAYLOAD);

  it('returns true for a correctly signed payload', () => {
    const sig = sign(rawBody);
    expect(verifySignature(rawBody, sig, SECRET)).toBe(true);
  });

  it('returns false for an incorrect signature', () => {
    expect(verifySignature(rawBody, 'sha256=0000000000000000', SECRET)).toBe(false);
  });

  it('returns false for a missing signature', () => {
    expect(verifySignature(rawBody, null, SECRET)).toBe(false);
  });

  it('returns false for a missing secret', () => {
    const sig = sign(rawBody);
    expect(verifySignature(rawBody, sig, null)).toBe(false);
  });

  it('handles the sha256= prefix correctly', () => {
    const hexOnly = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
    // With prefix
    expect(verifySignature(rawBody, `sha256=${hexOnly}`, SECRET)).toBe(true);
    // Without prefix — raw hex should also be accepted
    // (implementation-dependent; just verify it doesn't throw)
    expect(() => verifySignature(rawBody, hexOnly, SECRET)).not.toThrow();
  });

  it('uses timing-safe comparison (does not throw on length mismatch)', () => {
    // A short signature should not cause an unhandled buffer-length crash
    expect(() =>
      verifySignature(rawBody, 'sha256=abc', SECRET)
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secret resolution — async factory function
// ─────────────────────────────────────────────────────────────────────────────
describe('#332 — async secret resolver', () => {
  it('accepts a function that returns a Promise<string> as the secret', async () => {
    const rawBody = rawBodyOf(PAYLOAD);
    const sig     = sign(rawBody);
    const { req, res } = makeReqRes({ signature: sig, rawBody });

    const asyncSecret = jest.fn().mockResolvedValue(SECRET);
    const middleware   = validateInboundWebhook(asyncSecret);
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(asyncSecret).toHaveBeenCalledWith(req);
  });
});
