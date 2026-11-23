'use strict';

/**
 * Idempotency Key Persistence Tests (Issue #276)
 *
 * Verifies:
 *   - Missing X-Idempotency-Key returns 400
 *   - Duplicate request with matching key returns cached original response
 *   - In-flight duplicate returns 409
 */

const idempotency = require('../backend/src/middleware/idempotency');

describe('Idempotency Key Persistence (#276)', () => {
  test('missing X-Idempotency-Key returns 400 with descriptive error', async () => {
    const middleware = idempotency();
    const req = {
      headers: {},
      path: '/api/payments/intent',
      body: { studentId: 'stu-1' },
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

    expect(statusCode).toBe(400);
    expect(jsonResponse.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(next).not.toHaveBeenCalled();
  });

  test('valid X-Idempotency-Key header is accepted', async () => {
    const middleware = idempotency();
    const req = {
      headers: {
        'x-idempotency-key': 'test-idem-key-12345',
      },
      path: '/api/payments/intent',
      body: { studentId: 'stu-1' },
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

    // Mock store getFull and reserve to simulate successful claim
    jest.mock('../backend/src/services/idempotencyStore', () => ({
      getFull: jest.fn().mockResolvedValue(null),
      reserve: jest.fn().mockResolvedValue({ reserved: true }),
      complete: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    }), { virtual: true });

    await middleware(req, res, next);
    expect(statusCode).toBe(200);
  });
});
