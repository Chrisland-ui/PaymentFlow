'use strict';

const crypto = require('crypto');
const {
  validateInboundWebhook,
  verifySignature,
  timingSafeEqualStrings,
  canonicalizePayload,
  parseTimestamp,
  TOLERANCE_SECONDS,
} = require('../backend/src/middleware/validateInboundWebhook');

const mockCreate = jest.fn();
jest.mock('../backend/src/models/inboundWebhookNonceModel', () => ({
  create: (...args) => mockCreate(...args),
}));

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock('../backend/src/utils/logger', () => ({
  info: jest.fn(),
  warn: (...args) => mockLoggerWarn(...args),
  error: (...args) => mockLoggerError(...args),
  child: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: (...args) => mockLoggerWarn(...args),
    error: (...args) => mockLoggerError(...args),
  }),
}));

const SECRET = 'super-secret-key-12345';

function createMockReqRes(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { event: 'payment.received', amount: '100.50' };
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;

  const req = {
    headers: {
      'x-stellaredupay-timestamp': String(overrides.ts !== undefined ? overrides.ts : now),
      'x-stellaredupay-signature': overrides.signature !== undefined ? overrides.signature : signature,
      'x-stellaredupay-delivery-id': overrides.deliveryId !== undefined ? overrides.deliveryId : 'del-101',
      ...(overrides.headers || {}),
    },
    body,
    rawBody,
    ip: '127.0.0.1',
    path: '/api/webhooks/callback',
    ...overrides.req,
  };

  const res = {
    statusCode: 200,
    status: jest.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function (data) {
      this.body = data;
      return this;
    }),
  };

  const next = jest.fn();

  return { req, res, next, rawBody, signature, now };
}

describe('Harden Webhook Signature Verification (#30)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({});
  });

  describe('Constant-Time Comparison', () => {
    it('returns true for matching strings regardless of length or content', () => {
      expect(timingSafeEqualStrings('exact-match', 'exact-match')).toBe(true);
      expect(timingSafeEqualStrings('', '')).toBe(true);
      expect(timingSafeEqualStrings('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    });

    it('returns false for mismatched strings without throwing even on length difference', () => {
      expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false);
      expect(timingSafeEqualStrings('short', 'much-longer-string')).toBe(false);
      expect(timingSafeEqualStrings('test1', 'test2')).toBe(false);
      expect(timingSafeEqualStrings(null, 'str')).toBe(false);
      expect(timingSafeEqualStrings(undefined, 'str')).toBe(false);
    });
  });

  describe('Timestamp Skew & Parsing', () => {
    it('parses numeric seconds, milliseconds, and ISO date strings correctly', () => {
      expect(parseTimestamp('1600000000')).toBe(1600000000);
      expect(parseTimestamp('1600000000000')).toBe(1600000000);
      const iso = new Date('2026-01-01T00:00:00Z').toISOString();
      expect(parseTimestamp(iso)).toBe(Math.floor(Date.parse(iso) / 1000));
      expect(parseTimestamp('invalid-date')).toBeNull();
    });

    it('rejects stale timestamp older than tolerance', async () => {
      const staleTime = Math.floor(Date.now() / 1000) - TOLERANCE_SECONDS - 10;
      const { req, res, next } = createMockReqRes({ ts: staleTime });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMESTAMP_SKEW' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects future timestamp exceeding tolerance window', async () => {
      const futureTime = Math.floor(Date.now() / 1000) + TOLERANCE_SECONDS + 60;
      const { req, res, next } = createMockReqRes({ ts: futureTime });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMESTAMP_SKEW' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects missing timestamp when timestamp is required', async () => {
      const { req, res, next } = createMockReqRes();
      delete req.headers['x-stellaredupay-timestamp'];

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TIMESTAMP' }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Signature Verification & Body Preservation', () => {
    it('accepts valid payload and signature', async () => {
      const { req, res, next } = createMockReqRes();

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(401);
    });

    it('rejects invalid signature', async () => {
      const { req, res, next } = createMockReqRes({ signature: 'sha256=badf00dbadf00d' });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects altered request body (tampered payload)', async () => {
      const { req, res, next } = createMockReqRes();
      // Tamper with body while preserving original signature
      req.rawBody = JSON.stringify({ event: 'payment.received', amount: '999999.00' });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Replay Prevention & Nonce Tracking', () => {
    it('records delivery ID and allows first request', async () => {
      const { req, res, next } = createMockReqRes({ deliveryId: 'delivery-first' });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(mockCreate).toHaveBeenCalledWith({ deliveryId: 'delivery-first' });
      expect(next).toHaveBeenCalled();
    });

    it('rejects replayed delivery ID with 409 DUPLICATE_DELIVERY', async () => {
      const dupError = new Error('Duplicate key');
      dupError.code = 11000;
      mockCreate.mockRejectedValueOnce(dupError);

      const { req, res, next } = createMockReqRes({ deliveryId: 'delivery-replayed' });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DUPLICATE_DELIVERY' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('generates synthetic nonce when delivery-id is absent and prevents replay', async () => {
      const { req, res, next } = createMockReqRes({ deliveryId: null });
      delete req.headers['x-stellaredupay-delivery-id'];

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        deliveryId: expect.stringMatching(/^sig-[a-f0-9]{64}$/),
      }));
      expect(next).toHaveBeenCalled();

      // Second replay attempt
      const dupError = new Error('Duplicate key');
      dupError.code = 11000;
      mockCreate.mockRejectedValueOnce(dupError);

      const replayRes = createMockReqRes({ deliveryId: null });
      delete replayRes.req.headers['x-stellaredupay-delivery-id'];
      await mw(replayRes.req, replayRes.res, replayRes.next);

      expect(replayRes.res.status).toHaveBeenCalledWith(409);
      expect(replayRes.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DUPLICATE_DELIVERY' }));
    });
  });

  describe('Multi-Provider Support', () => {
    it('verifies Stripe formatted signature with timestamp binding', async () => {
      const now = Math.floor(Date.now() / 1000);
      const rawBody = '{"id":"evt_123"}';
      const signedPayload = `${now}.${rawBody}`;
      const sig = crypto.createHmac('sha256', SECRET).update(signedPayload).digest('hex');

      const req = {
        headers: {
          'stripe-signature': `t=${now},v1=${sig}`,
        },
        body: { id: 'evt_123' },
        rawBody,
        ip: '127.0.0.1',
        path: '/api/stripe-webhook',
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();

      const mw = validateInboundWebhook(SECRET, { provider: 'stripe' });
      await mw(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('verifies GitHub formatted webhook headers', async () => {
      const rawBody = '{"ref":"refs/heads/main"}';
      const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;

      const req = {
        headers: {
          'x-hub-signature-256': sig,
          'x-github-delivery': 'gh-deliv-1',
          'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: { ref: 'refs/heads/main' },
        rawBody,
        ip: '127.0.0.1',
        path: '/api/github-webhook',
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();

      const mw = validateInboundWebhook(SECRET, { provider: 'github' });
      await mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith({ deliveryId: 'gh-deliv-1' });
    });
  });

  describe('Auditing Without Secret Leakage', () => {
    it('logs verification failure without logging secret or sensitive values', async () => {
      const { req, res, next } = createMockReqRes({ signature: 'sha256=invalid' });

      const mw = validateInboundWebhook(SECRET);
      await mw(req, res, next);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Webhook verification rejected',
        expect.objectContaining({
          reason: 'INVALID_SIGNATURE',
          provider: 'stellaredupay',
        })
      );

      // Verify that secret is never in the logged call arguments
      const allCalls = mockLoggerWarn.mock.calls;
      for (const call of allCalls) {
        const str = JSON.stringify(call);
        expect(str).not.toContain(SECRET);
      }
    });
  });
});
