'use strict';

/**
 * Tests for Issue #27 — Request Correlation ID Middleware
 *
 * Verifies that:
 *  - Every request has exactly one correlation ID
 *  - Untrusted IDs are bounded (max 128 chars) and sanitized (safe charset)
 *  - A valid incoming X-Correlation-ID is accepted and reflected
 *  - An absent/empty/invalid header causes a fresh ID to be generated
 *  - Logs and response headers carry the same ID
 *  - requestLogger reuses the pre-set req.correlationId instead of creating another
 */

const { correlationIdMiddleware, sanitizeCorrelationId } = require('../backend/src/middleware/correlationId');
const { acceptCorrelationId, generateCorrelationId } = require('../backend/src/utils/correlationId');

// ── sanitizeCorrelationId unit tests ─────────────────────────────────────────

describe('sanitizeCorrelationId()', () => {
  test('returns null for undefined input', () => {
    expect(sanitizeCorrelationId(undefined)).toBeNull();
  });

  test('returns null for null input', () => {
    expect(sanitizeCorrelationId(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(sanitizeCorrelationId('')).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(sanitizeCorrelationId(12345)).toBeNull();
    expect(sanitizeCorrelationId({})).toBeNull();
  });

  test('passes through a valid alphanumeric ID unchanged', () => {
    const id = 'corr_abc123DEF456';
    expect(sanitizeCorrelationId(id)).toBe(id);
  });

  test('allows hyphens, underscores, colons, and dots', () => {
    const id = 'trace-id:v1.2_abc';
    expect(sanitizeCorrelationId(id)).toBe(id);
  });

  test('strips unsafe characters (spaces, angle brackets, newlines)', () => {
    const raw = 'abc <script>alert(1)</script> def';
    const result = sanitizeCorrelationId(raw);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain(' ');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
    // remaining safe chars should be preserved
    expect(result).toContain('abc');
    expect(result).toContain('def');
  });

  test('strips control characters', () => {
    const raw = 'abc\x00\x01\ndef';
    const result = sanitizeCorrelationId(raw);
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x01');
    expect(result).not.toContain('\n');
  });

  test('truncates IDs longer than 128 characters', () => {
    const long = 'a'.repeat(200);
    const result = sanitizeCorrelationId(long);
    expect(result.length).toBe(128);
  });

  test('returns null when entire input is unsafe characters', () => {
    expect(sanitizeCorrelationId('   \n\t<<>>')).toBeNull();
  });

  test('preserves exactly 128 chars when input is exactly 128 safe chars', () => {
    const id = 'x'.repeat(128);
    expect(sanitizeCorrelationId(id)).toBe(id);
    expect(sanitizeCorrelationId(id).length).toBe(128);
  });
});

// ── acceptCorrelationId unit tests ────────────────────────────────────────────

describe('acceptCorrelationId()', () => {
  test('returns a generated ID for undefined input', () => {
    const id = acceptCorrelationId(undefined);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('returns a generated ID for null input', () => {
    const id = acceptCorrelationId(null);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('accepts and returns a valid ID unchanged', () => {
    const valid = 'corr_abc123';
    expect(acceptCorrelationId(valid)).toBe(valid);
  });

  test('sanitizes and returns a cleaned ID for unsafe input', () => {
    const raw = 'abc <script>';
    const result = acceptCorrelationId(raw);
    expect(result).not.toContain('<');
    expect(result).toContain('abc');
  });

  test('returns a generated ID when entire input is unsafe', () => {
    const result = acceptCorrelationId('   \n<<<>>>');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('<');
    expect(result).not.toContain(' ');
  });
});

// ── correlationIdMiddleware unit tests ────────────────────────────────────────

function makeMiddlewareHarness(incomingHeaders = {}) {
  const headersSent = {};
  const req = {
    headers: incomingHeaders,
  };
  const res = {
    _headers: {},
    setHeader(name, value) { this._headers[name] = value; },
  };
  return { req, res };
}

describe('correlationIdMiddleware()', () => {
  test('generates a correlationId when X-Correlation-ID header is absent', () => {
    const { req, res } = makeMiddlewareHarness();
    let nextCalled = false;
    correlationIdMiddleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(typeof req.correlationId).toBe('string');
    expect(req.correlationId.length).toBeGreaterThan(0);
    expect(res._headers['X-Correlation-ID']).toBe(req.correlationId);
  });

  test('uses incoming X-Correlation-ID header when valid', () => {
    const incoming = 'my-trace-id-abc123';
    const { req, res } = makeMiddlewareHarness({ 'x-correlation-id': incoming });
    correlationIdMiddleware(req, res, () => {});

    expect(req.correlationId).toBe(incoming);
    expect(res._headers['X-Correlation-ID']).toBe(incoming);
  });

  test('generates a new ID when incoming header is an empty string', () => {
    const { req, res } = makeMiddlewareHarness({ 'x-correlation-id': '' });
    correlationIdMiddleware(req, res, () => {});

    expect(typeof req.correlationId).toBe('string');
    expect(req.correlationId.length).toBeGreaterThan(0);
    expect(req.correlationId).not.toBe('');
  });

  test('sanitizes an incoming ID that contains unsafe characters', () => {
    const { req, res } = makeMiddlewareHarness({ 'x-correlation-id': 'abc <injected> def' });
    correlationIdMiddleware(req, res, () => {});

    expect(req.correlationId).not.toContain('<');
    expect(req.correlationId).not.toContain('>');
    expect(req.correlationId).not.toContain(' ');
    expect(req.correlationId).toContain('abc');
    expect(req.correlationId).toContain('def');
  });

  test('truncates an incoming ID longer than 128 characters', () => {
    const long = 'a'.repeat(200);
    const { req, res } = makeMiddlewareHarness({ 'x-correlation-id': long });
    correlationIdMiddleware(req, res, () => {});

    expect(req.correlationId.length).toBe(128);
    expect(res._headers['X-Correlation-ID'].length).toBe(128);
  });

  test('sets both req.correlationId and X-Correlation-ID response header', () => {
    const { req, res } = makeMiddlewareHarness({ 'x-correlation-id': 'test-id' });
    correlationIdMiddleware(req, res, () => {});

    expect(req.correlationId).toBeDefined();
    expect(res._headers['X-Correlation-ID']).toBe(req.correlationId);
  });

  test('calls next()', () => {
    const { req, res } = makeMiddlewareHarness();
    const next = jest.fn();
    correlationIdMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('two requests get different IDs when no header supplied', () => {
    const { req: req1, res: res1 } = makeMiddlewareHarness();
    const { req: req2, res: res2 } = makeMiddlewareHarness();

    correlationIdMiddleware(req1, res1, () => {});
    correlationIdMiddleware(req2, res2, () => {});

    expect(req1.correlationId).not.toBe(req2.correlationId);
  });
});

// ── requestLogger integration with pre-set correlationId ─────────────────────

jest.mock('../backend/src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { requestLogger } = require('../backend/src/middleware/requestLogger');

function makeLoggerHarness(existingCorrelationId) {
  const listeners = {};
  const req = {
    correlationId: existingCorrelationId,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    method: 'GET',
    originalUrl: '/api/payments',
    body: {},
    query: {},
  };
  const res = {
    _headers: {},
    setHeader(name, value) { this._headers[name] = value; },
    on(event, cb) { listeners[event] = cb; },
    statusCode: 200,
    _emit(event) { if (listeners[event]) listeners[event](); },
  };
  return { req, res };
}

describe('requestLogger — respects pre-set req.correlationId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses existing req.correlationId when already set', () => {
    const preSetId = 'pre-set-correlation-id-abc';
    const { req, res } = makeLoggerHarness(preSetId);

    requestLogger()(req, res, () => {});

    // req.correlationId must not be overwritten
    expect(req.correlationId).toBe(preSetId);
  });

  test('does not overwrite X-Correlation-ID response header when ID already set', () => {
    const preSetId = 'pre-set-id-xyz';
    const { req, res } = makeLoggerHarness(preSetId);
    // Simulate correlationIdMiddleware having already set the header
    res._headers['X-Correlation-ID'] = preSetId;

    requestLogger()(req, res, () => {});

    // Header should still be the one correlationIdMiddleware set
    expect(res._headers['X-Correlation-ID']).toBe(preSetId);
  });

  test('generates a correlationId when req.correlationId is not set', () => {
    const { req, res } = makeLoggerHarness(undefined);
    requestLogger()(req, res, () => {});

    expect(typeof req.correlationId).toBe('string');
    expect(req.correlationId.length).toBeGreaterThan(0);
  });

  test('includes correlationId in log output', () => {
    const { logger } = require('../backend/src/utils/logger');
    const preSetId = 'log-trace-id';
    const { req, res } = makeLoggerHarness(preSetId);

    requestLogger()(req, res, () => {});

    const logCall = logger.info.mock.calls.find(([msg]) => msg.includes('[Request]'));
    expect(logCall).toBeDefined();
    const logData = logCall[1];
    expect(logData.correlationId).toBe(preSetId);
  });
});
