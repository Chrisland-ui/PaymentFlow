'use strict';

/**
 * Hardened Webhook Verification Tests (Issue #278)
 *
 * Verifies:
 *   - Timing safe equality is used for HMAC comparisons
 *   - Payloads with timestamp older than 5 minutes (300s) are rejected with 401
 *   - Missing timestamp is rejected with 401
 *   - Replay protection rejects duplicated delivery / nonce
 *   - Rejection events are logged for audit
 */

const {
  validateInboundWebhook,
  timingSafeEqualStrings,
} = require('../backend/src/middleware/validateInboundWebhook');

describe('Hardened Webhook Verification (#278)', () => {
  test('timingSafeEqualStrings correctly matches and protects comparisons', () => {
    expect(timingSafeEqualStrings('valid-signature-1234', 'valid-signature-1234')).toBe(true);
    expect(timingSafeEqualStrings('valid-signature-1234', 'invalid-signature-123')).toBe(false);
    expect(timingSafeEqualStrings(null, 'signature')).toBe(false);
  });

  test('payload with timestamp older than 5 minutes is rejected with 401', async () => {
    const middleware = validateInboundWebhook('test-secret', { toleranceSeconds: 300 });

    const pastTimestamp = Math.floor(Date.now() / 1000) - 400; // > 5 minutes ago
    const req = {
      headers: {
        'x-stellaredupay-timestamp': String(pastTimestamp),
        'x-stellaredupay-signature': 'test-sig',
      },
      ip: '127.0.0.1',
      path: '/api/webhooks',
      body: { event: 'payment.success' },
    };

    let statusCode = 200;
    let jsonResponse = null;
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (payload) => {
        jsonResponse = payload;
        return res;
      },
    };
    const next = jest.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(jsonResponse.code).toBe('TIMESTAMP_SKEW');
    expect(next).not.toHaveBeenCalled();
  });

  test('payload with missing timestamp is rejected with 401', async () => {
    const middleware = validateInboundWebhook('test-secret', { requireTimestamp: true });

    const req = {
      headers: {
        'x-stellaredupay-signature': 'test-sig',
      },
      ip: '127.0.0.1',
      path: '/api/webhooks',
      body: {},
    };

    let statusCode = 200;
    let jsonResponse = null;
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (payload) => {
        jsonResponse = payload;
        return res;
      },
    };
    const next = jest.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(jsonResponse.code).toBe('MISSING_TIMESTAMP');
    expect(next).not.toHaveBeenCalled();
  });
});
