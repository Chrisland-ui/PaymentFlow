'use strict';

const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
} = require('../services/inAppNotificationService');
const {
  getPreferences,
  setPreferences,
  NOTIFICATION_TYPES,
  CHANNELS,
} = require('../services/notificationPreferenceService');

/**
 * GET /api/notifications
 *
 * Query parameters:
 *   - page:       page number (default: 1)
 *   - limit:      results per page (default: 20, max: 100)
 *   - unreadOnly: 'true' to return only unread notifications
 *
 * Response: { notifications, total, unreadCount, page, limit }
 */
async function getNotificationsHandler(req, res, next) {
  try {
    const { schoolId } = req;
    const { page, limit, unreadOnly } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const parsedUnreadOnly = unreadOnly === 'true';

    const [{ notifications, total }, unreadCount] = await Promise.all([
      getNotifications(schoolId, {
        page: parsedPage,
        limit: parsedLimit,
        unreadOnly: parsedUnreadOnly,
      }),
      getUnreadCount(schoolId),
    ]);

    res.json({
      notifications,
      total,
      unreadCount,
      page: parsedPage,
      limit: parsedLimit,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/read
 *
 * Body: { notificationIds: string[] }
 *
 * Marks the specified notifications as read for the school.
 * Documents are preserved (not deleted) to maintain audit trail.
 */
async function markReadHandler(req, res, next) {
  try {
    const { schoolId } = req;
    const { notificationIds } = req.body;

    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
      return res.status(400).json({
        error: 'notificationIds must be a non-empty array',
        code: 'VALIDATION_ERROR',
      });
    }

    const modified = await markAsRead(schoolId, notificationIds);

    res.json({ modified });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/notifications/read-all
 *
 * Marks all unread notifications for the school as read.
 */
async function markAllReadHandler(req, res, next) {
  try {
    const { schoolId } = req;
    const modified = await markAllAsRead(schoolId);

    res.json({ modified });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/notifications/unread-count
 *
 * Returns the current unread notification count for the school.
 * Response: { unreadCount: N }
 */
async function getUnreadCountHandler(req, res, next) {
  try {
    const { schoolId } = req;
    const unreadCount = await getUnreadCount(schoolId);

    res.json({ unreadCount });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/notifications/preferences
 *
 * Returns all notification type preferences for the current user.
 * Missing types are filled with defaults (channel: 'in-app', enabled: true).
 *
 * Response: { preferences: [{ type, channel, enabled }] }
 */
async function getPreferencesHandler(req, res, next) {
  try {
    const { schoolId } = req;
    // Extract userId from the authenticated session (JWT payload has userId)
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(400).json({
        error: 'User ID is required to fetch notification preferences',
        code: 'VALIDATION_ERROR',
      });
    }

    const preferences = await getPreferences(schoolId, String(userId));
    res.json({ preferences });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/notifications/preferences
 *
 * Updates one or more notification type preferences for the current user.
 *
 * Body: { preferences: [{ type, channel, enabled? }] }
 *
 * Response: { preferences: [{ type, channel, enabled }] }
 */
async function updatePreferencesHandler(req, res, next) {
  try {
    const { schoolId } = req;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(400).json({
        error: 'User ID is required to update notification preferences',
        code: 'VALIDATION_ERROR',
      });
    }

    const { preferences } = req.body;

    if (!Array.isArray(preferences) || preferences.length === 0) {
      return res.status(400).json({
        error: 'preferences must be a non-empty array of { type, channel } objects',
        code: 'VALIDATION_ERROR',
      });
    }

    // Validate each preference entry
    for (const pref of preferences) {
      if (!pref.type || !NOTIFICATION_TYPES.includes(pref.type)) {
        return res.status(400).json({
          error: `Invalid notification type: ${pref.type}`,
          code: 'VALIDATION_ERROR',
        });
      }
      if (!pref.channel || !CHANNELS.includes(pref.channel)) {
        return res.status(400).json({
          error: `Invalid channel: ${pref.channel}. Must be one of: ${CHANNELS.join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
      }
    }

    const updated = await setPreferences(schoolId, String(userId), preferences);
    res.json({ preferences: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getNotifications: getNotificationsHandler,
  markRead: markReadHandler,
  markAllRead: markAllReadHandler,
  getUnreadCount: getUnreadCountHandler,
  getPreferences: getPreferencesHandler,
  updatePreferences: updatePreferencesHandler,
};
