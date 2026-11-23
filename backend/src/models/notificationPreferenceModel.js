'use strict';

const mongoose = require('mongoose');

/**
 * NotificationPreference model — per-user, per-notification-type channel preferences.
 *
 * Issue #362: "Allow per-type notification preferences (in-app, email, both)"
 *
 * Each preference record stores the delivery channel for a specific notification
 * type. The notification service checks these before creating in-app notifications
 * and before sending email notifications.
 *
 * Security:
 *   - schoolId is the tenant scope; all queries MUST include it.
 *   - userId is the individual user scope.
 */
const notificationPreferenceSchema = new mongoose.Schema(
  {
    // Tenant isolation
    schoolId: {
      type: String,
      required: true,
      index: true,
    },

    // User this preference belongs to
    userId: {
      type: String,
      required: true,
      index: true,
    },

    // Notification type (matches Notification.type enum)
    type: {
      type: String,
      enum: [
        'payment.confirmed',
        'payment.failed',
        'dispute.created',
        'dispute.updated',
        'report.ready',
        'system.alert',
      ],
      required: true,
    },

    // Delivery channel: 'in-app', 'email', or 'both'
    channel: {
      type: String,
      enum: ['in-app', 'email', 'both'],
      required: true,
      default: 'in-app',
    },

    // Whether this notification type is enabled at all
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index — one preference per (schoolId, userId, type)
notificationPreferenceSchema.index(
  { schoolId: 1, userId: 1, type: 1 },
  { unique: true }
);

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);
