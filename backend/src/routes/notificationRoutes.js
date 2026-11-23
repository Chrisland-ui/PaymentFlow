'use strict';

const express = require('express');
const router = express.Router();
const {
  getNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
  getPreferences,
  updatePreferences,
} = require('../controllers/notificationController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');

// All notification routes require school context + admin authentication
router.use(resolveSchool);
router.use(requireAdminAuth);

// GET /api/notifications — paginated list (accepts ?page, ?limit, ?unreadOnly)
router.get('/', getNotifications);

// GET /api/notifications/unread-count — fast count for badge display
// Registered before /:id patterns to avoid route shadowing
router.get('/unread-count', getUnreadCount);

// GET /api/notifications/preferences — get per-type notification preferences
router.get('/preferences', getPreferences);

// PUT /api/notifications/preferences — update per-type notification preferences
router.put('/preferences', updatePreferences);

// PATCH /api/notifications/read — mark specific notifications as read
router.patch('/read', markRead);

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', markAllRead);

module.exports = router;
