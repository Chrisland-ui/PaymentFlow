'use strict';

const {
  PAYMENT_ERROR_CATEGORIES,
  TAXONOMY,
  PaymentError,
  getErrorCategory,
  isTransientError,
  mapErrorToResponse,
} = require('../backend/src/errors/paymentErrorTaxonomy');
const { errorResponse, globalErrorHandler, ERROR_STATUS_MAP } = require('../backend/src/middleware/errorHandler');

describe('Payment Error Taxonomy (#26)', () => {
  describe('Categories and Taxonomy Definitions', () => {
    it('defines the five core taxonomy categories plus internal', () => {
      expect(PAYMENT_ERROR_CATEGORIES.VALIDATION).toBe('VALIDATION');
      expect(PAYMENT_ERROR_CATEGORIES.AUTHORIZATION).toBe('AUTHORIZATION');
      expect(PAYMENT_ERROR_CATEGORIES.CONFLICT).toBe('CONFLICT');
      expect(PAYMENT_ERROR_CATEGORIES.PROVIDER).toBe('PROVIDER');
      expect(PAYMENT_ERROR_CATEGORIES.TRANSIENT).toBe('TRANSIENT');
      expect(PAYMENT_ERROR_CATEGORIES.INTERNAL).toBe('INTERNAL');
    });

    it('correctly maps validation codes to VALIDATION and 400 status', () => {
      const validationCodes = [
        'VALIDATION_ERROR',
        'INVALID_AMOUNT',
        'AMOUNT_TOO_LOW',
        'AMOUNT_TOO_HIGH',
        'INVALID_HASH_FORMAT',
        'MISSING_MEMO',
        'INVALID_MEMO',
        'MISSING_XDR',
        'INVALID_DESTINATION',
        'UNSUPPORTED_ASSET',
        'ASSET_NOT_ACCEPTED',
      ];
      for (const code of validationCodes) {
        expect(TAXONOMY[code]).toBeDefined();
        expect(TAXONOMY[code].category).toBe(PAYMENT_ERROR_CATEGORIES.VALIDATION);
        expect(TAXONOMY[code].status).toBe(400);
        expect(TAXONOMY[code].retryable).toBe(false);
      }
    });

    it('correctly maps authorization codes to AUTHORIZATION and 401/403 status', () => {
      expect(TAXONOMY.UNAUTHORIZED.category).toBe(PAYMENT_ERROR_CATEGORIES.AUTHORIZATION);
      expect(TAXONOMY.UNAUTHORIZED.status).toBe(401);
      expect(TAXONOMY.FORBIDDEN.category).toBe(PAYMENT_ERROR_CATEGORIES.AUTHORIZATION);
      expect(TAXONOMY.FORBIDDEN.status).toBe(403);
      expect(TAXONOMY.INTENT_MISMATCH.category).toBe(PAYMENT_ERROR_CATEGORIES.AUTHORIZATION);
      expect(TAXONOMY.INTENT_MISMATCH.status).toBe(403);
    });

    it('correctly maps conflict codes to CONFLICT and 409 status', () => {
      expect(TAXONOMY.DUPLICATE_TX.category).toBe(PAYMENT_ERROR_CATEGORIES.CONFLICT);
      expect(TAXONOMY.DUPLICATE_TX.status).toBe(409);
      expect(TAXONOMY.DUPLICATE_PAYMENT_INTENT.category).toBe(PAYMENT_ERROR_CATEGORIES.CONFLICT);
      expect(TAXONOMY.DUPLICATE_PAYMENT_INTENT.status).toBe(409);
      expect(TAXONOMY.SYNC_IN_PROGRESS.category).toBe(PAYMENT_ERROR_CATEGORIES.CONFLICT);
      expect(TAXONOMY.SYNC_IN_PROGRESS.status).toBe(409);
      expect(TAXONOMY.SYNC_IN_PROGRESS.retryable).toBe(true);
    });

    it('correctly maps provider codes to PROVIDER and 502 status', () => {
      expect(TAXONOMY.PROVIDER_ERROR.category).toBe(PAYMENT_ERROR_CATEGORIES.PROVIDER);
      expect(TAXONOMY.PROVIDER_ERROR.status).toBe(502);
      expect(TAXONOMY.STELLAR_NETWORK_ERROR.category).toBe(PAYMENT_ERROR_CATEGORIES.PROVIDER);
      expect(TAXONOMY.STELLAR_NETWORK_ERROR.status).toBe(502);
      expect(TAXONOMY.HORIZON_ERROR.category).toBe(PAYMENT_ERROR_CATEGORIES.PROVIDER);
      expect(TAXONOMY.HORIZON_ERROR.status).toBe(502);
      expect(TAXONOMY.TX_SUBMISSION_FAILED.category).toBe(PAYMENT_ERROR_CATEGORIES.PROVIDER);
      expect(TAXONOMY.TX_SUBMISSION_FAILED.status).toBe(502);
    });

    it('correctly maps transient codes to TRANSIENT and appropriate retryable statuses', () => {
      expect(TAXONOMY.TRANSIENT_FAILURE.category).toBe(PAYMENT_ERROR_CATEGORIES.TRANSIENT);
      expect(TAXONOMY.TRANSIENT_FAILURE.status).toBe(503);
      expect(TAXONOMY.TRANSIENT_FAILURE.retryable).toBe(true);

      expect(TAXONOMY.SERVICE_UNAVAILABLE.category).toBe(PAYMENT_ERROR_CATEGORIES.TRANSIENT);
      expect(TAXONOMY.SERVICE_UNAVAILABLE.status).toBe(503);
      expect(TAXONOMY.SERVICE_UNAVAILABLE.retryable).toBe(true);

      expect(TAXONOMY.HORIZON_UNAVAILABLE.category).toBe(PAYMENT_ERROR_CATEGORIES.TRANSIENT);
      expect(TAXONOMY.HORIZON_UNAVAILABLE.status).toBe(503);
      expect(TAXONOMY.HORIZON_UNAVAILABLE.retryable).toBe(true);

      expect(TAXONOMY.QUEUE_UNAVAILABLE.category).toBe(PAYMENT_ERROR_CATEGORIES.TRANSIENT);
      expect(TAXONOMY.QUEUE_UNAVAILABLE.status).toBe(503);
      expect(TAXONOMY.QUEUE_UNAVAILABLE.retryable).toBe(true);

      expect(TAXONOMY.RATE_LIMITED.category).toBe(PAYMENT_ERROR_CATEGORIES.TRANSIENT);
      expect(TAXONOMY.RATE_LIMITED.status).toBe(429);
      expect(TAXONOMY.RATE_LIMITED.retryable).toBe(true);
    });
  });

  describe('PaymentError class', () => {
    it('constructs an instance with category, status, and default safe message', () => {
      const err = new PaymentError('AMOUNT_TOO_LOW');
      expect(err.name).toBe('PaymentError');
      expect(err.code).toBe('AMOUNT_TOO_LOW');
      expect(err.category).toBe(PAYMENT_ERROR_CATEGORIES.VALIDATION);
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe(TAXONOMY.AMOUNT_TOO_LOW.safeMessage);
      expect(err.retryable).toBe(false);
    });

    it('preserves diagnostic context and custom message', () => {
      const diag = { internalTxId: 'db-1234', rawStellarCode: 'op_underfunded' };
      const err = new PaymentError('STELLAR_NETWORK_ERROR', 'Stellar connection lost', diag);
      expect(err.code).toBe('STELLAR_NETWORK_ERROR');
      expect(err.category).toBe(PAYMENT_ERROR_CATEGORIES.PROVIDER);
      expect(err.message).toBe('Stellar connection lost');
      expect(err.diagnosticContext).toEqual(diag);
      expect(err.retryable).toBe(true);
    });

    it('falls back to INTERNAL_ERROR for unrecognized codes', () => {
      const err = new PaymentError('UNKNOWN_FOOBAR_CODE');
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.category).toBe(PAYMENT_ERROR_CATEGORIES.INTERNAL);
      expect(err.statusCode).toBe(500);
    });
  });

  describe('Helper functions', () => {
    it('getErrorCategory returns correct category or INTERNAL', () => {
      expect(getErrorCategory('INVALID_AMOUNT')).toBe('VALIDATION');
      expect(getErrorCategory('UNAUTHORIZED')).toBe('AUTHORIZATION');
      expect(getErrorCategory('DUPLICATE_TX')).toBe('CONFLICT');
      expect(getErrorCategory('HORIZON_ERROR')).toBe('PROVIDER');
      expect(getErrorCategory('SERVICE_UNAVAILABLE')).toBe('TRANSIENT');
      expect(getErrorCategory('NON_EXISTENT')).toBe('INTERNAL');
    });

    it('isTransientError distinguishes transient from non-transient', () => {
      expect(isTransientError('SERVICE_UNAVAILABLE')).toBe(true);
      expect(isTransientError('HORIZON_UNAVAILABLE')).toBe(true);
      expect(isTransientError('SYNC_IN_PROGRESS')).toBe(true);
      expect(isTransientError('RATE_LIMITED')).toBe(true);
      expect(isTransientError('INVALID_AMOUNT')).toBe(false);
      expect(isTransientError('UNAUTHORIZED')).toBe(false);
      expect(isTransientError('DUPLICATE_TX')).toBe(false);

      const retryableErr = new Error('Temporary');
      retryableErr.retryable = true;
      expect(isTransientError(retryableErr)).toBe(true);
    });
  });

  describe('mapErrorToResponse', () => {
    it('maps known validation error to client response', () => {
      const input = { code: 'INVALID_AMOUNT', message: 'Amount was negative', details: { field: 'amount' } };
      const { statusCode, body, diagnosticContext } = mapErrorToResponse(input, true);

      expect(statusCode).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_AMOUNT');
      expect(body.error.category).toBe('VALIDATION');
      expect(body.error.message).toBe('Amount was negative');
      expect(body.error.details).toEqual({ field: 'amount' });
      expect(diagnosticContext.internalMessage).toBe('Amount was negative');
    });

    it('redacts internal messages for 500 errors in production', () => {
      const internalErr = new Error('MongoNetworkError: connection 127.0.0.1:27017 timed out');
      internalErr.stack = 'Error at Connection.open (/app/node_modules/mongodb/...)';
      const { statusCode, body, diagnosticContext } = mapErrorToResponse(internalErr, true);

      expect(statusCode).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.category).toBe('INTERNAL');
      expect(body.error.message).toBe('An internal server error occurred.');
      expect(body.error.message).not.toContain('127.0.0.1');

      // Diagnostic context preserves the raw error for logs
      expect(diagnosticContext.internalMessage).toContain('MongoNetworkError');
      expect(diagnosticContext.stack).toBeDefined();
    });

    it('exposes error message in development mode', () => {
      const devErr = new Error('Debug error info');
      const { statusCode, body } = mapErrorToResponse(devErr, false);

      expect(statusCode).toBe(500);
      expect(body.error.message).toBe('Debug error info');
    });
  });

  describe('errorHandler backward compatibility', () => {
    it('errorResponse includes category and preserves backward-compatible shape', () => {
      const resp = errorResponse('Bad memo', 'MISSING_MEMO');
      expect(resp.success).toBe(false);
      expect(resp.error.message).toBe('Bad memo');
      expect(resp.error.code).toBe('MISSING_MEMO');
      expect(resp.error.category).toBe('VALIDATION');
    });

    it('ERROR_STATUS_MAP contains legacy and taxonomy error codes', () => {
      expect(ERROR_STATUS_MAP.TX_FAILED).toBe(400);
      expect(ERROR_STATUS_MAP.MISSING_MEMO).toBe(400);
      expect(ERROR_STATUS_MAP.VALIDATION_ERROR).toBe(400);
      expect(ERROR_STATUS_MAP.DUPLICATE_TX).toBe(409);
      expect(ERROR_STATUS_MAP.STELLAR_NETWORK_ERROR).toBe(502);
      expect(ERROR_STATUS_MAP.QUEUE_UNAVAILABLE).toBe(503);
    });

    it('globalErrorHandler formats response and logs diagnostic context', () => {
      const req = { path: '/api/payments', method: 'POST', requestId: 'req-1', schoolId: 'school-1' };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const next = jest.fn();

      const err = new PaymentError('AMOUNT_TOO_HIGH', 'Payment exceeds limit');
      globalErrorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'AMOUNT_TOO_HIGH',
          category: 'VALIDATION',
          message: 'Payment exceeds limit',
        }),
      }));
    });
  });
});
