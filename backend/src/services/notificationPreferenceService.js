'use strict';

/**
 * notificationPreferenceService.js
 *
 * Manages per-user, per-notification-type delivery channel preferences.
 * Issue #362: "Allow per-type notification preferences (in-app, email, both)"
 *
 * If no preference exists for a given type, the default is 'in-app'.
 */

const NotificationPreference = require('../models/notificationPreferenceModel');
const logger = require('../utils/logger').child('NotificationPreferenceService');

// All notification types supported by the system
const NOTIFICATION_TYPES = [
  'payment.confirmed',
  'payment.failed',
  'dispute.created',
  'dispute.updated',
  'report.ready',
  'system.alert',
];

// Channel options
const CHANNELS = ['in-app', 'email', 'both'];

// Default channel when no preference is set
const DEFAULT_CHANNEL = 'in-app';

/**
 * Get all notification preferences for a user within a school.
 * Returns a complete set — missing types are filled with defaults.
 *
 * @param {string} schoolId
 * @param {string} userId
 * @returns {Promise<object[]>} Array of preference objects with { type, channel, enabled }
 */
async function getPreferences(schoolId, userId) {
  const docs = await NotificationPreference.find({ schoolId, userId }).lean();

  // Build a map of existing preferences
  const prefMap = new Map(docs.map((d) => [d.type, d]));

  // Return a complete set, filling in defaults for missing types
  return NOTIFICATION_TYPES.map((type) => {
    const pref = prefMap.get(type);
    return {
      type,
      channel: pref ? pref.channel : DEFAULT_CHANNEL,
      enabled: pref ? pref.enabled : true,
    };
  });
}

/**
 * Get the delivery channel for a specific notification type.
 * Returns the default ('in-app') if no preference is set.
 *
 * @param {string} schoolId
 * @param {string} userId
 * @param {string} type
 * @returns {Promise<{ channel: string, enabled: boolean }>}
 */
async function getPreference(schoolId, userId, type) {
  const pref = await NotificationPreference.findOne({ schoolId, userId, type }).lean();

  return {
    channel: pref ? pref.channel : DEFAULT_CHANNEL,
    enabled: pref ? pref.enabled : true,
  };
}

/**
 * Set or update the delivery channel for a specific notification type.
 * Uses upsert to create if it doesn't exist.
 *
 * @param {string} schoolId
 * @param {string} userId
 * @param {string} type
 * @param {string} channel - 'in-app', 'email', or 'both'
 * @param {boolean} [enabled=true]
 * @returns {Promise<object>} The updated/created preference document
 */
async function setPreference(schoolId, userId, type, channel, enabled = true) {
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`Invalid notification type: ${type}`);
  }

  if (!CHANNELS.includes(channel)) {
    throw new Error(`Invalid channel: ${channel}. Must be one of: ${CHANNELS.join(', ')}`);
  }

  const pref = await NotificationPreference.findOneAndUpdate(
    { schoolId, userId, type },
    { $set: { channel, enabled } },
    { upsert: true, new: true, runValidators: true }
  ).lean();

  logger.info('Notification preference updated', { schoolId, userId, type, channel, enabled });
  return pref;
}

/**
 * Set multiple preferences at once.
 *
 * @param {string} schoolId
 * @param {string} userId
 * @param {object[]} preferences - Array of { type, channel, enabled? }
 * @returns {Promise<object[]>} Updated preference objects
 */
async function setPreferences(schoolId, userId, preferences) {
  const results = [];

  for (const { type, channel, enabled } of preferences) {
    const result = await setPreference(schoolId, userId, type, channel, enabled !== undefined ? enabled : true);
    results.push(result);
  }

  return results;
}

module.exports = {
  getPreferences,
  getPreference,
  setPreference,
  setPreferences,
  NOTIFICATION_TYPES,
  CHANNELS,
  DEFAULT_CHANNEL,
};
