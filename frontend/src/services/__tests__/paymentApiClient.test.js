/**
 * Tests for the typed payment API client — Issue #1.
 *
 * Covers:
 *   - Success paths for fetchStudentPayments and verifyPayment
 *   - Timeout / network error: normalizeApiError returns retryable=true, status=null
 *   - Validation failure (HTTP 422): normalizeApiError returns retryable=false, status=422
 *   - HTTP 503: normalizeApiError returns retryable=true, status=503
 *   - Error code extraction from response.data.code
 */

import {
  fetchStudentPayments,
  verifyPayment,
  normalizeApiError,
  fetchPaymentInstructions,
  fetchStudentBalance,
  fetchPaymentSummary,
  syncPayments,
  fetchSyncStatus,
  fetchConversionRates,
  initiateRefund,
  approveRefund,
  fetchPaymentRefunds,
  fetchSchoolRefunds,
} from '../paymentApiClient';

// Mock the shared axios instance — we only care about the HTTP calls,
// not the interceptor logic (tested separately in authRefresh.test.js).
jest.mock('../api', () => {
  const mockApi = {
    get: jest.fn(),
    post: jest.fn(),
  };
  mockApi.default = mockApi;
  return mockApi;
});

import api from '../api';

// ── helpers ───────────────────────────────────────────────────────────────────

function axiosNetworkError(message = 'Network Error') {
  const err = new Error(message);
  err.isAxiosError = true;
  // No .response property — simulates a timeout / offline / DNS failure.
  return err;
}

function axiosHttpError(status, code = '', message = 'Request failed') {
  const err = new Error(message);
  err.isAxiosError = true;
  err.response = {
    status,
    data: {
      error: message,
      ...(code && { code }),
    },
  };
  return err;
}

// ── normalizeApiError (unit tests, no mock needed) ───────────────────────────

describe('normalizeApiError', () => {
  it('returns retryable=true and status=null for a network/timeout error', () => {
    const err = axiosNetworkError('timeout of 15000ms exceeded');
    const result = normalizeApiError(err);
    expect(result.status).toBeNull();
    expect(result.retryable).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    expect(typeof result.code).toBe('string');
  });

  it('returns retryable=false and status=422 for a validation failure', () => {
    const err = axiosHttpError(422, 'VALIDATION_ERROR', 'Validation failed');
    const result = normalizeApiError(err);
    expect(result.status).toBe(422);
    expect(result.retryable).toBe(false);
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(result.message).toBe('Validation failed');
  });

  it('returns retryable=true and status=503 for a service-unavailable error', () => {
    const err = axiosHttpError(503, 'SERVICE_UNAVAILABLE', 'Service Unavailable');
    const result = normalizeApiError(err);
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('extracts the error code from response.data.code', () => {
    const err = axiosHttpError(400, 'DUPLICATE_TX', 'Duplicate transaction');
    const result = normalizeApiError(err);
    expect(result.code).toBe('DUPLICATE_TX');
    expect(result.retryable).toBe(false);
  });

  it('returns an empty string for code when no code is present', () => {
    const err = axiosHttpError(500, '', 'Internal Server Error');
    const result = normalizeApiError(err);
    expect(result.code).toBe('');
    expect(result.retryable).toBe(true);
  });

  it('returns a fallback message for completely unknown errors', () => {
    const result = normalizeApiError(new Error());
    expect(result.message).toBeTruthy();
    expect(result.status).toBeNull();
  });
});

// ── fetchStudentPayments ─────────────────────────────────────────────────────

describe('fetchStudentPayments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves with the axios response on success', async () => {
    const mockResponse = {
      data: [
        { txHash: 'abc123', status: 'SUCCESS', amount: 250, asset: 'XLM', createdAt: '2026-01-01T00:00:00Z' },
      ],
    };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchStudentPayments('STU001');

    expect(api.get).toHaveBeenCalledWith('/payments/STU001', { signal: undefined });
    expect(result).toBe(mockResponse);
  });

  it('passes an AbortSignal when provided', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    const controller = new AbortController();

    await fetchStudentPayments('STU002', { signal: controller.signal });

    expect(api.get).toHaveBeenCalledWith('/payments/STU002', { signal: controller.signal });
  });

  it('re-throws a normalised ApiError on network failure', async () => {
    api.get.mockRejectedValueOnce(axiosNetworkError());

    await expect(fetchStudentPayments('STU001')).rejects.toMatchObject({
      retryable: true,
      status: null,
    });
  });

  it('re-throws a normalised ApiError for HTTP 422', async () => {
    api.get.mockRejectedValueOnce(axiosHttpError(422, 'VALIDATION_ERROR'));

    await expect(fetchStudentPayments('STU001')).rejects.toMatchObject({
      retryable: false,
      status: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('re-throws a normalised ApiError for HTTP 503', async () => {
    api.get.mockRejectedValueOnce(axiosHttpError(503, 'SERVICE_UNAVAILABLE'));

    await expect(fetchStudentPayments('STU001')).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
  });
});

// ── verifyPayment ─────────────────────────────────────────────────────────────

describe('verifyPayment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts the txHash and resolves with the axios response', async () => {
    const mockResponse = { data: { txHash: 'abc123', status: 'SUCCESS', memo: 'STU001' } };
    api.post.mockResolvedValueOnce(mockResponse);

    const result = await verifyPayment('abc123');

    expect(api.post).toHaveBeenCalledWith('/payments/verify', { txHash: 'abc123' });
    expect(result).toBe(mockResponse);
  });

  it('re-throws a normalised ApiError for DUPLICATE_TX (HTTP 409)', async () => {
    api.post.mockRejectedValueOnce(axiosHttpError(409, 'DUPLICATE_TX', 'Duplicate transaction'));

    await expect(verifyPayment('abc123')).rejects.toMatchObject({
      retryable: false,
      status: 409,
      code: 'DUPLICATE_TX',
      message: 'Duplicate transaction',
    });
  });

  it('re-throws a normalised ApiError for network errors', async () => {
    api.post.mockRejectedValueOnce(axiosNetworkError('ECONNREFUSED'));

    await expect(verifyPayment('abc123')).rejects.toMatchObject({
      retryable: true,
      status: null,
    });
  });
});

// ── fetchPaymentInstructions ─────────────────────────────────────────────────

describe('fetchPaymentInstructions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the correct endpoint and resolves on success', async () => {
    const mockResponse = {
      data: { walletAddress: 'GSCHOOL...', memo: 'STU001', acceptedAssets: [{ code: 'XLM' }] },
    };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchPaymentInstructions('STU001');

    expect(api.get).toHaveBeenCalledWith('/payments/instructions/STU001', { signal: undefined });
    expect(result).toBe(mockResponse);
  });

  it('re-throws a normalised error on failure', async () => {
    api.get.mockRejectedValueOnce(axiosHttpError(404, 'NOT_FOUND'));

    await expect(fetchPaymentInstructions('INVALID')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      retryable: false,
    });
  });
});

// ── fetchStudentBalance ───────────────────────────────────────────────────────

describe('fetchStudentBalance', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves with balance data on success', async () => {
    const mockResponse = { data: { totalPaid: 250, totalDue: 500, balance: 250, feeStatus: 'partial' } };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchStudentBalance('STU001');

    expect(api.get).toHaveBeenCalledWith('/payments/balance/STU001', { signal: undefined });
    expect(result).toBe(mockResponse);
  });
});

// ── fetchPaymentSummary ───────────────────────────────────────────────────────

describe('fetchPaymentSummary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the summary endpoint and resolves on success', async () => {
    const mockResponse = { data: { totalCollected: 10000, pendingCount: 5, successCount: 40 } };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchPaymentSummary();

    expect(api.get).toHaveBeenCalledWith('/payments/summary', { signal: undefined });
    expect(result).toBe(mockResponse);
  });
});

// ── syncPayments ─────────────────────────────────────────────────────────────

describe('syncPayments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts to the sync endpoint and resolves on success', async () => {
    const mockResponse = { data: { processed: 10, new: 2 } };
    api.post.mockResolvedValueOnce(mockResponse);

    const result = await syncPayments();

    expect(api.post).toHaveBeenCalledWith('/payments/sync');
    expect(result).toBe(mockResponse);
  });
});

// ── fetchSyncStatus ───────────────────────────────────────────────────────────

describe('fetchSyncStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the sync/status endpoint and resolves on success', async () => {
    const mockResponse = { data: { running: false, lastSyncAt: '2026-01-01T00:00:00Z' } };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchSyncStatus();

    expect(api.get).toHaveBeenCalledWith('/payments/sync/status', { signal: undefined });
    expect(result).toBe(mockResponse);
  });
});

// ── fetchConversionRates ──────────────────────────────────────────────────────

describe('fetchConversionRates', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the rates endpoint and resolves on success', async () => {
    const mockResponse = { data: { rates: { XLM: 0.11, USDC: 1.0 } } };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchConversionRates();

    expect(api.get).toHaveBeenCalledWith('/payments/rates');
    expect(result).toBe(mockResponse);
  });
});

// ── initiateRefund ────────────────────────────────────────────────────────────

describe('initiateRefund', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts to the refund endpoint with the correct payload', async () => {
    const mockResponse = { data: { refundId: 'REF001', status: 'PENDING' } };
    api.post.mockResolvedValueOnce(mockResponse);

    const result = await initiateRefund('abc123', { reason: 'Overpayment' });

    expect(api.post).toHaveBeenCalledWith('/payments/abc123/refund', { reason: 'Overpayment' });
    expect(result).toBe(mockResponse);
  });
});

// ── approveRefund ─────────────────────────────────────────────────────────────

describe('approveRefund', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts to the approve endpoint with the correct payload', async () => {
    const mockResponse = { data: { status: 'APPROVED' } };
    api.post.mockResolvedValueOnce(mockResponse);

    const result = await approveRefund('REF001', { notes: 'Verified' });

    expect(api.post).toHaveBeenCalledWith('/payments/refunds/REF001/approve', { notes: 'Verified' });
    expect(result).toBe(mockResponse);
  });
});

// ── fetchPaymentRefunds ───────────────────────────────────────────────────────

describe('fetchPaymentRefunds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the refunds endpoint for a specific transaction', async () => {
    const mockResponse = { data: [{ refundId: 'REF001', status: 'APPROVED', amount: 250, createdAt: '2026-01-01T00:00:00Z' }] };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchPaymentRefunds('abc123');

    expect(api.get).toHaveBeenCalledWith('/payments/abc123/refunds');
    expect(result).toBe(mockResponse);
  });
});

// ── fetchSchoolRefunds ────────────────────────────────────────────────────────

describe('fetchSchoolRefunds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the school refunds list endpoint with params', async () => {
    const mockResponse = { data: { refunds: [], total: 0 } };
    api.get.mockResolvedValueOnce(mockResponse);

    const result = await fetchSchoolRefunds({ page: 1, limit: 20 });

    expect(api.get).toHaveBeenCalledWith('/payments/refunds/school/list', { params: { page: 1, limit: 20 } });
    expect(result).toBe(mockResponse);
  });

  it('defaults to empty params when none are provided', async () => {
    api.get.mockResolvedValueOnce({ data: { refunds: [], total: 0 } });

    await fetchSchoolRefunds();

    expect(api.get).toHaveBeenCalledWith('/payments/refunds/school/list', { params: {} });
  });
});
