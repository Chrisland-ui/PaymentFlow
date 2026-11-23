'use strict';
/**
 * tests/notificationCenter.test.js
 *
 * Unit tests for the notification center:
 *   - notificationCreationSubscriber maps events to correct notification payloads
 *   - notificationController HTTP handlers return correct shapes
 */

jest.mock('../backend/src/utils/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: () => mockLogger,
  };
  return mockLogger;
});

const mockCreateNotification = jest.fn().mockResolvedValue({ _id: 'n1' });
const mockGetNotifications = jest.fn().mockResolvedValue({
  notifications: [
    {
      _id: 'n1',
      schoolId: 's1',
      type: 'payment.confirmed',
      severity: 'info',
      title: 'Payment Confirmed',
      message: 'Paid',
      read: false,
      createdAt: new Date(),
    },
  ],
  total: 1,
});
const mockMarkAsRead = jest.fn().mockResolvedValue(1);
const mockMarkAllAsRead = jest.fn().mockResolvedValue(3);
const mockGetUnreadCount = jest.fn().mockResolvedValue(5);

jest.mock('../backend/src/services/inAppNotificationService', () => ({
  createNotification: (...args) => mockCreateNotification(...args),
  getNotifications: (...args) => mockGetNotifications(...args),
  markAsRead: (...args) => mockMarkAsRead(...args),
  markAllAsRead: (...args) => mockMarkAllAsRead(...args),
  getUnreadCount: (...args) => mockGetUnreadCount(...args),
}));

// ── notificationCreationSubscriber ────────────────────────────────────────────

describe('notificationCreationSubscriber', () => {
  let paymentEvents;

  beforeAll(() => {
    paymentEvents = require('../backend/src/events/paymentEvents');
    const { registerNotificationSubscribers } = require('../backend/src/services/notificationCreationSubscriber');
    registerNotificationSubscribers();
  });

  afterEach(() => {
    mockCreateNotification.mockClear();
  });

  it('creates an info notification for a CONFIRMED payment', async () => {
    const payload = {
      schoolId: 'sch1',
      studentId: 'STU001',
      amount: '250',
      assetCode: 'XLM',
      status: 'CONFIRMED',
    };
    await paymentEvents.asyncEmit('payment.saved', payload);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: 'sch1',
        type: 'payment.confirmed',
        severity: 'info',
      })
    );
  });

  it('creates a warning notification for a FAILED payment', async () => {
    const payload = {
      schoolId: 'sch1',
      studentId: 'STU002',
      status: 'FAILED',
    };
    await paymentEvents.asyncEmit('payment.saved', payload);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: 'sch1',
        type: 'payment.failed',
        severity: 'warning',
      })
    );
  });

  it('skips PENDING payment status', async () => {
    const payload = { schoolId: 'sch1', studentId: 'STU003', status: 'PENDING' };
    await paymentEvents.asyncEmit('payment.saved', payload);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips events with no schoolId', async () => {
    const payload = { studentId: 'STU004', status: 'CONFIRMED' };
    await paymentEvents.asyncEmit('payment.saved', payload);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('creates a warning notification for dispute.created', async () => {
    const payload = { schoolId: 'sch1', studentId: 'STU005' };
    paymentEvents.emit('dispute.created', payload);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: 'sch1',
        type: 'dispute.created',
        severity: 'warning',
      })
    );
  });

  it('creates an info notification for dispute.updated', async () => {
    const payload = { schoolId: 'sch1', studentId: 'STU006', status: 'resolved' };
    paymentEvents.emit('dispute.updated', payload);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: 'sch1',
        type: 'dispute.updated',
        severity: 'info',
      })
    );
  });

  it('notification metadata does not include txHash or wallet addresses', async () => {
    const payload = {
      schoolId: 'sch1',
      studentId: 'STU007',
      amount: '100',
      assetCode: 'USDC',
      status: 'CONFIRMED',
      txHash: 'abc123secret',
      walletAddress: 'GSCHOOL...',
    };
    await paymentEvents.asyncEmit('payment.saved', payload);

    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.metadata).not.toHaveProperty('txHash');
    expect(call.metadata).not.toHaveProperty('walletAddress');
  });
});

// ── notificationController response shape ────────────────────────────────────

describe('notificationController', () => {
  let getNotificationsHandler;
  let markReadHandler;
  let markAllReadHandler;
  let getUnreadCountHandler;

  beforeAll(() => {
    ({
      getNotifications: getNotificationsHandler,
      markRead: markReadHandler,
      markAllRead: markAllReadHandler,
      getUnreadCount: getUnreadCountHandler,
    } = require('../backend/src/controllers/notificationController'));
  });

  const makeRes = () => {
    const res = {};
    res.json = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res;
  };

  it('GET /notifications returns notifications and unreadCount', async () => {
    const req = { schoolId: 's1', query: {} };
    const res = makeRes();
    await getNotificationsHandler(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: expect.any(Array),
        unreadCount: 5,
        total: 1,
      })
    );
  });

  it('PATCH /notifications/read rejects empty array with 400', async () => {
    const req = { schoolId: 's1', body: { notificationIds: [] } };
    const res = makeRes();
    await markReadHandler(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('PATCH /notifications/read accepts valid ids and returns modified count', async () => {
    const req = { schoolId: 's1', body: { notificationIds: ['n1'] } };
    const res = makeRes();
    await markReadHandler(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ modified: 1 });
  });

  it('POST /notifications/read-all returns modified count', async () => {
    const req = { schoolId: 's1' };
    const res = makeRes();
    await markAllReadHandler(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ modified: 3 });
  });

  it('GET /notifications/unread-count returns unreadCount', async () => {
    const req = { schoolId: 's1' };
    const res = makeRes();
    await getUnreadCountHandler(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ unreadCount: 5 });
  });
});
