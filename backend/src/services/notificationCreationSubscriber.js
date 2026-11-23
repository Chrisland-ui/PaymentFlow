'use strict';

/**
 * notificationCreationSubscriber.js
 *
 * Subscribes to the paymentEvents EventEmitter and creates in-app notifications
 * for significant payment, dispute, report, and system lifecycle events.
 *
 * Supported events (Issue #362):
 *   - payment.saved    → payment.confirmed / payment.failed notification
 *   - dispute.created  → dispute.created notification
 *   - dispute.updated  → dispute.updated notification
 *   - report.ready     → report.ready notification
 *   - system.alert     → system.alert notification
 *
 * Security:
 *   - Notification metadata must NOT contain txHash, wallet addresses, or raw PII
 *     beyond studentId. Titles and messages use only safe display values.
 *   - schoolId scoping is enforced by inAppNotificationService.createNotification.
 *   - Errors are caught and logged — a notification write failure must not
 *     interrupt the main payment / dispute processing path.
 *
 * Registered once at app startup via registerNotificationSubscribers().
 */

const paymentEvents = require('../events/paymentEvents');
const { createNotification } = require('./inAppNotificationService');
const logger = require('../utils/logger').child('NotificationSubscriber');

/**
 * Handle a 'payment.saved' event.
 *
 * payment.saved fires when a payment is persisted to MongoDB after on-chain
 * confirmation. The payment document contains status, schoolId, studentId,
 * amount, and assetCode.
 *
 * @param {object} payment - The saved Payment document
 */
async function onPaymentSaved(payment) {
  const { schoolId, studentId, amount, assetCode, status } = payment || {};

  if (!schoolId) {
    logger.warn('payment.saved event missing schoolId — notification skipped');
    return;
  }

  // Only create notifications for confirmed and failed states
  const isFailed = status === 'FAILED' || status === 'VERIFICATION_FAILED';
  const isConfirmed = status === 'CONFIRMED' || status === 'PAID';

  if (!isConfirmed && !isFailed) {
    return;
  }

  const notifData = isConfirmed
    ? {
        type: 'payment.confirmed',
        severity: 'info',
        title: 'Payment Confirmed',
        message: amount && assetCode
          ? `Payment of ${amount} ${assetCode} confirmed for student ${studentId}.`
          : `Payment confirmed for student ${studentId}.`,
        deepLink: studentId ? `/dashboard?student=${encodeURIComponent(studentId)}` : null,
        metadata: { studentId, amount, assetCode },
      }
    : {
        type: 'payment.failed',
        severity: 'warning',
        title: 'Payment Verification Failed',
        message: `Payment verification failed for student ${studentId}. Please check the transaction.`,
        deepLink: studentId ? `/dashboard?student=${encodeURIComponent(studentId)}` : null,
        metadata: { studentId },
      };

  try {
    await createNotification({ schoolId, ...notifData });
  } catch (err) {
    logger.error('Failed to create payment notification', {
      schoolId,
      studentId,
      err: err.message,
    });
  }
}

/**
 * Handle a 'dispute.created' event.
 *
 * @param {object} payload - { schoolId, studentId, disputeId }
 */
async function onDisputeCreated(payload) {
  const { schoolId, studentId } = payload || {};

  if (!schoolId) {
    logger.warn('dispute.created event missing schoolId — notification skipped');
    return;
  }

  try {
    await createNotification({
      schoolId,
      type: 'dispute.created',
      severity: 'warning',
      title: 'New Dispute Opened',
      message: `A dispute has been opened for student ${studentId}.`,
      deepLink: '/disputes',
      metadata: { studentId },
    });
  } catch (err) {
    logger.error('Failed to create dispute.created notification', {
      schoolId,
      studentId,
      err: err.message,
    });
  }
}

/**
 * Handle a 'dispute.updated' event.
 *
 * @param {object} payload - { schoolId, studentId, status }
 */
async function onDisputeUpdated(payload) {
  const { schoolId, studentId, status } = payload || {};

  if (!schoolId) {
    logger.warn('dispute.updated event missing schoolId — notification skipped');
    return;
  }

  try {
    await createNotification({
      schoolId,
      type: 'dispute.updated',
      severity: 'info',
      title: 'Dispute Updated',
      message: status
        ? `Dispute for student ${studentId} is now ${status}.`
        : `Dispute status updated for student ${studentId}.`,
      deepLink: '/disputes',
      metadata: { studentId, status },
    });
  } catch (err) {
    logger.error('Failed to create dispute.updated notification', {
      schoolId,
      studentId,
      err: err.message,
    });
  }
}

/**
 * Handle a 'report.ready' event.
 *
 * Fired when a report job has completed and is available for download.
 *
 * @param {object} payload - { schoolId, jobId, reportType, downloadUrl }
 */
async function onReportReady(payload) {
  const { schoolId, jobId, reportType, downloadUrl } = payload || {};

  if (!schoolId) {
    logger.warn('report.ready event missing schoolId — notification skipped');
    return;
  }

  try {
    await createNotification({
      schoolId,
      type: 'report.ready',
      severity: 'info',
      title: 'Report Ready',
      message: reportType
        ? `Your ${reportType} report is ready for download.`
        : 'Your report is ready for download.',
      deepLink: downloadUrl || '/reports',
      metadata: { jobId, reportType },
    });
  } catch (err) {
    logger.error('Failed to create report.ready notification', {
      schoolId,
      jobId,
      err: err.message,
    });
  }
}

/**
 * Handle a 'system.alert' event.
 *
 * Fired for system-wide alerts such as maintenance windows, sync lag, or
 * critical health status changes.
 *
 * @param {object} payload - { schoolId, alertType, title, message, severity }
 */
async function onSystemAlert(payload) {
  const { schoolId, alertType, title, message, severity } = payload || {};

  if (!schoolId) {
    logger.warn('system.alert event missing schoolId — notification skipped');
    return;
  }

  try {
    await createNotification({
      schoolId,
      type: 'system.alert',
      severity: severity || 'warning',
      title: title || 'System Alert',
      message: message || 'A system alert has been raised.',
      deepLink: null,
      metadata: { alertType },
    });
  } catch (err) {
    logger.error('Failed to create system.alert notification', {
      schoolId,
      alertType,
      err: err.message,
    });
  }
}

/**
 * Register all notification event subscribers on the paymentEvents bus.
 *
 * Called once from app.js after all services are initialised.
 */
function registerNotificationSubscribers() {
  paymentEvents.on('payment.saved', onPaymentSaved);
  paymentEvents.on('dispute.created', onDisputeCreated);
  paymentEvents.on('dispute.updated', onDisputeUpdated);
  paymentEvents.on('report.ready', onReportReady);
  paymentEvents.on('system.alert', onSystemAlert);

  logger.info('Notification subscribers registered', {
    events: ['payment.saved', 'dispute.created', 'dispute.updated', 'report.ready', 'system.alert'],
  });
}

module.exports = { registerNotificationSubscribers };
