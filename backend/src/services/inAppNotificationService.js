'use strict';

const Notification = require('../models/notificationModel');
const logger = require('../utils/logger').child('InAppNotificationService');

// How long to keep notifications (in milliseconds) — matches TTL index
// Issue #362: retain last 30 days of notifications per user
const NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Create a new in-app notification for a school and emit an SSE event
 * so connected clients update their unread count in real time.
 *
 * @param {object} data
 * @param {string} data.schoolId     - Tenant scope (required)
 * @param {string} data.type         - Event type enum
 * @param {string} data.severity     - 'info' | 'warning' | 'critical'
 * @param {string} data.title        - Short title for the notification
 * @param {string} data.message      - Human-readable message (no txHash/wallet addresses)
 * @param {string} [data.deepLink]   - Optional navigation URL
 * @param {object} [data.metadata]   - Safe context data (no PII beyond studentId)
 * @returns {Promise<object>} The saved notification document
 */
async function createNotification(data) {
  const { schoolId, type, severity, title, message, deepLink, metadata } = data;

  const notification = await Notification.create({
    schoolId,
    type,
    severity,
    title,
    message,
    deepLink: deepLink || null,
    metadata: metadata || {},
    read: false,
    readAt: null,
    createdAt: new Date(),
  });

  logger.info('In-app notification created', { schoolId, type, severity });

  // Emit SSE event so connected clients update unread count in real time (Issue #362)
  try {
    const sseService = require('./sseService');
    const unreadCount = await getUnreadCount(schoolId);
    sseService.emit(schoolId, 'notification.created', {
      notification: {
        _id: notification._id,
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        message: notification.message,
        deepLink: notification.deepLink,
        read: notification.read,
        createdAt: notification.createdAt,
      },
      unreadCount,
    });
  } catch (err) {
    // SSE delivery is best-effort; do not fail the notification creation
    logger.warn('SSE emit failed for notification.created', {
      schoolId,
      type,
      error: err.message,
    });
  }

  return notification;
}

/**
 * Retrieve paginated notifications for a school.
 *
 * @param {string} schoolId
 * @param {object} options
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {boolean} [options.unreadOnly=false]
 * @returns {Promise<{ notifications: object[], total: number }>}
 */
async function getNotifications(schoolId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const query = { schoolId };
  if (unreadOnly) {
    query.read = false;
  }

  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(query),
  ]);

  return { notifications, total };
}

/**
 * Mark specific notifications as read for a school.
 * Documents are never deleted — this preserves the audit trail.
 *
 * @param {string} schoolId
 * @param {string[]} notificationIds - Array of notification _id strings
 * @returns {Promise<number>} Number of documents modified
 */
async function markAsRead(schoolId, notificationIds) {
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return 0;
  }

  const result = await Notification.updateMany(
    { schoolId, _id: { $in: notificationIds }, read: false },
    { $set: { read: true, readAt: new Date() } }
  );

  return result.modifiedCount || 0;
}

/**
 * Mark all unread notifications for a school as read.
 *
 * @param {string} schoolId
 * @returns {Promise<number>} Number of documents modified
 */
async function markAllAsRead(schoolId) {
  const result = await Notification.updateMany(
    { schoolId, read: false },
    { $set: { read: true, readAt: new Date() } }
  );

  return result.modifiedCount || 0;
}

/**
 * Get the count of unread notifications for a school.
 *
 * @param {string} schoolId
 * @returns {Promise<number>}
 */
async function getUnreadCount(schoolId) {
  return Notification.countDocuments({ schoolId, read: false });
}

/**
 * Delete notifications older than 30 days for a school.
 * This is a backup to the MongoDB TTL index for cases where TTL cleanup lags.
 *
 * @param {string} schoolId
 * @returns {Promise<number>} Number of documents deleted
 */
async function pruneOldNotifications(schoolId) {
  const cutoff = new Date(Date.now() - NOTIFICATION_TTL_MS);

  const result = await Notification.deleteMany({
    schoolId,
    createdAt: { $lt: cutoff },
  });

  const deleted = result.deletedCount || 0;
  if (deleted > 0) {
    logger.info('Pruned old notifications', { schoolId, deleted });
  }
  return deleted;
}

module.exports = {
  createNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  pruneOldNotifications,
};
