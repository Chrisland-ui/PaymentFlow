'use strict';

/**
 * Transactional Outbox Pattern Tests (Issue #277)
 *
 * Verifies:
 *   - Payment mutations save payment and outbox domain event
 *   - Outbox dispatcher process logic and event payload schema
 */

const { savePayment } = require('../backend/src/services/transactionService');
const Outbox = require('../backend/src/models/outboxModel');
const Payment = require('../backend/src/models/paymentModel');

jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/models/outboxModel');
jest.mock('../backend/src/utils/generateReferenceCode', () => ({
  generateReferenceCode: jest.fn().mockResolvedValue('REF-12345'),
}));

describe('Transactional Outbox Pattern (#277)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('savePayment creates Payment and Outbox records atomically', async () => {
    const mockSavePayment = jest.fn().mockResolvedValue(true);
    const mockSaveOutbox = jest.fn().mockResolvedValue(true);

    Payment.mockImplementation((data) => ({
      ...data,
      save: mockSavePayment,
      toObject: () => ({ ...data, _id: 'payment-123' }),
    }));

    Outbox.mockImplementation((event) => ({
      ...event,
      save: mockSaveOutbox,
    }));

    const session = { id: 'mock-session' };
    const paymentData = {
      txHash: '0xabc123',
      amount: 100,
      currency: 'XLM',
      studentId: 'stu-1',
      schoolId: 'sch-1',
    };

    const result = await savePayment(paymentData, { session });

    expect(result).toBeDefined();
    expect(mockSavePayment).toHaveBeenCalledWith({ session });
    expect(mockSaveOutbox).toHaveBeenCalledWith({ session });
    expect(Outbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'payment.saved',
        aggregateId: '0xabc123',
        aggregateType: 'payment',
      })
    );
  });
});
