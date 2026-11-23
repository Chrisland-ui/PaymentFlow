'use strict';

/**
 * Migration 031 — Update notification TTL index and add notification preference indexes
 *
 * Issue #362: "Retain the last 30 days of notifications per user"
 *
 * Changes:
 *   1. Drop the existing TTL index on notifications.createdAt (90 days) and
 *      recreate it with a 30-day expiry.
 *   2. Create the notificationpreferences collection with its compound unique
 *      index on { schoolId, userId, type }.
 *   3. Add individual indexes on schoolId and userId for notification preferences.
 */

const mongoose = require('mongoose');

const VERSION = '031_update_notification_ttl_and_preferences';

const NOTIFICATION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Existing indexes on a collection, tolerating a collection that has never
 * been created (NamespaceNotFound, code 26).
 * @param {import('mongodb').Collection} collection
 * @returns {Promise<Array<object>>}
 */
async function existingIndexes(collection) {
  return collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });
}

async function up() {
  // ── 1. Update notification TTL index from 90 → 30 days ─────────────────────
  const notifCollection = mongoose.connection.collection('notifications');

  for (const idx of await existingIndexes(notifCollection)) {
    // Drop the old TTL index on createdAt so we can recreate with new expiry
    if (idx.key && idx.key.createdAt !== undefined && idx.expireAfterSeconds !== undefined) {
      await notifCollection.dropIndex(idx.name);
      console.log(`[031] Dropped existing TTL index on notifications.createdAt: ${idx.name}`);
    }
  }

  await notifCollection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: NOTIFICATION_TTL_SECONDS }
  );
  console.log(`[031] Created TTL index on notifications.createdAt (${NOTIFICATION_TTL_SECONDS}s = 30 days)`);

  // Ensure compound indexes for common access patterns
  await notifCollection.createIndex({ schoolId: 1, createdAt: -1 });
  await notifCollection.createIndex({ schoolId: 1, read: 1, createdAt: -1 });
  console.log('[031] Ensured compound indexes on notifications');

  // ── 2. Create notification preferences collection + indexes ──────────────
  const prefCollection = mongoose.connection.collection('notificationpreferences');

  // Compound unique index — one preference per (schoolId, userId, type)
  await prefCollection.createIndex(
    { schoolId: 1, userId: 1, type: 1 },
    { unique: true }
  );
  console.log('[031] Created unique compound index on notificationpreferences { schoolId, userId, type }');

  // Individual indexes for lookup queries
  await prefCollection.createIndex({ schoolId: 1 });
  await prefCollection.createIndex({ userId: 1 });
  console.log('[031] Created individual indexes on notificationpreferences');
}

async function down() {
  const notifCollection = mongoose.connection.collection('notifications');

  // Revert TTL to 90 days
  for (const idx of await existingIndexes(notifCollection)) {
    if (idx.key && idx.key.createdAt !== undefined && idx.expireAfterSeconds !== undefined) {
      await notifCollection.dropIndex(idx.name);
    }
  }
  await notifCollection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // Drop preference indexes
  try {
    await mongoose.connection.collection('notificationpreferences').dropIndex('schoolId_1_userId_1_type_1');
  } catch { /* may not exist */ }
}

module.exports = { version: VERSION, up, down };
