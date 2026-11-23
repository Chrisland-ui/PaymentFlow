'use strict';

/**
 * Issue #84 — Webhook replay and signature tests
 *
 * Exercises the inbound webhook validation middleware
 * (backend/src/middleware/validateInboundWebhook.js) with:
 *
 * - Valid requests → accepted (pass-through)
 * - Altered body → signature mismatch → 401
 * - Stale timestamp → 400 TIMESTAMP_SKEW
 * - Tampered timestamp header after signing → 401
 * - Missing timestamp → 400 MISSING_TIMESTAMP
 * - Duplicate delivery-ID → 409 DUPLICATE_DELIVERY
 * - Missing signature with secret configured → 401 INVALID_SIGNATURE
 * - No secret configured → signature check skipped, passes through
 * - HMAC key uniqueness: different secrets produce different signatures
 * - Timing-safe comparison (no early-exit on length mismatch)
 *
 * Acceptance criteria:
 *   ✓ All invalid cases are rejected BEFORE business mutation
 *   ✓ Valid requests remain accepted
 *   ✓ Secrets are absent from test output (synthetic values only)
 */

process.env.MONGO_URI             = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET            = 'test-jwt-secret-issue84';
process.env.STELLAR_NETWORK       = 'testnet';
// Keep tolerance wide enough for tests while still testing boundary behaviour
process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = '300';

const crypto = require('crypto');

// ── Nonce store mock — controls duplicate-delivery behaviour ──────────────────

let _nonces = new Set();

const mockNonceCreate = jest.fn(async ({ deliveryId }) => {
  if (_nonces.has(deliveryId)) {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  }
  _nonces.add(deliveryId);
  return { deliveryId };
});

jest.mock('../backend/src/models/inboundWebhookNonceModel', () => ({
  create: (...a) => mockNonceCreate(...a),
}));

jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});

// ── Load the middleware under test ────────────────────────────────────────────
const { validateInboundWebhook } = require('../backend/src/middleware/validateInboundWebhook');

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET   = 'webhook-test-secret-issue84';
const BODY_OBJ = { event: 'payment.confirmed', data: { studentId: 'STU001', amount: 250 } };
const BODY_STR = JSON.stringify(BODY_OBJ);

function nowTs() {
  return String(Math.floor(Date.now() / 1000));
}

function makeSignature(body, secret) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function makeReq({ body = BODY_STR, secret = SECRET, deliveryId = null, tsOffset = 0, overrideTs = null, overrideSig = null } = {}) {
  const ts = overrideTs || String(Math.floor(Date.now() / 1000) + tsOffset);
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = overrideSig !== undefined ? overrideSig : makeSignature(rawBody, secret);

  const headers = {
    'x-stellaredupay-timestamp': ts,
    'x-stellaredupay-signature': sig,
  };
  if (deliveryId !== null) {
    headers['x-stellaredupay-delivery-id'] = deliveryId;
  }

  return {
    headers,
    body:    BODY_OBJ,
    rawBody: rawBody,
    ip:      '127.0.0.1',
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    _body: null,
    status(code) { this.statusCode = code; return this; },
    json(b)      { this._body = b; return this; },
  };
  return res;
}

async function runMiddleware(req, res, secretOrFn = SECRET) {
  const middleware = validateInboundWebhook(secretOrFn);
  let nextCalled = false;
  const nextErr = await new Promise((resolve) => {
    middleware(req, res, (err) => { nextCalled = true; resolve(err); });
  });
  return { nextCalled, nextErr };
}

// ── Reset nonce state before each test ───────────────────────────────────────
beforeEach(() => {
  _nonces = new Set();
  mockNonceCreate.mockClear();
});

// ── Test groups ───────────────────────────────────────────────────────────────

describe('Issue #84 — validateInboundWebhook: valid requests are accepted', () => {

  it('valid signature + fresh timestamp → passes through (next() called)', async () => {
    const req = makeReq({ deliveryId: 'delivery-valid-001' });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(req, res);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('valid request without delivery-ID → passes through (dedup skipped)', async () => {
    const req = makeReq(); // no deliveryId
    const res = makeRes();
    const { nextCalled } = await runMiddleware(req, res);
    expect(nextCalled).toBe(true);
  });

  it('no secret configured (undefined) → signature check is skipped, proceeds', async () => {
    const req = makeReq({ overrideSig: null, secret: 'ignored' });
    const res = makeRes();
    // Pass undefined as secret — middleware treats it as "no secret, skip check"
    const { nextCalled } = await runMiddleware(req, res, undefined);
    expect(nextCalled).toBe(true);
  });
});

describe('Issue #84 — validateInboundWebhook: invalid signatures are rejected', () => {

  it('wrong secret → INVALID_SIGNATURE 401', async () => {
    const req = makeReq({ secret: 'wrong-secret' }); // signature computed with wrong secret
    const res = makeRes();
    await runMiddleware(req, res, SECRET); // middleware uses correct SECRET
    expect(res.statusCode).toBe(401);
    expect(res._body.code).toBe('INVALID_SIGNATURE');
  });

  it('altered body after signing → INVALID_SIGNATURE 401', async () => {
    const originalBody = JSON.stringify({ event: 'payment.confirmed', data: { amount: 100 } });
    const tamperedBody  = JSON.stringify({ event: 'payment.confirmed', data: { amount: 999999 } });
    const sig = makeSignature(originalBody, SECRET);

    const req = {
      headers: {
        'x-stellaredupay-timestamp': nowTs(),
        'x-stellaredupay-signature': sig,
      },
      body:    { event: 'payment.confirmed', data: { amount: 999999 } },
      rawBody: tamperedBody, // body tampered, signature still from original
    };
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._body.code).toBe('INVALID_SIGNATURE');
  });

  it('signature prefix tampered (not sha256=…) → INVALID_SIGNATURE 401', async () => {
    const req = makeReq({ overrideSig: 'md5=deadbeef' });
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._body.code).toBe('INVALID_SIGNATURE');
  });

  it('completely absent signature header → INVALID_SIGNATURE 401', async () => {
    const req = makeReq({ overrideSig: null });
    delete req.headers['x-stellaredupay-signature'];
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._body.code).toBe('INVALID_SIGNATURE');
  });
});

describe('Issue #84 — validateInboundWebhook: timestamp skew is enforced', () => {

  it('missing timestamp header → 400 MISSING_TIMESTAMP', async () => {
    const req = makeReq();
    delete req.headers['x-stellaredupay-timestamp'];
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._body.code).toBe('MISSING_TIMESTAMP');
  });

  it('timestamp too old (>tolerance) → 400 TIMESTAMP_SKEW', async () => {
    const tolerance = 300;
    const req = makeReq({ tsOffset: -(tolerance + 60) }); // 60s past tolerance
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._body.code).toBe('TIMESTAMP_SKEW');
  });

  it('timestamp far in the future (>tolerance) → 400 TIMESTAMP_SKEW', async () => {
    const tolerance = 300;
    const req = makeReq({ tsOffset: tolerance + 60 }); // 60s past future tolerance
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._body.code).toBe('TIMESTAMP_SKEW');
  });

  it('non-numeric timestamp → 400 TIMESTAMP_SKEW', async () => {
    const req = makeReq({ overrideTs: 'not-a-number' });
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._body.code).toBe('TIMESTAMP_SKEW');
  });

  it('timestamp within tolerance → passes timestamp check', async () => {
    // 10s in the future is well within the 300s window
    const req = makeReq({ tsOffset: 10, deliveryId: 'fresh-ts-001' });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(req, res);
    expect(nextCalled).toBe(true);
  });
});

describe('Issue #84 — validateInboundWebhook: replay / duplicate delivery', () => {

  it('first delivery with ID → accepted (nonce stored)', async () => {
    const deliveryId = `unique-delivery-${Date.now()}`;
    const req = makeReq({ deliveryId });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(req, res);
    expect(nextCalled).toBe(true);
    expect(mockNonceCreate).toHaveBeenCalledWith({ deliveryId });
  });

  it('second delivery with same ID → 409 DUPLICATE_DELIVERY', async () => {
    const deliveryId = 'replay-id-84001';
    _nonces.add(deliveryId); // Pre-seed as already seen

    const req = makeReq({ deliveryId });
    const res = makeRes();
    await runMiddleware(req, res);
    expect(res.statusCode).toBe(409);
    expect(res._body.code).toBe('DUPLICATE_DELIVERY');
  });

  it('two sequential requests with same ID: first passes, second is 409', async () => {
    const deliveryId = `seq-replay-${Date.now()}`;

    // First request
    const req1 = makeReq({ deliveryId });
    const res1 = makeRes();
    const { nextCalled: next1 } = await runMiddleware(req1, res1);
    expect(next1).toBe(true);

    // Second request — same delivery ID
    const req2 = makeReq({ deliveryId });
    const res2 = makeRes();
    await runMiddleware(req2, res2);
    expect(res2.statusCode).toBe(409);
    expect(res2._body.code).toBe('DUPLICATE_DELIVERY');
  });

  it('nonce store error (non-duplicate) → logs and continues (does not block)', async () => {
    const deliveryId = 'nonce-error-delivery';
    // Simulate a non-duplicate DB error
    mockNonceCreate.mockRejectedValueOnce(new Error('DB timeout'));

    const req = makeReq({ deliveryId });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(req, res);
    // Non-dedup errors must not block processing
    expect(nextCalled).toBe(true);
  });
});

describe('Issue #84 — HMAC signature correctness: pure crypto unit', () => {
  const { generateSignature, verifySignature } = (() => {
    // Reimplement the same logic as validateInboundWebhook for pure unit testing
    function generate(body, secret) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      return crypto.createHmac('sha256', secret).update(raw).digest('hex');
    }
    function verify(rawBody, signatureHeader, secret) {
      if (!signatureHeader || !secret) return false;
      const hex = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      try {
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hex, 'hex'));
      } catch { return false; }
    }
    return { generateSignature: generate, verifySignature: verify };
  })();

  it('HMAC is deterministic: same body + same secret → same signature', () => {
    const sig1 = generateSignature(BODY_STR, SECRET);
    const sig2 = generateSignature(BODY_STR, SECRET);
    expect(sig1).toBe(sig2);
  });

  it('different secrets → different signatures', () => {
    const sig1 = generateSignature(BODY_STR, 'secret-a');
    const sig2 = generateSignature(BODY_STR, 'secret-b');
    expect(sig1).not.toBe(sig2);
  });

  it('body mutation changes signature', () => {
    const sig1 = generateSignature(BODY_STR, SECRET);
    const sig2 = generateSignature(JSON.stringify({ ...BODY_OBJ, extra: 'field' }), SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it('signature verifies correctly with sha256= prefix', () => {
    const sig = 'sha256=' + generateSignature(BODY_STR, SECRET);
    expect(verifySignature(BODY_STR, sig, SECRET)).toBe(true);
  });

  it('corrupted signature (bit flip) → verification fails', () => {
    const sig = generateSignature(BODY_STR, SECRET);
    const corrupted = sig.replace(sig[0], sig[0] === 'a' ? 'b' : 'a');
    expect(verifySignature(BODY_STR, 'sha256=' + corrupted, SECRET)).toBe(false);
  });

  it('empty signature → verification fails without throwing', () => {
    expect(verifySignature(BODY_STR, '', SECRET)).toBe(false);
  });

  it('null signature → verification fails without throwing', () => {
    expect(verifySignature(BODY_STR, null, SECRET)).toBe(false);
  });

  it('length-mismatched signature → returns false (timing-safe path)', () => {
    // Pass a truncated hex string — timingSafeEqual will catch the length mismatch
    expect(verifySignature(BODY_STR, 'sha256=deadbeef', SECRET)).toBe(false);
  });
});

describe('Issue #84 — validateInboundWebhook: secret resolver function', () => {

  it('secret as async function is awaited and used correctly', async () => {
    const asyncSecretFn = jest.fn().mockResolvedValue(SECRET);
    const req = makeReq({ deliveryId: 'async-secret-001' });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(req, res, asyncSecretFn);
    expect(nextCalled).toBe(true);
    expect(asyncSecretFn).toHaveBeenCalledWith(req);
  });

  it('secret resolver returning wrong secret → 401 INVALID_SIGNATURE', async () => {
    const badSecretFn = jest.fn().mockResolvedValue('wrong-secret');
    const req = makeReq({ deliveryId: 'async-bad-secret' });
    const res = makeRes();
    await runMiddleware(req, res, badSecretFn);
    expect(res.statusCode).toBe(401);
    expect(res._body.code).toBe('INVALID_SIGNATURE');
  });
});

describe('Issue #84 — validateInboundWebhook: ordering (pre-mutation gate)', () => {
  it('rejects BEFORE any business logic runs — next() not called on invalid sig', async () => {
    const businessLogic = jest.fn();
    const req = makeReq({ secret: 'wrong-secret' });
    const res = makeRes();
    const middleware = validateInboundWebhook(SECRET);

    await new Promise((resolve) => {
      middleware(req, res, () => { businessLogic(); resolve(); });
    });

    expect(businessLogic).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects BEFORE any business logic runs — next() not called on timestamp skew', async () => {
    const businessLogic = jest.fn();
    const req = makeReq({ tsOffset: -9999 });
    const res = makeRes();
    const middleware = validateInboundWebhook(SECRET);

    await new Promise((resolve) => {
      middleware(req, res, () => { businessLogic(); resolve(); });
    });

    expect(businessLogic).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});
