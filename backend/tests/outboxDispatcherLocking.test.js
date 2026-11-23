'use strict';

/**
 * Tests for outboxDispatcher — dispatch locking and idempotency (Issue #29).
 *
 * Covers:
 *   - Lock acquisition prevents double-dispatch in concurrent workers
 *   - Already-processed events are skipped (idempotency guard)
 *   - scheduledAfter in the future delays dispatch
 *   - scheduledAfter in the past does not delay dispatch
 *   - Exponential backoff sets scheduledAfter on failure
 *   - Failed lock claim causes event to be skipped without error
 */

const Outbox = require('../src/models/outboxModel');
const paymentEvents = require('../src/events/paymentEvents');

jest.mock('../src/models/outboxModel', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../src/events/paymentEvents', () => ({
  emit: jest.fn(),
  asyncEmit: jest.fn().mockResolvedValue([]),
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ child: jest.fn(() => mockLogger) }));

const { dispatchOutboxEvents } = require('../src/services/outboxDispatcher');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    _id: 'event-id-1',
    eventId: 'evt-1',
    eventType: 'payment.saved',
    payload: { txHash: 'abc' },
    retryCount: 0,
    processed: false,
    processedAt: null,
    deadLettered: false,
    lockedUntil: null,
    scheduledAfter: null,
    ...overrides,
  };
}

function mockBatch(events) {
  const sort = jest.fn().mockResolvedValue(events);
  const limit = jest.fn(() => ({ sort }));
  Outbox.find.mockReturnValue({ limit });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: lock claim succeeds (returns a document)
  Outbox.findOneAndUpdate.mockResolvedValue({ _id: 'event-id-1' });
});

// ── Dispatch locking ─────────────────────────────────────────────────────────

describe('outboxDispatcher — dispatch locking', () => {
  it('skips an event when the lock claim returns null (another worker holds the lock)', async () => {
    const event = makeEvent();
    mockBatch([event]);
    // Simulate lock already held by another worker
    Outbox.findOneAndUpdate.mockResolvedValueOnce(null);

    await dispatchOutboxEvents();

    expect(paymentEvents.asyncEmit).not.toHaveBeenCalled();
    const processedCalls = Outbox.findByIdAndUpdate.mock.calls.filter(
      ([, update]) => update.processed === true,
    );
    expect(processedCalls).toHaveLength(0);
  });

  it('acquires the lock via findOneAndUpdate with lockedUntil condition', async () => {
    const event = makeEvent();
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });
    paymentEvents.asyncEmit.mockResolvedValueOnce([]);

    await dispatchOutboxEvents();

    expect(Outbox.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: event._id, processed: false }),
      expect.objectContaining({ $set: expect.objectContaining({ lockedUntil: expect.any(Date) }) }),
      expect.any(Object),
    );
  });

  it('releases the lock (sets lockedUntil: null) after successful dispatch', async () => {
    const event = makeEvent();
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });
    paymentEvents.asyncEmit.mockResolvedValueOnce([]);

    await dispatchOutboxEvents();

    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({ processed: true, lockedUntil: null }),
    );
  });

  it('releases the lock after a retryable failure', async () => {
    const event = makeEvent({ retryCount: 0 });
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });
    paymentEvents.asyncEmit.mockResolvedValueOnce([
      { status: 'rejected', reason: new Error('transient failure') },
    ]);

    await dispatchOutboxEvents();

    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({ lockedUntil: null }),
    );
  });
});

// ── Idempotency guard ────────────────────────────────────────────────────────

describe('outboxDispatcher — idempotency guard', () => {
  it('skips an event that is already marked processed', async () => {
    const event = makeEvent({ processed: true, processedAt: new Date() });
    mockBatch([event]);

    await dispatchOutboxEvents();

    expect(paymentEvents.asyncEmit).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Outbox event already processed; skipping',
      expect.objectContaining({ eventId: event.eventId }),
    );
  });

  it('processes an event that is not yet marked processed', async () => {
    const event = makeEvent({ processed: false, processedAt: null });
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });
    paymentEvents.asyncEmit.mockResolvedValueOnce([]);

    await dispatchOutboxEvents();

    expect(paymentEvents.asyncEmit).toHaveBeenCalledWith('payment.saved', event.payload);
  });
});

// ── scheduledAfter ───────────────────────────────────────────────────────────

describe('outboxDispatcher — scheduledAfter', () => {
  it('skips an event whose scheduledAfter is in the future', async () => {
    const futureDate = new Date(Date.now() + 60000);
    const event = makeEvent({ scheduledAfter: futureDate });
    mockBatch([event]);

    await dispatchOutboxEvents();

    expect(paymentEvents.asyncEmit).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Outbox event scheduled for future; skipping',
      expect.objectContaining({ eventId: event.eventId }),
    );
  });

  it('processes an event whose scheduledAfter is in the past', async () => {
    const pastDate = new Date(Date.now() - 1000);
    const event = makeEvent({ scheduledAfter: pastDate });
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });
    paymentEvents.asyncEmit.mockResolvedValueOnce([]);

    await dispatchOutboxEvents();

    expect(paymentEvents.asyncEmit).toHaveBeenCalledWith('payment.saved', event.payload);
  });

  it('sets scheduledAfter with exponential backoff on a retryable failure', async () => {
    // retryCount: 1 => next retry is attempt 2 => backoff = 2^2 * 1000 = 4000ms
    const event = makeEvent({ retryCount: 1 });
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });
    paymentEvents.asyncEmit.mockResolvedValueOnce([
      { status: 'rejected', reason: new Error('retry me') },
    ]);

    const before = Date.now();
    await dispatchOutboxEvents();
    const after = Date.now();

    const updateCall = Outbox.findByIdAndUpdate.mock.calls.find(
      ([id, update]) => id === event._id && update.scheduledAfter,
    );
    expect(updateCall).toBeDefined();
    const scheduledAfter = updateCall[1].scheduledAfter;
    // Should be at least 3s in the future (generous margin)
    expect(scheduledAfter.getTime()).toBeGreaterThanOrEqual(before + 3000);
    // Should not exceed 65s (max backoff is 60s + a little buffer)
    expect(scheduledAfter.getTime()).toBeLessThanOrEqual(after + 65000);
  });
});

// ── Dead-letter handling with lock release ────────────────────────────────────

describe('outboxDispatcher — dead-letter with locking', () => {
  it('dead-letters and clears lock when retry budget is exhausted', async () => {
    const event = makeEvent({ retryCount: 3 }); // MAX_RETRIES default = 3
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });

    await dispatchOutboxEvents();

    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({ deadLettered: true, lockedUntil: null }),
    );
  });

  it('logs an error when dead-lettering', async () => {
    const event = makeEvent({ retryCount: 3, lastError: 'too many failures' });
    mockBatch([event]);
    Outbox.findOneAndUpdate.mockResolvedValueOnce({ _id: event._id });

    await dispatchOutboxEvents();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Outbox event exceeded max retries',
      expect.objectContaining({ eventId: event.eventId }),
    );
  });
});
