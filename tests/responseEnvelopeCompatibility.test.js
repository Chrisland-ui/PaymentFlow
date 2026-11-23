'use strict';

/**
 * Snapshot & compatibility tests for API response envelope structure.
 * Issue #298: Guarantees canonical shape { data, meta, error } and X-API-Version header.
 */

const { formatEnvelope, sendEnvelope, sendSuccess, sendError, sendPaginated } = require('../backend/src/utils/responseHelper');

describe('Response Envelope Compatibility (#298)', () => {
  const createMockRes = () => {
    const res = {
      headers: {},
      statusCode: 200,
      jsonPayload: null,
      setHeader: (name, val) => { res.headers[name] = val; },
      status: (code) => { res.statusCode = code; return res; },
      json: (obj) => { res.jsonPayload = obj; return res; },
    };
    return res;
  };

  test('Canonical envelope format includes success, data, meta, and error', () => {
    const envelope = formatEnvelope({
      data: { id: 'item-1' },
      meta: { page: 1, limit: 10, total: 100 },
      error: null,
      success: true,
    });

    expect(envelope).toHaveProperty('success', true);
    expect(envelope).toHaveProperty('data');
    expect(envelope.data).toEqual({ id: 'item-1' });
    expect(envelope).toHaveProperty('meta');
    expect(envelope.meta).toEqual({ page: 1, limit: 10, total: 100 });
    expect(envelope).toHaveProperty('error', null);
  });

  test('sendEnvelope sets X-API-Version header and canonical envelope', () => {
    const res = createMockRes();
    sendEnvelope(res, {
      data: { status: 'active' },
      statusCode: 200,
    });

    expect(res.headers['X-API-Version']).toBeDefined();
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.success).toBe(true);
    expect(res.jsonPayload.data).toEqual({ status: 'active' });
    expect(res.jsonPayload.error).toBeNull();
  });

  test('sendPaginated sets standard pagination metadata', () => {
    const res = createMockRes();
    const items = [{ id: 1 }, { id: 2 }];
    sendPaginated(res, items, 1, 10, 25, 'cursor-abc');

    expect(res.headers['X-API-Version']).toBeDefined();
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.success).toBe(true);
    expect(res.jsonPayload.data).toEqual(items);
    expect(res.jsonPayload.meta.pagination).toBeDefined();
    expect(res.jsonPayload.meta.pagination.page).toBe(1);
    expect(res.jsonPayload.meta.pagination.limit).toBe(10);
    expect(res.jsonPayload.meta.pagination.total).toBe(25);
    expect(res.jsonPayload.meta.pagination.totalPages).toBe(3);
    expect(res.jsonPayload.meta.pagination.hasNext).toBe(true);
    expect(res.jsonPayload.meta.pagination.hasPrev).toBe(false);
    expect(res.jsonPayload.meta.pagination.nextCursor).toBe('cursor-abc');
  });

  test('sendError format sets X-API-Version header and error details', () => {
    const res = createMockRes();
    sendError(res, 'Invalid request', 'BAD_REQUEST', 400, { field: 'amount' });

    expect(res.headers['X-API-Version']).toBeDefined();
    expect(res.statusCode).toBe(400);
    expect(res.jsonPayload.success).toBe(false);
    expect(res.jsonPayload.error.code).toBe('BAD_REQUEST');
    expect(res.jsonPayload.error.message).toBe('Invalid request');
    expect(res.jsonPayload.error.details).toEqual({ field: 'amount' });
  });
});
